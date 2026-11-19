"""代码索引查询租约进入 Run profile，并在终态释放。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from harness_agent.code_index.manager import CodeIndexManager
from harness_agent.code_index.runtime import FakeCodeIndexRuntime
from harness_agent.host.run_coordinator import RunPreparation
from harness_agent.runtime.builtin_agents import EXPLORE_TOOL_ALLOWLIST, resolve_builtin_child_view
from harness_agent.policy.capability_policy import EffectiveCapabilityView


async def _ready_manager(tmp_path: Path) -> CodeIndexManager:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = CodeIndexManager(workspace, FakeCodeIndexRuntime())
    await manager.apply({"action": "ensure", "expected_revision": 0})
    import asyncio

    for _ in range(50):
        if manager.snapshot()["query_status"] == "ready":
            return manager
        await asyncio.sleep(0)
    raise AssertionError("query did not become ready")


@pytest.mark.asyncio
async def test_healthy_index_run_gets_lease_job_run_does_not(tmp_path: Path) -> None:
    manager = await _ready_manager(tmp_path)
    lease = await manager.acquire_query()
    assert lease is not None
    assert "UNIQUE_MARK" in await lease.explore("UNIQUE_MARK", 2)

    busy = tmp_path / "busy"
    busy.mkdir()
    held = asyncio.Event()

    class _HeldRuntime(FakeCodeIndexRuntime):
        async def run_index(self, workspace: Path, *, on_progress, timeout: float = 1800.0):
            await held.wait()
            return await super().run_index(workspace, on_progress=on_progress, timeout=timeout)

    job_manager = CodeIndexManager(busy, _HeldRuntime())
    await job_manager.apply({"action": "ensure", "expected_revision": 0})
    assert await job_manager.acquire_query() is None
    held.set()
    await lease.release()
    await manager.close()
    await job_manager.close()


@pytest.mark.asyncio
async def test_release_snapshot_reservation_also_releases_code_index_lease() -> None:
    released = []

    class _Lease:
        async def release(self) -> None:
            released.append("lease")

    class _Reservation:
        async def release(self) -> None:
            released.append("snapshot")

    preparation = RunPreparation(
        skill_snapshot_id=None,
        snapshot_reservation=_Reservation(),
        code_index_lease=_Lease(),
    )
    from harness_agent.host.run_coordinator import RunCoordinator

    await RunCoordinator._release_snapshot_reservation(preparation)
    assert released == ["snapshot", "lease"]
    await RunCoordinator._release_snapshot_reservation(preparation)
    assert released == ["snapshot", "lease", "snapshot", "lease"]


def test_explore_allowlist_includes_codebase_explore_but_plugin_view_does_not() -> None:
    assert "codebase_explore" in EXPLORE_TOOL_ALLOWLIST
    parent = EffectiveCapabilityView(
        tool_names=("ls", "read_file", "glob", "grep", "lsp", "codebase_explore", "write_file"),
        mcp_tool_names=(),
        skill_ids=(),
        filesystem_read=None,
        filesystem_write=None,
        shell_commands=None,
        policy_fingerprint="a" * 64,
    )
    explore = resolve_builtin_child_view(
        agent_id="explore",
        parent=parent,
        available_tool_names=frozenset(parent.tool_names),
    )
    assert "codebase_explore" in explore.tool_names
    assert "write_file" not in explore.tool_names
    plugin_names = set(parent.tool_names) - {"codebase_explore"}
    assert "codebase_explore" not in plugin_names
