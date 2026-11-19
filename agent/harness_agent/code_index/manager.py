"""CodeIndexManager：代码符号知识图谱（CodeGraph）生命周期与状态机管理模块。

【什么是 CodeGraph，为什么需要它？】
在大型代码工程中，如果 Coding Agent 仅靠 `grep` 或逐个读取源码文件来理解系统，
会面临极高的时间开销和天文数字般的 Token 浪费。
为此，Harness Code 建立了基于 SQLite 的代码图谱索引（CodeGraph）：
- 深度索引：在后台静态解析整个代码库的符号（类、函数、接口）、调用边（Caller/Callee）与依赖网络；
- 极速检索：Agent 通过 `codegraph_explore` 可以在几毫秒内直接定位目标符号的定义位置、
  所有直接与间接调用方，并按需提取逐行源码，相较于纯文本 grep 减少了 90% 以上的无效上下文消耗。

【Manager 的核心职责】
本模块负责维护单个工作区内代码图谱的完整生命周期状态机：
1. 单例建图任务（Job Scheduling）：同一工作区同一时刻严格只允许一个建图任务在后台运行，防止磁盘 I/O 争抢；
2. 统一状态快照（State Snapshot）：实时维护并向前端 TUI 广播索引状态（未创建 absent、正在建图 building、服务就绪 ready、错误 error），带百分比进度；
3. 查询租约管理（Query Lease）：当 Agent 正在执行图谱探索查询时分发只读租约，保护底层 SQLite 数据库不被并发写操作锁死；
4. 文件变动监听（Watcher）：在代码保存后触发增量同步（Sync），保持图谱与磁盘代码的时刻一致。

┌────────────────────────────────────────────────────────────────────────┐
│                 CodeIndexManager 代码知识图谱生命周期管理               │
└────────────────────────────────────────────────────────────────────────┘

     用户命令 / Agent           CodeIndexManager                CodeIndexRuntime (后台进程)
            │                          │                                     │
     1. 触发构建索引                   │                                     │
            │── trigger_build() ──────>│                                     │
            │                          │ 校验单例任务 (同一时间仅允许一个)    │
            │                          │ 写入持久化状态: building            │
            │                          │──── 异步启动建图任务 ──────────────>│
            │<─ 返回 Job 已受理 ───────│                                     │ 扫描代码符号与调用边
            │                          │<─── 周期性上报进度 (百分比) ────────│ 写入 .codegraph SQLite
            │<─ 广播状态快照 Snapshot ─│                                     │
            │                          │                                     │
     2. 构建完成，进入服务态           │                                     │
            │                          │<─── 接收 BuildResult ───────────────│
            │                          │ 更新状态: serving / ready           │
            │<─ 广播就绪状态快照 ──────│                                     │
            │                          │                                     │
     3. Agent 符号探索查询             │                                     │
            │── acquire_lease() ──────>│ 分发只读查询租约                    │
            │── codegraph_explore ────>│──── 执行符号图谱高速检索 ──────────>│
            │<─ 返回行级源码与调用链 ──│<─── 毫秒级返回调用关系图 ───────────│
"""

from __future__ import annotations

import asyncio
import inspect
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from harness_agent.code_index.models import (
    CodeIndexBuildResult,
    CodeIndexPreflight,
    CodeIndexQueryLease,
    CodeIndexRuntimePort,
    CodeIndexSnapshot,
    DurableCodeIndexState,
    ErrorCode,
    error_for,
)
from harness_agent.code_index.path_policy import CodeIndexPathError, CodeIndexPathPolicy
from harness_agent.code_index.state_store import CodeIndexStateError, CodeIndexStateStore

ChangedCallback = Callable[[dict[str, object]], Awaitable[None] | None]


class CodeIndexManagerError(RuntimeError):
    """写操作在受理前被稳定业务规则拒绝。"""

    def __init__(self, code: ErrorCode) -> None:
        super().__init__(code)
        self.code = code
        self.detail = error_for(code)


class CodeIndexManager:
    """单工作区代码索引管理者；只允许一个后台建图任务。"""

    def __init__(
        self,
        workspace: Path,
        runtime: CodeIndexRuntimePort,
        *,
        on_changed: ChangedCallback | None = None,
    ) -> None:
        self._workspace = workspace
        self._runtime = runtime
        self._on_changed = on_changed
        self._closed = False
        self._lock = asyncio.Lock()
        self._job_task: asyncio.Task[None] | None = None
        self._explicit_cancel_jobs: set[str] = set()
        self._leases: set[CodeIndexQueryLease] = set()
        self._query_started = False
        self._query_starting = False
        self._last_job: dict[str, str] | None = None
        self._policy = CodeIndexPathPolicy(workspace)
        self._store = CodeIndexStateStore(self._policy)
        self._current = self._snapshot_from_preflight(runtime.preflight())
        if self._current.runtime_status == "ready":
            self._current = self._load_existing(self._current)

    def snapshot(self) -> dict[str, object]:
        """返回当前完整快照；只读调用不创建索引目录。"""
        return self._current.to_wire()

    async def start(self) -> None:
        """恢复干净关闭留下的健康索引；重复调用不会建立第二个查询 session。"""
        async with self._lock:
            if (
                self._closed
                or self._query_started
                or self._query_starting
                or self._active_job()
                or self._current.index_status != "ready"
            ):
                return
            self._query_starting = True
            revision = self._current.revision + 1
            last_job = self._last_job or {}
            self._store.write(
                DurableCodeIndexState(
                    revision=revision,
                    generation=self._current.generation,
                    lifecycle="serving",
                    last_job=last_job,
                )
            )
            self._current = replace(
                self._current,
                revision=revision,
                query_status="starting",
                watcher_status="starting",
                error=None,
            )
            snapshot = self.snapshot()
        await self._notify(snapshot)
        try:
            await self._start_query_session(self._workspace, last_job)
        finally:
            async with self._lock:
                self._query_starting = False

    async def acquire_query(self) -> CodeIndexQueryLease | None:
        """仅在健康 generation 且无 job 时返回查询租约。"""
        async with self._lock:
            if (
                self._closed
                or self._active_job()
                or not self._query_started
                or self._current.index_status != "ready"
                or self._current.query_status != "ready"
            ):
                return None
            lease = CodeIndexQueryLease(
                self._current.generation,
                self._explore_generation,
                self._release_lease,
            )
            self._leases.add(lease)
            return lease

    async def apply(self, request: Mapping[str, object]) -> dict[str, object]:
        """受理首建、增量或重建并立刻返回 running。"""
        action = request.get("action")
        expected_revision = request.get("expected_revision")
        cancel_task: asyncio.Task[None] | None = None
        async with self._lock:
            if self._closed:
                raise CodeIndexManagerError("CODE_INDEX_INCOMPLETE")
            if type(expected_revision) is not int or expected_revision != self._current.revision:
                raise CodeIndexManagerError("CODE_INDEX_REVISION_CONFLICT")
            if action == "cancel":
                job = self._current.job
                job_id = request.get("job_id")
                if (
                    not isinstance(job, dict)
                    or job.get("status") != "running"
                    or not isinstance(job_id, str)
                    or job.get("id") != job_id
                    or self._job_task is None
                ):
                    raise CodeIndexManagerError("CODE_INDEX_JOB_NOT_FOUND")
                self._explicit_cancel_jobs.add(job_id)
                cancel_task = self._job_task
                cancel_task.cancel()
            elif self._active_job():
                raise CodeIndexManagerError("CODE_INDEX_JOB_ACTIVE")
            if cancel_task is not None:
                accepted = None
            else:
                if self._current.runtime_status != "ready":
                    code = self._current.error.code if self._current.error is not None else "CODE_INDEX_RUNTIME_UNAVAILABLE"
                    raise CodeIndexManagerError(code)
                if action == "ensure" and self._current.index_status == "absent":
                    job_action = "initialize"
                elif action == "ensure" and self._current.index_status == "ready":
                    job_action = "sync"
                elif action == "rebuild" and self._current.index_status in {"ready", "incomplete"}:
                    job_action = "rebuild"
                elif (
                    action == "remove"
                    and request.get("confirmed") is True
                    and self._current.index_status in {"ready", "incomplete"}
                ):
                    job_action = "remove"
                else:
                    raise CodeIndexManagerError("CODE_INDEX_INCOMPLETE")
                if self._leases:
                    raise CodeIndexManagerError("CODE_INDEX_RUN_ACTIVE")
                job_id = str(uuid.uuid4())
                revision = self._current.revision + 1
                job = {
                    "id": job_id,
                    "action": job_action,
                    "status": "running",
                    "phase": "removing" if job_action == "remove" else "preparing",
                    "message": "正在删除代码索引。" if job_action == "remove" else "正在准备代码索引。",
                }
                started_at = _now()
                try:
                    self._store.write(
                        DurableCodeIndexState(
                            revision=revision,
                            generation=self._current.generation,
                            lifecycle="running",
                            last_job={"id": job_id, "action": job_action, "started_at": started_at},
                        )
                    )
                except CodeIndexStateError as exc:
                    code: ErrorCode = (
                        "CODE_INDEX_PATH_UNSAFE"
                        if str(exc) == "CODE_INDEX_PATH_UNSAFE"
                        else "CODE_INDEX_INCOMPLETE"
                    )
                    raise CodeIndexManagerError(code) from exc
                self._query_started = False
                self._current = replace(
                    self._current,
                    revision=revision,
                    query_status="stopped",
                    watcher_status="stopped",
                    job=job,
                    error=None,
                )
                accepted = self.snapshot()
                coroutine = (
                    self._run_remove(job_id, started_at)
                    if job_action == "remove"
                    else self._run_build(job_id, job_action, started_at)
                )
                self._job_task = asyncio.create_task(
                    coroutine,
                    name=f"harness-code-index-{job_id}",
                )
        if cancel_task is not None:
            await asyncio.gather(cancel_task, return_exceptions=True)
            return self.snapshot()
        assert accepted is not None
        await self._notify(accepted)
        return accepted

    async def close(self) -> None:
        """幂等停止自己的后台任务与查询进程；不删除索引目录。"""
        task: asyncio.Task[None] | None = None
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            task = self._job_task
            if task is not None and not task.done():
                task.cancel()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        stop_failed = False
        try:
            await self._runtime.stop_query()
        except Exception:
            stop_failed = True
        async with self._lock:
            self._query_started = False
            self._query_starting = False
            if self._current.index_status != "ready" or self._active_job():
                return
            revision = self._current.revision + 1
            lifecycle = "incomplete" if stop_failed else "ready"
            self._store.write(
                DurableCodeIndexState(
                    revision=revision,
                    generation=self._current.generation,
                    lifecycle=lifecycle,
                    last_job=self._last_job,
                )
            )
            self._current = replace(
                self._current,
                revision=revision,
                index_status="incomplete" if stop_failed else "ready",
                query_status="stopped",
                watcher_status="stopped",
                error=error_for("CODE_INDEX_INCOMPLETE") if stop_failed else None,
            )

    async def _run_build(self, job_id: str, action: str, started_at: str) -> None:
        try:
            if action != "initialize":
                await self._runtime.stop_query()
            result = await self._runtime.run_index(
                self._workspace,
                operation=action,
                on_progress=lambda progress: self._record_progress(job_id, action, started_at, progress),
            )
            await self._finish(job_id, action, started_at, result)
        except asyncio.CancelledError:
            cancelled = job_id in self._explicit_cancel_jobs
            self._explicit_cancel_jobs.discard(job_id)
            await self._finish(
                job_id,
                action,
                started_at,
                CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_INCOMPLETE")),
                cancelled=cancelled,
            )
            raise
        except BaseException:
            await self._finish(
                job_id,
                action,
                started_at,
                CodeIndexBuildResult(success=False, error=error_for("CODE_INDEX_INCOMPLETE")),
            )

    async def _run_remove(self, job_id: str, started_at: str) -> None:
        """停止查询后删除唯一受管目录；失败不谎报 absent。"""
        try:
            await self._runtime.stop_query()
            self._store.remove()
        except BaseException as exc:
            cancelled = isinstance(exc, asyncio.CancelledError) and job_id in self._explicit_cancel_jobs
            self._explicit_cancel_jobs.discard(job_id)
            async with self._lock:
                revision = self._current.revision + 1
                error_code: ErrorCode = (
                    "CODE_INDEX_PATH_UNSAFE"
                    if isinstance(exc, (CodeIndexPathError, CodeIndexStateError))
                    and str(exc) == "CODE_INDEX_PATH_UNSAFE"
                    else "CODE_INDEX_INCOMPLETE"
                )
                last_job = {
                    "id": job_id,
                    "action": "remove",
                    "started_at": started_at,
                    "finished_at": _now(),
                }
                try:
                    self._store.write(
                        DurableCodeIndexState(
                            revision=revision,
                            generation=self._current.generation,
                            lifecycle="cancelled" if cancelled else "incomplete",
                            last_job=last_job,
                        )
                    )
                except CodeIndexStateError:
                    # 原目录本身不安全时不能强行覆盖，只保留内存终态并继续 fail closed。
                    pass
                self._current = replace(
                    self._current,
                    revision=revision,
                    index_status="incomplete",
                    query_status="stopped",
                    watcher_status="stopped",
                    job={
                        **(self._current.job or {}),
                        "status": "cancelled" if cancelled else "failed",
                        "phase": "removing",
                        "message": "代码索引删除已取消。" if cancelled else "代码索引删除失败。",
                    },
                    error=error_for(error_code),
                )
                self._job_task = None
                snapshot = self.snapshot()
            await self._notify(snapshot)
            if isinstance(exc, asyncio.CancelledError):
                raise
            return
        async with self._lock:
            revision = self._current.revision + 1
            self._current = CodeIndexSnapshot(
                revision=revision,
                generation=self._current.generation,
                job={
                    "id": job_id,
                    "action": "remove",
                    "status": "succeeded",
                    "phase": "removing",
                    "message": "代码索引已删除。",
                },
            )
            self._job_task = None
            snapshot = self.snapshot()
        await self._notify(snapshot)

    async def _record_progress(
        self,
        job_id: str,
        action: str,
        started_at: str,
        progress: dict[str, object],
    ) -> None:
        async with self._lock:
            job = self._current.job
            if not isinstance(job, dict) or job.get("id") != job_id or job.get("status") != "running":
                return
            next_job = {**job, **progress, "message": "正在建立代码索引。"}
            revision = self._current.revision + 1
            self._store.write(
                DurableCodeIndexState(
                    revision=revision,
                    generation=self._current.generation,
                    lifecycle="running",
                    last_job={"id": job_id, "action": action, "started_at": started_at},
                )
            )
            self._current = replace(self._current, revision=revision, job=next_job)
            snapshot = self.snapshot()
        await self._notify(snapshot)

    async def _finish(
        self,
        job_id: str,
        action: str,
        started_at: str,
        result: CodeIndexBuildResult,
        *,
        cancelled: bool = False,
    ) -> None:
        query_workspace: Path | None = None
        async with self._lock:
            job = self._current.job
            if not isinstance(job, dict) or job.get("id") != job_id:
                return
            revision = self._current.revision + 1
            finished_at = _now()
            last_job = {
                "id": job_id,
                "action": action,
                "started_at": started_at,
                "finished_at": finished_at,
            }
            self._last_job = last_job
            if result.success and result.stats is not None:
                generation = self._current.generation + 1
                self._store.write(
                    DurableCodeIndexState(
                        revision=revision,
                        generation=generation,
                        lifecycle="serving",
                        last_job=last_job,
                    )
                )
                self._current = replace(
                    self._current,
                    revision=revision,
                    generation=generation,
                    index_status="ready",
                    query_status="starting",
                    watcher_status="starting",
                    job={**job, "status": "succeeded", "phase": "starting_query", "message": "正在启动代码索引查询。"},
                    stats=result.stats,
                    error=None,
                )
                query_workspace = self._workspace
            else:
                error = result.error or error_for("CODE_INDEX_INCOMPLETE")
                self._store.write(
                    DurableCodeIndexState(
                        revision=revision,
                        generation=self._current.generation,
                        lifecycle="cancelled" if cancelled else "incomplete",
                        last_job=last_job,
                    )
                )
                self._current = replace(
                    self._current,
                    revision=revision,
                    index_status="incomplete",
                    query_status="stopped",
                    watcher_status="stopped",
                    job={
                        **job,
                        "status": "cancelled" if cancelled else "failed",
                        "phase": "validating",
                        "message": "代码索引已取消。" if cancelled else "代码索引未完整建立。",
                    },
                    stats=None,
                    error=error,
                )
            self._job_task = None
            snapshot = self.snapshot()
        await self._notify(snapshot)
        if query_workspace is not None:
            await self._start_query_session(query_workspace, last_job)

    async def _start_query_session(self, workspace: Path, last_job: dict[str, str]) -> None:
        try:
            session = await self._runtime.start_query(workspace)
        except asyncio.CancelledError:
            await self._runtime.stop_query()
            raise
        except BaseException:
            await self._mark_query_failed(last_job)
            return
        if session.watcher_status == "failed":
            await self._runtime.stop_query()
            await self._mark_query_failed(last_job)
            return
        async with self._lock:
            if self._closed or self._current.index_status != "ready":
                return
            revision = self._current.revision + 1
            self._store.write(
                DurableCodeIndexState(
                    revision=revision,
                    generation=self._current.generation,
                    lifecycle="serving",
                    last_job=last_job,
                )
            )
            watcher = session.watcher_status if session.watcher_status != "failed" else "failed"
            self._query_started = watcher != "failed"
            job = self._current.job
            self._current = replace(
                self._current,
                revision=revision,
                query_status="ready" if self._query_started else "failed",
                watcher_status=watcher,
                job=None if not isinstance(job, dict) else {
                    **job,
                    "status": "succeeded",
                    "phase": "starting_query",
                    "message": "代码索引已建立。",
                },
            )
            snapshot = self.snapshot()
        await self._notify(snapshot)

    async def _mark_query_failed(self, last_job: dict[str, str]) -> None:
        async with self._lock:
            revision = self._current.revision + 1
            self._store.write(
                DurableCodeIndexState(
                    revision=revision,
                    generation=self._current.generation,
                    lifecycle="incomplete",
                    last_job=last_job,
                )
            )
            self._query_started = False
            self._current = replace(
                self._current,
                revision=revision,
                index_status="incomplete",
                query_status="failed",
                watcher_status="failed",
                error=error_for("CODE_INDEX_INCOMPLETE"),
            )
            snapshot = self.snapshot()
        await self._notify(snapshot)

    async def _explore_generation(self, generation: int, query: str, max_files: int) -> str:
        if generation != self._current.generation or not self._query_started:
            return "代码索引查询已过期。请改用 glob、grep 或 read_file。"
        try:
            return await self._runtime.explore(query, max_files)
        except BaseException:
            return "代码索引查询失败。请改用 glob、grep 或 read_file。"

    async def _release_lease(self, lease: CodeIndexQueryLease) -> None:
        async with self._lock:
            self._leases.discard(lease)

    async def _notify(self, snapshot: dict[str, object]) -> None:
        callback = self._on_changed
        if callback is None:
            return
        result = callback(snapshot)
        if inspect.isawaitable(result):
            await result

    def _active_job(self) -> bool:
        return isinstance(self._current.job, dict) and self._current.job.get("status") == "running"

    def _load_existing(self, current: CodeIndexSnapshot) -> CodeIndexSnapshot:
        try:
            state = self._store.load()
        except CodeIndexStateError as exc:
            code: ErrorCode = "CODE_INDEX_PATH_UNSAFE" if str(exc) == "CODE_INDEX_PATH_UNSAFE" else "CODE_INDEX_INCOMPLETE"
            return replace(current, index_status="incomplete", error=error_for(code))
        if state is None:
            return current
        if state.lifecycle == "ready":
            self._last_job = state.last_job
            return replace(current, revision=state.revision, generation=state.generation, index_status="ready")
        return replace(
            current,
            revision=state.revision,
            generation=state.generation,
            index_status="incomplete",
            error=error_for("CODE_INDEX_INCOMPLETE"),
        )

    @staticmethod
    def _snapshot_from_preflight(result: CodeIndexPreflight) -> CodeIndexSnapshot:
        if result.ok:
            return CodeIndexSnapshot()
        return CodeIndexSnapshot(runtime_status="unavailable", error=result.error)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
