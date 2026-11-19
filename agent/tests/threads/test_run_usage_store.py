"""以同步 SQLite 驱动验证终态事务，无需启动依赖 socketpair 的事件循环。"""

import asyncio
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from harness_agent.threads.thread_persistence import ThreadPersistence, ThreadPersistenceError


def immediate(coroutine):
    """测试适配器的 await 均立即完成，若出现真实异步等待则让测试失败。"""
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    finally:
        coroutine.close()
    raise AssertionError("Unexpected asynchronous IO in SQLite unit test")


class Cursor:
    def __init__(self, cursor):
        self.cursor = cursor

    @property
    def rowcount(self):
        return self.cursor.rowcount

    async def fetchone(self):
        return self.cursor.fetchone()

    async def fetchall(self):
        return self.cursor.fetchall()

    async def close(self):
        self.cursor.close()


class Connection:
    def __init__(self, raw):
        self.raw = raw

    async def execute(self, sql, params=()):
        return Cursor(self.raw.execute(sql, params))

    async def commit(self):
        self.raw.commit()

    async def rollback(self):
        self.raw.rollback()


@pytest.fixture
def store():
    raw = sqlite3.connect(":memory:")
    raw.executescript("""
        CREATE TABLE harness_threads (project_fingerprint TEXT, thread_id TEXT, updated_at_ms INTEGER);
        CREATE TABLE harness_run_execution_bindings (project_fingerprint TEXT, thread_id TEXT, run_id TEXT, created_at_ms INTEGER, terminal_summary TEXT);
        CREATE TABLE harness_thread_transcript (project_fingerprint TEXT, thread_id TEXT, run_id TEXT);
        INSERT INTO harness_threads VALUES ('p', 'thread', 1);
        INSERT INTO harness_run_execution_bindings VALUES ('p', 'thread', 'one', 1, NULL), ('p', 'thread', 'old', 0, NULL);
        INSERT INTO harness_thread_transcript VALUES ('p', 'thread', 'one'), ('p', 'thread', 'old');
    """)
    persistence = ThreadPersistence(connection=Connection(raw), checkpointer=SimpleNamespace(lock=asyncio.Lock()), path=Path("unused.sqlite3"), project_fingerprint="p")
    try:
        yield persistence, raw
    finally:
        raw.close()


def test_save_restore_same_value_and_idempotence_without_forging_old_usage(store):
    persistence, raw = store
    usage = dict(input_tokens=100, output_tokens=None, input_complete=True, output_complete=False, cached_tokens=80)
    immediate(persistence.save_run_summary("thread", "one", "cancelled", usage, 1234))
    immediate(persistence.save_run_summary("thread", "one", "cancelled", usage, 1234))
    assert immediate(persistence.load_run_summaries("thread")) == [{"run_id": "one", "outcome": "cancelled", "usage": usage, "duration_ms": 1234}]
    assert raw.execute("SELECT updated_at_ms FROM harness_threads").fetchone()[0] > 1
    assert raw.execute("SELECT terminal_summary FROM harness_run_execution_bindings WHERE run_id='old'").fetchone()[0] is None


def test_sql_failure_rolls_back_summary_and_unknown_binding_does_not_create_row(store):
    persistence, raw = store
    usage = dict(input_tokens=1, output_tokens=2, input_complete=True, output_complete=True)
    raw.execute("CREATE TRIGGER fail_time BEFORE UPDATE ON harness_threads BEGIN SELECT RAISE(ABORT, 'injected'); END")
    with pytest.raises(sqlite3.IntegrityError):
        immediate(persistence.save_run_summary("thread", "one", "completed", usage, 1234))
    assert raw.execute("SELECT terminal_summary FROM harness_run_execution_bindings WHERE run_id='one'").fetchone()[0] is None
    with pytest.raises(ThreadPersistenceError, match="BINDING_NOT_FOUND"):
        immediate(persistence.save_run_summary("thread", "absent", "completed", usage, 1234))


def test_conflicting_terminal_cannot_overwrite_first_snapshot(store):
    persistence, _ = store
    usage = dict(input_tokens=0, output_tokens=0, input_complete=True, output_complete=True)
    immediate(persistence.save_run_summary("thread", "one", "completed", usage, 1234))
    with pytest.raises(ThreadPersistenceError, match="CONFLICT"):
        immediate(persistence.save_run_summary("thread", "one", "failed", usage, 1234))
    assert immediate(persistence.load_run_summaries("thread"))[0]["outcome"] == "completed"


def test_terminal_observer_sees_same_committed_summary_and_write_failure_is_failed(store):
    from harness_agent.host.run_coordinator import RunCoordinator, RunTimingLedger
    from harness_agent.runtime.run_usage import RunUsage
    persistence, raw = store
    coordinator = object.__new__(RunCoordinator)
    coordinator._goal_terminal_reconciler = None
    observed = []
    coordinator._finish = lambda run, status, payload: observed.append((status, payload, immediate(persistence.load_run_summaries("thread"))))
    collector = RunUsage()
    collector.start("request")
    collector.finish("request", {"input_tokens": 100, "output_tokens": 20})
    run = SimpleNamespace(completion=None, context_summary={}, timing=RunTimingLedger(), usage_collector=collector, persistence=persistence, ref=SimpleNamespace(thread_id="thread", run_id="one"))
    immediate(coordinator._finish_after_goal_reconcile(run, "completed", {}))
    status, payload, saved = observed.pop()
    assert status == "completed"
    assert payload["usage"] == saved[0]["usage"]
    raw.execute("CREATE TRIGGER fail_time BEFORE UPDATE ON harness_threads BEGIN SELECT RAISE(ABORT, 'injected'); END")
    run.ref.run_id = "old"
    immediate(coordinator._finish_after_goal_reconcile(run, "completed", {}))
    status, payload, _ = observed.pop()
    assert status == "failed"
    assert payload["error"]["code"] == "RUN_SUMMARY_PERSIST_FAILED"
    assert payload["usage"]["input_tokens"] is None


@pytest.mark.asyncio
async def test_real_database_upgrade_from_v20_and_usage_survives_reopen(tmp_path):
    from tests.support.thread_fixtures import accept_thread
    project, home = tmp_path / "project", tmp_path / "home"
    project.mkdir()
    persistence = await ThreadPersistence.open(project=project, home=home)
    await accept_thread(persistence, "thread", "old", run_id="old")
    path = persistence.database_path
    await persistence.close()
    # 重建上一版本真实列布局，验证升级不为旧轮次编造用量。
    with sqlite3.connect(path) as database:
        database.execute("ALTER TABLE harness_run_execution_bindings DROP COLUMN terminal_summary")
        database.execute("PRAGMA user_version=20")
    persistence = await ThreadPersistence.open(project=project, home=home)
    usage = dict(input_tokens=100, output_tokens=20, input_complete=True, output_complete=True, cached_tokens=80)
    try:
        assert await persistence.load_run_summaries("thread") == []
        await accept_thread(persistence, "thread", "new", run_id="new")
        await persistence.save_run_summary("thread", "new", "completed", usage, 1234)
    finally:
        await persistence.close()
    persistence = await ThreadPersistence.open(project=project, home=home)
    try:
        assert await persistence.load_run_summaries("thread") == [{"run_id": "new", "outcome": "completed", "usage": usage, "duration_ms": 1234}]
    finally:
        await persistence.close()
