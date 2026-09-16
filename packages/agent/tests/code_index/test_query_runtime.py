"""私有查询进程与用户 MCP catalog 隔离。"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness_agent.code_index.manager import CodeIndexManager
from harness_agent.code_index.runtime import FakeCodeIndexRuntime
from harness_agent.extensions.mcp import McpConnectionManager, build_mcp_snapshot


@pytest.mark.asyncio
async def test_query_lease_ready_generation_and_idempotent_release(tmp_path: Path) -> None:
    """ready 才能租约，release 幂等，旧 generation 查询被拒绝。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FakeCodeIndexRuntime()
    manager = CodeIndexManager(workspace, runtime)
    assert await manager.acquire_query() is None
    accepted = await manager.apply({"action": "ensure", "expected_revision": 0})
    assert accepted["job"]["status"] == "running"
    for _ in range(50):
        if manager.snapshot()["query_status"] == "ready":
            break
        await __import__("asyncio").sleep(0)
    snapshot = manager.snapshot()
    assert snapshot["index_status"] == "ready"
    assert snapshot["query_status"] == "ready"
    assert snapshot["watcher_status"] == "ready"
    assert runtime.query_started is True
    lease = await manager.acquire_query()
    assert lease is not None
    assert lease.generation == snapshot["generation"]
    text = await lease.explore("UNIQUE_MARK", 4)
    assert "UNIQUE_MARK" in text
    await lease.release()
    await lease.release()
    stale = await manager.acquire_query()
    assert stale is not None
    stale.generation = 0
    assert "过期" in await stale.explore("UNIQUE_MARK", 4)
    await stale.release()
    await manager.close()


@pytest.mark.asyncio
async def test_start_query_failure_converges_to_incomplete(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FakeCodeIndexRuntime(start_query_error=RuntimeError("boom"))
    manager = CodeIndexManager(workspace, runtime)
    await manager.apply({"action": "ensure", "expected_revision": 0})
    for _ in range(50):
        if manager.snapshot()["index_status"] == "incomplete":
            break
        await __import__("asyncio").sleep(0)
    assert manager.snapshot()["query_status"] == "failed"
    assert await manager.acquire_query() is None
    await manager.close()


@pytest.mark.asyncio
async def test_private_query_session_is_not_in_user_mcp_snapshot() -> None:
    """私有查询 runtime 不进入用户 MCP catalog。"""
    manager = McpConnectionManager(build_mcp_snapshot([], revision="test"))
    names = [server.name for server in manager.snapshot.servers]
    assert names == []
    assert "codegraph" not in str(manager.snapshot.servers).lower()



