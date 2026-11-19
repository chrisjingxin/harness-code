"""Run 终态与持久化、压缩的采集字段契约。"""

import json
from types import SimpleNamespace

from langchain_core.messages import HumanMessage

from harness_agent.tracing import TraceRecorder, FunctionCall


def test_compaction_decision_records_actual_tier_and_threshold(tmp_path):
    from harness_agent.threads.context_compaction import _trace_compaction_decision
    from harness_agent.threads.context_pressure import ContextPressurePolicyConfig
    from harness_agent.tracing import use_trace
    from harness_agent.tracing.context import _bind_span, _reset_span

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        span = recorder.start_span("context.compact")
        token = _bind_span(span)
        _trace_compaction_decision("micro", ContextPressurePolicyConfig())
        _reset_span(token)
        recorder.end_span(span)
        recorder.end_trace()
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    attrs = next(row["attributes"] for row in rows if row.get("name") == "context.compact" and row["event"] == "span.end")
    assert attrs["tier"] == "micro"
    assert attrs["threshold"] == 0.6


def test_committed_summary_capture_failure_is_isolated(tmp_path, monkeypatch):
    from harness_agent.threads.context_compaction import _trace_compaction_commit
    from harness_agent.tracing import use_trace
    from harness_agent.tracing.context import _bind_span, _reset_span

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    def fail(*args):
        raise OSError("trace unavailable")
    with use_trace(recorder.start_trace()):
        span = recorder.start_span("context.compact")
        token = _bind_span(span)
        monkeypatch.setattr(recorder, "payload", fail)
        _trace_compaction_commit(SimpleNamespace(artifacts=[]), SimpleNamespace(content="summary"))
        _reset_span(token)
        recorder.end_span(span)
        recorder.end_trace()


def test_summary_model_belongs_to_compaction_without_opening_step(tmp_path):
    from harness_agent.tracing import use_trace
    from harness_agent.tracing.context import _bind_span, _reset_span
    from harness_agent.tracing.model import TraceModelMiddleware

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        compact = recorder.start_span("context.compact")
        token = _bind_span(compact)
        try:
            TraceModelMiddleware().wrap_model_call(
                SimpleNamespace(messages=[], tools=[], model=None),
                lambda _: SimpleNamespace(result=[]),
            )
        finally:
            _reset_span(token)
        recorder.end_span(compact)
        recorder.end_trace()
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    assert not any(row.get("name") == "step" for row in rows)
    llm = next(row for row in rows if row.get("name") == "llm.call")
    assert llm["parent_span_id"] == compact.span_id


def test_run_terminal_has_no_bookkeeping_span(tmp_path):
    from harness_agent.host.run_coordinator import RunCoordinator

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    run = SimpleNamespace(
        trace_context=recorder.start_trace(), status="completed", run_id="r",
        completion=SimpleNamespace(
            duration_ms=5,
            usage={"input_tokens": 10, "cached_tokens": 4, "input_complete": True},
            error=None,
        ),
    )
    RunCoordinator._complete_trace(None, run)
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in rows] == ["trace.start", "trace.end"]
    assert rows[-1]["attributes"]["status"] == "completed"
    assert "duration" not in rows[-1]["attributes"]


def test_failed_root_keeps_terminal_error_information(tmp_path):
    from harness_agent.host.run_coordinator import RunCoordinator

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    run = SimpleNamespace(
        trace_context=recorder.start_trace(), status="failed", run_id="r",
        completion=SimpleNamespace(
            duration_ms=5, usage={},
            error={"code": "MODEL_UNAVAILABLE", "message": "unavailable"},
        ),
    )
    RunCoordinator._complete_trace(None, run)
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    assert rows[-1]["status"] == "FAILED"
    assert "MODEL_UNAVAILABLE" in json.dumps(rows[-1])


def test_persist_metadata_describes_records_without_content():
    from harness_agent.threads.thread_persistence import _persist_attributes, TranscriptRecord

    record = TranscriptRecord("id", "thread", "run", None, 7, "assistant",
                              {"content": "private body"}, "hash", 12, None, 0)
    attrs = _persist_attributes("transcript_batch")(
        FunctionCall(function=lambda: None, args=(None, ()), kwargs={}, result=(record,)))
    assert attrs["rows"] == 1
    assert attrs["seq_from"] == attrs["seq_to"] == 7
    assert attrs["bytes"] == 12
    assert attrs["record_ids"] == ["id"]
    assert attrs["thread_id"] == "thread"
    assert attrs["run_id"] == "run"
    assert "private body" not in json.dumps(attrs)


def test_compaction_metadata_keeps_trigger_counts_and_skipped_reason():
    from harness_agent.threads.context_compaction import (
        _compaction_attributes, CompressionRequest, CompressionResult,
    )
    from harness_agent.threads.context_projection import ModelProjection

    messages = (HumanMessage(content="hello"),)
    request = CompressionRequest("thread", "manual", ModelProjection(messages, None, 0, 1),
                                 estimated_tokens=10)
    result = CompressionResult("skipped", "manual", "manual_skipped", messages, 10, 100,
                               reason="too_small")
    attrs = _compaction_attributes(FunctionCall(
        function=lambda: None, args=(SimpleNamespace(_window=128), request), kwargs={}, result=result))
    assert attrs["trigger"] == "manual"
    assert attrs["outcome"] == "skipped"
    assert attrs["tokens_before"] == attrs["tokens_after"] == 10
    assert attrs["messages_before"] == attrs["messages_after"] == 1
    assert attrs["skip_reason"] == "too_small"


def test_preparation_projection_is_timing_only_and_execution_has_one_node(tmp_path):
    import pytest
    from harness_agent.tracing import use_trace
    from harness_agent.tracing.context import _bind_span, _reset_span
    from harness_agent.threads.context_projection import ContextProjector, ModelProjection

    projector = ContextProjector(SimpleNamespace())
    async def project(_thread_id, **kwargs):
        return ModelProjection((HumanMessage(content="hello"),), None, 0, 1)
    projector._project_unchecked = project
    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        prepare = recorder.start_span("run.prepare")
        token = _bind_span(prepare)
        with pytest.raises(StopIteration):
            projector.project("t").send(None)
        _reset_span(token)
        recorder.end_span(prepare)
        with pytest.raises(StopIteration):
            projector.project("t").send(None)
        recorder.end_trace()
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    projected = [row for row in rows if row.get("name") == "context.project" and row["event"] == "span.end"]
    assert len(projected) == 1
    assert projected[0]["parent_span_id"] == recorder.root_span_id
    assert projected[0]["attributes"]["source_seq"] == 1
    prepared = next(row for row in rows if row.get("name") == "run.prepare" and row["event"] == "span.end")
    assert prepared["attributes"]["projection_ms"] >= 0


def test_database_capture_observes_actual_lock_and_written_rows(tmp_path):
    import pytest
    from harness_agent.tracing import use_trace
    from harness_agent.tracing.context import _bind_span, _reset_span
    from harness_agent.tracing.persistence import observe_transaction

    class Lock:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False

    connection = SimpleNamespace(total_changes=2)
    async def transaction():
        async with observe_transaction(Lock(), connection):
            connection.total_changes += 3

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        span = recorder.start_span("db.persist")
        token = _bind_span(span)
        with pytest.raises(StopIteration):
            transaction().send(None)
        _reset_span(token)
        recorder.end_span(span)
        recorder.end_trace()
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    attrs = next(row["attributes"] for row in rows if row.get("name") == "db.persist" and row["event"] == "span.end")
    assert attrs["rows"] == 3
    assert attrs["lock_wait_ms"] >= 0


def test_model_capture_failure_does_not_prevent_business_call(tmp_path, monkeypatch):
    from harness_agent.tracing import use_trace
    from harness_agent.tracing.model import TraceModelMiddleware

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    response = SimpleNamespace(result=[])
    calls = []
    def broken_payload(*args):
        raise ValueError("capture failed")
    def handler(request):
        calls.append(request)
        return response
    request = SimpleNamespace(messages=[HumanMessage(content="input")], model=None, tools=[])
    with use_trace(recorder.start_trace()):
        monkeypatch.setattr(recorder, "payload", broken_payload)
        assert TraceModelMiddleware().wrap_model_call(request, handler) is response
        recorder.end_trace()
    assert calls == [request]


def test_preparation_span_stays_open_until_acceptance(tmp_path):
    from harness_agent.tracing import use_trace, func_monitor
    from harness_agent.tracing.context import current_span

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    @func_monitor(name="run.prepare", idempotency_key="run.prepare:r", manual=True)
    def prepare():
        return "prepared"
    with use_trace(recorder.start_trace()):
        assert prepare() == "prepared"
        assert current_span() is None
        span = recorder.span_for_key("run.prepare:r")
        assert span is not None
        recorder.end_span(span, attributes={"outcome": "accepted", "mode": "build"})
        assert recorder.span_for_key("run.prepare:r") is None
        recorder.end_trace()
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    spans = [row for row in rows if row.get("name") == "run.prepare"]
    assert [row["event"] for row in spans] == ["span.start", "span.end"]
    assert spans[-1]["attributes"]["outcome"] == "accepted"
