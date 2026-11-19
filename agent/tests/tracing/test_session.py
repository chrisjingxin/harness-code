"""schema v2 写入器：去重、脱敏、换文件和采集档位。"""

from __future__ import annotations

import json
import os
from pathlib import Path


def test_payload_unknown_objects_are_marked_without_losing_other_fields(tmp_path: Path) -> None:
    from harness_agent.tracing import TraceRecorder

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    recorder.start_trace()
    recorder.payload("tool_result", {"value": object(), "ok": "retained"})
    recorder.end_trace()
    rows = [json.loads(line) for file in tmp_path.glob("*.jsonl")
            for line in file.read_text(encoding="utf-8").splitlines()]
    body = next(row["body"] for row in rows if row["event"] == "payload")
    assert body == {"value": {"unserializable": "object"}, "ok": "retained"}

from harness_agent.tracing.session import TraceSession


def _events(root: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for path in sorted(root.glob("*.jsonl"))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_full_capture_dedups_payloads_and_redacts_secrets(tmp_path: Path) -> None:
    """相同消息只写一次，密钥字段不保留原值，普通正文保留。"""
    session = TraceSession(session_id="thread", run_id="run", log_dir=tmp_path, capture="full")
    message = {"role": "user", "content": "请读 README", "api_key": "sk-secret"}
    first = session.payload("message", message)
    second = session.payload("message", dict(message))
    session.payload("message", {"authorization": "Bearer abc", "content": "下一条"})
    span = session.span("llm.call", kind="LLM", attributes={"model": "mock", "message_refs": [first]})
    span.end(attributes={"finish_reason": "stop"})
    session.close()

    events = _events(tmp_path)
    payloads = [event for event in events if event["event"] == "payload"]
    assert first == second
    assert len(payloads) == 2
    assert payloads[0]["body"]["content"] == "请读 README"
    assert payloads[0]["body"]["api_key"] == "[redacted]"
    assert payloads[1]["body"]["authorization"] == "[redacted]"
    serialized = json.dumps(events, ensure_ascii=False)
    assert "sk-secret" not in serialized
    assert "Bearer abc" not in serialized
    ended = next(event for event in events if event["event"] == "span.end")
    assert ended["attributes"]["model"] == "mock"
    assert ended["attributes"]["finish_reason"] == "stop"
    assert ended["attributes"]["message_refs"] == [first]
    assert {event["schema_version"] for event in events} == {2}


def test_meta_omits_payloads_and_refs_and_off_writes_nothing(tmp_path: Path) -> None:
    """meta 只留计数和枚举；off 不创建文件。"""
    meta = TraceSession(session_id="meta", run_id="run", log_dir=tmp_path / "meta", capture="meta")
    assert meta.payload("message", {"content": "不落盘"}) == ""
    span = meta.span("llm.call", kind="LLM", attributes={"model": "mock", "message_refs": ["p1"]})
    span.end()
    meta.close()
    events = _events(tmp_path / "meta")
    assert events
    assert not any(event["event"] == "payload" for event in events)
    assert "message_refs" not in json.dumps(events)
    assert "不落盘" not in json.dumps(events, ensure_ascii=False)

    off_dir = tmp_path / "off"
    off = TraceSession(session_id="off", run_id="run", log_dir=off_dir, capture="off")
    off.payload("message", {"content": "不落盘"})
    off.span("llm.call", kind="LLM").end()
    off.close()
    assert list(off_dir.glob("*.jsonl")) == []


def test_writer_rotates_after_max_bytes_and_prunes_expired_files(tmp_path: Path) -> None:
    """超过单文件上限后换文件，trace_id 不变；过期文件在启动时删除。"""
    stale = tmp_path / "Trace-log-20000101-000000-deadbeef.jsonl"
    stale.write_text("{}\n", encoding="utf-8")
    os.utime(stale, (0, 0))

    session = TraceSession(
        session_id="rotate",
        run_id="run",
        log_dir=tmp_path,
        capture="full",
        max_file_bytes=80,
        retention_days=14,
    )
    session.payload("message", {"content": "a" * 40})
    session.payload("message", {"content": "b" * 40})
    session.close()

    files = list(tmp_path.glob("*.jsonl"))
    assert stale not in files
    assert len(files) >= 2
    trace_ids = {event["trace_id"] for event in _events(tmp_path) if "trace_id" in event}
    assert len(trace_ids) == 1
