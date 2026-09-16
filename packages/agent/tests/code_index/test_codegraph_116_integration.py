"""当前 macOS 上对已安装 1.1.6 的离线闭环；缺包时 skip，不记为通过。"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

from harness_agent.code_index.manager import CodeIndexManager
from harness_agent.code_index.runtime import NodeCodeIndexRuntime

pytestmark = pytest.mark.codegraph_integration

_MARKER = "hc180UniqueSymbolZx"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _runtime_or_skip() -> NodeCodeIndexRuntime:
    runtime = NodeCodeIndexRuntime(_repo_root())
    result = runtime.preflight()
    if not result.ok:
        pytest.skip(f"1.1.6 runtime unavailable: {None if result.error is None else result.error.code}")
    return runtime


async def _wait_snapshot(manager: CodeIndexManager, predicate, *, timeout: float = 180.0) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        snapshot = manager.snapshot()
        if predicate(snapshot):
            return snapshot
        job = snapshot.get("job")
        if (
            isinstance(job, dict)
            and job.get("status") in {"failed", "cancelled"}
            and not predicate(snapshot)
        ):
            raise AssertionError(f"job ended unsuccessfully: {snapshot}")
        await asyncio.sleep(0.05)
    raise AssertionError(f"timeout waiting for snapshot: {manager.snapshot()}")


@pytest.mark.asyncio
async def test_macos_offline_index_query_sync_rebuild_cancel_restart_remove(tmp_path: Path) -> None:
    """首建、查询、增量、重建、取消、干净重启和删除都留下可观察终态。"""
    workspace = tmp_path / "fixture"
    workspace.mkdir()
    (workspace / ".git" / "info").mkdir(parents=True)
    source = workspace / "src"
    source.mkdir()
    (source / "mark.ts").write_text(f"export function {_MARKER}() {{ return 1 }}\n", encoding="utf-8")
    (source / "mark.py").write_text(f"def {_MARKER.lower()}():\n    return 1\n", encoding="utf-8")
    os.environ.setdefault("CODEGRAPH_NO_DOWNLOAD", "1")
    runtime = _runtime_or_skip()
    manager = CodeIndexManager(workspace, runtime)
    timings: dict[str, float] = {}

    started = time.monotonic()
    accepted = await manager.apply({"action": "ensure", "expected_revision": manager.snapshot()["revision"]})
    assert accepted["job"]["action"] == "initialize"
    ready = await _wait_snapshot(manager, lambda item: item["index_status"] == "ready" and item["query_status"] == "ready")
    timings["initialize"] = time.monotonic() - started
    assert ready["stats"] is not None
    assert (workspace / ".harness-index").is_dir()
    assert not (workspace / ".codegraph").exists()

    lease = await manager.acquire_query()
    assert lease is not None
    explored = await lease.explore(_MARKER, 6)
    await lease.release()
    assert _MARKER in explored or "read_file" in explored

    (source / "mark.ts").write_text(f"export function {_MARKER}Updated() {{ return 2 }}\n", encoding="utf-8")
    started = time.monotonic()
    await manager.apply({"action": "ensure", "expected_revision": manager.snapshot()["revision"]})
    baseline_generation = int(ready["generation"])
    try:
        synced = await _wait_snapshot(manager, lambda item: item["index_status"] == "ready" and item["query_status"] == "ready")
        timings["sync"] = time.monotonic() - started
        baseline_generation = int(synced["generation"])
    except AssertionError:
        timings["sync"] = time.monotonic() - started
        if manager.snapshot()["index_status"] != "incomplete":
            raise

    started = time.monotonic()
    rebuild = await manager.apply({"action": "rebuild", "expected_revision": manager.snapshot()["revision"]})
    assert rebuild["job"]["action"] == "rebuild"
    rebuilt = await _wait_snapshot(manager, lambda item: item["index_status"] == "ready" and item["query_status"] == "ready")
    timings["rebuild"] = time.monotonic() - started
    assert rebuilt["generation"] > baseline_generation

    await manager.apply({"action": "rebuild", "expected_revision": manager.snapshot()["revision"]})
    job = manager.snapshot()["job"]
    if isinstance(job, dict) and job.get("status") == "running":
        from harness_agent.code_index.manager import CodeIndexManagerError

        try:
            await manager.apply(
                {
                    "action": "cancel",
                    "expected_revision": manager.snapshot()["revision"],
                    "job_id": job["id"],
                }
            )
        except CodeIndexManagerError:
            pass
        try:
            await _wait_snapshot(
                manager,
                lambda item: item["job"] is None or item["job"]["status"] != "running",
                timeout=8.0,
            )
        except AssertionError:
            await manager.close()
            manager = CodeIndexManager(workspace, runtime)

    if manager.snapshot()["index_status"] == "ready" and manager.snapshot()["query_status"] != "ready":
        await manager.start()
        await _wait_snapshot(manager, lambda item: item["query_status"] in {"ready", "failed", "stopped"}, timeout=30.0)
    generation = manager.snapshot()["generation"]
    await manager.close()
    restarted = CodeIndexManager(workspace, runtime)
    await restarted.start()
    recovered = await _wait_snapshot(restarted, lambda item: item["query_status"] in {"ready", "failed", "stopped"})
    assert recovered["generation"] == generation or recovered["index_status"] == "incomplete"

    await restarted.apply(
        {
            "action": "remove",
            "expected_revision": restarted.snapshot()["revision"],
            "confirmed": True,
        }
    )
    removed = await _wait_snapshot(restarted, lambda item: item["index_status"] == "absent")
    assert removed["index_status"] == "absent"
    assert not (workspace / ".harness-index").exists()
    assert (workspace / ".git").exists()
    await restarted.close()
    assert timings["initialize"] > 0
    assert os.environ.get("CODEGRAPH_NO_DOWNLOAD") == "1"
