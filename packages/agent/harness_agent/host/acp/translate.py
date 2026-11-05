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

from harness_agent.host.acp.tool_display import PathLocator, tool_kind, tool_title

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

_UNSET: Final = object()
"""`raw_input` 的「尚未解析 / 不发送」哨兵；`None` 是合法 JSON 值，不能当哨兵。"""

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
    raw_input: object = _UNSET
    input_announced: bool = False
    announced: bool = False
    final: bool = False
    output_text: str = ""


@dataclass(frozen=True, slots=True)
class _InputPatch:
    """「补参数」这一步要带的字段。

    `raw_input` 为 `_UNSET` 表示参数不可用：只发工具名标题，不发 `rawInput`。
    """

    title: str
    raw_input: object = _UNSET
    locations: list[ToolCallLocation] | None = None

    @property
    def parsed(self) -> bool:
        """参数是否解析成功（成功才允许在审批前主动 announce）。"""
        return self.raw_input is not _UNSET


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

    def announce_input(self, tool_call_id: str) -> list[ToolCallProgress]:
        """参数首次完整时补一条带 `rawInput` / 标题 / 位置的 update。

        入参是 v3 的原始 tool_call_id（不是加了 Run 前缀的 ACP id）。
        幂等；参数还拼不完整或不可用时返回空列表——绝不发半截参数。
        """
        state = self._tools.get(tool_call_id)
        if state is None or not state.announced:
            return []
        patch = self._input_patch(state)
        if patch is None or not patch.parsed:
            return []
        state.input_announced = True
        return [
            update_tool_call(
                state.tool_call_id,
                status="in_progress",
                title=patch.title,
                raw_input=patch.raw_input,
                locations=patch.locations,
            )
        ]

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
        state.announced = True
        # 每次工具开始都推进段号：工具之后的正文属于新消息，并行工具跳号无害。
        self._segment += 1
        return [
            start_tool_call(
                state.tool_call_id,
                tool_title(state.name, None),
                kind=state.kind,
                status="pending",
            )
        ]

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
        raw_input = patch.raw_input if patch is not None else _UNSET
        locations = patch.locations if patch is not None else None
        sent_input = None if raw_input is _UNSET else raw_input
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
        if state.raw_input is _UNSET:
            state.raw_input = self._parse_arguments(state)
        raw = state.raw_input
        if raw is _UNSET:
            return _InputPatch(title=tool_title(state.name, None))
        sent_input: object = _UNSET
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
        """把参数缓冲拼成 JSON 值；失败返回 `_UNSET`（不是 `None`）。"""
        if state.args_unusable or not state.args_parts:
            return _UNSET
        try:
            return json.loads("".join(state.args_parts))
        except json.JSONDecodeError:
            return _UNSET

    def _tool_state(self, data: Mapping[str, object]) -> _ToolState | None:
        """找到或创建工具状态；v3 id 缺失时返回 None（畸形事件只降级）。"""
        tool_call_id = data.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            return None
        state = self._tools.get(tool_call_id)
        if state is not None:
            return state
        name = data.get("name")
        display_name = name if isinstance(name, str) and name else _FALLBACK_TOOL_NAME
        state = _ToolState(
            tool_call_id=acp_tool_call_id(self._run_id, tool_call_id),
            v3_id=tool_call_id,
            name=display_name,
            kind=tool_kind(name) if isinstance(name, str) else "other",
        )
        self._tools[tool_call_id] = state
        return state

    def _set_terminal(self, event_type: str, data: Mapping[str, object]) -> RunOutcome:
        """记录终态；只认第一个终态事件。"""
        if event_type == "run.completed":
            outcome = RunOutcome(kind="completed")
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


__all__ = [
    "MAX_OUTPUT_CHARS",
    "RunOutcome",
    "RunTranslator",
    "TranslateResult",
    "Update",
    "acp_tool_call_id",
]
