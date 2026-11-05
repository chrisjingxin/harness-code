"""Run 级「(工具名, 参数) → provider tool_call_id」短生命周期缓存的单元测试。"""

from __future__ import annotations

import time

from harness_agent.runtime.approval_tool_calls import MAX_TOOL_CALL_IDS, ToolCallIdStore


class _Unserializable:
    """无法 JSON 编码的参数值；`json.dumps` 会抛 TypeError。"""


def test_remember_and_lookup_roundtrip() -> None:
    """登记后能按同一工具名与参数查回 provider id。"""
    store = ToolCallIdStore()
    assert store.remember("execute", {"command": "npm test"}, "call-1") is True
    assert store.lookup("execute", {"command": "npm test"}) == "call-1"


def test_args_key_order_does_not_matter() -> None:
    """参数键顺序不影响指纹，与审批展示缓存的口径一致。"""
    store = ToolCallIdStore()
    assert store.remember("write_file", {"file_path": "/a.py", "content": "x"}, "call-2")
    assert store.lookup("write_file", {"content": "x", "file_path": "/a.py"}) == "call-2"


def test_different_args_or_tool_do_not_hit() -> None:
    """参数不同或工具名不同都不能命中，避免把审批挂到别的卡片上。"""
    store = ToolCallIdStore()
    assert store.remember("execute", {"command": "ls"}, "call-3")
    assert store.lookup("execute", {"command": "ls -la"}) is None
    assert store.lookup("web_fetch", {"command": "ls"}) is None


def test_unserializable_args_are_rejected() -> None:
    """参数无法稳定编码时登记失败（返回 False），查询也安全返回 None。"""
    store = ToolCallIdStore()
    args = {"command": _Unserializable()}
    assert store.remember("execute", args, "call-4") is False
    assert store.lookup("execute", args) is None


def test_empty_name_or_id_is_rejected() -> None:
    """空工具名或空 id 不登记。"""
    store = ToolCallIdStore()
    assert store.remember("", {"a": 1}, "call-5") is False
    assert store.remember("execute", {"a": 1}, "") is False
    assert store.lookup("execute", {"a": 1}) is None


def test_lru_evicts_oldest_beyond_capacity() -> None:
    """超过容量时淘汰最久未使用的条目，容量本身是默认值。"""
    store = ToolCallIdStore(max_entries=2)
    assert store.remember("execute", {"n": 1}, "call-1")
    assert store.remember("execute", {"n": 2}, "call-2")
    assert store.lookup("execute", {"n": 1}) == "call-1"  # 变成最新
    assert store.remember("execute", {"n": 3}, "call-3")
    assert store.lookup("execute", {"n": 2}) is None
    assert store.lookup("execute", {"n": 1}) == "call-1"
    assert store.lookup("execute", {"n": 3}) == "call-3"
    assert MAX_TOOL_CALL_IDS == 256


def test_same_fingerprint_keeps_latest_id() -> None:
    """同一指纹再次登记覆盖旧值：跨轮次同参数调用拿到的是最新 id。"""
    store = ToolCallIdStore()
    assert store.remember("execute", {"command": "ls"}, "call-old")
    assert store.remember("execute", {"command": "ls"}, "call-new")
    assert store.lookup("execute", {"command": "ls"}) == "call-new"


def test_clear_releases_everything() -> None:
    """Run 收敛时清空，之后查不到任何条目。"""
    store = ToolCallIdStore()
    assert store.remember("execute", {"command": "ls"}, "call-6")
    store.clear()
    assert store.lookup("execute", {"command": "ls"}) is None


def test_no_expiry_over_time(monkeypatch) -> None:
    """审批没有超时：时间大幅前进后仍能查到。

    回归护栏：如果有人给缓存加了 TTL，同一批第 2、3 个审批会拿不到 id。
    """
    store = ToolCallIdStore()
    assert store.remember("execute", {"command": "ls"}, "call-7")
    monkeypatch.setattr(time, "monotonic", lambda: time.monotonic() + 3600)
    assert store.lookup("execute", {"command": "ls"}) == "call-7"


def test_invalid_capacity_is_rejected() -> None:
    """非法容量直接报错，而不是静默创建一个「什么都存不下」的缓存。"""
    try:
        ToolCallIdStore(max_entries=0)
    except ValueError as exc:
        assert "TOOL_CALL_ID" in str(exc)
    else:  # pragma: no cover - 明确失败更直观
        raise AssertionError("max_entries=0 should be rejected")
