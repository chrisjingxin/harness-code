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
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import aiosqlite

T = TypeVar("T")
PHASES = frozenset(
    {
        "READY",
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
    "fusion_leases": """CREATE TABLE IF NOT EXISTS fusion_leases (
        workspace_key TEXT PRIMARY KEY, project_fingerprint TEXT, task_id TEXT,
        owner TEXT, generation INTEGER NOT NULL)""",
}


class FusionError(ValueError):
    """只暴露稳定错误码，避免错误携带模型参数或凭据。"""

    def __init__(self, code: str) -> None:
        """保存可用于工具与 RPC 的安全错误码。"""
        self.code = code
        super().__init__(code)


class FusionWorkspaceBusy(FusionError):
    """派单未落库时携带占用者的安全摘要；不包含原话、路径或工具参数。"""

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

        await self._transaction(action)

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

    async def _workspace_blocker(self, task: FusionTask) -> dict[str, object] | None:
        cursor = await self.connection.execute(
            "SELECT task_id,project_fingerprint FROM fusion_leases WHERE workspace_key=?",
            (task.workspace_key,),
        )
        lease = await cursor.fetchone()
        if not lease or not lease["task_id"]:
            return None
        if (
            lease["task_id"] == task.task_id
            and lease["project_fingerprint"] == self.project
        ):
            return None
        if lease["project_fingerprint"] != self.project:
            # 只能公开本项目内的会话身份，未知来源不能自动抢占。
            return {
                "task_id": None,
                "thread_id": None,
                "phase": None,
                "round": 0,
                "reason": "owner_unavailable",
                "requires_inspection": True,
            }
        owner = await self._get(lease["task_id"])
        return {
            "task_id": owner.task_id,
            "thread_id": owner.thread_id,
            "phase": owner.phase,
            "round": owner.data.get("round", 0),
            "reason": owner.data.get("reason"),
            "requires_inspection": owner.phase == "OUTCOME_UNKNOWN"
            or await self._pending(owner.task_id)
            or await self._pending_delivery(owner.task_id),
        }

    async def workspace_blocker(self, task_id: str) -> dict[str, object] | None:
        """读取实际写者，不按进程、时间或模型声明推断占用已解除。"""
        async with self.lock:
            return await self._workspace_blocker(await self._get(task_id))

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
        return await self._get(task.task_id)

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
        self, task: FusionTask, owner: str, *, new_round: bool = False
    ) -> FusionLease:
        if not task.active or task.phase == "OUTCOME_UNKNOWN":
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        cursor = await self.connection.execute(
            "SELECT * FROM fusion_leases WHERE workspace_key=?", (task.workspace_key,)
        )
        row = await cursor.fetchone()
        if row and row["task_id"] is not None:
            if (
                row["task_id"] != task.task_id
                or row["project_fingerprint"] != self.project
            ):
                blocker = await self._workspace_blocker(task)
                assert blocker is not None
                raise FusionWorkspaceBusy(blocker)
            if await self._pending(task.task_id) or await self._pending_delivery(
                task.task_id
            ):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            if row["owner"] == owner and not new_round:
                return FusionLease(
                    task.workspace_key, task.task_id, owner, row["generation"]
                )
        generation = (row["generation"] if row else 0) + 1
        await self.connection.execute(
            "INSERT INTO fusion_leases VALUES(?,?,?,?,?) ON CONFLICT(workspace_key) DO UPDATE SET project_fingerprint=excluded.project_fingerprint,task_id=excluded.task_id,owner=excluded.owner,generation=excluded.generation",
            (task.workspace_key, self.project, task.task_id, owner, generation),
        )
        return FusionLease(task.workspace_key, task.task_id, owner, generation)

    async def acquire_lease(self, task_id: str, owner: str) -> FusionLease:
        """取得或交接写者；未停止操作或未确认派发阻止交接。"""

        async def action() -> FusionLease:
            return await self._acquire_lease(await self._get(task_id), owner)

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
            }:
                raise FusionError("FUSION_TASK_CONFLICT")
            lease = await self._acquire_lease(task, "sidekick", new_round=True)
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
        cursor = await self.connection.execute(
            "SELECT 1 FROM fusion_effects WHERE project_fingerprint=? AND task_id=? AND stopped=0 LIMIT 1",
            (self.project, task_id),
        )
        return (await cursor.fetchone()) is not None

    async def release_lease(self, task_id: str, generation: int) -> None:
        """只释放当前代写者，有不明操作时拒绝释放。"""

        async def action() -> None:
            if await self._pending(task_id) or await self._pending_delivery(task_id):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            cursor = await self.connection.execute(
                "UPDATE fusion_leases SET task_id=NULL,project_fingerprint=NULL,owner=NULL WHERE task_id=? AND project_fingerprint=? AND generation=?",
                (task_id, self.project, generation),
            )
            if cursor.rowcount != 1:
                raise FusionError("FUSION_LEASE_BUSY")

        await self._transaction(action)

    async def begin_effect(
        self, task_id: str, generation: int, execution_id: str, kind: str, digest: str
    ) -> str:
        """副作用开始前保存 running 事实，参数仅保存摘要。"""
        operation_id = new_id("effect")

        async def action() -> str:
            task = await self._get(task_id)
            cursor = await self.connection.execute(
                "SELECT 1 FROM fusion_leases WHERE task_id=? AND project_fingerprint=? AND generation=?",
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

    async def pause(self, task_id: str) -> FusionTask:
        """取消 Run 时暂停任务；仍有副作用则保持未知和写者。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if not task.active:
                return task
            unknown = await self._pending(task_id) or await self._pending_delivery(
                task_id
            )
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
            data = {
                "resume_phase": task.data.get("resume_phase", task.phase)
                if task.phase in {"PAUSED", "OUTCOME_UNKNOWN"}
                else task.phase,
                "reason": "effects_unconfirmed"
                if unknown
                else (
                    "workspace_busy"
                    if task.data.get("reason") == "workspace_busy"
                    else "run_paused"
                ),
                "pending_operations": pending_operations,
            }
            if unknown:
                data["ticket_id"] = None
            return await self._update(
                task, phase="OUTCOME_UNKNOWN" if unknown else "PAUSED", data=data
            )

        return await self._transaction(action)

    async def reconcile(self, task_id: str) -> FusionTask:
        """重启只核对事实；未收敛的派发或写入不自动重放。"""
        task = await self.get(task_id)
        if task.active and task.data.get("reason") == "workspace_busy":
            return await self._refresh_workspace_wait(task_id)
        async with self.lock:
            delivery_pending = await self._pending_delivery(task_id)
        if (
            task.phase in {"WORKER_RUNNING", "CHECKING"}
            or delivery_pending
            or any(not x["stopped"] for x in await self.effects(task_id))
        ):
            return await self.pause(task_id)
        return task

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
                task.phase != "OUTCOME_UNKNOWN"
                or effects_stopped is not True
                or not inspection_note.strip()
            ):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            await self.connection.execute(
                "UPDATE fusion_effects SET state='unknown',stopped=1 WHERE project_fingerprint=? AND task_id=? AND stopped=0",
                (self.project, task_id),
            )
            await self.connection.execute(
                "UPDATE fusion_outbox SET state='inspected' WHERE project_fingerprint=? AND task_id=? AND state='dispatched'",
                (self.project, task_id),
            )
            return await self._update(
                task,
                phase="PAUSED",
                data={
                    "inspection_digest": hashlib.sha256(
                        inspection_note.encode()
                    ).hexdigest(),
                    "reason": "inspection_recorded",
                    "ticket_id": None,
                    "pending_operations": [],
                },
            )

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
            task, phase=phase, data={**data, "workspace_blocker": None}
        )
        await self.connection.execute(
            "UPDATE fusion_leases SET task_id=NULL,project_fingerprint=NULL,owner=NULL WHERE task_id=? AND project_fingerprint=?",
            (task.task_id, self.project),
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

    async def cancel(self, task_id: str, expected_version: int) -> FusionTask:
        """副作用已停止时终结任务并释放写者；不回滚用户文件。"""

        async def action() -> FusionTask:
            task = await self._get(task_id)
            if task.version != expected_version:
                raise FusionError("FUSION_TASK_CONFLICT")
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
