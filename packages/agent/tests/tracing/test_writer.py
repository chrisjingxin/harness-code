"""Session JSONL writer 的文件安全、并发与故障隔离测试。"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from harness_agent.tracing import TraceRecorder, func_monitor, trace_monitor, use_trace


def _read(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_same_session_appends_runs_with_distinct_trace_ids(tmp_path: Path) -> None:
    for run_id in ("run-1", "run-2"):
        recorder = TraceRecorder(session_id="thread-1", run_id=run_id, log_dir=tmp_path)
        recorder.start_trace(attributes={"模式": "构建"})
        recorder.end_trace()

    paths = list(tmp_path.glob("*.jsonl"))
    assert len(paths) == 1
    assert re.fullmatch(r"Trace-log-\d{8}-\d{6}-[0-9a-f]{8}\.jsonl", paths[0].name)
    events = _read(paths[0])
    assert len(events) == 4
    assert all(event["session_id"] == "thread-1" for event in events)
    assert len({event["trace_id"] for event in events}) == 2
    assert events[0]["attributes"] == {"模式": "构建"}


def test_session_filename_prevents_traversal_and_collision(tmp_path: Path) -> None:
    for session_id in ("../thread", "thread"):
        recorder = TraceRecorder(session_id=session_id, run_id="run", log_dir=tmp_path)
        recorder.start_trace()
        recorder.end_trace()

    paths = list(tmp_path.glob("*.jsonl"))
    assert len(paths) == 2
    assert all(path.parent == tmp_path for path in paths)
    assert all(".." not in path.name and "/" not in path.name for path in paths)


async def test_concurrent_sessions_write_only_to_their_own_file(tmp_path: Path) -> None:
    @func_monitor(name="custom.concurrent")
    async def observed(value: str) -> str:
        await asyncio.sleep(0)
        return value

    async def run(session_id: str) -> None:
        recorder = TraceRecorder(session_id=session_id, run_id=f"run-{session_id}", log_dir=tmp_path)
        context = recorder.start_trace()
        with use_trace(context):
            assert await asyncio.create_task(observed(session_id)) == session_id
        recorder.end_trace()

    await asyncio.gather(run("session-a"), run("session-b"))

    paths = list(tmp_path.glob("*.jsonl"))
    assert len(paths) == 2
    for path in paths:
        events = _read(path)
        assert len({event["session_id"] for event in events}) == 1
        assert len({event["trace_id"] for event in events}) == 1
        assert [event["event"] for event in events].count("span.start") == 1


def test_unserializable_attributes_are_omitted_without_losing_event(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="thread-json", run_id="run-json", log_dir=tmp_path)
    recorder.start_trace(
        attributes={
            "count": 2,
            "nested": {"safe": True, "bad": object()},
            "not_finite": float("nan"),
            "bad": object(),
        }
    )
    recorder.end_trace()

    events = _read(next(tmp_path.glob("*.jsonl")))
    assert events[0]["attributes"] == {"count": 2, "nested": {"safe": True}}


def test_unwritable_log_directory_does_not_break_business_or_stdout(
    tmp_path: Path, capsys
) -> None:
    blocked = tmp_path / "not-a-directory"
    blocked.write_text("file", encoding="utf-8")

    @trace_monitor(session_id="thread-io", run_id="run-io", log_dir=blocked / "log")
    @func_monitor(name="custom.io")
    def observed() -> str:
        return "business"

    assert observed() == "business"
    captured = capsys.readouterr()
    assert captured.out == ""
