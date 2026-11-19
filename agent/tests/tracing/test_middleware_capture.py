"""只保留慢或失败的中间件节点，不把整个图当成中间件。"""

import json
import uuid

import pytest

from harness_agent.tracing import TraceRecorder, use_trace
import harness_agent.tracing.recorder as recorder_module


@pytest.mark.parametrize("duration,error,expected", [(49, None, False), (50, None, True), (1, ValueError("failed"), True)])
def test_middleware_threshold_and_failure(tmp_path, monkeypatch, duration, error, expected):
    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    callback_id = uuid.uuid4()
    with use_trace(recorder.start_trace()):
        with pytest.raises(StopIteration):
            recorder.on_chain_start({"name": "Guard.before_model"}, {}, run_id=callback_id).send(None)
        monkeypatch.setattr(recorder_module, "_elapsed_ms", lambda _: duration)
        callback = recorder.on_chain_end({}, run_id=callback_id) if error is None else recorder.on_chain_error(error, run_id=callback_id)
        with pytest.raises(StopIteration):
            callback.send(None)
        recorder.end_trace()
    rows = [json.loads(line) for path in tmp_path.glob("*.jsonl")
            for line in path.read_text(encoding="utf-8").splitlines()]
    spans = [row for row in rows if row.get("name") == "graph.node"]
    assert bool(spans) is expected
    if expected:
        assert [row["event"] for row in spans] == ["span.start", "span.end"]
        assert spans[-1]["duration_ms"] == duration
        assert spans[-1]["status"] == ("SUCCESS" if error is None else "FAILED")
