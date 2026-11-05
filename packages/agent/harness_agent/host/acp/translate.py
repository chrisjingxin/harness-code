"""v3 Run 事件 → ACP `session/update` 的翻译状态机。

【这是做什么的？】
一个 Run 一个 `RunTranslator`；它把 Host 推来的 v3 事件字典翻译成零到多条 ACP
update，并在收到终态事件时给出 `RunOutcome`。全是内存状态，不做 I/O、不写日志，
所以可以逐条单测。

【上下游】
- 上游：`server.py` 的发送泵，按 Run 找到对应翻译器后 `feed()`。
- 下游：`tool_display.py`（kind / 标题 / 位置）与官方 SDK 的 schema 类型。

【为什么这样设计】
1. 参数增量只缓冲不外泄。流式 JSON 拼到一半就推给客户端，界面会闪出一串半截
   参数；这里等 `tool.completed` 时一次解析，代价是执行期间副标题只有工具名。
2. 工具输出用「累计值」推送。ACP 的 `content` 是替换语义而不是追加，所以每次都得
   发全量；超过 64 KiB 就截断，避免把帧撑过桥的 8 MiB 上限。
3. 子 agent 事件全部丢弃并计数。它们的正文若混进主消息，用户会看到两段语气不同的
   回答；S1 只显示父级 `task` 工具卡。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Literal

from acp.helpers import (
    start_tool_call,
    text_block,
    tool_content,
    update_tool_call,
)
from acp.schema import (
    AgentMessageChunk,
    AgentThoughtChunk,
    ToolCallLocation,
    ToolCallProgress,
    ToolCallStart,
    ToolKind,
)

from harness_agent.host.acp.tool_display import (
    PathLocator,
    sanitize_line,
    tool_kind,
    tool_title,
)

Update = AgentMessageChunk | AgentThoughtChunk | ToolCallStart | ToolCallProgress
"""本模块会产出的 ACP `session/update` 联合类型。"""

MAX_OUTPUT_CHARS: Final = 64 * 1024
"""工具输出文本的累计上限；超过后不再追加，避免单帧过大。"""

_MAX_RAW_INPUT_BYTES: Final = 256 * 1024
"""`rawInput` 序列化后的上限；超过就不发，客户端仍能靠标题识别工具。"""

_MAX_ARGS_BYTES: Final = 1024 * 1024
"""参数缓冲的累计上限；超过后视为不可用，之后不再解析。"""

_FALLBACK_TOOL_NAME: Final = "tool"
"""没有 `tool.started` 时（例如只收到完成事件）的兜底显示名。"""

UNSET: Final = object()
"""`raw_input` 的「尚未解析 / 不发送」哨兵；`None` 是合法 JSON 值，不能当哨兵。"""

_MAX_SUMMARY_BYTES: Final = 16 * 1024
"""`RunOutcome.summary.context` 的序列化上限；超过就丢掉 `context` 这一项。"""

_IGNORED_EVENT_TYPES: Final = frozenset(
    {
        "run.started",
        "run.progress",
        "skill.loaded",
        "context.updated",
        "interaction.resolved",
    }
)
"""已知但 S1 不翻译的事件；静默丢弃，不算「未知类型」。"""

_IGNORED_EVENT_PREFIXES: Final = ("compose.", "goal.")
"""按前缀归类的已知事件族，同样静默丢弃。"""

TERMINAL_EVENT_TYPES: Final = frozenset({"run.completed", "run.cancelled", "run.failed"})
"""Run 终态事件类型。"""


@dataclass(frozen=True, slots=True)
class RunOutcome:
    """Run 的终态；`failed` 时带上 v3 `payload.error` 原样内容。"""

    kind: Literal["completed", "cancelled", "failed"]
    error: Mapping[str, object] | None = None
    # `run.completed` 的汇总（usage / duration_ms / context）；取消与失败不带。
    summary: Mapping[str, object] | None = None


@dataclass(frozen=True, slots=True)
class ApprovalTarget:
    """一次权限请求要挂在哪张工具卡上。

    `raw_input` 为 `UNSET` 表示参数不可发送（超 256 KiB 或缺失）；
    `updates` 必须先于 `session/request_permission` 发出去，客户端才有卡片可挂。
    `matched` 是诊断口径：`id` 精确关联、`args` 降级匹配、`none` 兜底卡。
    """

    tool_call_id: str
    title: str
    kind: ToolKind
    locations: list[ToolCallLocation]
    raw_input: object
    updates: list[Update]
    matched: Literal["id", "args", "none"]


@dataclass(slots=True)
class TranslateResult:
    """一次 `feed()` 的结果：要发的 update，以及（可选）Run 终态。"""

    updates: list[Update] = field(default_factory=list)
    outcome: RunOutcome | None = None


@dataclass(slots=True)
class _ToolState:
    """单个工具调用的翻译状态。"""

    tool_call_id: str
    v3_id: str
    name: str = ""
    kind: ToolKind = "other"
    args_parts: list[str] = field(default_factory=list)
    args_bytes: int = 0
    args_unusable: bool = False
    raw_input: object = UNSET
    input_announced: bool = False
    announced: bool = False
    final: bool = False
    # 已被某个审批占用：防止两个同时挂起的审批抢同一张卡。
    permission_claimed: bool = False
    # 兜底卡 / 目录信任卡：终态由 `finish_card` 收尾，而真实工具卡等 `tool.completed`。
    aux: bool = False
    # 批准后已推过 `in_progress`（幂等）。
    executing: bool = False
    output_text: str = ""


@dataclass(frozen=True, slots=True)
class _InputPatch:
    """「补参数」这一步要带的字段。

    `raw_input` 为 `UNSET` 表示参数不可用：只发工具名标题，不发 `rawInput`。
    """

    title: str
    raw_input: object = UNSET
    locations: list[ToolCallLocation] | None = None

    @property
    def parsed(self) -> bool:
        """参数是否解析成功（成功才允许在审批前主动 announce）。"""
        return self.raw_input is not UNSET


def acp_tool_call_id(run_id: str, tool_call_id: str) -> str:
    """返回会话内唯一的工具调用 id：`{run_id}:{v3_id}`。

    provider 的 id 只在单次 Run 内唯一（常见的就是 `call_0`），而 ACP 要求会话内唯一；
    S2 的审批关联也走同一个函数，不需要额外映射表。
    """
    return f"{run_id}:{tool_call_id}"


class RunTranslator:
    """把一个 Run 的 v3 事件翻译成 ACP update 的纯状态机。"""

    def __init__(self, run_id: str, locator: PathLocator) -> None:
        """绑定 Run 身份与位置解析器；`segment` 从 0 开始，每遇到工具开始加一。"""
        self._run_id = run_id
        self._locator = locator
        self._segment = 0
        self._tools: dict[str, _ToolState] = {}
        self._terminal: RunOutcome | None = None
        self.ignored_types: set[str] = set()
        self.dropped_child_events = 0

    def feed(self, event: Mapping[str, object]) -> TranslateResult:
        """处理一条 v3 事件记录；终态之后到达的事件一律丢弃。"""
        if self._terminal is not None:
            return TranslateResult()
        # 子 agent（inline child）的事件与父级共用一条流，只按 parent_execution_id 区分。
        if event.get("parent_execution_id") is not None:
            self.dropped_child_events += 1
            return TranslateResult()
        event_type = event.get("type")
        if not isinstance(event_type, str):
            return TranslateResult()
        payload = event.get("payload")
        data: Mapping[str, object] = payload if isinstance(payload, Mapping) else {}
        if event_type == "content.delta":
            return TranslateResult(self._content_delta(data))
        if event_type == "reasoning.delta":
            return TranslateResult(self._reasoning_delta(data))
        if event_type == "tool.started":
            return TranslateResult(self._tool_started(data))
        if event_type == "tool.delta":
            return TranslateResult(self._tool_delta(data))
        if event_type == "tool.completed":
            return TranslateResult(self._tool_completed(data))
        if event_type in TERMINAL_EVENT_TYPES:
            return TranslateResult([], self._set_terminal(event_type, data))
        if event_type in _IGNORED_EVENT_TYPES or event_type.startswith(_IGNORED_EVENT_PREFIXES):
            return TranslateResult()
        self.ignored_types.add(event_type)
        return TranslateResult()

    def leftovers(self) -> list[ToolCallProgress]:
        """终态时把还没结束的工具补发成 `failed`，否则界面会一直转圈。

        三种终态（完成、取消、失败）都调用；幂等，重复调用返回空列表。
        """
        updates: list[ToolCallProgress] = []
        for state in self._tools.values():
            if state.final or not state.announced:
                continue
            state.final = True
            updates.append(update_tool_call(state.tool_call_id, status="failed"))
        return updates

    def prepare_approval(
        self,
        *,
        request_id: str,
        name: str,
        args: Mapping[str, object] | None,
        tool_call_id: str | None,
        is_child: bool,
        agent_id: str | None,
    ) -> ApprovalTarget:
        """把一次审批关联到一张工具卡，并给出必须先发出去的卡片更新。

        输入：审批 payload 里的工具名、真正会执行的参数，以及 2.0 注入的 provider
              `tool_call_id`（可能为空）；子代理审批直接走兜底卡。
        输出：卡片 id、标题、类别、位置、rawInput 与 `updates`。

        判断顺序：子代理 → 有 id 按 id（已收尾/已被占用则兜底）→
                  没 id 按「同名 + 参数相同 + 未被占用」降级匹配 → 兜底卡。
        兜底卡用 `approval:{request_id}`，请求 id 本身已在会话内唯一。
        """
        raw = UNSET if args is None else bounded_raw_input(dict(args))
        title = tool_title(name, args)
        kind = tool_kind(name)
        locations = self._locator.locations(name, args)
        fallback_id = f"approval:{request_id}"
        if is_child:
            # 翻译器丢弃了子代理事件，不认得它们的工具卡，只能用兜底卡。
            prefix = f"{agent_id}: " if agent_id else ""
            return self._aux_card(
                fallback_id, f"{prefix}{title}", kind, locations, raw, "none"
            )
        if tool_call_id:
            known = self._tools.get(tool_call_id)
            if known is None:
                # provider 重复使用 id 时，事件里的真实卡改用了合成 id，按 id 找不到；
                # 先按「同名 + 参数相同」认领已有卡，免得再造一张永远转圈的幻影卡。
                by_args = self._match_by_args(name, args)
                if by_args is not None:
                    return self._claim(
                        by_args,
                        title=title,
                        kind=kind,
                        locations=locations,
                        raw=raw,
                        matched="args",
                    )
            state = known or self._state_for_id(tool_call_id, name)
            if state.final or state.permission_claimed:
                return self._aux_card(fallback_id, title, kind, locations, raw, "none")
            return self._claim(
                state, title=title, kind=kind, locations=locations, raw=raw, matched="id"
            )
        matched = self._match_by_args(name, args)
        if matched is not None:
            return self._claim(
                matched, title=title, kind=kind, locations=locations, raw=raw, matched="args"
            )
        return self._aux_card(fallback_id, title, kind, locations, raw, "none")

    def prepare_trust(
        self, *, request_id: str, directory: str, access: str, target_path: str
    ) -> ApprovalTarget:
        """目录信任永远用独立卡片 `trust:{request_id}`，不抢任何工具卡。"""
        title = sanitize_line(f"访问工作区外目录：{directory}")
        kind: ToolKind = "edit" if access == "write" else "read"
        locations = (
            [ToolCallLocation(path=target_path)] if _is_absolute(target_path) else []
        )
        return self._aux_card(f"trust:{request_id}", title, kind, locations, UNSET, "none")

    def mark_executing(self, card_id: str) -> list[Update]:
        """批准后把真实工具卡从 `pending` 推进到 `in_progress`；只发一次。"""
        state = self._find_card(card_id)
        if state is None or state.aux or state.final or state.executing:
            return []
        state.executing = True
        return [update_tool_call(card_id, status="in_progress")]

    def finish_card(self, card_id: str, *, ok: bool) -> list[Update]:
        """给兜底卡 / 信任卡收尾；真实工具卡的终态由 `tool.completed` 决定。"""
        state = self._find_card(card_id)
        if state is None or not state.aux or state.final:
            return []
        state.final = True
        return [update_tool_call(card_id, status="completed" if ok else "failed")]

    def _claim(
        self,
        state: _ToolState,
        *,
        title: str,
        kind: ToolKind,
        locations: list[ToolCallLocation],
        raw: object,
        matched: Literal["id", "args"],
    ) -> ApprovalTarget:
        """占用一张已有工具卡：补标题/位置/参数，卡还没建就现在建。"""
        state.kind = kind
        state.permission_claimed = True
        state.input_announced = True
        state.raw_input = raw
        sent = None if raw is UNSET else raw
        if state.announced:
            updates: list[Update] = [
                update_tool_call(
                    state.tool_call_id,
                    title=title,
                    locations=locations or None,
                    raw_input=sent,
                )
            ]
        else:
            updates = [
                self._announce(
                    state, title=title, kind=kind, locations=locations, raw_input=raw
                )
            ]
        return ApprovalTarget(
            tool_call_id=state.tool_call_id,
            title=title,
            kind=kind,
            locations=locations,
            raw_input=raw,
            updates=updates,
            matched=matched,
        )

    def _aux_card(
        self,
        card_id: str,
        title: str,
        kind: ToolKind,
        locations: list[ToolCallLocation],
        raw: object,
        matched: Literal["none"],
    ) -> ApprovalTarget:
        """建一张兜底卡并登记，使终态补发也能把它收尾（不留转圈的卡）。"""
        state = _ToolState(
            tool_call_id=card_id,
            v3_id=card_id,
            kind=kind,
            aux=True,
            permission_claimed=True,
            input_announced=True,
            raw_input=raw,
        )
        self._tools[card_id] = state
        update = self._announce(
            state, title=title, kind=kind, locations=locations, raw_input=raw
        )
        return ApprovalTarget(card_id, title, kind, locations, raw, [update], matched)

    def _announce(
        self,
        state: _ToolState,
        *,
        title: str,
        kind: ToolKind,
        locations: list[ToolCallLocation] | None = None,
        raw_input: object = UNSET,
    ) -> ToolCallStart:
        """新建一张工具卡并推进正文段号。

        段号必须在这里推进：审批可能比任何事件都早到，若审批建卡时不推进，
        工具之后的正文会与前面的正文共用同一个 messageId，被客户端拼成一条。
        """
        state.announced = True
        state.kind = kind
        self._segment += 1
        return start_tool_call(
            state.tool_call_id,
            title,
            kind=kind,
            status="pending",
            locations=locations or None,
            raw_input=None if raw_input is UNSET else raw_input,
        )

    def _find_card(self, card_id: str) -> _ToolState | None:
        """按 ACP 卡片 id 找状态；条目很少，直接扫。"""
        for state in self._tools.values():
            if state.tool_call_id == card_id:
                return state
        return None

    def _match_by_args(
        self, name: str, args: Mapping[str, object] | None
    ) -> _ToolState | None:
        """没有 id 时按「同名 + 参数相同 + 未被占用 + 未结束」找最早的一张卡。"""
        if not name or args is None:
            return None
        for state in self._tools.values():
            if state.aux or state.final or state.permission_claimed or not state.announced:
                continue
            if state.name != name:
                continue
            parsed = state.raw_input if state.input_announced else self._parse_arguments(state)
            if isinstance(parsed, Mapping) and dict(parsed) == dict(args):
                return state
        return None

    def _content_delta(self, data: Mapping[str, object]) -> list[Update]:
        """正文增量 → `agent_message_chunk`，messageId 用当前段号。"""
        text = data.get("text")
        if not isinstance(text, str) or not text:
            return []
        return [
            AgentMessageChunk(
                session_update="agent_message_chunk",
                content=text_block(text),
                message_id=f"{self._run_id}:m{self._segment}",
            )
        ]

    def _reasoning_delta(self, data: Mapping[str, object]) -> list[Update]:
        """思考增量 → `agent_thought_chunk`，前缀 `t` 与正文分开。"""
        text = data.get("text")
        if not isinstance(text, str) or not text:
            return []
        return [
            AgentThoughtChunk(
                session_update="agent_thought_chunk",
                content=text_block(text),
                message_id=f"{self._run_id}:t{self._segment}",
            )
        ]

    def _tool_started(self, data: Mapping[str, object]) -> list[Update]:
        """工具开始 → `pending` 卡片；重复到达只公告一次。"""
        state = self._tool_state(data)
        if state is None:
            return []
        name = data.get("name")
        if isinstance(name, str) and name:
            state.name = name
            state.kind = tool_kind(name)
        if state.announced:
            return []
        # 每次工具开始都推进段号：工具之后的正文属于新消息，并行工具跳号无害。
        return [self._announce(state, title=tool_title(state.name, None), kind=state.kind)]

    def _tool_delta(self, data: Mapping[str, object]) -> list[Update]:
        """参数只缓冲不外泄；工具输出按累计值推送（ACP 的 content 是替换语义）。"""
        state = self._tool_state(data)
        if state is None:
            return []
        arguments = data.get("arguments_delta")
        if isinstance(arguments, str) and arguments and not state.args_unusable:
            state.args_parts.append(arguments)
            state.args_bytes += len(arguments.encode("utf-8"))
            if data.get("truncated") or state.args_bytes > _MAX_ARGS_BYTES:
                # 已被 v3 截断或累计超限：之后不再解析，也不发 rawInput。
                state.args_unusable = True
                state.args_parts.clear()
        output = data.get("output_delta")
        if not isinstance(output, str) or not output or not state.announced:
            return []
        if len(state.output_text) < MAX_OUTPUT_CHARS:
            state.output_text = (state.output_text + output)[:MAX_OUTPUT_CHARS]
        return [
            update_tool_call(
                state.tool_call_id,
                status="in_progress",
                content=[tool_content(text_block(state.output_text))],
            )
        ]

    def _tool_completed(self, data: Mapping[str, object]) -> list[Update]:
        """工具结束 → 终态卡片；首次完成时顺带补参数、标题与位置。"""
        state = self._tool_state(data)
        if state is None or state.final:
            return []
        result = data.get("result")
        result_data: Mapping[str, object] = result if isinstance(result, Mapping) else {}
        content_value = result_data.get("content")
        raw_output = content_value if isinstance(content_value, str) else ""
        status: Literal["completed", "failed"] = "failed" if result_data.get("is_error") else "completed"
        content = [tool_content(text_block(raw_output[:MAX_OUTPUT_CHARS]))] if raw_output else None
        state.final = True
        patch = self._input_patch(state)
        state.input_announced = True
        title = patch.title if patch is not None else tool_title(state.name, None)
        raw_input = patch.raw_input if patch is not None else UNSET
        locations = patch.locations if patch is not None else None
        sent_input = None if raw_input is UNSET else raw_input
        if not state.announced:
            # 没见过 started：发一条完整的 tool_call，客户端才能建卡片。
            state.announced = True
            return [
                start_tool_call(
                    state.tool_call_id,
                    title,
                    kind=state.kind,
                    status=status,
                    content=content,
                    locations=locations,
                    raw_input=sent_input,
                    raw_output=raw_output or None,
                )
            ]
        return [
            update_tool_call(
                state.tool_call_id,
                status=status,
                # 参数此前已经公告过（patch 为 None）时，不能把标题回写成裸工具名。
                title=title if patch is not None else None,
                content=content,
                locations=locations,
                raw_input=sent_input,
                raw_output=raw_output or None,
            )
        ]

    def _input_patch(self, state: _ToolState) -> _InputPatch | None:
        """返回「补参数」要带的字段；已补过返回 None。

        解析只做一次：成功得到 `rawInput`、含参数的标题与位置；失败（半截、非法、
        `args_unusable`、序列化超限）就退化成工具名标题，绝不发半截 JSON。
        """
        if state.input_announced:
            return None
        if state.raw_input is UNSET:
            state.raw_input = self._parse_arguments(state)
        raw = state.raw_input
        if raw is UNSET:
            return _InputPatch(title=tool_title(state.name, None))
        sent_input: object = UNSET
        try:
            size = len(json.dumps(raw))
        except (TypeError, ValueError):
            size = _MAX_RAW_INPUT_BYTES + 1
        if size <= _MAX_RAW_INPUT_BYTES:
            sent_input = raw
        if isinstance(raw, Mapping):
            return _InputPatch(
                title=tool_title(state.name, raw),
                raw_input=sent_input,
                locations=self._locator.locations(state.name, raw) or None,
            )
        return _InputPatch(title=tool_title(state.name, None), raw_input=sent_input)

    @staticmethod
    def _parse_arguments(state: _ToolState) -> object:
        """把参数缓冲拼成 JSON 值；失败返回 `UNSET`（不是 `None`）。"""
        if state.args_unusable or not state.args_parts:
            return UNSET
        try:
            return json.loads("".join(state.args_parts))
        except json.JSONDecodeError:
            return UNSET

    def _tool_state(self, data: Mapping[str, object]) -> _ToolState | None:
        """找到或创建工具状态；v3 id 缺失时返回 None（畸形事件只降级）。"""
        tool_call_id = data.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return None
        name = data.get("name")
        return self._state_for_id(tool_call_id, name if isinstance(name, str) else "")

    def _state_for_id(self, tool_call_id: str, name: str) -> _ToolState:
        """按 v3 `tool_call_id` 找或建状态；名字只在提供时补写。"""
        state = self._tools.get(tool_call_id)
        if state is None:
            state = _ToolState(
                tool_call_id=acp_tool_call_id(self._run_id, tool_call_id),
                v3_id=tool_call_id,
                name=name or _FALLBACK_TOOL_NAME,
                kind=tool_kind(name) if name else "other",
            )
            self._tools[tool_call_id] = state
        elif name:
            state.name = name
            state.kind = tool_kind(name)
        return state

    def _set_terminal(self, event_type: str, data: Mapping[str, object]) -> RunOutcome:
        """记录终态；只认第一个终态事件。"""
        if event_type == "run.completed":
            outcome = RunOutcome(kind="completed", summary=_run_summary(data))
        elif event_type == "run.cancelled":
            outcome = RunOutcome(kind="cancelled")
        else:
            error = data.get("error")
            outcome = RunOutcome(
                kind="failed",
                error=error if isinstance(error, Mapping) else None,
            )
        self._terminal = outcome
        return outcome


def bounded_raw_input(value: object) -> object:
    """序列化后超过 `rawInput` 上限时返回 `UNSET`，调用方据此不发该字段。"""
    if value is UNSET:
        return UNSET
    try:
        size = len(json.dumps(value))
    except (TypeError, ValueError):
        return UNSET
    return value if size <= _MAX_RAW_INPUT_BYTES else UNSET


def _is_absolute(path: str) -> bool:
    """判断是否为绝对路径；空串与异常一律当相对路径（不发 locations）。"""
    if not path:
        return False
    try:
        return Path(path).is_absolute()
    except (TypeError, ValueError):
        return False


def _run_summary(data: Mapping[str, object]) -> dict[str, object] | None:
    """取 `run.completed` payload 里的 usage / duration_ms / context。

    缺哪项省哪项；`context` 序列化后超过 16 KiB 就丢掉它（客户端拿不到也不影响运行）。
    """
    summary: dict[str, object] = {}
    for key in ("usage", "duration_ms"):
        value = data.get(key)
        if value is not None:
            summary[key] = value
    context = data.get("context")
    if isinstance(context, Mapping):
        try:
            size = len(json.dumps(dict(context), ensure_ascii=False))
        except (TypeError, ValueError):
            size = _MAX_SUMMARY_BYTES + 1
        if size <= _MAX_SUMMARY_BYTES:
            summary["context"] = dict(context)
    return summary or None


__all__ = [
    "MAX_OUTPUT_CHARS",
    "ApprovalTarget",
    "RunOutcome",
    "RunTranslator",
    "TranslateResult",
    "UNSET",
    "Update",
    "acp_tool_call_id",
    "bounded_raw_input",
]
