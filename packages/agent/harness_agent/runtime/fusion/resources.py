"""跨进程的文件范围与短期命令协调。

任务预留文件范围；实际写文件登记短期操作；命令等待短期写入结束。
申请 -> SQLite 短事务判断 -> 异步等待 -> 实际操作 -> 停止后释放。
等待期间不占数据库事务和 Host 工具锁，未知命令继续保护整个目录。
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
import unicodedata
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RESOURCE_SQL = {
    "fusion_reservations": """CREATE TABLE IF NOT EXISTS fusion_reservations (
        workspace_key TEXT NOT NULL, project_fingerprint TEXT NOT NULL, task_id TEXT NOT NULL,
        owner TEXT, generation INTEGER NOT NULL, paths_json TEXT NOT NULL,
        PRIMARY KEY(project_fingerprint,task_id))""",
    "fusion_generations": """CREATE TABLE IF NOT EXISTS fusion_generations (
        workspace_key TEXT PRIMARY KEY, generation INTEGER NOT NULL)""",
    "fusion_access": """CREATE TABLE IF NOT EXISTS fusion_access (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
        workspace_key TEXT NOT NULL, project_fingerprint TEXT NOT NULL, task_id TEXT,
        execution_id TEXT NOT NULL, kind TEXT NOT NULL, paths_json TEXT NOT NULL,
        state TEXT NOT NULL, effect_id TEXT, heartbeat_ms INTEGER NOT NULL DEFAULT 0, inspection_digest TEXT, owner_pid INTEGER NOT NULL DEFAULT 0)""",
}


IDLE_RESERVATIONS_SQL = """UPDATE fusion_reservations SET owner=NULL WHERE owner IS NOT NULL
    AND EXISTS(SELECT 1 FROM fusion_tasks t WHERE t.project_fingerprint=fusion_reservations.project_fingerprint
      AND t.task_id=fusion_reservations.task_id AND (t.phase IN ('PAUSED','WAITING_USER','COMPLETED','CANCELLED') OR t.phase='OUTCOME_UNKNOWN' AND json_extract(t.data_json,'$.active_run') IS NULL))
    AND NOT EXISTS(SELECT 1 FROM fusion_effects e WHERE e.project_fingerprint=fusion_reservations.project_fingerprint AND e.task_id=fusion_reservations.task_id AND e.stopped=0)
    AND NOT EXISTS(SELECT 1 FROM fusion_outbox o WHERE o.project_fingerprint=fusion_reservations.project_fingerprint AND o.task_id=fusion_reservations.task_id AND o.state='dispatched')
    AND NOT EXISTS(SELECT 1 FROM fusion_access a WHERE a.project_fingerprint=fusion_reservations.project_fingerprint AND a.task_id=fusion_reservations.task_id AND a.kind IN ('file','command') AND a.state IN ('running','unknown'))"""


def scopes_overlap(left: Iterable[str], right: Iterable[str]) -> bool:
    """同名或祖先/子路径均有冲突；a 与 ab 不冲突。"""
    right = tuple(right)
    for a in left:
        for b in right:
            a, b = (
                unicodedata.normalize("NFC", a.rstrip("/")).casefold(),
                unicodedata.normalize("NFC", b.rstrip("/")).casefold(),
            )
            if (
                a == "."
                or b == "."
                or a == b
                or a.startswith(b + "/")
                or b.startswith(a + "/")
            ):
                return True
    return False


def blocker_summary(
    connection: sqlite3.Connection, project: str, row: Mapping[str, Any]
) -> dict[str, Any]:
    """只展示当前项目的任务身份及相对范围，不暴露其他项目资料。"""
    paths = json.loads(row["paths_json"])
    task_id = row["task_id"]
    own = row["project_fingerprint"] == project
    task = (
        connection.execute(
            "SELECT thread_id,phase,data_json FROM fusion_tasks WHERE project_fingerprint=? AND task_id=?",
            (project, task_id),
        ).fetchone()
        if own and task_id
        else None
    )
    data = json.loads(task["data_json"]) if task else {}
    result = {
        "task_id": task_id if task else None,
        "thread_id": task["thread_id"] if task else None,
        "phase": task["phase"] if task else None,
        "round": data.get("round", 0),
        "reason": data.get("reason") if own else "owner_unavailable",
        "requires_inspection": row.get("state") == "unknown"
        or bool(task and task["phase"] == "OUTCOME_UNKNOWN")
        or not own,
        "kind": "command" if row.get("kind") in {"command", "snapshot"} else "paths",
        "paths": paths if own else [],
    }
    if own and task_id is None and row.get("state") == "unknown":
        result.update(
            {"operation_id": row.get("request_id"), "sequence": row.get("sequence")}
        )
    return result


CLEANUP_ACCESS_SQL = (
    """DELETE FROM fusion_access WHERE state='unknown'
        AND EXISTS (SELECT 1 FROM fusion_effects e WHERE e.project_fingerprint=fusion_access.project_fingerprint
          AND e.operation_id=COALESCE(fusion_access.effect_id,fusion_access.request_id) AND e.stopped=1)""",
    """DELETE FROM fusion_access WHERE request_id LIKE 'legacy-%' AND state='unknown'
        AND NOT EXISTS(SELECT 1 FROM fusion_effects e WHERE e.project_fingerprint=fusion_access.project_fingerprint AND e.task_id=fusion_access.task_id AND e.stopped=0)
        AND NOT EXISTS(SELECT 1 FROM fusion_outbox o WHERE o.project_fingerprint=fusion_access.project_fingerprint AND o.task_id=fusion_access.task_id AND o.state='dispatched')""",
    """DELETE FROM fusion_access WHERE state='waiting' AND task_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM fusion_tasks t WHERE t.project_fingerprint=fusion_access.project_fingerprint
          AND t.task_id=fusion_access.task_id AND t.active=0)""",
    """DELETE FROM fusion_access WHERE state='waiting' AND heartbeat_ms < CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-5000""",
)


def owner_exited(pid: int) -> bool:
    """只能确认 Host 进程消失；不能据此确认它启动的子命令停止。"""
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        return False
    return False


def cleanup_access(connection: sqlite3.Connection) -> None:
    """迟到的停止回执可释放对应保护；没有回执不按等待时间抢锁。"""
    for row in connection.execute(
        "SELECT DISTINCT owner_pid FROM fusion_access WHERE state IN ('running','unknown') AND owner_pid>0"
    ).fetchall():
        if owner_exited(row[0]):
            connection.execute(
                "DELETE FROM fusion_access WHERE kind='snapshot' AND owner_pid=?",
                (row[0],),
            )
            connection.execute(
                "UPDATE fusion_access SET state='unknown' WHERE state='running' AND owner_pid=?",
                (row[0],),
            )
    for query in CLEANUP_ACCESS_SQL:
        connection.execute(query)
    connection.execute(IDLE_RESERVATIONS_SQL)


@dataclass(slots=True)
class AccessPermit:
    """仅由 Host 创建的短期许可；停止不明时保留数据库保护记录。"""

    request_id: str
    kind: str
    paths: tuple[str, ...]
    task_id: str | None
    context: Any = None
    host: bool = False
    stopped: bool = True


class FusionResources:
    """共享 SQLite 的实际操作队列；不将任务长期预留当作命令锁。"""

    def __init__(self, database_path: Path, project: str, workspace_key: str) -> None:
        """接入与任务相同的数据库及已规范化目录键。"""
        self.database_path, self.project, self.workspace_key = (
            database_path,
            project,
            workspace_key,
        )

    def connection(self) -> sqlite3.Connection:
        """每次短事务独立连接，避免跨 asyncio 等待持有 SQLite 锁。"""
        connection = sqlite3.connect(
            self.database_path, timeout=5, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        return connection

    def _try_enter(
        self, permit: AccessPermit, execution_id: str
    ) -> dict[str, Any] | None:
        from harness_agent.runtime.fusion.store import FusionError

        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                cleanup_access(connection)
                if permit.task_id:
                    task = connection.execute(
                        "SELECT active,phase FROM fusion_tasks WHERE project_fingerprint=? AND task_id=?",
                        (self.project, permit.task_id),
                    ).fetchone()
                    if not task or not task["active"]:
                        raise FusionError("FUSION_TASK_CONFLICT")
                    if task["phase"] == "OUTCOME_UNKNOWN":
                        raise FusionError("FUSION_OUTCOME_UNKNOWN")
                connection.execute(
                    "INSERT OR IGNORE INTO fusion_access(request_id,workspace_key,project_fingerprint,task_id,execution_id,kind,paths_json,state,heartbeat_ms,owner_pid) VALUES(?,?,?,?,?,?,?,'waiting',?,?)",
                    (
                        permit.request_id,
                        self.workspace_key,
                        self.project,
                        permit.task_id,
                        execution_id,
                        permit.kind,
                        json.dumps(permit.paths),
                        int(time.time() * 1000),
                        os.getpid(),
                    ),
                )
                connection.execute(
                    "UPDATE fusion_access SET heartbeat_ms=? WHERE request_id=? AND state='waiting'",
                    (int(time.time() * 1000), permit.request_id),
                )
                current = connection.execute(
                    "SELECT sequence,state FROM fusion_access WHERE request_id=?",
                    (permit.request_id,),
                ).fetchone()
                if current["state"] != "waiting":
                    raise FusionError("FUSION_TASK_CONFLICT")
                conflict = None
                holder = (
                    permit.task_id
                    and connection.execute(
                        "SELECT 1 FROM fusion_reservations WHERE project_fingerprint=? AND task_id=? AND owner IS NOT NULL",
                        (self.project, permit.task_id),
                    ).fetchone()
                )
                # 普通写入只等待与自身路径相交的预留。没有声明范围的普通命令须等待全部预留。
                if permit.kind == "file" or not permit.task_id:
                    for item in connection.execute(
                        "SELECT * FROM fusion_reservations WHERE workspace_key=? AND owner IS NOT NULL",
                        (self.workspace_key,),
                    ):
                        if (
                            item["project_fingerprint"] == self.project
                            and item["task_id"] == permit.task_id
                        ):
                            continue
                        if scopes_overlap(permit.paths, json.loads(item["paths_json"])):
                            conflict = blocker_summary(
                                connection, self.project, dict(item)
                            )
                            break
                if conflict is None:
                    for item in connection.execute(
                        "SELECT * FROM fusion_access WHERE workspace_key=? AND request_id!=? AND state IN ('waiting','running','unknown') ORDER BY sequence",
                        (self.workspace_key, permit.request_id),
                    ):
                        if item["kind"] == "reservation":
                            if (
                                permit.task_id is not None
                                or permit.kind != "file"
                                or item["sequence"] >= current["sequence"]
                            ):
                                continue
                            if scopes_overlap(
                                permit.paths, json.loads(item["paths_json"])
                            ):
                                conflict = blocker_summary(
                                    connection, self.project, dict(item)
                                )
                                break
                            continue
                        # 无范围普通命令必须等任务交回文件；不能反过来挡住这些任务的收尾。
                        if (
                            holder
                            and item["state"] == "waiting"
                            and item["task_id"] is None
                        ):
                            continue
                        running = item["state"] in {"running", "unknown"}
                        earlier = item["sequence"] < current["sequence"]
                        conflicts = (
                            permit.kind != "file"
                            or item["kind"] != "file"
                            or scopes_overlap(
                                permit.paths, json.loads(item["paths_json"])
                            )
                        )
                        if conflicts and (running or earlier):
                            conflict = blocker_summary(
                                connection, self.project, dict(item)
                            )
                            break
                if conflict is None:
                    connection.execute(
                        "UPDATE fusion_access SET state='running' WHERE request_id=?",
                        (permit.request_id,),
                    )
                connection.commit()
                return conflict
            except BaseException:
                connection.rollback()
                raise

    def bind_effect(self, permit: AccessPermit, effect_id: str) -> None:
        """一组检查共用许可，但停止回执必须对应当前正在执行的那一条。"""
        with self.connection() as connection:
            connection.execute(
                "UPDATE fusion_access SET effect_id=? WHERE request_id=?",
                (effect_id, permit.request_id),
            )

    def finish(self, permit: AccessPermit) -> None:
        """释放已停止操作；未知操作只更新状态，保留排他保护。"""
        with self.connection() as connection:
            if permit.stopped:
                connection.execute(
                    "DELETE FROM fusion_access WHERE request_id=? AND state!='inspected'",
                    (permit.request_id,),
                )
            else:
                connection.execute(
                    "UPDATE fusion_access SET state='unknown' WHERE request_id=? AND state!='inspected'",
                    (permit.request_id,),
                )

    @asynccontextmanager
    async def operation(
        self,
        kind: str,
        *,
        paths: Iterable[str] = ("./",),
        task_id: str | None = None,
        context: Any = None,
        host: bool = False,
        request_id: str | None = None,
        on_wait: Callable[[str, dict[str, Any] | None], Awaitable[None]] | None = None,
    ) -> AsyncIterator[AccessPermit]:
        """异步等候实际操作许可；取消排队会回收请求，未知执行不回收。"""
        permit = AccessPermit(
            request_id or "access-" + uuid.uuid4().hex,
            kind,
            tuple(paths),
            task_id,
            context,
            host,
        )
        previous: object = None
        waiting = False
        try:
            while True:
                # 屏蔽线程等待的取消，先收敛登记事务，再清理对应请求，防止迟到的幽灵记录。
                job = asyncio.create_task(
                    asyncio.to_thread(
                        self._try_enter,
                        permit,
                        getattr(context, "execution_id", "host"),
                    )
                )
                try:
                    blocker = await asyncio.shield(job)
                except asyncio.CancelledError:
                    await asyncio.shield(job)
                    raise
                if blocker != previous and on_wait is not None:
                    waiting = blocker is not None
                    previous = blocker
                    await on_wait(permit.request_id, blocker)
                if blocker is None:
                    break
                await asyncio.sleep(0.1)
            yield permit
        finally:
            await asyncio.shield(asyncio.to_thread(self.finish, permit))
            if on_wait is not None and waiting:
                await asyncio.shield(on_wait(permit.request_id, None))
