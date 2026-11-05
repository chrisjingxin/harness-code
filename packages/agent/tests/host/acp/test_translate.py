"""v3 事件 → ACP `session/update` 的翻译规则。

【为什么用纯字典事件】
翻译器是纯状态机：输入是 `AgentEvent.record()` 形状的字典，输出是 ACP update 列表。
不启动 Host、不用模型，就能逐条验证设计里的规则表，包括「半截参数不外泄」
「终态补发未结束工具」这类容易写错的边界。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from acp.schema import ToolCallProgress, ToolCallStart

from harness_agent.host.acp.tool_display import PathLocator
from harness_agent.host.acp.translate import (
    _MAX_RAW_INPUT_BYTES,
    RunOutcome,
    RunTranslator,
    acp_tool_call_id,
)


def _event(kind: str, payload: dict[str, Any] | None = None, **overrides: Any) -> dict[str, Any]:
    """构造一条根执行（无父级）的 v3 事件记录。"""
    record: dict[str, Any] = {
        "event_id": "e1",
        "type": kind,
        "thread_id": "t1",
        "run_id": "r1",
        "sequence": 1,
        "timestamp_ms": 0,
        "execution_id": "root-r1",
        "agent_id": "main",
        "payload": payload or {},
    }
    record.update(overrides)
    return record


def _translator(tmp_path: Path) -> RunTranslator:
    """默认翻译器：工作区是一个临时目录。"""
    return RunTranslator("r1", PathLocator(tmp_path))


def _feed_ok(translator: RunTranslator, event: dict[str, Any]) -> list[Any]:
    """喂一条事件并断言它不产生终态。"""
    result = translator.feed(event)
    assert result.outcome is None
    return result.updates


def test_tool_call_id_is_prefixed_by_run(tmp_path: Path) -> None:
    """provider 的 tool id 只在单次 Run 内唯一，ACP 要求会话内唯一，所以加前缀。"""
    assert acp_tool_call_id("r1", "call_0") == "r1:call_0"


def test_content_delta_becomes_agent_message_chunk(tmp_path: Path) -> None:
    """正文增量 → `agent_message_chunk`，带 `{run}:m0` 形式的 messageId。"""
    translator = _translator(tmp_path)
    [update] = _feed_ok(translator, _event("content.delta", {"text": "你好"}))
    assert update.session_update == "agent_message_chunk"
    assert update.content.text == "你好"
    assert update.message_id == "r1:m0"


def test_reasoning_delta_becomes_agent_thought_chunk(tmp_path: Path) -> None:
    """思考增量 → `agent_thought_chunk`，前缀是 `t`，与正文分属不同消息。"""
    translator = _translator(tmp_path)
    [update] = _feed_ok(translator, _event("reasoning.delta", {"text": "想一想"}))
    assert update.session_update == "agent_thought_chunk"
    assert update.content.text == "想一想"
    assert update.message_id == "r1:t0"


def test_empty_delta_is_dropped(tmp_path: Path) -> None:
    """空文本不产生 update，避免客户端画出空气泡。"""
    translator = _translator(tmp_path)
    assert _feed_ok(translator, _event("content.delta", {"text": ""})) == []


def test_tool_started_announces_pending_card(tmp_path: Path) -> None:
    """`tool.started` → `tool_call`，状态 pending，标题是工具名，类别来自映射表。"""
    translator = _translator(tmp_path)
    [update] = _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    assert isinstance(update, ToolCallStart)
    assert update.tool_call_id == "r1:call_0"
    assert update.status == "pending"
    assert update.kind == "edit"
    assert update.title == "edit_file"


def test_message_id_segment_increments_after_tool_started(tmp_path: Path) -> None:
    """每次工具开始序号加一，工具之后的正文章节换 messageId。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("content.delta", {"text": "第一段"}))
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "read_file"}))
    [update] = _feed_ok(translator, _event("content.delta", {"text": "第二段"}))
    assert update.message_id == "r1:m1"


def test_duplicate_tool_started_is_ignored(tmp_path: Path) -> None:
    """同一 id 的 `tool.started` 只公告一次，重复到达不再发卡片。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "read_file"}))
    assert _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "read_file"})) == []


def test_arguments_delta_is_buffered_not_published(tmp_path: Path) -> None:
    """半截 JSON 绝不外泄：参数增量只进缓冲，不产生 update。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    assert _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"file_path":'})) == []
    assert _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '"/src/a.py"}'})) == []


def test_truncated_arguments_are_never_parsed(tmp_path: Path) -> None:
    """解析时标记了 truncated 的参数永远不发 rawInput（内容已经不完整）。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    _feed_ok(
        translator,
        _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"file_path":', "truncated": True}),
    )
    _feed_ok(
        translator,
        _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '"/src/a.py"}'}),
    )
    [progress] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "ok", "is_error": False}}),
    )
    assert progress.raw_input is None
    assert progress.title == "edit_file"


def test_oversize_arguments_are_never_parsed(tmp_path: Path) -> None:
    """参数累计超过上限后不再解析、也不发 rawInput，避免撑爆帧。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    chunk = json.dumps({"command": "x" * (1024 * 1024)})
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": chunk}))
    [progress] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "ok", "is_error": False}}),
    )
    assert progress.raw_input is None


def test_output_delta_publishes_cumulative_text(tmp_path: Path) -> None:
    """工具输出增量按「累计值」推送：ACP 的 content 是替换语义。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    [first] = _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "output_delta": "第一行\n"}))
    assert isinstance(first, ToolCallProgress)
    assert first.status == "in_progress"
    assert first.content is not None
    assert first.content[0].content.text == "第一行\n"
    [second] = _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "output_delta": "第二行\n"}))
    assert second.content is not None
    assert second.content[0].content.text == "第一行\n第二行\n"


def test_child_only_tool_delta_produces_nothing(tmp_path: Path) -> None:
    """只有 child_* 字段的 delta（task 工具的子 agent 分派）不产生 update。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "task"}))
    updates = _feed_ok(
        translator,
        _event("tool.delta", {"tool_call_id": "call_0", "child_execution_id": "x", "child_agent_id": "general"}),
    )
    assert updates == []


def test_delta_before_started_is_buffered_then_announced(tmp_path: Path) -> None:
    """先到 delta 后到 started：参数缓冲保留，公告时不丢。"""
    translator = _translator(tmp_path)
    assert _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"file_path":"/src/a.py"}'})) == []
    [update] = _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    assert isinstance(update, ToolCallStart)
    [progress] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "ok", "is_error": False}}),
    )
    assert progress.raw_input == {"file_path": "/src/a.py"}


def test_tool_completed_fills_raw_input_title_and_locations(tmp_path: Path) -> None:
    """参数完整时才在完成事件里补 rawInput、标题与位置。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"file_path":"/src/a.py"}'}))
    [progress] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "wrote", "is_error": False}}),
    )
    assert progress.status == "completed"
    assert progress.raw_input == {"file_path": "/src/a.py"}
    assert progress.title == "edit_file /src/a.py"
    assert progress.locations[0].path == str(tmp_path / "src" / "a.py")
    assert progress.raw_output == "wrote"
    assert progress.content[0].content.text == "wrote"


def test_tool_completed_with_error_marks_failed(tmp_path: Path) -> None:
    """`is_error` 的工具结果映射成 `failed`。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    [progress] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "boom", "is_error": True}}),
    )
    assert progress.status == "failed"


def test_completed_without_started_emits_full_tool_call(tmp_path: Path) -> None:
    """没公告过的工具直接完成时，发一条完整的 `tool_call` 而不是空 update。"""
    translator = _translator(tmp_path)
    [update] = _feed_ok(
        translator,
        _event(
            "tool.completed",
            {
                "tool_call_id": "call_0",
                "result": {"content": "done", "is_error": False},
            },
        ),
    )
    assert isinstance(update, ToolCallStart)
    assert update.status == "completed"
    assert update.title == "tool"


def test_duplicate_completion_is_ignored(tmp_path: Path) -> None:
    """同一工具重复完成只处理第一次。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "read_file"}))
    _feed_ok(translator, _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "a", "is_error": False}}))
    assert _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "b", "is_error": False}}),
    ) == []


def test_child_execution_events_are_dropped_and_counted(tmp_path: Path) -> None:
    """子 agent 的事件全程丢弃并计数：它们的正文不能混进主消息。"""
    translator = _translator(tmp_path)
    child = _event("content.delta", {"text": "子 agent 的话"}, parent_execution_id="root-r1:child")
    assert _feed_ok(translator, child) == []
    assert translator.dropped_child_events == 1


def test_terminal_events_set_outcome_once(tmp_path: Path) -> None:
    """终态事件只认第一个；之后的终态与普通事件都不再产出。"""
    translator = _translator(tmp_path)
    first = translator.feed(_event("run.completed", {"finish_reason": "stop"}))
    assert first.outcome == RunOutcome(kind="completed")
    assert first.updates == []
    second = translator.feed(_event("run.failed", {"error": {"code": "BOOM"}}))
    assert second.outcome is None and second.updates == []


def test_failed_outcome_carries_error_payload(tmp_path: Path) -> None:
    """失败终态把 payload.error 原样带出，供上层拼错误响应。"""
    translator = _translator(tmp_path)
    result = translator.feed(
        _event("run.failed", {"error": {"code": "MODEL_ERROR", "message": "模型炸了", "retryable": True}})
    )
    assert result.outcome is not None
    assert result.outcome.kind == "failed"
    assert result.outcome.error == {"code": "MODEL_ERROR", "message": "模型炸了", "retryable": True}


def test_cancelled_outcome(tmp_path: Path) -> None:
    """取消终态映射成 cancelled。"""
    translator = _translator(tmp_path)
    assert translator.feed(_event("run.cancelled", {})).outcome == RunOutcome(kind="cancelled")


def test_leftovers_mark_unfinished_tools_failed(tmp_path: Path) -> None:
    """终态时把还没结束的工具补发成 failed，否则界面一直转圈。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_1", "name": "read_file"}))
    translator.feed(_event("run.cancelled", {}))
    leftovers = translator.leftovers()
    assert [item.tool_call_id for item in leftovers] == ["r1:call_0", "r1:call_1"]
    assert all(item.status == "failed" for item in leftovers)
    # 幂等：再次调用不再重复补发。
    assert translator.leftovers() == []


def test_leftovers_skip_already_finished_tools(tmp_path: Path) -> None:
    """已完成或已失败的工具不再补发。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "ok", "is_error": False}}),
    )
    translator.feed(_event("run.completed", {}))
    assert translator.leftovers() == []


def test_announce_input_is_idempotent(tmp_path: Path) -> None:
    """`announce_input` 只补一次参数；S2 的审批请求会复用它。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"file_path":"/src/a.py"}'}))
    [progress] = translator.announce_input("call_0")
    assert progress.raw_input == {"file_path": "/src/a.py"}
    assert progress.status == "in_progress"
    assert translator.announce_input("call_0") == []


def test_completed_after_announce_does_not_rewrite_title_to_bare_name(tmp_path: Path) -> None:
    """参数已公告后，`tool.completed` 的更新不能把标题回写成裸工具名（Code Review 发现）。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"command":"npm test"}'}))
    [announced] = translator.announce_input("call_0")
    assert announced.title == "execute npm test"
    [done] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "ok", "is_error": False}}),
    )
    assert done.status == "completed"
    assert done.title is None  # 不传 title，客户端沿用已公告的标题


def test_announce_input_without_complete_arguments_returns_nothing(tmp_path: Path) -> None:
    """参数不完整时 announce 不发任何东西（不发半截 rawInput）。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "edit_file"}))
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": '{"file_path":'}))
    assert translator.announce_input("call_0") == []


def test_known_but_untranslated_events_produce_nothing(tmp_path: Path) -> None:
    """已知但不翻译的事件（run.started 等）既不产 update，也不计入未知类型。"""
    translator = _translator(tmp_path)
    for kind in ("run.started", "run.progress", "skill.loaded", "context.updated", "interaction.resolved"):
        assert _feed_ok(translator, _event(kind, {})) == []
    assert translator.ignored_types == set()


def test_unknown_event_type_is_recorded_once(tmp_path: Path) -> None:
    """未知事件在诊断里每种只记一次，不刷屏。"""
    translator = _translator(tmp_path)
    assert _feed_ok(translator, _event("weird.new", {})) == []
    assert _feed_ok(translator, _event("weird.new", {})) == []
    assert translator.ignored_types == {"weird.new"}


def test_malformed_payload_does_not_raise(tmp_path: Path) -> None:
    """payload 形状不对（字典型事件但没有必需字段）只能降级，不能抛。"""
    translator = _translator(tmp_path)
    assert _feed_ok(translator, _event("tool.delta", {"output_delta": "x"})) == []
    assert _feed_ok(translator, _event("tool.completed", {"result": {}})) == []
    assert _feed_ok(translator, _event("content.delta", {})) == []


def test_events_after_terminal_are_ignored(tmp_path: Path) -> None:
    """终态之后到达的事件一律丢弃（可能是队列里的迟到帧）。"""
    translator = _translator(tmp_path)
    translator.feed(_event("run.completed", {}))
    assert _feed_ok(translator, _event("content.delta", {"text": "迟到"})) == []


def test_output_text_is_capped(tmp_path: Path) -> None:
    """工具输出的累计文本有上限，防止一个工具把帧撑过桥的 8 MiB 限制。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    chunk = "x" * (70 * 1024)
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "output_delta": chunk}))
    [second] = _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "output_delta": chunk}))
    assert len(second.content[0].content.text) <= 64 * 1024


def test_raw_input_serialization_limit(tmp_path: Path) -> None:
    """参数 JSON 序列化后超过 256 KiB 就不发 rawInput。"""
    translator = _translator(tmp_path)
    _feed_ok(translator, _event("tool.started", {"tool_call_id": "call_0", "name": "execute"}))
    big = json.dumps({"command": "x" * (_MAX_RAW_INPUT_BYTES + 1024)})
    _feed_ok(translator, _event("tool.delta", {"tool_call_id": "call_0", "arguments_delta": big}))
    [progress] = _feed_ok(
        translator,
        _event("tool.completed", {"tool_call_id": "call_0", "result": {"content": "ok", "is_error": False}}),
    )
    # 只有 rawInput 被丢弃；标题仍按设计显示截断后的参数。
    assert progress.raw_input is None
    assert progress.title.startswith("execute ")
