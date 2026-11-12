"""统一 Trace 核心、装饰器与上下文语义测试。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from harness_agent.tracing import (
    FunctionCall,
    TraceRecorder,
    TraceStatus,
    current_trace,
    func_monitor,
    trace_monitor,
    use_trace,
)


def _events(root: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for path in root.glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


def _named(events: list[dict[str, object]], name: str) -> list[dict[str, object]]:
    return [event for event in events if event.get("name") == name]


def test_trace_and_func_share_envelope_parent_and_safe_attributes(tmp_path: Path) -> None:
    @trace_monitor(session_id="thread-1", run_id="run-1", log_dir=tmp_path)
    @func_monitor(
        name="policy.evaluate",
        kind="POLICY",
        attributes=lambda call: {"decision": call.result, "prompt": "不得落盘"},
    )
    def evaluate() -> str:
        return "allow"

    assert evaluate() == "allow"

    events = _events(tmp_path)
    assert [event["event"] for event in events] == [
        "trace.start",
        "span.start",
        "span.end",
        "trace.end",
    ]
    trace_start, span_start, span_end, trace_end = events
    assert trace_start["kind"] == trace_end["kind"] == "ROOT"
    assert trace_start["parent_span_id"] is None
    assert span_start["kind"] == span_end["kind"] == "POLICY"
    assert span_start["parent_span_id"] == trace_start["span_id"]
    assert span_end["parent_span_id"] == trace_start["span_id"]
    assert span_end["start_time_ms"] == span_start["start_time_ms"]
    assert span_end["end_time_ms"] >= span_end["start_time_ms"]
    assert span_end["attributes"] == {"decision": "allow"}
    assert "prompt" not in json.dumps(events, ensure_ascii=False)
    assert len({event["trace_id"] for event in events}) == 1
    assert {event["schema_version"] for event in events} == {2}
    assert {event["session_id"] for event in events} == {"thread-1"}
    assert {event["run_id"] for event in events} == {"run-1"}
    assert span_end["status"] == "SUCCESS"
    assert span_end["duration_ms"] >= 0
    assert trace_end["status"] == "SUCCESS"
    assert current_trace() is None


def test_nested_func_spans_keep_parent_on_start_and_end(tmp_path: Path) -> None:
    @func_monitor(name="custom.child")
    def child() -> None:
        return None

    @trace_monitor(session_id="thread-tree", run_id="run-tree", log_dir=tmp_path)
    @func_monitor(name="custom.parent")
    def parent() -> None:
        child()

    parent()
    events = _events(tmp_path)
    parent_start = next(
        event for event in _named(events, "custom.parent") if event["event"] == "span.start"
    )
    child_events = _named(events, "custom.child")
    assert len(child_events) == 2
    assert all(event["parent_span_id"] == parent_start["span_id"] for event in child_events)


@pytest.mark.parametrize("kind", ["FUNC", "DB", "POLICY", "CONTEXT", "INTERACTION"])
def test_func_monitor_supports_standard_kinds_and_preserves_metadata(
    tmp_path: Path, kind: str
) -> None:
    @trace_monitor(session_id="thread-kind", run_id=kind, log_dir=tmp_path)
    @func_monitor(name=f"custom.{kind.lower()}", kind=kind)
    def observed(value: int) -> int:
        """业务 docstring。"""
        return value + 1

    assert observed(1) == 2
    assert observed.__name__ == "observed"
    assert observed.__doc__ == "业务 docstring。"
    events = _named(_events(tmp_path), f"custom.{kind.lower()}")
    assert {event["kind"] for event in events} == {kind}


async def test_async_function_exception_propagates_and_closes_trace(tmp_path: Path) -> None:
    error = RuntimeError("业务失败")

    @trace_monitor(session_id="thread-async", run_id="run-async", log_dir=tmp_path)
    @func_monitor(name="custom.async")
    async def fail() -> None:
        raise error

    with pytest.raises(RuntimeError) as caught:
        await fail()

    assert caught.value is error
    events = _events(tmp_path)
    assert events[-1]["event"] == "trace.end"
    assert events[-1]["status"] == "FAILED"
    span_end = next(event for event in events if event["event"] == "span.end")
    assert span_end["status"] == "FAILED"
    assert span_end["error_type"] == "RuntimeError"
    assert current_trace() is None


def test_sync_generator_close_ends_trace_exactly_once(tmp_path: Path) -> None:
    @trace_monitor(session_id="thread-generator", run_id="run-generator", log_dir=tmp_path)
    def values():
        yield 1
        yield 2

    generator = values()
    assert next(generator) == 1
    generator.close()
    generator.close()

    events = _events(tmp_path)
    assert [event["event"] for event in events] == ["trace.start", "trace.end"]
    assert events[-1]["status"] == "SUCCESS"
    assert current_trace() is None


async def test_async_generator_close_ends_trace_exactly_once(tmp_path: Path) -> None:
    @trace_monitor(session_id="thread-agenerator", run_id="run-agenerator", log_dir=tmp_path)
    async def values():
        yield 1
        yield 2

    generator = values()
    assert await generator.__anext__() == 1
    await generator.aclose()
    await generator.aclose()

    events = _events(tmp_path)
    assert [event["event"] for event in events] == ["trace.start", "trace.end"]
    assert events[-1]["status"] == "SUCCESS"
    assert current_trace() is None


def test_nested_trace_reuses_active_trace(tmp_path: Path) -> None:
    @trace_monitor(session_id="thread-nested", run_id="inner", log_dir=tmp_path)
    def inner() -> str:
        return current_trace().trace_id

    @trace_monitor(session_id="thread-nested", run_id="outer", log_dir=tmp_path)
    def outer() -> str:
        return inner()

    outer_id = outer()
    events = _events(tmp_path)
    starts = [event for event in events if event["event"] == "trace.start"]
    assert len(starts) == 1
    assert starts[0]["run_id"] == "outer"
    assert starts[0]["trace_id"] == outer_id


async def test_manual_trace_stays_open_for_background_task(tmp_path: Path) -> None:
    contexts = []

    @trace_monitor(
        session_id="thread-manual", run_id="run-manual", log_dir=tmp_path, manual=True
    )
    async def prepare() -> None:
        contexts.append(current_trace())

    @func_monitor(name="custom.background")
    async def background() -> str:
        return "done"

    await prepare()
    context = contexts[0]
    assert context is not None
    assert [event["event"] for event in _events(tmp_path)] == ["trace.start"]

    result = await asyncio.create_task(background())
    assert result == "done"
    assert current_trace() is context

    context.recorder.end_trace(TraceStatus.SUCCESS)
    context.recorder.end_trace(TraceStatus.FAILED)
    events = _events(tmp_path)
    assert [event["event"] for event in events].count("trace.end") == 1
    assert events[-1]["status"] == "SUCCESS"
    assert current_trace() is None


async def test_explicit_trace_context_crosses_async_task_boundary(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="thread-explicit", run_id="run-explicit", log_dir=tmp_path)
    context = recorder.start_trace()

    @func_monitor(name="custom.explicit")
    async def observed() -> None:
        return None

    with use_trace(context):
        await asyncio.create_task(observed())
    recorder.end_trace()

    events = _events(tmp_path)
    span_start = next(event for event in events if event["event"] == "span.start")
    assert span_start["trace_id"] == context.trace_id
    assert span_start["parent_span_id"] == context.root_span_id


def test_func_without_trace_is_passthrough_and_does_not_evaluate_attributes() -> None:
    evaluated = False

    def attributes(_call: FunctionCall) -> dict[str, object]:
        nonlocal evaluated
        evaluated = True
        return {"outcome": "unexpected"}

    @func_monitor(name="custom.disabled", attributes=attributes)
    def observed() -> str:
        return "plain"

    assert observed() == "plain"
    assert evaluated is False


def test_attribute_provider_failure_does_not_change_business_result(tmp_path: Path) -> None:
    def broken_provider(_call: FunctionCall) -> dict[str, object]:
        raise ValueError("埋点字段失败")

    @trace_monitor(session_id="thread-provider", run_id="run-provider", log_dir=tmp_path)
    @func_monitor(name="custom.provider", attributes=broken_provider)
    def observed() -> str:
        return "business"

    assert observed() == "business"
    events = _events(tmp_path)
    span_end = next(event for event in events if event["event"] == "span.end")
    assert span_end["status"] == "SUCCESS"
    assert events[-1]["event"] == "trace.end"


def test_idempotency_key_suppresses_duplicate_span_but_not_independent_calls(
    tmp_path: Path,
) -> None:
    recorder = TraceRecorder(session_id="thread-idem", run_id="run-idem", log_dir=tmp_path)
    context = recorder.start_trace()
    with use_trace(context):
        @func_monitor(name="custom.idem", idempotency_key="stable-key")
        def duplicate(value: str) -> str:
            return value

        @func_monitor(name="custom.independent")
        def independent(value: str) -> str:
            return value

        assert duplicate("first") == "first"
        assert duplicate("second") == "second"
        assert independent("first") == "first"
        assert independent("second") == "second"
    recorder.end_trace()

    events = _events(tmp_path)
    assert len(_named(events, "custom.idem")) == 2
    assert len(_named(events, "custom.independent")) == 4
    duplicate_start = next(event for event in _named(events, "custom.idem") if event["event"] == "span.start")
    assert duplicate_start["idempotency_key"] == "stable-key"


def test_nested_duplicate_decorators_emit_only_one_span(tmp_path: Path) -> None:
    """同一业务函数被重复装饰时，相同幂等键只保留最外层 Span。"""
    def business(value: str) -> str:
        return value

    observed = func_monitor(name="custom.nested", idempotency_key="nested-key")(
        func_monitor(name="custom.nested", idempotency_key="nested-key")(business)
    )
    recorder = TraceRecorder(session_id="thread-nested-idem", run_id="run-nested-idem", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        assert observed("result") == "result"
    recorder.end_trace()

    events = _named(_events(tmp_path), "custom.nested")
    assert [event["event"] for event in events] == ["span.start", "span.end"]
    assert events[0]["span_id"] == events[1]["span_id"]


def test_direct_span_end_is_idempotent_and_rejects_writes_after_trace_end(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="thread-span", run_id="run-span", log_dir=tmp_path)
    recorder.start_trace()
    span = recorder.start_span("custom.manual", kind="FUNC")
    assert span is not None
    recorder.end_span(span)
    recorder.end_span(span)
    recorder.end_trace()
    assert recorder.start_span("custom.late") is None

    events = _events(tmp_path)
    assert [event["event"] for event in events].count("span.end") == 1
    assert _named(events, "custom.late") == []
