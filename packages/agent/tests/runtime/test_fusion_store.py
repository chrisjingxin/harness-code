"""真实 SQLite 下的 Fusion 状态、并发写者和恢复。"""

from __future__ import annotations

import asyncio

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
        task.task_id,
        task.version,
        {"revision": 1, "allowed_paths": ["./"]},
        "dispatch",
        "message",
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


async def test_workspace_blocker_shows_only_owner_and_stop_facts(persistence):
    store = persistence.fusion_state_store()
    owner = await create(persistence, "owner-thread")
    waiting = await create(persistence, "waiting-thread")
    lease = await store.acquire_lease(owner.task_id, "sidekick")
    effect = await store.begin_effect(
        owner.task_id, lease.generation, "worker", "execute", "private-command-digest"
    )
    blocker = await store.workspace_blocker(waiting.task_id)
    assert blocker == {
        "task_id": owner.task_id,
        "thread_id": owner.thread_id,
        "phase": "READY",
        "round": 0,
        "reason": None,
        "requires_inspection": True,
        "kind": "paths",
        "paths": ["./"],
    }
    assert "source_message" not in blocker and "profile" not in blocker
    with pytest.raises(ValueError, match="FUSION_OUTCOME_UNKNOWN"):
        await store.cancel(owner.task_id, owner.version)
    assert await store.workspace_blocker(waiting.task_id) == blocker
    await store.finish_effect(effect, succeeded=True, stopped=True)
    assert (await store.workspace_blocker(waiting.task_id))[
        "requires_inspection"
    ] is False
    await store.cancel(owner.task_id, owner.version)
    assert await store.workspace_blocker(waiting.task_id) is None


async def test_cancelling_waiter_never_releases_other_task_writer(persistence):
    store = persistence.fusion_state_store()
    owner = await create(persistence, "owner-thread")
    waiting = await create(persistence, "waiting-thread")
    lease = await store.acquire_lease(owner.task_id, "sidekick")
    waiting = await store.update(
        waiting.task_id,
        waiting.version,
        phase="WAITING_USER",
        data={
            "reason": "workspace_busy",
            "workspace_blocker": await store.workspace_blocker(waiting.task_id),
        },
    )
    cancelled = await store.cancel(waiting.task_id, waiting.version)
    assert (
        cancelled.phase == "CANCELLED"
        and cancelled.to_record()["workspace_blocker"] is None
    )
    assert (
        await store.acquire_lease(owner.task_id, "sidekick")
    ).generation == lease.generation


@pytest.mark.parametrize("foreign", [False, True])
async def test_workspace_owner_without_current_task_respects_project_boundary(
    persistence, foreign
):
    from harness_agent.runtime.fusion.store import FusionStateStore

    store = persistence.fusion_state_store()
    task = await create(persistence)
    lease = await store.acquire_lease(task.task_id, "sidekick")
    await store.begin_effect(
        task.task_id, lease.generation, "old-worker", "execute", "digest"
    )
    task = await store.pause(task.task_id)
    query = FusionStateStore(
        store.connection,
        project_fingerprint="other" if foreign else store.project,
        lock=store.lock,
        database_path=store.database_path,
    )
    workspace = persistence.database_path.parent.parent / "workspace"
    result = await query.workspace_owner(workspace)
    assert result is not None
    assert (result["reason"] == "owner_unavailable") is foreign
    assert result["requires_inspection"] is True
    assert result["task_id"] == (None if foreign else task.task_id)
    assert result["thread_id"] == (None if foreign else task.thread_id)
    assert await store.get(task.task_id) == task
