"""ACP 斜杠命令：命令表快照、内置命令拦截与 `/名称 参数` 识别。

【这是做什么的？】
把两份来源合成客户端看到的命令表，并认出用户刚打的那一行是不是内置命令：
1. 内置命令（compact / btw / undo / redo / title / goal / abandon）加 Host 快照里的
   Plugin 命令和 `skill:<id>`；
2. `session/prompt` 里内置命令由服务端直接执行，不交给模型；其余命中项补全
   `RequestedSkill`。

【上下游】
- 上游：`server.py` 的 `_bind_commands`（握手时建表）与 `prompt`（每轮识别）。
- 下游：`RequestedSkill`（Host 唯一接受的命令入参形状）；内置命令再调 Host 服务面。

【三条硬约束】
1. **不匹配就当普通文本。** 未知名称、`//` 转义、没有 `/` 一律返回 `None`。
   客户端没声明表单时 `/goal` 也当普通文本，避免把一句话吞成命令。
2. **`raw_invocation` 必须逐字等于发给 Host 的 message。** Host 会严格比较
   （`COMMAND_INVOCATION_RAW_MISMATCH`），所以这里传整条 text，不做 strip、不改大小写。
3. **解析规则与 Host 逐字一致。** Host 的解析函数是私有的、ACP 侧不能 import，
   所以这里复制那三行，并用漂移测试锁定两边相等。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Final, Literal

from acp.schema import AvailableCommand, AvailableCommandInput

from harness_agent.host.acp.ext import available_command_meta
from harness_agent.host.connection import RpcError
from harness_agent.host.run_coordinator import RequestedSkill

_SLASH = re.compile(r"/([^\s/]+)([\s\S]*)")
"""与 `agent_host._parse_raw_command_invocation` 同一条正则。"""

_BUILTIN_ORDER: Final[tuple[str, ...]] = (
    "compact",
    "btw",
    "undo",
    "redo",
    "title",
    "goal",
    "abandon",
)

_BUILTIN_COPY: Final[dict[str, tuple[str, str | None]]] = {
    "compact": ("压缩当前上下文", None),
    "btw": ("旁注提问，不写入历史", "问题"),
    "undo": ("回退最近一轮", "both|code|conversation"),
    "redo": ("重做刚才的回退", None),
    "title": ("修改会话标题", "标题"),
    "goal": ("设置并查看当前目标", "目标或 pause|resume|clear|edit"),
    "abandon": ("放弃当前 Compose 进度，对话保留", None),
}

_GOAL_MUTATIONS: Final = frozenset({"pause", "resume", "clear"})

QUEUED_GOAL_TEXT: Final = "目标请求已排队，将在当前任务结束后继续。"
UNDO_TEXT: Final = "已回退第 {turn} 轮，恢复 {files} 个文件。重新打开会话可看到回退后的历史"
REDO_TEXT: Final = "已重做，恢复 {files} 个文件"
TITLE_TEXT: Final = "已改名为：{title}"
ABANDON_TEXT: Final = "已放弃当前 Compose 进度，对话保留"
COMPACT_TEXT: Final = "已压缩上下文：约 {before} → {after} tokens"


@dataclass(frozen=True, slots=True)
class CommandSpec:
    """一条可被用户直接调用的斜杠命令。"""

    skill_id: str
    name: str
    description: str
    source: Literal["builtin", "plugin", "skill"] = "plugin"
    argument_hint: str | None = None
    plugin_id: str | None = None


@dataclass(frozen=True, slots=True)
class DroppedCommand:
    """被挤掉的命令：不出现在菜单里，只留诊断。"""

    name: str
    source: str


@dataclass(frozen=True, slots=True)
class BuiltinCall:
    """一行已经认出的内置命令。`args` 是去掉命令名后的参数，两侧空白已去掉。"""

    name: str
    args: str
    raw: str


@dataclass(frozen=True, slots=True)
class GoalVerb:
    """`/goal` 的三种走法：查看、暂停类变更、提交新目标。"""

    kind: Literal["inspect", "mutate", "request"]
    action: str | None = None
    request_kind: str | None = None
    input_text: str = ""


@dataclass(frozen=True, slots=True)
class CommandIndex:
    """一次连接级的命令表：内置在前，其余按 Host 快照顺序，名称大小写不敏感。"""

    commands: tuple[CommandSpec, ...] = ()
    by_name: Mapping[str, CommandSpec] = field(
        default_factory=lambda: MappingProxyType({})
    )
    dropped: tuple[DroppedCommand, ...] = ()

    @classmethod
    def from_snapshot(
        cls,
        agent_commands: Sequence[Mapping[str, object]],
        *,
        forms: bool = False,
    ) -> CommandIndex:
        """内置命令优先占名；同名的 Plugin / Skill 不宣告，记在 `dropped`。"""
        commands: list[CommandSpec] = []
        by_name: dict[str, CommandSpec] = {}
        dropped: list[DroppedCommand] = []
        for spec in _builtin_specs(forms):
            commands.append(spec)
            by_name[spec.name.casefold()] = spec
        for entry in agent_commands:
            spec = _spec_from_entry(entry)
            if spec is None:
                continue
            key = spec.name.casefold()
            if key in by_name:
                dropped.append(DroppedCommand(name=spec.name, source=spec.source))
                continue
            commands.append(spec)
            by_name[key] = spec
        return cls(
            commands=tuple(commands),
            by_name=MappingProxyType(by_name),
            dropped=tuple(dropped),
        )

    def available_commands(self, *, commands_ext: bool = False) -> list[AvailableCommand]:
        """给客户端的命令列表。声明了 `commands` 扩展时，每条带上来源。"""
        listed: list[AvailableCommand] = []
        for spec in self.commands:
            meta = None
            if commands_ext:
                meta = available_command_meta(
                    command_id=spec.skill_id,
                    source=spec.source,
                    requested_skill_id=None if spec.source == "builtin" else spec.skill_id,
                    plugin_id=spec.plugin_id,
                )
            fields: dict[str, object] = {
                "name": spec.name,
                "description": spec.description,
                "input": (
                    AvailableCommandInput.model_validate({"hint": spec.argument_hint})
                    if spec.argument_hint
                    else None
                ),
            }
            # 没声明扩展时连键都不出现。显式传 None 会被 SDK 当成要序列化的值。
            if meta is not None:
                fields["field_meta"] = meta
            listed.append(AvailableCommand.model_validate(fields))
        return listed

    def match(self, text: str) -> RequestedSkill | None:
        """识别 Plugin / Skill 的 `/名称 参数`。内置命令不在这里，调用方先走 `parse_builtin`。"""
        parsed = parse_slash(text)
        if parsed is None:
            return None
        name, args = parsed
        spec = self.by_name.get(name.casefold())
        if spec is None or spec.source == "builtin":
            return None
        return RequestedSkill(
            skill_id=spec.skill_id,
            args=args,
            raw_invocation=text,
            command_name=spec.name,
        )


def parse_slash(text: str) -> tuple[str, str] | None:
    """拆出（名称, 规范化参数）；`//` 转义、没有名称或没有 `/` 返回 `None`。"""
    value = text.lstrip()
    if not value.startswith("/") or value.startswith("//"):
        return None
    match = _SLASH.fullmatch(value)
    if match is None:
        return None
    return match.group(1), match.group(2).strip()


def parse_builtin(text: str, *, forms: bool) -> BuiltinCall | None:
    """只认七个内置名。`/goal` 在客户端不支持表单时返回 `None`（当普通文本）。"""
    parsed = parse_slash(text)
    if parsed is None:
        return None
    name, args = parsed
    folded = name.casefold()
    if folded not in _BUILTIN_COPY:
        return None
    if folded == "goal" and not forms:
        return None
    return BuiltinCall(name=folded, args=args, raw=text)


def validate_builtin(call: BuiltinCall) -> GoalVerb | str | None:
    """参数不合法抛 `-32602 INVALID_COMMAND_ARGUMENTS`。

    `/goal` 返回 `GoalVerb`；`/undo` 返回模式字符串；其余返回 `None`。
    """
    name, args = call.name, call.args
    if name == "compact" and args:
        _bad_args()
    if name == "btw" and not args:
        _bad_args()
    if name == "redo" and args:
        _bad_args()
    if name == "title" and not args:
        _bad_args()
    if name == "undo":
        return undo_mode(args)
    if name == "goal":
        return classify_goal(args)
    return None


def undo_mode(args: str) -> str:
    """`/undo` 的模式。不写参数就是 `both`。"""
    if not args:
        return "both"
    if args in {"both", "code", "conversation"}:
        return args
    _bad_args()
    return "both"


def classify_goal(args: str) -> GoalVerb:
    """拆 `/goal`。`pause` 后面再跟字是非法的；`foobar` 是一句新目标，不是子命令。"""
    if not args:
        return GoalVerb("inspect")
    head, _, rest = args.partition(" ")
    rest = rest.strip()
    folded = head.casefold()
    if folded in _GOAL_MUTATIONS:
        if rest:
            _bad_args()
        return GoalVerb("mutate", action=folded)
    if folded == "edit":
        if not rest:
            _bad_args()
        return GoalVerb("request", request_kind="amend", input_text=rest)
    return GoalVerb("request", request_kind="create", input_text=args)


def undo_target(turns_payload: Mapping[str, object]) -> Mapping[str, object]:
    """最近一个还能再退的用户回合。

    生产环境在 Run 开始时记检查点，所以退「最新一个未回退回合」就是撤销那一轮的文件。
    已经退过时，只在那个回退点之前再找一轮。没有可退的回合抛 `NOTHING_TO_UNDO`。
    """
    raw = turns_payload.get("turns")
    turns = [item for item in raw if isinstance(item, Mapping)] if isinstance(raw, list) else []
    reverted = turns_payload.get("reverted_turn_id")
    pool: Sequence[Mapping[str, object]] = turns
    if isinstance(reverted, str) and reverted:
        index = next(
            (i for i, turn in enumerate(turns) if turn.get("turn_id") == reverted),
            None,
        )
        pool = turns[:index] if index is not None else []
    if not pool:
        raise RpcError(-32602, "NOTHING_TO_UNDO")
    target = pool[-1]
    if not isinstance(target.get("turn_id"), str):
        raise RpcError(-32602, "NOTHING_TO_UNDO")
    return target


def compact_sentence(result: Mapping[str, object]) -> tuple[str, tuple[int, int] | None]:
    """压缩结果 → 给用户的句子，以及可选的 `(used, size)`。

    有 `before_tokens` / `after_tokens` 就用它们。没有时两边都退回 `estimated_tokens`，
    句子仍然是「约 A → B tokens」。`size` 为 0 时不发用量（客户端把 0 当成没有）。
    """
    context = result.get("context")
    if not isinstance(context, Mapping):
        context = {}
    estimated = context.get("estimated_tokens")
    before = result.get("before_tokens")
    after = result.get("after_tokens")
    if not _int(before):
        before = estimated if _int(estimated) else 0
    if not _int(after):
        after = estimated if _int(estimated) else 0
    text = COMPACT_TEXT.format(before=before, after=after)
    used = context.get("estimated_tokens")
    size = context.get("input_cap_tokens")
    usage = (used, size) if _int(used) and _int(size) and size > 0 else None
    return text, usage


def goal_inspect_text(snapshot: Mapping[str, object]) -> str:
    """和 TUI 的目标浮层同一句话，后面带验收条件。"""
    pending = snapshot.get("pending") if isinstance(snapshot.get("pending"), Mapping) else None
    goal = snapshot.get("goal") if isinstance(snapshot.get("goal"), Mapping) else None
    if pending is not None and pending.get("input_text"):
        summary = f"目标正在处理中：{pending.get('input_text')}"
    elif goal is None:
        summary = "当前 thread 还没有目标。用 `/goal <目标>` 创建。"
    else:
        summary = f"当前目标（{goal.get('status')} · r{goal.get('revision')}）：{goal.get('objective')}"
    criteria = _criteria(goal, pending)
    if not criteria:
        return summary
    lines = "\n".join(f"- {item}" for item in criteria)
    return f"{summary}\n\n验收：\n{lines}"


def goal_mutate_text(action: str) -> str:
    """暂停 / 恢复 / 清除的固定回复。"""
    return {"pause": "目标已暂停", "resume": "目标已恢复", "clear": "目标已清除"}.get(
        action, "目标操作已完成"
    )


def _criteria(
    goal: Mapping[str, object] | None,
    pending: Mapping[str, object] | None,
) -> list[str]:
    raw = None
    if goal is not None:
        raw = goal.get("criteria")
    if not raw and pending is not None:
        raw = pending.get("proposed_criteria")
    if not isinstance(raw, list):
        return []
    texts: list[str] = []
    for item in raw:
        if isinstance(item, str) and item:
            texts.append(item)
        elif isinstance(item, Mapping) and isinstance(item.get("text"), str):
            texts.append(str(item["text"]))
    return texts


def _int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _bad_args() -> None:
    raise RpcError(-32602, "INVALID_COMMAND_ARGUMENTS")


def _builtin_specs(forms: bool) -> tuple[CommandSpec, ...]:
    specs: list[CommandSpec] = []
    for name in _BUILTIN_ORDER:
        if name == "goal" and not forms:
            continue
        description, hint = _BUILTIN_COPY[name]
        specs.append(
            CommandSpec(
                skill_id=name,
                name=name,
                description=description,
                source="builtin",
                argument_hint=hint,
            )
        )
    return tuple(specs)


def _spec_from_entry(entry: Mapping[str, object]) -> CommandSpec | None:
    skill_id = entry.get("id")
    name = entry.get("name")
    if not isinstance(skill_id, str) or not skill_id:
        return None
    if not isinstance(name, str) or not name or name.startswith("/"):
        return None
    description = entry.get("description")
    hint = entry.get("argument_hint")
    plugin_raw = entry.get("plugin_id")
    plugin_id = plugin_raw if isinstance(plugin_raw, str) and plugin_raw else None
    # `skill:` 优先于 plugin_id。协议强制 Skill 行也带 plugin_id，不能因此标成插件命令。
    source: Literal["plugin", "skill"] = "skill" if name.startswith("skill:") else "plugin"
    return CommandSpec(
        skill_id=skill_id,
        name=name,
        description=description if isinstance(description, str) else "",
        source=source,
        argument_hint=hint if isinstance(hint, str) and hint else None,
        plugin_id=plugin_id,
    )


EMPTY_COMMAND_INDEX: Final = CommandIndex()
"""没有命令时的默认表（握手前）。"""

__all__ = [
    "ABANDON_TEXT",
    "COMPACT_TEXT",
    "EMPTY_COMMAND_INDEX",
    "QUEUED_GOAL_TEXT",
    "REDO_TEXT",
    "TITLE_TEXT",
    "UNDO_TEXT",
    "BuiltinCall",
    "CommandIndex",
    "CommandSpec",
    "DroppedCommand",
    "GoalVerb",
    "classify_goal",
    "compact_sentence",
    "goal_inspect_text",
    "goal_mutate_text",
    "parse_builtin",
    "parse_slash",
    "undo_target",
    "validate_builtin",
]
