"""同一目录按文件并行，跨连接排队和取消；不调用真实模型。"""

from __future__ import annotations

import asyncio

import pytest

from harness_agent.runtime.fusion.snapshot import capture_snapshot, normalize_paths
from harness_agent.runtime.fusion.store import FusionError
from harness_agent.threads.thread_persistence import ThreadPersistence


@pytest.fixture
async def shared(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    p = await ThreadPersistence.open(project=root, home=tmp_path / "home")
    q = await ThreadPersistence.open(project=root, home=tmp_path / "home")
    store, other = p.fusion_state_store(), q.fusion_state_store()

    async def task(thread, source=store):
        return await source.create(
            thread_id=thread, profile={}, workspace=root, source_message="修改文件"
        )

    yield root, store, other, task
    await q.close()
    await p.close()


async def test_different_files_hold_reservations_at_the_same_time(shared):
    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    first = await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    second = await other.acquire_lease(b.task_id, "sidekick", paths=["b.py"])
    assert first.task_id != second.task_id
    assert await store.workspace_blocker(a.task_id) is None
    assert await other.workspace_blocker(b.task_id) is None
    await store.release_lease(a.task_id, first.generation)
    await other.release_lease(b.task_id, second.generation)


@pytest.mark.parametrize(
    "left,right",
    [("a.py", "a.py"), ("src/", "src/a.py"), ("src/a.py", "src/"), ("./", "a.py")],
)
async def test_overlap_still_rejects_nonwaiting_acquisition(shared, left, right):
    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    await store.acquire_lease(a.task_id, "sidekick", paths=[left])
    with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
        await other.acquire_lease(b.task_id, "sidekick", paths=[right])


async def test_waiter_automatically_continues_after_scope_release(shared):
    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    lease = await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    waiting = asyncio.create_task(
        other.wait_for_lease(b.task_id, "sidekick", paths=["a.py"])
    )
    try:
        for _ in range(100):
            if (await other.get(b.task_id)).phase == "WAITING_RESOURCE":
                break
            await asyncio.sleep(0.01)
        assert not waiting.done()
        status = (await other.get(b.task_id)).to_record()
        assert status["phase"] == "WAITING_RESOURCE"
        assert status["workspace_blocker"]["paths"] == ["a.py"]
        await store.release_lease(a.task_id, lease.generation)
        acquired = await asyncio.wait_for(waiting, 2)
        assert acquired.task_id == b.task_id
    finally:
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)


async def test_cancelled_waiter_does_not_block_later_request(shared):
    root, store, other, make = shared
    a, b, c = await make("a"), await make("b", other), await make("c")
    lease = await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    waiting = asyncio.create_task(
        other.wait_for_lease(b.task_id, "sidekick", paths=["a.py"])
    )
    await asyncio.sleep(0.06)
    waiting.cancel()
    await asyncio.gather(waiting, return_exceptions=True)
    await store.release_lease(a.task_id, lease.generation)
    await asyncio.wait_for(
        store.wait_for_lease(c.task_id, "sidekick", paths=["a.py"]), 2
    )


def test_task_snapshot_does_not_include_other_task_files(tmp_path):
    (tmp_path / "a.py").write_text("a")
    (tmp_path / "b.py").write_text("b")
    before = capture_snapshot(tmp_path, ["a.py"])
    (tmp_path / "b.py").write_text("other task changed")
    after = capture_snapshot(tmp_path, ["a.py"])
    assert before["digest"] == after["digest"]
    assert set(after["entries"]) == {"a.py"}


def test_existing_directory_is_normalized_as_directory(tmp_path):
    (tmp_path / "src").mkdir()
    assert normalize_paths(tmp_path, ["src"]) == ("src/",)


async def test_command_does_not_wait_for_other_tasks_idle_file_reservation(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    await other.acquire_lease(b.task_id, "sidekick", paths=["b.py"])
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    async with asyncio.timeout(2):
        async with resources.operation("command", task_id=a.task_id):
            pass


async def test_command_pauses_actual_file_write_and_automatically_releases(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    await other.acquire_lease(b.task_id, "sidekick", paths=["b.py"])
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    entered = asyncio.Event()

    async def write():
        async with resources.operation("file", paths=["b.py"], task_id=b.task_id):
            entered.set()

    async with resources.operation("command", task_id=a.task_id):
        waiting = asyncio.create_task(write())
        await asyncio.sleep(0.08)
        assert not entered.is_set()
    await asyncio.wait_for(waiting, 2)
    assert entered.is_set()


async def test_unknown_file_protects_only_its_scope_but_command_waits(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    async with resources.operation(
        "file", paths=["a.py"], task_id=a.task_id
    ) as uncertain:
        uncertain.stopped = False
    async with asyncio.timeout(2):
        async with resources.operation("file", paths=["b.py"], task_id=b.task_id):
            pass
    pending = asyncio.create_task(
        resources.operation("command", task_id=b.task_id).__aenter__()
    )
    await asyncio.sleep(0.08)
    assert not pending.done()
    pending.cancel()
    await asyncio.gather(pending, return_exceptions=True)
    uncertain.stopped = True
    await asyncio.to_thread(resources.finish, uncertain)


async def test_cancelled_command_waiter_leaves_no_access_request(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    async with resources.operation("command", task_id=a.task_id):

        async def queued():
            async with resources.operation("command", task_id=b.task_id):
                pass

        waiting = asyncio.create_task(queued())
        await asyncio.sleep(0.06)
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
    async with asyncio.timeout(2):
        async with resources.operation("command", task_id=b.task_id):
            pass
    async with other.lock:
        cursor = await other.connection.execute("SELECT COUNT(*) FROM fusion_access")
        assert (await cursor.fetchone())[0] == 0


def test_workspace_snapshot_ignores_runtime_cache_but_keeps_explicit_file(tmp_path):
    (tmp_path / "a.py").write_text("a")
    before = capture_snapshot(tmp_path, ["./"])
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    (cache / "a.pyc").write_bytes(b"cache")
    assert capture_snapshot(tmp_path, ["./"])["digest"] == before["digest"]
    assert (
        "__pycache__/a.pyc"
        in capture_snapshot(tmp_path, ["__pycache__/a.pyc"])["entries"]
    )


async def test_cross_expansion_requests_all_paths_without_deadlock(shared):
    root, store, other, make = shared
    a, b = await make("a"), await make("b", other)
    await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    await other.acquire_lease(b.task_id, "sidekick", paths=["b.py"])
    first = asyncio.create_task(
        store.wait_for_lease(a.task_id, "sidekick", paths=["a.py", "b.py"])
    )
    await asyncio.sleep(0.04)
    second = asyncio.create_task(
        other.wait_for_lease(b.task_id, "sidekick", paths=["b.py", "a.py"])
    )
    try:
        lease = await asyncio.wait_for(first, 2)
        assert not second.done()
        await store.release_lease(a.task_id, lease.generation)
        assert (await asyncio.wait_for(second, 2)).task_id == b.task_id
    finally:
        first.cancel()
        second.cancel()
        await asyncio.gather(first, second, return_exceptions=True)


async def test_holder_can_finish_while_ordinary_command_waits_for_its_scope(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    a = await make("a")
    lease = await store.acquire_lease(a.task_id, "sidekick", paths=["a.py"])
    resources = FusionResources(store.database_path, store.project, workspace_key(root))

    async def ordinary():
        async with resources.operation("command"):
            pass

    pending = asyncio.create_task(ordinary())
    try:
        await asyncio.sleep(0.06)
        async with asyncio.timeout(2):
            async with resources.operation("file", paths=["a.py"], task_id=a.task_id):
                pass
            async with resources.operation("command", task_id=a.task_id):
                pass
        assert not pending.done()
        await store.release_lease(a.task_id, lease.generation)
        await asyncio.wait_for(pending, 2)
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


async def test_unknown_ordinary_operation_can_be_released_with_explicit_inspection(
    shared,
):
    import hashlib

    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    async with resources.operation("command") as permit:
        permit.stopped = False
    async with store.lock:
        row = await (
            await store.connection.execute(
                "SELECT sequence FROM fusion_access WHERE request_id=?",
                (permit.request_id,),
            )
        ).fetchone()
    note = "已检查并确认该命令停止"
    await store.release_workspace_operation(permit.request_id, row[0], note)
    async with resources.operation("command"):
        pass
    # 迟到的旧 finally 不得复活已经核查的保护，且不保存核查原文。
    resources.finish(permit)
    async with store.lock:
        record = await (
            await store.connection.execute(
                "SELECT state,inspection_digest FROM fusion_access WHERE request_id=?",
                (permit.request_id,),
            )
        ).fetchone()
    assert (
        record[0] == "inspected"
        and record[1] == hashlib.sha256(note.encode()).hexdigest()
    )


async def test_release_rejects_active_operation_and_wrong_sequence(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, other, make = shared
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    async with resources.operation("command") as permit:
        async with store.lock:
            row = await (
                await store.connection.execute(
                    "SELECT sequence FROM fusion_access WHERE request_id=?",
                    (permit.request_id,),
                )
            ).fetchone()
        with pytest.raises(FusionError):
            await store.release_workspace_operation(permit.request_id, row[0], "已核查")
        permit.stopped = False
    with pytest.raises(FusionError):
        await store.release_workspace_operation(permit.request_id, row[0] + 1, "已核查")
    with pytest.raises(FusionError):
        await store.release_workspace_operation(permit.request_id, row[0], "  ")


async def test_abandoned_host_becomes_inspectable_without_unlocking(shared):
    from harness_agent.runtime.fusion.resources import AccessPermit, FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, _, _ = shared
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    permit = AccessPermit("abandoned-command", "command", ("./",), None)
    assert resources._try_enter(permit, "old-host-execution") is None
    async with store.lock:
        await store.connection.execute(
            "UPDATE fusion_access SET owner_pid=99999999 WHERE request_id=?",
            (permit.request_id,),
        )
        await store.connection.commit()
    # 主进程已不存在只意味着无法取得停止回执，不能推断子命令已停。
    blocker = resources._try_enter(
        AccessPermit("new-write", "file", ("a.py",), None), "new-host"
    )
    assert (
        blocker["requires_inspection"] and blocker["operation_id"] == permit.request_id
    )
    await store.release_workspace_operation(
        permit.request_id, blocker["sequence"], "已检查残留命令和文件，确认停止"
    )
    resources.finish(AccessPermit("new-write", "file", ("a.py",), None))
    async with resources.operation("command"):
        pass


async def test_abandoned_readonly_snapshot_does_not_leave_a_command_blocker(shared):
    from harness_agent.runtime.fusion.resources import AccessPermit, FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, _, _ = shared
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    permit = AccessPermit("old-snapshot", "snapshot", ("./",), None)
    assert resources._try_enter(permit, "snapshot-host") is None
    async with store.lock:
        await store.connection.execute(
            "UPDATE fusion_access SET owner_pid=99999999 WHERE request_id=?",
            (permit.request_id,),
        )
        await store.connection.commit()
    current = AccessPermit("new-file", "file", ("a.py",), None)
    assert resources._try_enter(current, "new-host") is None
    resources.finish(current)


async def test_unknown_access_without_effect_keeps_operation_identity(shared):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    root, store, _, make = shared
    task = await make("interrupted-before-effect")
    resources = FusionResources(store.database_path, store.project, workspace_key(root))
    async with resources.operation(
        "file", paths=["a.py"], task_id=task.task_id
    ) as permit:
        permit.stopped = False
    current = await store.pause(task.task_id)
    assert current.phase == "OUTCOME_UNKNOWN"
    assert current.data["pending_operations"][0]["operation_id"] == permit.request_id
    await store.cancel(
        task.task_id, current.version, stopped_inspection_note="已确认文件操作停止"
    )
    async with resources.operation("command"):
        pass
