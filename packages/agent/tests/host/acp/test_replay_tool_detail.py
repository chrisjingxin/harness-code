"""2.9：回放 tool 记录带 tool_call_id/arguments/status 的真实细节。"""

from __future__ import annotations

from pathlib import Path

from harness_agent.host.acp.sessions import replay_updates
from tests.support.acp_harness import primary_path_resolver
from harness_agent.host.acp.tool_display import PathLocator


def _locator(tmp: Path) -> PathLocator:
    return PathLocator(primary_path_resolver(tmp))


def _msgs(tool: dict) -> list[dict]:
    return [{"kind": "tool", "content": "out", "tool_name": "read_file", **tool}]


def _tool_call(updates) -> dict:
    for u in updates:
        d = u.model_dump(mode="json", by_alias=True, exclude_none=True)
        if d.get("sessionUpdate") == "tool_call":
            return d
    raise AssertionError("no tool_call")


def test_replay_tool_carries_args_kind_locations(tmp_path: Path) -> None:
    """带参数 → rawInput/标题含参数/kind=read/locations 绝对路径。"""
    updates = list(replay_updates("s1", _msgs({
        "tool_call_id": "c1",
        "arguments": {"file_path": "/a.txt"},
        "status": "completed",
    }), _locator(tmp_path)))
    tc = _tool_call(updates)
    assert tc["rawInput"] == {"file_path": "/a.txt"}
    assert tc["kind"] == "read"
    assert tc["status"] == "completed"
    assert tc["locations"] == [{"path": str(tmp_path / "a.txt")}]
    assert tc["toolCallId"] == "s1:h0"


def test_replay_tool_failed_status(tmp_path: Path) -> None:
    updates = list(replay_updates("s1", _msgs({
        "tool_call_id": "c1", "status": "failed",
    }), _locator(tmp_path)))
    assert _tool_call(updates)["status"] == "failed"
    # 缺省（旧数据）→ completed
    updates = list(replay_updates("s1", _msgs({"tool_call_id": "c1"}), _locator(tmp_path)))
    assert _tool_call(updates)["status"] == "completed"


def test_replay_tool_legacy_no_args(tmp_path: Path) -> None:
    """旧数据无 arguments → 无 rawInput、标题退回纯工具名。"""
    updates = list(replay_updates("s1", _msgs({"tool_call_id": "c1"}), _locator(tmp_path)))
    tc = _tool_call(updates)
    assert "rawInput" not in tc
    assert tc["title"] == "read_file"


def test_replay_is_deterministic(tmp_path: Path) -> None:
    """同一份历史两次回放：id 与内容逐字一致。"""
    msgs = _msgs({"tool_call_id": "c1", "arguments": {"file_path": "/a.txt"}, "status": "failed"})
    first = [u.model_dump(mode="json", by_alias=True) for u in replay_updates("s1", msgs, _locator(tmp_path))]
    second = [u.model_dump(mode="json", by_alias=True) for u in replay_updates("s1", msgs, _locator(tmp_path))]
    assert first == second
