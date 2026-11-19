"""2.8：open_thread 投影把 tool 记录的 tool_call_id/arguments/status 带上。"""

from __future__ import annotations

from pathlib import Path

from harness_agent.threads.thread_persistence import _replay_messages
from harness_agent.threads.thread_records import TranscriptRecord


def _rec(kind: str, payload: dict, seq: int = 0):
    return TranscriptRecord(
        record_id=f"r{seq}", thread_id="t", run_id="run", execution_id=None,
        sequence=seq, kind=kind, payload=payload,
        content_sha256="", byte_length=0, artifact_id=None,
        created_at_ms=0,
    )


def test_tool_message_gets_id_args_status() -> None:
    """assistant 的 tool_calls 参数按 tool_call_id 补到随后的 tool 记录上。"""
    records = (
        _rec("assistant", {"content": "", "tool_calls": [{"id": "c1", "name": "execute", "args": {"command": "ls"}}]}, 1),
        _rec("tool", {"content": "out", "tool_call_id": "c1", "name": "execute", "status": "success"}, 2),
    )
    (msg,) = [m for m in _replay_messages(records) if m.kind == "tool"]
    assert msg.tool_call_id == "c1"
    assert msg.tool_arguments == {"command": "ls"}
    assert msg.tool_status == "success"


def test_tool_message_error_status_survives() -> None:
    records = (
        _rec("tool", {"content": "err", "tool_call_id": "c1", "name": "execute", "status": "error"}, 1),
    )
    (msg,) = [m for m in _replay_messages(records) if m.kind == "tool"]
    assert msg.tool_status == "error"
    assert msg.tool_arguments is None


def test_tool_message_legacy_defaults() -> None:
    """旧数据：tool 记录无 status/无 assistant args → status 默认 success、无参数。"""
    records = (
        _rec("tool", {"content": "out", "tool_call_id": "c1", "name": "execute"}, 1),
    )
    (msg,) = [m for m in _replay_messages(records) if m.kind == "tool"]
    assert msg.tool_status == "success"
    assert msg.tool_arguments is None
    assert msg.tool_call_id == "c1"


def test_tool_message_args_over_limit_dropped() -> None:
    big = "x" * 300_000
    records = (
        _rec("assistant", {"content": "", "tool_calls": [{"id": "c1", "name": "execute", "args": {"big": big}}]}, 1),
        _rec("tool", {"content": "out", "tool_call_id": "c1", "name": "execute"}, 2),
    )
    (msg,) = [m for m in _replay_messages(records) if m.kind == "tool"]
    assert msg.tool_arguments is None
    assert msg.tool_call_id == "c1"


def test_last_assistant_args_wins_for_same_id() -> None:
    records = (
        _rec("assistant", {"content": "", "tool_calls": [{"id": "c1", "name": "t", "args": {"v": 1}}]}, 1),
        _rec("assistant", {"content": "", "tool_calls": [{"id": "c1", "name": "t", "args": {"v": 2}}]}, 2),
        _rec("tool", {"content": "out", "tool_call_id": "c1", "name": "t"}, 3),
    )
    (msg,) = [m for m in _replay_messages(records) if m.kind == "tool"]
    assert msg.tool_arguments == {"v": 2}
