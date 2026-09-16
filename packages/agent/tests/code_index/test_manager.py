"""只读 CodeIndexManager：absent/unavailable，不创建索引目录。"""

from __future__ import annotations

from pathlib import Path
import asyncio

import pytest

from harness_agent.code_index.manager import CodeIndexManager, CodeIndexManagerError
from harness_agent.code_index.models import CodeIndexBuildResult, CodeIndexPreflight, error_for
from harness_agent.code_index.runtime import FakeCodeIndexRuntime
from harness_agent.code_index.state_store import CodeIndexStateStore
from harness_agent.code_index.path_policy import CodeIndexPathPolicy
from harness_agent.code_index.models import DurableCodeIndexState


@pytest.mark.asyncio
async def test_snapshot_absent_when_preflight_succeeds(tmp_path: Path) -> None:
    """preflight 成功时返回未建立快照，且不创建目录。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = CodeIndexManager(workspace, FakeCodeIndexRuntime())
    snapshot = manager.snapshot()
    assert manager.snapshot() == snapshot
    assert snapshot["index_status"] == "absent"
    assert snapshot["runtime_status"] == "ready"
    assert snapshot["query_status"] == "stopped"
    assert snapshot["data_directory"] == ".harness-index"
    assert snapshot["engine_version"] == "1.1.6"
    assert snapshot["error"] is None
    assert not (workspace / ".harness-index").exists()
    await manager.close()
    await manager.close()


@pytest.mark.asyncio
async def test_preflight_runs_once_when_manager_is_constructed(tmp_path: Path) -> None:
    """Host 启动构造 Manager 时完成一次 preflight，重复 status 不反复探测包。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FakeCodeIndexRuntime()
    manager = CodeIndexManager(workspace, runtime)
    assert runtime.preflight_calls == 1
    manager.snapshot()
    manager.snapshot()
    assert runtime.preflight_calls == 1
    await manager.close()


@pytest.mark.asyncio
async def test_snapshot_unavailable_when_preflight_fails(tmp_path: Path) -> None:
    """运行时缺失时返回可恢复 unavailable，仍不建目录。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FakeCodeIndexRuntime(
        CodeIndexPreflight(ok=False, error=error_for("CODE_INDEX_RUNTIME_UNAVAILABLE"))
    )
    manager = CodeIndexManager(workspace, runtime)
    snapshot = manager.snapshot()
    assert snapshot["runtime_status"] == "unavailable"
    assert snapshot["index_status"] == "absent"
    assert snapshot["query_status"] == "stopped"
    assert snapshot["error"]["code"] == "CODE_INDEX_RUNTIME_UNAVAILABLE"
    assert "CodeGraph" not in snapshot["error"]["message"]
    assert str(workspace) not in snapshot["error"]["message"]
    assert not (workspace / ".harness-index").exists()
    await manager.close()


class _ControlledRuntime(FakeCodeIndexRuntime):
    def __init__(self, result: CodeIndexBuildResult | None = None) -> None:
        super().__init__()
        self.result = result or CodeIndexBuildResult(
            success=True,
            stats={"files": 2, "symbols": 7, "relationships": 3, "db_bytes": 100, "wal_bytes": 0},
        )
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.operations: list[str] = []

    async def run_index(
        self,
        workspace: Path,
        *,
        operation: str = "initialize",
        on_progress,
        timeout: float = 1800.0,
    ) -> CodeIndexBuildResult:
        self.operations.append(operation)
        self.started.set()
        await on_progress({"phase": "indexing", "completed": 1, "total": 2})
        await self.release.wait()
        return self.result


async def _wait_for(predicate, *, attempts: int = 50) -> None:
    for _ in range(attempts):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition not reached")


@pytest.mark.asyncio
async def test_ensure_returns_running_then_persists_ready_and_notifies(tmp_path: Path) -> None:
    """首建请求快速返回，后台进度和终态 revision 单调且写入 marker。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = _ControlledRuntime()
    notifications: list[dict[str, object]] = []
    manager = CodeIndexManager(workspace, runtime, on_changed=notifications.append)

    accepted = await manager.apply({"action": "ensure", "expected_revision": 0})
    assert accepted["job"]["status"] == "running"
    assert accepted["job"]["action"] == "initialize"
    assert accepted["revision"] == 1
    assert (workspace / ".harness-index" / "state.json").is_file()
    await runtime.started.wait()
    await _wait_for(lambda: manager.snapshot()["job"].get("completed") == 1)
    assert manager.snapshot()["revision"] > accepted["revision"]

    runtime.release.set()
    await _wait_for(lambda: manager.snapshot()["query_status"] == "ready")
    final = manager.snapshot()
    assert final["index_status"] == "ready"
    assert final["generation"] == 1
    assert final["job"]["status"] == "succeeded"
    assert final["query_status"] == "ready"
    assert final["watcher_status"] == "ready"
    assert final["stats"]["symbols"] == 7
    assert [item["revision"] for item in notifications] == sorted(item["revision"] for item in notifications)
    assert notifications[-1] == final
    await manager.close()


@pytest.mark.asyncio
async def test_ensure_rejects_stale_revision_and_parallel_job(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = _ControlledRuntime()
    manager = CodeIndexManager(workspace, runtime)
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_REVISION_CONFLICT"):
        await manager.apply({"action": "ensure", "expected_revision": 9})
    await manager.apply({"action": "ensure", "expected_revision": 0})
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_JOB_ACTIVE"):
        await manager.apply({"action": "ensure", "expected_revision": 1})
    runtime.release.set()
    await _wait_for(lambda: manager.snapshot()["job"]["status"] == "succeeded")
    await manager.close()


@pytest.mark.asyncio
async def test_background_failure_converges_to_incomplete_terminal(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = _ControlledRuntime(
        CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_INCOMPLETE"))
    )
    notifications: list[dict[str, object]] = []
    manager = CodeIndexManager(workspace, runtime, on_changed=notifications.append)
    await manager.apply({"action": "ensure", "expected_revision": 0})
    runtime.release.set()
    await _wait_for(lambda: manager.snapshot()["job"]["status"] == "failed")
    final = manager.snapshot()
    assert final["index_status"] == "incomplete"
    assert final["query_status"] == "stopped"
    assert final["error"]["code"] == "CODE_INDEX_INCOMPLETE"
    assert notifications[-1] == final
    await manager.close()


async def _ready_manager(workspace: Path) -> tuple[CodeIndexManager, _ControlledRuntime]:
    runtime = _ControlledRuntime()
    manager = CodeIndexManager(workspace, runtime)
    await manager.apply({"action": "ensure", "expected_revision": 0})
    runtime.release.set()
    await _wait_for(lambda: manager.snapshot()["query_status"] == "ready")
    runtime.started = asyncio.Event()
    runtime.release = asyncio.Event()
    return manager, runtime


@pytest.mark.asyncio
async def test_ready_ensure_runs_incremental_sync_and_switches_generation(tmp_path: Path) -> None:
    """健康索引上的 ensure 停止旧查询、执行 sync，并只向后切 generation。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager, runtime = await _ready_manager(workspace)
    revision = manager.snapshot()["revision"]

    accepted = await manager.apply({"action": "ensure", "expected_revision": revision})
    assert accepted["job"]["action"] == "sync"
    assert await manager.acquire_query() is None
    await runtime.started.wait()
    assert runtime.operations == ["initialize", "sync"]
    assert runtime.stop_query_calls >= 1

    runtime.release.set()
    await _wait_for(lambda: manager.snapshot()["query_status"] == "ready")
    assert manager.snapshot()["generation"] == 2
    await manager.close()


@pytest.mark.asyncio
async def test_rebuild_rejects_active_lease_then_reconnects_new_generation(tmp_path: Path) -> None:
    """活动 Run 不被重建中断；租约释放后 rebuild 才能关闭旧查询。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager, runtime = await _ready_manager(workspace)
    lease = await manager.acquire_query()
    assert lease is not None
    revision = manager.snapshot()["revision"]
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_RUN_ACTIVE"):
        await manager.apply({"action": "rebuild", "expected_revision": revision})

    await lease.release()
    accepted = await manager.apply({"action": "rebuild", "expected_revision": revision})
    assert accepted["job"]["action"] == "rebuild"
    await runtime.started.wait()
    assert runtime.operations == ["initialize", "rebuild"]
    runtime.release.set()
    await _wait_for(lambda: manager.snapshot()["query_status"] == "ready")
    assert manager.snapshot()["generation"] == 2
    await manager.close()


@pytest.mark.asyncio
async def test_cancel_requires_current_job_and_persists_cancelled(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = _ControlledRuntime()
    manager = CodeIndexManager(workspace, runtime)
    accepted = await manager.apply({"action": "ensure", "expected_revision": 0})
    await runtime.started.wait()
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_JOB_NOT_FOUND"):
        await manager.apply({
            "action": "cancel",
            "expected_revision": manager.snapshot()["revision"],
            "job_id": "stale-job",
        })

    cancelled = await manager.apply({
        "action": "cancel",
        "expected_revision": manager.snapshot()["revision"],
        "job_id": accepted["job"]["id"],
    })
    assert cancelled["job"]["status"] == "cancelled"
    assert cancelled["index_status"] == "incomplete"
    assert cancelled["query_status"] == "stopped"
    stored = CodeIndexStateStore(CodeIndexPathPolicy(workspace)).load()
    assert stored is not None and stored.lifecycle == "cancelled"
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_JOB_NOT_FOUND"):
        await manager.apply({
            "action": "cancel",
            "expected_revision": cancelled["revision"],
            "job_id": accepted["job"]["id"],
        })
    await manager.close()


@pytest.mark.asyncio
async def test_close_during_job_never_leaves_running_marker(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = _ControlledRuntime()
    manager = CodeIndexManager(workspace, runtime)
    await manager.apply({"action": "ensure", "expected_revision": 0})
    await runtime.started.wait()
    await manager.close()
    stored = CodeIndexStateStore(CodeIndexPathPolicy(workspace)).load()
    assert stored is not None and stored.lifecycle == "incomplete"


@pytest.mark.parametrize("lifecycle", ["running", "serving"])
def test_unclean_restart_marks_transient_lifecycle_incomplete(tmp_path: Path, lifecycle: str) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.write(DurableCodeIndexState(revision=8, generation=2, lifecycle=lifecycle))
    manager = CodeIndexManager(workspace, FakeCodeIndexRuntime())
    snapshot = manager.snapshot()
    assert snapshot["revision"] == 8
    assert snapshot["index_status"] == "incomplete"
    assert snapshot["query_status"] == "stopped"


@pytest.mark.asyncio
async def test_rebuild_on_unsafe_directory_returns_stable_manager_error(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    store = CodeIndexStateStore(CodeIndexPathPolicy(workspace))
    store.write(DurableCodeIndexState(revision=3, generation=1, lifecycle="ready"))
    (workspace / ".harness-index" / ".gitignore").write_text("not-owned\n", encoding="utf-8")
    manager = CodeIndexManager(workspace, FakeCodeIndexRuntime())
    assert manager.snapshot()["error"]["code"] == "CODE_INDEX_PATH_UNSAFE"
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_PATH_UNSAFE"):
        await manager.apply({"action": "rebuild", "expected_revision": 0})
    await manager.close()


@pytest.mark.asyncio
async def test_remove_requires_confirmation_and_rejects_active_lease(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager, _runtime = await _ready_manager(workspace)
    revision = manager.snapshot()["revision"]
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_INCOMPLETE"):
        await manager.apply({"action": "remove", "expected_revision": revision})
    lease = await manager.acquire_query()
    assert lease is not None
    with pytest.raises(CodeIndexManagerError, match="CODE_INDEX_RUN_ACTIVE"):
        await manager.apply({"action": "remove", "expected_revision": revision, "confirmed": True})
    await lease.release()
    await manager.close()


@pytest.mark.asyncio
async def test_confirmed_remove_deletes_only_managed_index(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".harness").mkdir()
    (workspace / ".harness" / "keep").write_text("user", encoding="utf-8")
    manager, runtime = await _ready_manager(workspace)
    revision = manager.snapshot()["revision"]
    accepted = await manager.apply({"action": "remove", "expected_revision": revision, "confirmed": True})
    assert accepted["job"]["action"] == "remove"
    await _wait_for(lambda: manager.snapshot()["index_status"] == "absent")
    assert not (workspace / ".harness-index").exists()
    assert (workspace / ".harness" / "keep").is_file()
    assert runtime.stop_query_calls >= 1
    await manager.close()


@pytest.mark.asyncio
async def test_remove_interruption_persists_incomplete_instead_of_absent(tmp_path: Path) -> None:
    """删除失败保留可观察 marker，不能在重启后谎报不存在。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager, _runtime = await _ready_manager(workspace)
    revision = manager.snapshot()["revision"]

    def fail_remove() -> None:
        raise CodeIndexStateError("CODE_INDEX_INCOMPLETE")

    manager._store.remove = fail_remove  # type: ignore[method-assign]
    await manager.apply({"action": "remove", "expected_revision": revision, "confirmed": True})
    await _wait_for(lambda: manager.snapshot()["job"]["status"] == "failed")
    assert manager.snapshot()["index_status"] == "incomplete"
    stored = CodeIndexStateStore(CodeIndexPathPolicy(workspace)).load()
    assert stored is not None and stored.lifecycle == "incomplete"
    await manager.close()


@pytest.mark.asyncio
async def test_clean_close_persists_ready_and_reopen_restores_query(tmp_path: Path) -> None:
    """干净关闭区分于 serving 崩溃；下次启动自动恢复同一 generation。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager, _runtime = await _ready_manager(workspace)
    generation = manager.snapshot()["generation"]

    await manager.close()
    stored = CodeIndexStateStore(CodeIndexPathPolicy(workspace)).load()
    assert stored is not None and stored.lifecycle == "ready"

    restored_runtime = FakeCodeIndexRuntime()
    restored = CodeIndexManager(workspace, restored_runtime)
    assert restored.snapshot()["query_status"] == "stopped"
    await restored.start()
    assert restored.snapshot()["index_status"] == "ready"
    assert restored.snapshot()["query_status"] == "ready"
    assert restored.snapshot()["generation"] == generation
    assert restored_runtime.start_query_calls == 1
    assert await restored.acquire_query() is not None
    await restored.close()


@pytest.mark.asyncio
async def test_degraded_watcher_keeps_query_ready_but_marks_index_stale(tmp_path: Path) -> None:
    """watcher 降级不伪装自动同步，查询仍可用并由界面提示手工更新。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FakeCodeIndexRuntime(watcher_status="degraded")
    manager = CodeIndexManager(workspace, runtime)
    await manager.apply({"action": "ensure", "expected_revision": 0})
    await _wait_for(lambda: manager.snapshot()["query_status"] == "ready")
    assert manager.snapshot()["watcher_status"] == "degraded"
    assert await manager.acquire_query() is not None
    await manager.close()
