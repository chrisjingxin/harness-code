"""真实 SQLite 下的 Fusion 状态、并发写者和恢复。"""

from __future__ import annotations
import asyncio
from pathlib import Path
import pytest
from harness_agent.threads.thread_persistence import ThreadPersistence


@pytest.fixture
async def persistence(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    store = await ThreadPersistence.open(project=project, home=tmp_path / "home")
    yield store
    await store.close()


async def create(persistence, thread="thread"):
    return await persistence.fusion_state_store().create(
        thread_id=thread,
        profile={
            "profile_id": "duo",
            "config_fingerprint": "a" * 64,
            "lead": {"profile_id": "pro"},
            "sidekick": {"profile_id": "fast"},
        },
        workspace=persistence.database_path.parent.parent / "workspace",
        source_message="保持兼容，修改实现。",
    )


async def test_active_task_unique_and_projects_isolated(persistence):
    from harness_agent.runtime.fusion.store import FusionError

    task = await create(persistence)
    assert task.phase == "READY" and task.version == 1
    with pytest.raises(FusionError, match="FUSION_TASK_CONFLICT"):
        await create(persistence)
    assert (
        await persistence.fusion_state_store().active("thread")
    ).task_id == task.task_id
    other = await create(persistence, "other")
    assert other.worker_session_id != task.worker_session_id


async def test_compare_and_swap_has_one_winner(persistence):
    from harness_agent.runtime.fusion.store import FusionError

    task = await create(persistence)
    store = persistence.fusion_state_store()
    results = await asyncio.gather(
        *[
            store.update(task.task_id, task.version, phase="WAITING_USER")
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    assert sum(isinstance(x, FusionError) for x in results) == 1
    assert (await store.get(task.task_id)).version == 2


async def test_workspace_lease_fences_other_tasks_and_stale_generations(persistence):
    from harness_agent.runtime.fusion.store import FusionError

    store = persistence.fusion_state_store()
    first = await create(persistence)
    second = await create(persistence, "other")
    lease = await store.acquire_lease(first.task_id, "sidekick")
    with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
        await store.acquire_lease(second.task_id, "sidekick")
    await store.release_lease(first.task_id, lease.generation)
    newer = await store.acquire_lease(second.task_id, "sidekick")
    assert newer.generation > lease.generation
    with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
        await store.release_lease(first.task_id, lease.generation)


async def test_unknown_effect_retains_lease_until_explicit_recovery(persistence):
    from harness_agent.runtime.fusion.store import FusionError

    store = persistence.fusion_state_store()
    task = await create(persistence)
    lease = await store.acquire_lease(task.task_id, "sidekick")
    effect = await store.begin_effect(
        task.task_id, lease.generation, "exec-1", "execute", "digest"
    )
    task = await store.pause(task.task_id)
    assert task.phase == "OUTCOME_UNKNOWN"
    with pytest.raises(FusionError, match="FUSION_OUTCOME_UNKNOWN"):
        await store.cancel(task.task_id, task.version)
    with pytest.raises(FusionError, match="FUSION_OUTCOME_UNKNOWN"):
        await store.recover(task.task_id, task.version, "已检查", False)
    task = await store.recover(
        task.task_id, task.version, "已手动确认进程停止和文件状态", True
    )
    assert task.phase == "PAUSED"
    assert (await store.effects(task.task_id))[0]["operation_id"] == effect
    task = await store.cancel(task.task_id, task.version)
    assert task.phase == "CANCELLED" and not task.active


async def test_reopen_preserves_task_and_effect_records(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    home = tmp_path / "home"
    first = await ThreadPersistence.open(project=project, home=home)
    task = await create(first)
    lease = await first.fusion_state_store().acquire_lease(task.task_id, "sidekick")
    await first.fusion_state_store().begin_effect(
        task.task_id, lease.generation, "exec", "write_file", "hash"
    )
    await first.close()
    second = await ThreadPersistence.open(project=project, home=home)
    try:
        restored = await second.fusion_state_store().reconcile(task.task_id)
        assert restored.phase == "OUTCOME_UNKNOWN"
        assert restored.worker_session_id == task.worker_session_id
        assert len(await second.fusion_state_store().effects(task.task_id)) == 1
    finally:
        await second.close()


async def test_start_round_is_atomic_and_busy_workspace_leaves_no_dispatch(persistence):
    from harness_agent.runtime.fusion.store import FusionError

    store = persistence.fusion_state_store()
    first = await create(persistence)
    second = await create(persistence, "other")
    order = {"revision": 1, "allowed_paths": ["src/"]}
    started, lease = await store.start_round(
        first.task_id, first.version, order, "dispatch-one", "message"
    )
    assert started.phase == "WORKER_RUNNING" and lease.owner == "sidekick"
    with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
        await store.start_round(
            second.task_id, second.version, order, "dispatch-two", "message"
        )
    assert (await store.get(second.task_id)).phase == "READY"
    async with store.lock:
        for table in ("fusion_orders", "fusion_outbox", "fusion_messages"):
            cursor = await store.connection.execute(
                f"SELECT count(*) FROM {table} WHERE task_id=?", (second.task_id,)
            )
            assert (await cursor.fetchone())[0] == 0
    with pytest.raises(FusionError, match="FUSION_TASK_CONFLICT"):
        await store.start_round(
            first.task_id, first.version, order, "dispatch-three", "message"
        )


async def test_dispatched_worker_without_tool_effect_is_unknown_after_restart(
    persistence,
):
    store = persistence.fusion_state_store()
    task = await create(persistence)
    task, lease = await store.start_round(
        task.task_id, task.version, {"revision": 1}, "dispatch", "message"
    )
    await store.mark_delivery("dispatch", "dispatched")
    task = await store.reconcile(task.task_id)
    assert task.phase == "OUTCOME_UNKNOWN"
    task = await store.recover(task.task_id, task.version, "已确认原进程退出", True)
    assert task.phase == "PAUSED"
    assert (await store.reconcile(task.task_id)).phase == "PAUSED"


async def test_pause_keeps_finished_review_receipt_and_latest_status(persistence):
    store = persistence.fusion_state_store()
    task = await create(persistence)
    task = await store.update(
        task.task_id, task.version, phase="REVIEWING", data={"ticket_id": "ticket"}
    )
    task = await store.pause(task.task_id)
    assert task.data["ticket_id"] == "ticket" and task.phase == "PAUSED"
    task = await store.cancel(task.task_id, task.version)
    assert (await store.latest(task.thread_id)).task_id == task.task_id
    assert await store.active(task.thread_id) is None


async def test_schema_rejects_same_name_index_with_wrong_unique_columns(persistence):
    """同名索引不能替代同一 Thread 只留一个活动任务的约束。"""
    from harness_agent.runtime.fusion.store import FusionError

    store = persistence.fusion_state_store()
    async with store.lock:
        await store.connection.execute("DROP INDEX fusion_one_active_thread")
        await store.connection.execute(
            "CREATE INDEX fusion_one_active_thread ON fusion_tasks(task_id) WHERE active=1"
        )
        await store.connection.commit()
    with pytest.raises(FusionError, match="FUSION_SCHEMA_INVALID"):
        await store.ensure_schema()
