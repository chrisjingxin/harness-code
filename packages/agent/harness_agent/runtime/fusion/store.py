"""保存 Fusion 任务、证据和工作区写者，借用 ThreadPersistence 的连接和锁。

Service/Guard --> 短事务 [检查版本 -> 登记事实 -> 提交] --> SQLite
                模型、审批和命令均在事务外执行

同一 Thread 只留一个活动任务；完成/取消与交还写者在同一事务内提交。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import time
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import aiosqlite

from harness_agent.runtime.fusion.resources import (
    CLEANUP_ACCESS_SQL,
    IDLE_RESERVATIONS_SQL,
    RESOURCE_SQL,
    owner_exited,
    scopes_overlap,
)
from harness_agent.runtime.fusion.snapshot import (
    normalize_paths,
    path_allowed,
    snapshot_from_entries,
)

T = TypeVar("T")
PHASES = frozenset(
    {
        "READY",
        "WAITING_RESOURCE",
        "WORKER_RUNNING",
        "CHECKING",
        "REVIEWING",
        "PAUSED",
        "WAITING_USER",
        "OUTCOME_UNKNOWN",
        "COMPLETED",
        "CANCELLED",
    }
)
TABLE_SQL = {
    "fusion_tasks": """CREATE TABLE IF NOT EXISTS fusion_tasks (
        project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL, worker_session_id TEXT NOT NULL, phase TEXT NOT NULL,
        active INTEGER NOT NULL, version INTEGER NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(project_fingerprint, task_id))""",
    "fusion_orders": """CREATE TABLE IF NOT EXISTS fusion_orders (
        project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
        data_json TEXT NOT NULL, PRIMARY KEY(project_fingerprint,task_id,revision))""",
    "fusion_outbox": """CREATE TABLE IF NOT EXISTS fusion_outbox (
        project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        state TEXT NOT NULL, digest TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(project_fingerprint,operation_id))""",
    "fusion_messages": """CREATE TABLE IF NOT EXISTS fusion_messages (
        project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        data_json TEXT NOT NULL, PRIMARY KEY(project_fingerprint,operation_id))""",
    "fusion_evidence": """CREATE TABLE IF NOT EXISTS fusion_evidence (
        project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
        kind TEXT NOT NULL, data_json TEXT NOT NULL,
        PRIMARY KEY(project_fingerprint,evidence_id))""",
    "fusion_effects": """CREATE TABLE IF NOT EXISTS fusion_effects (
        project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        execution_id TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL,
        task_version INTEGER NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL,
        stopped INTEGER NOT NULL, PRIMARY KEY(project_fingerprint,operation_id))""",
}

TABLE_SQL.update(RESOURCE_SQL)


class FusionError(ValueError):
    """只暴露稳定错误码，避免错误携带模型参数或凭据。"""

    def __init__(self, code: str) -> None:
        """保存可用于工具与 RPC 的安全错误码。"""
        self.code = code
        super().__init__(code)


class FusionWorkspaceBusy(FusionError):
    """派单未落库时携带占用者的安全摘要；不包含原话、模型配置或工具参数。"""

    def __init__(self, blocker: Mapping[str, object]) -> None:
        """复制事务内确认的占用事实，外层只读取诊断信息。"""
        super().__init__("FUSION_LEASE_BUSY")
        self.blocker = dict(blocker)


def workspace_key(workspace: Path) -> str:
    """同一真实工作目录在不同 Host 中使用同一个键。"""
    return hashlib.sha256(str(workspace.resolve()).encode()).hexdigest()


def new_id(prefix: str) -> str:
    """生成任务、操作或证据的不可重复身份。"""
    return f"{prefix}-{uuid.uuid4().hex}"


def encode(value: object) -> str:
    """以稳定 JSON 表达已校验的持久化事实。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True, slots=True)
class FusionTask:
    """持久化任务快照，工具不得直接改变此对象。"""

    task_id: str
    thread_id: str
    workspace_key: str
    worker_session_id: str
    phase: str
    active: bool
    version: int
    data: Mapping[str, Any]

    def to_record(self) -> dict[str, object]:
        """仅输出安全状态；原始用户消息和工具报告不进入状态协议。"""
        return {
            "task_id": self.task_id,
            "thread_id": self.thread_id,
            "version": self.version,
            "phase": self.phase,
            "active": self.active,
            "profile": self.data["profile"],
            "worker_session_id": self.worker_session_id,
            "revision": self.data.get("revision", 0),
            "round": self.data.get("round", 0),
            "verification": self.data.get("verification", "unverified"),
            "reason": self.data.get("reason"),
            "report_id": self.data.get("report_id"),
            "ticket_id": self.data.get("ticket_id"),
            "pending_operations": self.data.get("pending_operations", []),
            "workspace_blocker": self.data.get("workspace_blocker"),
            "write_paths": list(self.data.get("write_paths", [])),
            "resource_waits": list(self.data.get("resource_waits", {}).values()),
            **(
                {"exploration": self.data["exploration"]}
                if "exploration" in self.data
                else {}
            ),
            **({"usage": self.data["usage"]} if "usage" in self.data else {}),
            **(
                {"stagnation": self.data["stagnation"]}
                if self.data.get("stagnation")
                else {}
            ),
        }


@dataclass(frozen=True, slots=True)
class FusionLease:
    """记录当前写者和授权代号，旧一轮的操作不能借用新授权。"""

    workspace_key: str
    task_id: str
    owner: str
    generation: int


class FusionStateStore:
    """按项目隔离任务，按真实工作区串行写入，所有更新使用短事务。"""

    def __init__(
        self,
        connection: aiosqlite.Connection,
        *,
        project_fingerprint: str,
        lock: asyncio.Lock,
        database_path: Path,
    ) -> None:
        """借用 ThreadPersistence 的连接和锁，不另建任务数据库。"""
        self.connection = connection
        self.project = project_fingerprint
        self.lock = lock
        self.database_path = database_path

    async def ensure_schema(self) -> None:
        """由 ThreadPersistence 初始化扩展表，并验证每张表的列和唯一性。"""

        async def action() -> None:
            for sql in TABLE_SQL.values():
                await self.connection.execute(sql)
            await self._migrate_workspace_leases()
            await self.connection.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS fusion_one_active_thread ON fusion_tasks(project_fingerprint,thread_id) WHERE active=1"
            )
            # 在内存中建同一结构，避免已有同名表被 IF NOT EXISTS 静默接受。
            reference = sqlite3.connect(":memory:")
            try:
                for name, sql in TABLE_SQL.items():
                    reference.execute(sql)
                    cursor = await self.connection.execute(f"PRAGMA table_info({name})")
                    actual = [tuple(row) for row in await cursor.fetchall()]
                    expected = list(reference.execute(f"PRAGMA table_info({name})"))
                    if actual != expected:
                        raise FusionError("FUSION_SCHEMA_INVALID")
                cursor = await self.connection.execute(
                    "SELECT sql FROM sqlite_master WHERE name='fusion_one_active_thread'"
                )
                row = await cursor.fetchone()
                cursor = await self.connection.execute(
                    "PRAGMA index_list(fusion_tasks)"
                )
                indexes = {item[1]: tuple(item) for item in await cursor.fetchall()}
                cursor = await self.connection.execute(
                    "PRAGMA index_info(fusion_one_active_thread)"
                )
                columns = [item[2] for item in await cursor.fetchall()]
                index = indexes.get("fusion_one_active_thread")
                if (
                    not row
                    or not index
                    or index[2] != 1
                    or index[4] != 1
                    or columns != ["project_fingerprint", "thread_id"]
                    or "".join(str(row[0]).lower().split()).split("where")[-1]
                    != "active=1"
                ):
                    raise FusionError("FUSION_SCHEMA_INVALID")
            finally:
                reference.close()

        async with self.lock:
            cursor = await self.connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='fusion_leases'"
            )
            legacy = await cursor.fetchone()
        if legacy:
            await asyncio.to_thread(self._backup_before_scope_upgrade)
        await self._transaction(action)

    def _backup_before_scope_upgrade(self) -> None:
        """备份只用于数据保护；不作为另一条运行路径读取或双写。"""
        import os

        backup = self.database_path.with_name(
            self.database_path.stem
            + ".before-file-scopes-"
            + uuid.uuid4().hex
            + ".sqlite3"
        )
        descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        source = sqlite3.connect(self.database_path)
        target = sqlite3.connect(backup)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()

    async def _migrate_workspace_leases(self) -> None:
        """一次性迁移目录租约；旧表删除后，旧进程不能通过旧查询写入。"""

        async def one(sql, parameters=()):
            async with self.connection.execute(sql, parameters) as cursor:
                return await cursor.fetchone()

        async def rows(sql, parameters=()):
            async with self.connection.execute(sql, parameters) as cursor:
                return await cursor.fetchall()

        if not await one(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='fusion_leases'"
        ):
            return
        for lease in await rows("SELECT * FROM fusion_leases"):
            await self.connection.execute(
                "INSERT INTO fusion_generations VALUES(?,?) ON CONFLICT(workspace_key) DO UPDATE SET generation=MAX(generation,excluded.generation)",
                (lease["workspace_key"], lease["generation"]),
            )
            if not lease["task_id"]:
                continue
            identity = (lease["project_fingerprint"], lease["task_id"])
            task = await one(
                "SELECT * FROM fusion_tasks WHERE project_fingerprint=? AND task_id=?",
                identity,
            )
            if not task:
                raise FusionError("FUSION_SCHEMA_INVALID")
            data = json.loads(task["data_json"])
            order = await one(
                "SELECT data_json FROM fusion_orders WHERE project_fingerprint=? AND task_id=? AND revision=?",
                (*identity, data.get("revision", 0)),
            )
            paths = json.loads(order[0])["allowed_paths"] if order else ["./"]
            await self.connection.execute(
                "INSERT INTO fusion_reservations VALUES(?,?,?,?,?,?)",
                (
                    lease["workspace_key"],
                    *identity,
                    lease["owner"],
                    lease["generation"],
                    encode(paths),
                ),
            )
            unknown_command = await one(
                "SELECT 1 FROM fusion_effects WHERE project_fingerprint=? AND task_id=? AND stopped=0 AND kind NOT IN ('write','edit','delete','write_file','edit_file','delete_file') UNION ALL SELECT 1 FROM fusion_outbox WHERE project_fingerprint=? AND task_id=? AND state='dispatched'",
                (*identity, *identity),
            )
            if unknown_command:
                await self.connection.execute(
                    "INSERT INTO fusion_access(request_id,workspace_key,project_fingerprint,task_id,execution_id,kind,paths_json,state) VALUES(?,?,?,?,?,'command',?,'unknown')",
                    (
                        "legacy-" + lease["task_id"],
                        lease["workspace_key"],
                        *identity,
                        "legacy",
                        encode(["./"]),
                    ),
                )
        for task in await rows("SELECT * FROM fusion_tasks WHERE active=1"):
            data = json.loads(task["data_json"])
            identity = (task["project_fingerprint"], task["task_id"])
            if not data.get("revision"):
                if data.get("reason") == "workspace_busy":
                    data.update({"reason": None, "workspace_blocker": None})
                    await self.connection.execute(
                        "UPDATE fusion_tasks SET phase='READY',version=version+1,data_json=? WHERE project_fingerprint=? AND task_id=?",
                        (encode(data), *identity),
                    )
                continue
            for row in await rows(
                "SELECT revision,data_json FROM fusion_orders WHERE project_fingerprint=? AND task_id=?",
                identity,
            ):
                order = json.loads(row["data_json"])
                if row["revision"] == data["revision"]:
                    data["write_paths"] = order["allowed_paths"]
                if "baseline" in order:
                    order["baseline"] = snapshot_from_entries(
                        {
                            name: value
                            for name, value in order["baseline"]["entries"].items()
                            if path_allowed(name, order["allowed_paths"])
                        }
                    )
                    await self.connection.execute(
                        "UPDATE fusion_orders SET data_json=? WHERE project_fingerprint=? AND task_id=? AND revision=?",
                        (encode(order), *identity, row["revision"]),
                    )
            pending = await one(
                "SELECT 1 FROM fusion_access WHERE project_fingerprint=? AND task_id=? AND state='unknown'",
                identity,
            )
            effects = await one(
                "SELECT 1 FROM fusion_effects WHERE project_fingerprint=? AND task_id=? AND stopped=0 LIMIT 1",
                identity,
            )
            unknown = bool(pending or effects or task["phase"] == "OUTCOME_UNKNOWN")
            data.update(
                {
                    "report_id": None,
                    "ticket_id": None,
                    "candidate_digest": None,
                    "verification": "unverified",
                    "check_started_plan_ids": [],
                    "verification_cycle": new_id("verification"),
                    "reason": "effects_unconfirmed" if unknown else "scope_upgrade",
                }
            )
            phase = "OUTCOME_UNKNOWN" if unknown else "PAUSED"
            await self.connection.execute(
                "UPDATE fusion_tasks SET phase=?,version=version+1,data_json=? WHERE project_fingerprint=? AND task_id=?",
                (phase, encode(data), *identity),
            )
        await self.connection.execute("DROP TABLE fusion_leases")

    async def wait_for_lease(
        self,
        task_id: str,
        owner: str,
        *,
        paths: Iterable[str],
        on_wait: Callable[[FusionTask], Awaitable[None]] | None = None,
        preserve_ticket: bool = False,
    ) -> FusionLease:
        """一次排队申请全部范围；不让模型重试，也不跨等待持有数据库或 Host 锁。"""
        request_id = new_id("reservation")
        wanted = tuple(paths)

        async def enqueue() -> None:
            task = await self._get(task_id)
            if not task.active or task.phase == "OUTCOME_UNKNOWN":
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            if await self._pending(task_id) or await self._pending_delivery(task_id):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            # 开新轮须交回整组旧范围，避免 A 持 a 等 b、B 持 b 等 a。
            await self.connection.execute(
                "UPDATE fusion_reservations SET owner=NULL WHERE project_fingerprint=? AND task_id=?",
                (self.project, task_id),
            )
            await self.connection.execute(
                "INSERT INTO fusion_access(request_id,workspace_key,project_fingerprint,task_id,execution_id,kind,paths_json,state,heartbeat_ms) VALUES(?,?,?,?,?,'reservation',?,'waiting',?)",
                (
                    request_id,
                    task.workspace_key,
                    self.project,
                    task_id,
                    "reservation",
                    encode(wanted),
                    int(time.time() * 1000),
                ),
            )
            await self._update(
                task,
                phase="WAITING_RESOURCE",
                data={
                    "waiting_request": request_id,
                    "waiting_paths": list(wanted),
                    "reason": "resource_wait",
                    "ticket_id": task.data.get("ticket_id")
                    if preserve_ticket
                    else None,
                    "verification": task.data.get("verification", "unverified")
                    if preserve_ticket
                    else "unverified",
                },
            )

        acquired: FusionLease | None = None
        returned = False
        try:
            await self._transaction(enqueue)
            while True:

                async def attempt() -> tuple[FusionLease | None, FusionTask]:
                    nonlocal acquired
                    task = await self._get(task_id)
                    if task.data.get("waiting_request") != request_id:
                        raise asyncio.CancelledError()
                    await self.connection.execute(
                        "INSERT OR IGNORE INTO fusion_access(request_id,workspace_key,project_fingerprint,task_id,execution_id,kind,paths_json,state,heartbeat_ms) VALUES(?,?,?,?,?,'reservation',?,'waiting',?)",
                        (
                            request_id,
                            task.workspace_key,
                            self.project,
                            task_id,
                            "reservation",
                            encode(wanted),
                            int(time.time() * 1000),
                        ),
                    )
                    await self.connection.execute(
                        "UPDATE fusion_access SET heartbeat_ms=? WHERE request_id=? AND state='waiting'",
                        (int(time.time() * 1000), request_id),
                    )
                    if not task.active:
                        raise asyncio.CancelledError()
                    try:
                        acquired = await self._acquire_lease(
                            task, owner, paths=wanted, request_id=request_id
                        )
                    except FusionWorkspaceBusy as exc:
                        if task.data.get("workspace_blocker") != exc.blocker:
                            task = await self._update(
                                task, data={"workspace_blocker": exc.blocker}
                            )
                        return None, task
                    task = await self._update(
                        task,
                        data={
                            "workspace_blocker": None,
                            "write_paths": list(wanted),
                            "reason": None,
                        },
                    )
                    return acquired, task

                lease, task = await self._transaction(attempt)
                if on_wait:
                    await on_wait(task)
                if lease:
                    returned = True
                    return lease
                await asyncio.sleep(0.1)
        finally:

            async def remove() -> None:
                await self.connection.execute(
                    "DELETE FROM fusion_access WHERE request_id=?", (request_id,)
                )
                task = await self._get(task_id)
                if not returned:
                    if acquired:
                        await self.connection.execute(
                            "UPDATE fusion_reservations SET owner=NULL WHERE project_fingerprint=? AND task_id=? AND generation=?",
                            (self.project, task_id, acquired.generation),
                        )
                    if (
                        task.active
                        and task.phase == "WAITING_RESOURCE"
                        and task.data.get("waiting_request") == request_id
                    ):
                        await self._update(
                            task,
                            phase="PAUSED",
                            data={
                                "reason": "resource_wait_paused",
                                "waiting_paths": [],
                                "waiting_request": None,
                            },
                        )

            await asyncio.shield(self._transaction(remove))

    async def _transaction(self, action: Callable[[], Awaitable[T]]) -> T:
        async with self.lock:
            await self.connection.execute("BEGIN IMMEDIATE")
            try:
                result = await action()
                await self.connection.commit()
                return result
            except BaseException:
                await self.connection.rollback()
                raise

    async def _get(self, task_id: str) -> FusionTask:
        cursor = await self.connection.execute(
            "SELECT * FROM fusion_tasks WHERE project_fingerprint=? AND task_id=?",
            (self.project, task_id),
        )
        row = await cursor.fetchone()
        if row is None:
            raise FusionError("FUSION_TASK_NOT_FOUND")
        return FusionTask(
            row["task_id"],
            row["thread_id"],
            row["workspace_key"],
            row["worker_session_id"],
            row["phase"],
            bool(row["active"]),
            row["version"],
            json.loads(row["data_json"]),
        )

    async def get(self, task_id: str) -> FusionTask:
        """读取本项目任务，不允许跨项目访问任务 ID。"""
        async with self.lock:
            return await self._get(task_id)

    async def active(self, thread_id: str) -> FusionTask | None:
        """读取 Thread 的唯一活动任务。"""
        async with self.lock:
            cursor = await self.connection.execute(
                "SELECT task_id FROM fusion_tasks WHERE project_fingerprint=? AND thread_id=? AND active=1",
                (self.project, thread_id),
            )
            row = await cursor.fetchone()
            return await self._get(row[0]) if row else None

    async def latest(self, thread_id: str) -> FusionTask | None:
        """返回活动任务，或最近创建的终结任务，供重连展示结果。"""
        async with self.lock:
            cursor = await self.connection.execute(
                "SELECT task_id FROM fusion_tasks WHERE project_fingerprint=? AND thread_id=? ORDER BY active DESC,rowid DESC LIMIT 1",
                (self.project, thread_id),
            )
            row = await cursor.fetchone()
            return await self._get(row[0]) if row else None

    async def claim_run(
        self, task_id: str, expected_version: int, owner: str, run_id: str
    ) -> FusionTask:
        """跨窗口只允许一轮执行操作同一任务；不能把未知的旧执行当成已停止。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.version != expected_version:
                raise FusionError("FUSION_TASK_CONFLICT")
            scope = {"owner": owner, "run_id": run_id}
            current = task.data.get("active_run")
            if current == scope:
                return task
            if current is not None:
                raise FusionError("FUSION_LEASE_BUSY")
            if not task.active or task.phase in {
                "OUTCOME_UNKNOWN",
                "WORKER_RUNNING",
                "CHECKING",
            }:
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            return await self._update(task, data={"active_run": scope})

        return await self._transaction(action)

    async def release_run(
        self, task_id: str, owner: str, run_id: str, *, abandon_new: bool = False
    ) -> None:
        """只清理自己取得的归属，旧回调不能结束后来的运行。"""

        async def action() -> None:
            task = await self._get(task_id)
            if task.data.get("active_run") == {"owner": owner, "run_id": run_id}:
                if abandon_new and task.phase == "READY" and not task.data.get("round"):
                    await self._terminate(
                        task, "CANCELLED", {"reason": "run_not_accepted"}
                    )
                    return
                if task.active and task.phase in {
                    "READY",
                    "WORKER_RUNNING",
                    "CHECKING",
                    "REVIEWING",
                    "OUTCOME_UNKNOWN",
                }:
                    task = await self._pause(task)
                await self._update(task, data={"active_run": None})

        await self._transaction(action)

    async def _release_idle_lease(self, task: FusionTask) -> bool:
        """只有安全暂停/等待的任务让出目录；任务和文件仍保留。"""
        if task.phase not in {"PAUSED", "WAITING_USER", "COMPLETED", "CANCELLED"}:
            return False
        if await self._pending(task.task_id) or await self._pending_delivery(
            task.task_id
        ):
            return False
        cursor = await self.connection.execute(
            "UPDATE fusion_reservations SET owner=NULL WHERE task_id=? AND project_fingerprint=?",
            (task.task_id, self.project),
        )
        return cursor.rowcount > 0

    async def _workspace_blocker(self, task: FusionTask) -> dict[str, object] | None:
        cursor = await self.connection.execute(
            "SELECT paths_json FROM fusion_reservations WHERE project_fingerprint=? AND task_id=? AND owner IS NOT NULL",
            (self.project, task.task_id),
        )
        row = await cursor.fetchone()
        paths = (
            task.data.get("waiting_paths")
            or (json.loads(row[0]) if row else task.data.get("write_paths"))
            or ["./"]
        )
        return await self._workspace_owner(
            task.workspace_key, excluding_task_id=task.task_id, paths=paths
        )

    async def _cleanup_resources(self) -> None:
        async with self.connection.execute(
            "SELECT DISTINCT owner_pid FROM fusion_access WHERE state IN ('running','unknown') AND owner_pid>0"
        ) as cursor:
            pids = [row[0] for row in await cursor.fetchall()]
        for pid in pids:
            if owner_exited(pid):
                await self.connection.execute(
                    "DELETE FROM fusion_access WHERE kind='snapshot' AND owner_pid=?",
                    (pid,),
                )
                await self.connection.execute(
                    "UPDATE fusion_access SET state='unknown' WHERE state='running' AND owner_pid=?",
                    (pid,),
                )
        for query in CLEANUP_ACCESS_SQL:
            await self.connection.execute(query)
        await self.connection.execute(IDLE_RESERVATIONS_SQL)

    async def _workspace_owner(
        self,
        key: str,
        *,
        excluding_task_id: str | None = None,
        paths: Iterable[str] = ("./",),
        include_operations: bool = True,
    ) -> dict[str, object] | None:
        """返回第一个实际范围冲突；不同文件的其他任务不会被当作阻塞者。"""
        await self._cleanup_resources()
        if include_operations:
            cursor = await self.connection.execute(
                "SELECT * FROM fusion_access WHERE workspace_key=? AND ((kind IN ('command','snapshot') AND state IN ('running','unknown')) OR kind='file' AND state='unknown') ORDER BY sequence",
                (key,),
            )
            for operation in await cursor.fetchall():
                if (
                    excluding_task_id is not None
                    and operation["project_fingerprint"] == self.project
                    and operation["task_id"] == excluding_task_id
                ):
                    continue
                own = operation["project_fingerprint"] == self.project
                holder = (
                    await self._get(operation["task_id"])
                    if own and operation["task_id"]
                    else None
                )
                return {
                    "task_id": holder.task_id if holder else None,
                    "thread_id": holder.thread_id if holder else None,
                    "phase": holder.phase if holder else None,
                    "round": holder.data.get("round", 0) if holder else 0,
                    "reason": holder.data.get("reason") if holder else None,
                    "requires_inspection": operation["state"] == "unknown",
                    "kind": "command" if operation["kind"] != "file" else "paths",
                    "paths": json.loads(operation["paths_json"]),
                    **(
                        {
                            "operation_id": operation["request_id"],
                            "sequence": operation["sequence"],
                        }
                        if own
                        and operation["task_id"] is None
                        and operation["state"] == "unknown"
                        else {}
                    ),
                }
        cursor = await self.connection.execute(
            "SELECT * FROM fusion_reservations WHERE workspace_key=? AND owner IS NOT NULL ORDER BY generation",
            (key,),
        )
        for lease in await cursor.fetchall():
            if (
                lease["task_id"] == excluding_task_id
                and lease["project_fingerprint"] == self.project
            ):
                continue
            if not scopes_overlap(paths, json.loads(lease["paths_json"])):
                continue
            if lease["project_fingerprint"] != self.project:
                return {
                    "task_id": None,
                    "thread_id": None,
                    "phase": None,
                    "round": 0,
                    "reason": "owner_unavailable",
                    "requires_inspection": True,
                    "kind": "paths",
                    "paths": [],
                }
            owner = await self._get(lease["task_id"])
            if await self._release_idle_lease(owner):
                continue
            return {
                "task_id": owner.task_id,
                "thread_id": owner.thread_id,
                "phase": owner.phase,
                "round": owner.data.get("round", 0),
                "reason": owner.data.get("reason"),
                "requires_inspection": owner.phase == "OUTCOME_UNKNOWN"
                or (
                    not owner.data.get("active_run")
                    and (
                        await self._pending(owner.task_id)
                        or await self._pending_delivery(owner.task_id)
                    )
                ),
                "kind": "paths",
                "paths": json.loads(lease["paths_json"]),
            }
        return None

    async def workspace_blocker(self, task_id: str) -> dict[str, object] | None:
        """读取实际写者，不按进程、时间或模型声明推断占用已解除。"""

        async def action() -> dict[str, object] | None:
            return await self._workspace_blocker(await self._get(task_id))

        return await self._transaction(action)

    async def claimed_paths(self, key: str) -> tuple[str, ...]:
        """命令核查包含所有已声明文件，别人明确修改的缓存文件也不能漏掉。"""
        async with self.lock:
            cursor = await self.connection.execute(
                "SELECT paths_json FROM fusion_reservations WHERE workspace_key=? AND owner IS NOT NULL",
                (key,),
            )
            paths = []
            for row in await cursor.fetchall():
                for path in json.loads(row[0]):
                    if path not in paths:
                        paths.append(path)
            return tuple(paths)

    async def workspace_owner(self, workspace: Path) -> dict[str, object] | None:
        """没有本会话任务时仍能读取当前目录的实际占用；不自动核查未知操作。"""

        async def action() -> dict[str, object] | None:
            return await self._workspace_owner(workspace_key(workspace))

        return await self._transaction(action)

    async def _refresh_workspace_wait(self, task_id: str) -> FusionTask:
        async def action() -> FusionTask:
            current = await self._get(task_id)
            if not current.active or current.data.get("reason") != "workspace_busy":
                return current
            blocker = await self._workspace_blocker(current)
            reason = "workspace_busy" if blocker else "workspace_available"
            if (
                current.data.get("workspace_blocker") == blocker
                and current.data.get("reason") == reason
            ):
                return current
            return await self._update(
                current,
                phase="WAITING_USER" if blocker else "PAUSED",
                data={"reason": reason, "workspace_blocker": blocker},
            )

        return await self._transaction(action)

    async def create(
        self,
        *,
        thread_id: str,
        profile: Mapping[str, object],
        workspace: Path,
        source_message: str,
    ) -> FusionTask:
        """原子建立任务和独立 Sidekick 会话，不解析或执行检查命令。"""
        if not thread_id or not source_message.strip():
            raise FusionError("FUSION_INPUT_INVALID")
        task_id = new_id("fusion")
        session_id = new_id("sidekick")
        data = {
            "profile": dict(profile),
            "source_message": source_message,
            "workspace_path": str(workspace.resolve()),
            "revision": 0,
            "round": 0,
            "verification": "unverified",
        }

        async def action() -> FusionTask:
            try:
                await self.connection.execute(
                    "INSERT INTO fusion_tasks VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        self.project,
                        task_id,
                        thread_id,
                        workspace_key(workspace),
                        session_id,
                        "READY",
                        1,
                        1,
                        encode(data),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise FusionError("FUSION_TASK_CONFLICT") from exc
            return await self._get(task_id)

        return await self._transaction(action)

    async def _update(
        self,
        task: FusionTask,
        *,
        phase: str | None = None,
        data: Mapping[str, object] | None = None,
    ) -> FusionTask:
        chosen = phase or task.phase
        if chosen not in PHASES:
            raise FusionError("FUSION_PHASE_INVALID")
        if not task.active and chosen != task.phase:
            raise FusionError("FUSION_TASK_CONFLICT")
        merged = dict(task.data)
        merged.update(data or {})
        cursor = await self.connection.execute(
            "UPDATE fusion_tasks SET phase=?,active=?,version=version+1,data_json=? WHERE project_fingerprint=? AND task_id=? AND version=?",
            (
                chosen,
                int(chosen not in {"COMPLETED", "CANCELLED"}),
                encode(merged),
                self.project,
                task.task_id,
                task.version,
            ),
        )
        if cursor.rowcount != 1:
            raise FusionError("FUSION_TASK_CONFLICT")
        updated = await self._get(task.task_id)
        await self._release_idle_lease(updated)
        return updated

    async def update(
        self,
        task_id: str,
        expected_version: int,
        *,
        phase: str | None = None,
        data: Mapping[str, object] | None = None,
    ) -> FusionTask:
        """CAS 写入新状态；旧版本不会覆盖更晚的工具结果。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.version != expected_version:
                raise FusionError("FUSION_TASK_CONFLICT")
            return await self._update(task, phase=phase, data=data)

        return await self._transaction(action)

    async def _acquire_lease(
        self,
        task: FusionTask,
        owner: str,
        *,
        new_round: bool = False,
        paths: Iterable[str] | None = None,
        request_id: str | None = None,
    ) -> FusionLease:
        if not task.active or task.phase == "OUTCOME_UNKNOWN":
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        if owner not in {"host", "sidekick"}:
            raise FusionError("FUSION_ROLE_DENIED")
        cursor = await self.connection.execute(
            "SELECT * FROM fusion_reservations WHERE project_fingerprint=? AND task_id=?",
            (self.project, task.task_id),
        )
        row = await cursor.fetchone()
        wanted = (
            tuple(paths)
            if paths is not None
            else tuple(
                json.loads(row["paths_json"])
                if row
                else task.data.get("write_paths") or ["./"]
            )
        )
        if task.data.get("workspace_path"):
            wanted = normalize_paths(Path(task.data["workspace_path"]), wanted)
        blocker = await self._workspace_owner(
            task.workspace_key,
            excluding_task_id=task.task_id,
            paths=wanted,
            include_operations=False,
        )
        if blocker:
            raise FusionWorkspaceBusy(blocker)
        # 已有范围内的 owner 交接不受后到等待者阻碍，避免它无法完成检查而永远不释放。
        renewing = bool(
            row and row["owner"] and set(wanted) == set(json.loads(row["paths_json"]))
        )
        if not renewing:
            cursor = await self.connection.execute(
                "SELECT * FROM fusion_access WHERE workspace_key=? AND kind IN ('command','snapshot') AND (state IN ('running','unknown') OR state='waiting' AND task_id IS NULL) ORDER BY sequence",
                (task.workspace_key,),
            )
            for running in await cursor.fetchall():
                owner_task = (
                    await self._get(running["task_id"])
                    if running["project_fingerprint"] == self.project
                    and running["task_id"]
                    else None
                )
                raise FusionWorkspaceBusy(
                    {
                        "task_id": owner_task.task_id if owner_task else None,
                        "thread_id": owner_task.thread_id if owner_task else None,
                        "phase": owner_task.phase if owner_task else None,
                        "round": owner_task.data.get("round", 0) if owner_task else 0,
                        "reason": owner_task.data.get("reason") if owner_task else None,
                        "requires_inspection": running["state"] == "unknown",
                        "kind": "command",
                        "paths": ["./"],
                    }
                )
            cursor = await self.connection.execute(
                "SELECT sequence FROM fusion_access WHERE request_id=?", (request_id,)
            )
            current = await cursor.fetchone()
            position = current[0] if current else 2**63 - 1
            cursor = await self.connection.execute(
                "SELECT * FROM fusion_access WHERE workspace_key=? AND kind='reservation' AND state='waiting' AND sequence<? ORDER BY sequence",
                (task.workspace_key, position),
            )
            for queued in await cursor.fetchall():
                if (
                    queued["task_id"] == task.task_id
                    and queued["project_fingerprint"] == self.project
                ):
                    continue
                if scopes_overlap(wanted, json.loads(queued["paths_json"])):
                    owner_task = (
                        await self._get(queued["task_id"])
                        if queued["project_fingerprint"] == self.project
                        else None
                    )
                    raise FusionWorkspaceBusy(
                        {
                            "task_id": owner_task.task_id if owner_task else None,
                            "thread_id": owner_task.thread_id if owner_task else None,
                            "phase": owner_task.phase if owner_task else None,
                            "round": owner_task.data.get("round", 0)
                            if owner_task
                            else 0,
                            "reason": "resource_wait",
                            "requires_inspection": False,
                            "kind": "paths",
                            "paths": json.loads(queued["paths_json"]),
                        }
                    )
        if await self._pending(task.task_id) or await self._pending_delivery(
            task.task_id
        ):
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        if renewing and row["owner"] == owner and not new_round:
            return FusionLease(
                task.workspace_key, task.task_id, owner, row["generation"]
            )
        cursor = await self.connection.execute(
            "INSERT INTO fusion_generations VALUES(?,1) ON CONFLICT(workspace_key) DO UPDATE SET generation=generation+1 RETURNING generation",
            (task.workspace_key,),
        )
        generation = (await cursor.fetchone())[0]
        await self.connection.execute(
            "INSERT INTO fusion_reservations VALUES(?,?,?,?,?,?) ON CONFLICT(project_fingerprint,task_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,paths_json=excluded.paths_json",
            (
                task.workspace_key,
                self.project,
                task.task_id,
                owner,
                generation,
                encode(wanted),
            ),
        )
        if request_id:
            await self.connection.execute(
                "DELETE FROM fusion_access WHERE request_id=? AND state='waiting'",
                (request_id,),
            )
        return FusionLease(task.workspace_key, task.task_id, owner, generation)

    async def acquire_lease(
        self, task_id: str, owner: str, *, paths: Iterable[str] | None = None
    ) -> FusionLease:
        """非等待申请文件范围；未声明范围时沿用当前预留，首次保守申请整个目录。"""

        async def action() -> FusionLease:
            return await self._acquire_lease(
                await self._get(task_id), owner, paths=paths
            )

        return await self._transaction(action)

    async def begin_workspace_phase(
        self, task_id: str, expected_version: int, phase: str
    ) -> tuple[FusionTask, FusionLease]:
        """取得目录并进入执行/检查/审阅须在一起提交，避免暂停任务刚取得目录又被让出。"""
        if phase not in {"CHECKING", "REVIEWING", "WORKER_RUNNING"}:
            raise FusionError("FUSION_PHASE_INVALID")

        async def action() -> tuple[FusionTask, FusionLease]:
            task = await self._get(task_id)
            if task.version != expected_version:
                raise FusionError("FUSION_TASK_CONFLICT")
            lease = await self._acquire_lease(
                task, "sidekick" if phase == "WORKER_RUNNING" else "host"
            )
            task = await self._update(task, phase=phase)
            return task, lease

        return await self._transaction(action)

    async def start_round(
        self,
        task_id: str,
        expected_version: int,
        order: Mapping[str, object],
        operation_id: str,
        message: str,
    ) -> tuple[FusionTask, FusionLease]:
        """同一短事务内登记任务单、消息、待派发操作和写者，不执行模型。

        先取得写者再登记派单；失败会完整回滚。每轮更新写者代号，避免
        上一轮延迟返回的工具沿用旧授权。
        """

        async def action() -> tuple[FusionTask, FusionLease]:
            task = await self._get(task_id)
            if task.version != expected_version or task.phase not in {
                "READY",
                "REVIEWING",
                "WAITING_USER",
                "PAUSED",
                "WAITING_RESOURCE",
            }:
                raise FusionError("FUSION_TASK_CONFLICT")
            lease = await self._acquire_lease(
                task, "sidekick", new_round=True, paths=order["allowed_paths"]
            )
            revision = int(order["revision"])
            cursor = await self.connection.execute(
                "SELECT data_json FROM fusion_orders WHERE project_fingerprint=? AND task_id=? AND revision=?",
                (self.project, task_id, revision),
            )
            row = await cursor.fetchone()
            if row is None:
                await self.connection.execute(
                    "INSERT INTO fusion_orders VALUES(?,?,?,?)",
                    (self.project, task_id, revision, encode(order)),
                )
            elif row[0] != encode(order):
                raise FusionError("FUSION_TASK_CONFLICT")
            payload = {
                "worker_session_id": task.worker_session_id,
                "message_digest": hashlib.sha256(message.encode()).hexdigest(),
            }
            await self.connection.execute(
                "INSERT INTO fusion_outbox VALUES(?,?,?,?,?,?)",
                (
                    self.project,
                    task_id,
                    operation_id,
                    "prepared",
                    hashlib.sha256(encode(payload).encode()).hexdigest(),
                    encode(payload),
                ),
            )
            await self.connection.execute(
                "INSERT INTO fusion_messages VALUES(?,?,?,?)",
                (
                    self.project,
                    task_id,
                    operation_id,
                    encode({"revision": revision, "message": message}),
                ),
            )
            task = await self._update(
                task,
                phase="WORKER_RUNNING",
                data={
                    "revision": revision,
                    "round": task.data.get("round", 0) + 1,
                    "report_id": None,
                    "ticket_id": None,
                    "verification": "unverified",
                    "reason": None,
                    "operation_id": operation_id,
                    "worker_execution_id": None,
                    "pending_operations": [],
                    "candidate_digest": None,
                    "check_started_plan_ids": [],
                    "verification_cycle": new_id("verification"),
                    "write_paths": list(order["allowed_paths"]),
                    "waiting_paths": [],
                    "waiting_request": None,
                    "pending_round": None,
                    "workspace_blocker": None,
                    "resource_waits": {},
                },
            )
            return task, lease

        return await self._transaction(action)

    async def _pending_delivery(self, task_id: str) -> bool:
        cursor = await self.connection.execute(
            "SELECT 1 FROM fusion_outbox WHERE project_fingerprint=? AND task_id=? AND state='dispatched' LIMIT 1",
            (self.project, task_id),
        )
        return await cursor.fetchone() is not None

    async def _pending(self, task_id: str) -> bool:
        await self._cleanup_resources()
        cursor = await self.connection.execute(
            "SELECT 1 FROM fusion_effects WHERE project_fingerprint=? AND task_id=? AND stopped=0 LIMIT 1",
            (self.project, task_id),
        )
        if await cursor.fetchone() is not None:
            return True
        cursor = await self.connection.execute(
            "SELECT 1 FROM fusion_access a WHERE a.project_fingerprint=? AND a.task_id=? AND a.kind IN ('file','command') AND a.state IN ('running','unknown') AND NOT EXISTS(SELECT 1 FROM fusion_effects e WHERE e.project_fingerprint=a.project_fingerprint AND e.operation_id=COALESCE(a.effect_id,a.request_id) AND e.stopped=1) LIMIT 1",
            (self.project, task_id),
        )
        return await cursor.fetchone() is not None

    async def release_lease(self, task_id: str, generation: int) -> None:
        """只释放当前代写者，有不明操作时拒绝释放。"""

        async def action() -> None:
            if await self._pending(task_id) or await self._pending_delivery(task_id):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            cursor = await self.connection.execute(
                "UPDATE fusion_reservations SET owner=NULL WHERE task_id=? AND project_fingerprint=? AND generation=? AND owner IS NOT NULL",
                (task_id, self.project, generation),
            )
            if cursor.rowcount != 1:
                raise FusionError("FUSION_LEASE_BUSY")

        await self._transaction(action)

    async def begin_effect(
        self,
        task_id: str,
        generation: int,
        execution_id: str,
        kind: str,
        digest: str,
        *,
        operation_id: str | None = None,
    ) -> str:
        """副作用开始前保存 running 事实，参数仅保存摘要。"""
        operation_id = operation_id or new_id("effect")

        async def action() -> str:
            task = await self._get(task_id)
            cursor = await self.connection.execute(
                "SELECT 1 FROM fusion_reservations WHERE task_id=? AND project_fingerprint=? AND generation=? AND owner IS NOT NULL",
                (task_id, self.project, generation),
            )
            if not await cursor.fetchone():
                raise FusionError("FUSION_LEASE_BUSY")
            await self.connection.execute(
                "INSERT INTO fusion_effects VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    self.project,
                    task_id,
                    operation_id,
                    execution_id,
                    kind,
                    digest,
                    task.version,
                    generation,
                    "running",
                    0,
                ),
            )
            return operation_id

        return await self._transaction(action)

    async def finish_effect(
        self, operation_id: str, *, succeeded: bool, stopped: bool
    ) -> None:
        """只有明确停止才记终态，否则保留 unknown 阻止下一写者。"""

        async def action() -> None:
            await self.connection.execute(
                "UPDATE fusion_effects SET state=?,stopped=? WHERE project_fingerprint=? AND operation_id=?",
                (
                    "succeeded"
                    if succeeded and stopped
                    else "failed"
                    if stopped
                    else "unknown",
                    int(stopped),
                    self.project,
                    operation_id,
                ),
            )

        await self._transaction(action)

    async def effects(self, task_id: str) -> list[dict[str, object]]:
        """返回操作身份和停止事实，不返回工具参数或命令输出。"""
        await self.get(task_id)
        async with self.lock:
            cursor = await self.connection.execute(
                "SELECT operation_id,execution_id,kind,state,stopped,generation FROM fusion_effects WHERE project_fingerprint=? AND task_id=?",
                (self.project, task_id),
            )
            return [dict(row) for row in await cursor.fetchall()]

    async def _pause(self, task: FusionTask) -> FusionTask:
        """在已有事务中暂停；供显式暂停与运行归属收尾共用。"""
        task_id = task.task_id
        if not task.active:
            return task
        unknown = await self._pending(task_id) or await self._pending_delivery(task_id)
        cursor = await self.connection.execute(
            "SELECT operation_id,execution_id,kind,state FROM fusion_effects WHERE project_fingerprint=? AND task_id=? AND stopped=0",
            (self.project, task_id),
        )
        pending_operations = [dict(row) for row in await cursor.fetchall()]
        cursor = await self.connection.execute(
            "SELECT operation_id,state FROM fusion_outbox WHERE project_fingerprint=? AND task_id=? AND state='dispatched'",
            (self.project, task_id),
        )
        pending_operations.extend(
            {**dict(row), "kind": "dispatch"} for row in await cursor.fetchall()
        )
        # 进程可能在登记实际操作后、保存工具副作用前退出；状态仍须给出可核查的身份。
        cursor = await self.connection.execute(
            "SELECT a.request_id AS operation_id,a.execution_id,CASE a.kind WHEN 'file' THEN 'write' ELSE 'execute' END AS kind,a.state FROM fusion_access a WHERE a.project_fingerprint=? AND a.task_id=? AND a.kind IN ('file','command') AND a.state IN ('running','unknown') AND NOT EXISTS(SELECT 1 FROM fusion_effects e WHERE e.project_fingerprint=a.project_fingerprint AND e.operation_id=COALESCE(a.effect_id,a.request_id))",
            (self.project, task_id),
        )
        pending_operations.extend(dict(row) for row in await cursor.fetchall())
        prepared = False
        if (
            not unknown
            and task.data.get("operation_id")
            and task.data.get("worker_execution_id") is None
        ):
            cursor = await self.connection.execute(
                "SELECT state FROM fusion_outbox WHERE project_fingerprint=? AND operation_id=?",
                (self.project, task.data["operation_id"]),
            )
            delivery = await cursor.fetchone()
            prepared = bool(delivery and delivery[0] == "prepared")
        data = {
            "resume_phase": task.data.get("resume_phase", task.phase)
            if task.phase in {"PAUSED", "OUTCOME_UNKNOWN"}
            else task.phase,
            "reason": "effects_unconfirmed"
            if unknown
            else (
                task.data.get("reason")
                if task.data.get("reason") in {"workspace_busy", "resource_wait_paused"}
                else "resource_wait_paused"
                if task.data.get("pending_round") or prepared
                else "run_paused"
            ),
            "pending_operations": pending_operations,
        }
        if unknown:
            data["ticket_id"] = None
        phase = "OUTCOME_UNKNOWN" if unknown else "PAUSED"
        if task.phase == phase and all(task.data.get(k) == v for k, v in data.items()):
            await self._release_idle_lease(task)
            return task
        return await self._update(task, phase=phase, data=data)

    async def pause(self, task_id: str) -> FusionTask:
        """暂停后按操作事实决定是否让出目录；未知操作继续保留写者。"""

        async def action() -> FusionTask:
            return await self._pause(await self._get(task_id))

        return await self._transaction(action)

    async def reconcile(self, task_id: str) -> FusionTask:
        """重启只核对事实；未收敛的派发或写入不自动重放。"""
        task = await self.get(task_id)
        if task.active and task.data.get("reason") == "workspace_busy":
            return await self._refresh_workspace_wait(task_id)
        async with self.lock:
            delivery_pending = await self._pending_delivery(task_id)
        if (
            task.phase in {"WORKER_RUNNING", "CHECKING", "OUTCOME_UNKNOWN"}
            or delivery_pending
            or any(not x["stopped"] for x in await self.effects(task_id))
        ):
            return await self.pause(task_id)
        return task

    async def release_workspace_operation(
        self, operation_id: str, expected_sequence: int, note: str
    ) -> None:
        """用户明确核查后释放普通工具的未知保护；带 Task 的操作仍走完整恢复流程。"""
        if not isinstance(note, str) or not note.strip() or len(note) > 4000:
            raise FusionError("FUSION_OUTCOME_UNKNOWN")

        async def action() -> None:
            cursor = await self.connection.execute(
                "SELECT * FROM fusion_access WHERE project_fingerprint=? AND request_id=? AND sequence=?",
                (self.project, operation_id, expected_sequence),
            )
            row = await cursor.fetchone()
            if not row or row["task_id"] is not None or row["state"] != "unknown":
                raise FusionError("FUSION_TASK_CONFLICT")
            await self.connection.execute(
                "UPDATE fusion_access SET state='inspected',inspection_digest=? WHERE request_id=?",
                (hashlib.sha256(note.encode()).hexdigest(), operation_id),
            )

        await self._transaction(action)

    async def recover(
        self,
        task_id: str,
        expected_version: int,
        inspection_note: str,
        effects_stopped: bool,
    ) -> FusionTask:
        """记录人工核查后解除未知状态，仍需用户显式继续。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.version != expected_version:
                raise FusionError("FUSION_TASK_CONFLICT")
            if (
                task.phase not in {"OUTCOME_UNKNOWN", "WORKER_RUNNING", "CHECKING"}
                or effects_stopped is not True
                or not inspection_note.strip()
            ):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            return await self._record_inspection(task, inspection_note)

        return await self._transaction(action)

    async def _record_inspection(self, task: FusionTask, note: str) -> FusionTask:
        """调用方事务内保存用户明确核查；核查、取消和交还目录可以一起提交。"""
        if not isinstance(note, str) or not note.strip() or len(note) > 4000:
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        await self.connection.execute(
            "UPDATE fusion_effects SET state='unknown',stopped=1 WHERE project_fingerprint=? AND task_id=? AND stopped=0",
            (self.project, task.task_id),
        )
        await self.connection.execute(
            "UPDATE fusion_outbox SET state='inspected' WHERE project_fingerprint=? AND task_id=? AND state='dispatched'",
            (self.project, task.task_id),
        )
        await self.connection.execute(
            "DELETE FROM fusion_access WHERE project_fingerprint=? AND task_id=?",
            (self.project, task.task_id),
        )
        return await self._update(
            task,
            phase="PAUSED",
            data={
                "inspection_digest": hashlib.sha256(note.encode()).hexdigest(),
                "reason": "inspection_recorded",
                "ticket_id": None,
                "pending_operations": [],
                "worker_checkpoint_interrupted": True,
                "active_run": None,
            },
        )

    async def pause_dispatch(
        self, task_id: str, operation_id: str | None, run_id: str
    ) -> FusionTask:
        """当前派发回调收尾；从未登记子执行时恢复 prepared，不把未启动误报为未知。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            scope = task.data.get("active_run")
            if (
                not task.active
                or task.data.get("operation_id") != operation_id
                or scope is not None
                and scope["run_id"] != run_id
            ):
                return task
            if (
                operation_id
                and task.data.get("worker_execution_id") is None
                and not await self._pending(task_id)
            ):
                # 原生 Worker 先登记执行 ID 再创建执行器；回调已返回，说明没有未来待启动的子执行。
                await self.connection.execute(
                    "UPDATE fusion_outbox SET state='prepared' WHERE project_fingerprint=? AND task_id=? AND operation_id=? AND state='dispatched'",
                    (self.project, task_id, operation_id),
                )
                task = await self._update(task, data={"reason": "resource_wait_paused"})
            return await self._pause(task)

        return await self._transaction(action)

    async def record_worker_stopped(
        self, task_id: str, operation_id: str, execution_id: str, *, interrupted: bool
    ) -> bool:
        """真实执行退出后收尾派发；命令的停止事实仍由各自操作记录决定。"""

        async def action() -> bool:
            task = await self._get(task_id)
            if (
                not task.active
                or task.data.get("operation_id") != operation_id
                or task.data.get("worker_execution_id") != execution_id
            ):
                return False
            await self.connection.execute(
                "UPDATE fusion_outbox SET state='stopped' WHERE project_fingerprint=? AND task_id=? AND operation_id=? AND state='dispatched'",
                (self.project, task_id, operation_id),
            )
            await self._update(
                task, data={"worker_checkpoint_interrupted": interrupted}
            )
            return True

        return await self._transaction(action)

    async def _terminate(
        self,
        task: FusionTask,
        phase: str,
        data: Mapping[str, object],
    ) -> FusionTask:
        """在调用方的短事务内同时提交终态和写者释放。"""
        if await self._pending(task.task_id) or await self._pending_delivery(
            task.task_id
        ):
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        task = await self._update(
            task,
            phase=phase,
            data={
                **data,
                "workspace_blocker": None,
                "active_run": None,
                "resource_waits": {},
            },
        )
        await self.connection.execute(
            "UPDATE fusion_reservations SET owner=NULL WHERE task_id=? AND project_fingerprint=?",
            (task.task_id, self.project),
        )
        await self.connection.execute(
            "DELETE FROM fusion_access WHERE project_fingerprint=? AND task_id=? AND state='waiting'",
            (self.project, task.task_id),
        )
        return task

    async def complete_task(
        self,
        task_id: str,
        expected_version: int,
        *,
        reason: str | None = None,
    ) -> FusionTask:
        """已通过服务门禁的任务原子完成；停止状态不明时拒绝释放写者。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.version != expected_version or task.phase not in {
                "READY",
                "REVIEWING",
            }:
                raise FusionError("FUSION_TASK_CONFLICT")
            return await self._terminate(task, "COMPLETED", {"reason": reason})

        return await self._transaction(action)

    async def cancel(
        self,
        task_id: str,
        expected_version: int,
        *,
        stopped_inspection_note: str | None = None,
    ) -> FusionTask:
        """副作用已停止时终结任务并释放写者；不回滚用户文件。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.version != expected_version:
                raise FusionError("FUSION_TASK_CONFLICT")
            if not task.active:
                return task
            if stopped_inspection_note is not None:
                task = await self._record_inspection(task, stopped_inspection_note)
            return await self._terminate(task, "CANCELLED", {"ticket_id": None})

        return await self._transaction(action)

    async def save_record(
        self, task_id: str, kind: str, record_id: str, data: Mapping[str, object]
    ) -> None:
        """保存已校验的任务单、投递或证据；重复 ID 不覆盖旧事实。"""

        async def action() -> None:
            await self._get(task_id)
            if kind == "order":
                await self.connection.execute(
                    "INSERT INTO fusion_orders VALUES(?,?,?,?)",
                    (self.project, task_id, int(record_id), encode(data)),
                )
            elif kind == "outbox":
                await self.connection.execute(
                    "INSERT INTO fusion_outbox VALUES(?,?,?,?,?,?)",
                    (
                        self.project,
                        task_id,
                        record_id,
                        "prepared",
                        hashlib.sha256(encode(data).encode()).hexdigest(),
                        encode(data),
                    ),
                )
            elif kind == "message":
                await self.connection.execute(
                    "INSERT INTO fusion_messages VALUES(?,?,?,?)",
                    (self.project, task_id, record_id, encode(data)),
                )
            else:
                await self.connection.execute(
                    "INSERT INTO fusion_evidence VALUES(?,?,?,?,?)",
                    (self.project, task_id, record_id, kind, encode(data)),
                )

        await self._transaction(action)

    async def record_usage(
        self,
        task_id: str,
        event_id: str,
        *,
        role: str,
        profile_id: str,
        calls: list[dict[str, int]],
    ) -> FusionTask:
        """调用事实与累计值在同一短事务提交，重复事件不重复扣算。"""
        from harness_agent.runtime.fusion.usage import aggregate_usage, usage_record

        if role not in {"lead", "sidekick"} or not calls or not event_id:
            raise FusionError("FUSION_USAGE_INVALID")
        fact = {"role": role, "profile_id": profile_id, "calls": calls}

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.data["profile"][role]["id"] != profile_id:
                raise FusionError("FUSION_USAGE_PROFILE_CONFLICT")
            cursor = await self.connection.execute(
                "SELECT data_json FROM fusion_evidence WHERE project_fingerprint=? AND task_id=? AND evidence_id=?",
                (self.project, task_id, event_id),
            )
            existing = await cursor.fetchone()
            if existing:
                if existing[0] != encode(fact):
                    raise FusionError("FUSION_USAGE_EVENT_CONFLICT")
                return task
            roles = dict(task.data.get("usage", {}))
            roles[role] = aggregate_usage(roles.get(role), profile_id, calls)
            summary = usage_record(roles, task.data["profile"].get("pricing", {}))
            await self.connection.execute(
                "INSERT INTO fusion_evidence VALUES(?,?,?,?,?)",
                (self.project, task_id, event_id, "usage", encode(fact)),
            )
            # 统计只改变数据和版本，不改变终态、轮次、票据或写者代号。
            return await self._update(task, data={"usage": summary})

        return await self._transaction(action)

    async def load_record(
        self, task_id: str, kind: str, record_id: str
    ) -> dict[str, Any]:
        """按任务与项目读取证据，防止跨任务使用审阅票据。"""
        table, column = (
            ("fusion_orders", "revision")
            if kind == "order"
            else ("fusion_evidence", "evidence_id")
        )
        async with self.lock:
            cursor = await self.connection.execute(
                f"SELECT data_json FROM {table} WHERE project_fingerprint=? AND task_id=? AND {column}=?",
                (self.project, task_id, record_id),
            )
            row = await cursor.fetchone()
            if not row:
                raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
            return json.loads(row[0])

    async def mark_delivery(self, operation_id: str, state: str) -> None:
        """记录投递状态，不在未知恢复中自动发出新消息。"""
        if state not in {"dispatched", "accepted", "result_recorded", "not_started"}:
            raise FusionError("FUSION_DELIVERY_INVALID")

        async def action() -> None:
            await self.connection.execute(
                "UPDATE fusion_outbox SET state=? WHERE project_fingerprint=? AND operation_id=?",
                (state, self.project, operation_id),
            )

        await self._transaction(action)

    async def load_delivery(self, task_id: str, operation_id: str) -> dict[str, Any]:
        """同时核对投递记录和原消息，恢复只能使用原任务的已保存输入。"""
        async with self.lock:
            task = await self._get(task_id)
            cursor = await self.connection.execute(
                "SELECT o.state,o.digest,o.data_json,m.data_json FROM fusion_outbox o "
                "JOIN fusion_messages m ON m.project_fingerprint=o.project_fingerprint AND m.operation_id=o.operation_id "
                "WHERE o.project_fingerprint=? AND o.task_id=? AND m.task_id=? AND o.operation_id=?",
                (self.project, task_id, task_id, operation_id),
            )
            row = await cursor.fetchone()
            if not row:
                raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
            payload, message = json.loads(row[2]), json.loads(row[3])
            if (
                row[1] != hashlib.sha256(encode(payload).encode()).hexdigest()
                or payload.get("worker_session_id") != task.worker_session_id
                or payload.get("message_digest")
                != hashlib.sha256(message["message"].encode()).hexdigest()
                or message.get("revision") != task.data.get("revision")
            ):
                raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
            return {"state": row[0], **message}

    async def list_records(self, task_id: str, kind: str) -> list[dict[str, Any]]:
        """读取指定任务的持久化证据，检查恢复按派单身份筛选。"""
        async with self.lock:
            cursor = await self.connection.execute(
                "SELECT data_json FROM fusion_evidence WHERE project_fingerprint=? AND task_id=? AND kind=? ORDER BY rowid",
                (self.project, task_id, kind),
            )
            return [json.loads(row[0]) for row in await cursor.fetchall()]
