"""用真实临时数据库验证旧目录权限迁移；不接触用户数据。"""

import json
import sqlite3
import stat

import pytest

from harness_agent.runtime.fusion.resources import RESOURCE_SQL
from harness_agent.runtime.fusion.store import FusionError
from harness_agent.threads.thread_persistence import ThreadPersistence
from harness_agent.threads.thread_records import ThreadPersistenceError


async def legacy_database(tmp_path, effect_kind):
    root = tmp_path / "workspace"
    root.mkdir()
    p = await ThreadPersistence.open(project=root, home=tmp_path / "home")
    store = p.fusion_state_store()
    task = await store.create(
        thread_id="old", profile={}, workspace=root, source_message="旧任务"
    )
    await store.save_record(
        task.task_id,
        "order",
        "1",
        {
            "revision": 1,
            "allowed_paths": ["a.py"],
            "baseline": {
                "entries": {"a.py": "old-a", "b.py": "old-b"},
                "digest": "full",
                "tree": "old",
            },
        },
    )
    await store.save_record(task.task_id, "ticket", "old-ticket", {"legacy": True})
    task = await store.update(
        task.task_id,
        task.version,
        phase="REVIEWING",
        data={
            "revision": 1,
            "ticket_id": "old-ticket",
            "report_id": "old-report",
            "candidate_digest": "full",
        },
    )
    effect = None
    if effect_kind:
        lease = await store.acquire_lease(task.task_id, "sidekick", paths=["a.py"])
        effect = await store.begin_effect(
            task.task_id, lease.generation, "old-execution", effect_kind, "digest"
        )
    database, project = store.database_path, store.project
    await p.close()
    with sqlite3.connect(database) as connection:
        for table in RESOURCE_SQL:
            connection.execute(f"DROP TABLE {table}")
        connection.execute(
            "CREATE TABLE fusion_leases(workspace_key TEXT PRIMARY KEY,project_fingerprint TEXT,task_id TEXT,owner TEXT,generation INTEGER NOT NULL)"
        )
        connection.execute(
            "INSERT INTO fusion_leases VALUES(?,?,?,?,7)",
            (task.workspace_key, project, task.task_id, "sidekick"),
        )
    return root, database, task, effect


@pytest.mark.parametrize("effect_kind", [None, "execute", "write"])
async def test_upgrade_backs_up_projects_baseline_and_keeps_stop_uncertainty(
    tmp_path, effect_kind
):
    root, database, old, effect = await legacy_database(tmp_path, effect_kind)
    p = await ThreadPersistence.open(project=root, home=tmp_path / "home")
    try:
        store = p.fusion_state_store()
        current = await store.get(old.task_id)
        assert current.phase == ("OUTCOME_UNKNOWN" if effect_kind else "PAUSED")
        assert (
            current.data["ticket_id"] is None
            and current.data["verification"] == "unverified"
        )
        order = await store.load_record(old.task_id, "order", "1")
        assert order["baseline"]["entries"] == {"a.py": "old-a"}
        assert (await store.load_record(old.task_id, "ticket", "old-ticket"))["legacy"]
        backups = list(database.parent.glob("*.before-file-scopes-*.sqlite3"))
        assert len(backups) == 1 and stat.S_IMODE(backups[0].stat().st_mode) == 0o600
        with sqlite3.connect(backups[0]) as backup:
            assert (
                backup.execute("SELECT generation FROM fusion_leases").fetchone()[0]
                == 7
            )
            assert (
                backup.execute("SELECT data_json FROM fusion_orders")
                .fetchone()[0]
                .find("old-b")
                >= 0
            )
        async with store.lock:
            assert not await (
                await store.connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='fusion_leases'"
                )
            ).fetchone()
            row = await (
                await store.connection.execute(
                    "SELECT paths_json FROM fusion_reservations WHERE task_id=?",
                    (old.task_id,),
                )
            ).fetchone()
            assert json.loads(row[0]) == ["a.py"]
        other = await store.create(
            thread_id="new", profile={}, workspace=root, source_message="新任务"
        )
        if effect_kind == "execute":
            with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
                await store.acquire_lease(other.task_id, "sidekick", paths=["b.py"])
        else:
            lease = await store.acquire_lease(other.task_id, "sidekick", paths=["b.py"])
            assert lease.generation > 7
            await store.release_lease(other.task_id, lease.generation)
        if effect_kind:
            with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
                await store.acquire_lease(other.task_id, "sidekick", paths=["a.py"])
            # 只有可信的迟到停止记录才自动解除旧保护。
            await store.finish_effect(effect, succeeded=False, stopped=True)
            await store.acquire_lease(other.task_id, "sidekick", paths=["a.py"])
    finally:
        await p.close()


async def test_upgrade_backup_failure_keeps_old_schema_and_task(tmp_path, monkeypatch):
    from harness_agent.runtime.fusion.store import FusionStateStore

    root, database, old, _ = await legacy_database(tmp_path, None)

    def denied(self):
        raise OSError("backup denied")

    monkeypatch.setattr(FusionStateStore, "_backup_before_scope_upgrade", denied)
    with pytest.raises(
        ThreadPersistenceError, match="CHECKPOINT_OPEN_FAILED: backup denied"
    ):
        await ThreadPersistence.open(project=root, home=tmp_path / "home")
    with sqlite3.connect(database) as connection:
        assert (
            connection.execute("SELECT generation FROM fusion_leases").fetchone()[0]
            == 7
        )
        assert (
            connection.execute(
                "SELECT phase FROM fusion_tasks WHERE task_id=?", (old.task_id,)
            ).fetchone()[0]
            == "REVIEWING"
        )
