"""文件准备和真正提交均检查持久化写者；Shell 开始前登记副作用。

准备文件 --> 固定任务/范围/写者代号 --> 用户审批
                                         |
提交文件 <-- 重查代号与范围 <-- 保存 running 记录
    |                              |
    +---- 保存成功/失败及停止确认 ---+

下游是 Snapshot 文件工具和命令中间件；崩溃留存 running，恢复不能自动重写。
"""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, ToolMessage

from harness_agent.runtime.fusion.roles import LEAD_CONTROLS, WORKER_CONTROLS
from harness_agent.runtime.fusion.snapshot import normalize_paths, path_allowed
from harness_agent.runtime.fusion.store import (
    FusionError,
    FusionStateStore,
    new_id,
    workspace_key,
)
from harness_agent.runtime.run_context import (
    current_approval_mode,
    plan_constraint_active,
)
from harness_agent.tools.file_mutation import MutationMetadata


def _mutates_git(command: str) -> bool:
    """Fusion 只允许 Git 查询；提交、暂存和配置均由用户在任务外完成。"""
    try:
        parts = shlex.split(command, posix=True)
    except ValueError:
        return True
    readonly = {
        "status",
        "diff",
        "log",
        "show",
        "ls-files",
        "ls-tree",
        "rev-parse",
        "blame",
        "grep",
        "check-ignore",
    }
    for index, token in enumerate(parts):
        if Path(token).name != "git":
            continue
        rest = parts[index + 1 :]
        while rest and rest[0] in {"-C", "--git-dir", "--work-tree"}:
            rest = rest[2:]
        if (
            not rest
            or rest[0] not in readonly
            or any(
                value.startswith(("--output", "--ext-diff", "--textconv"))
                for value in rest
            )
        ):
            return True
    return False


class FusionWriteGuard:
    """短同步 SQLite 事务覆盖文件 CAS 提交；不在网络或审批等待中持锁。"""

    def __init__(
        self,
        database_path: Path,
        *,
        project_fingerprint: str,
        workspace: Path,
        context_provider: Callable[[], Any],
    ) -> None:
        """注入持久化数据库和可信运行上下文，工具参数不能指定写者。"""
        self.database_path = database_path
        self.project = project_fingerprint
        self.workspace = workspace.resolve()
        self.key = workspace_key(workspace)
        self.context_provider = context_provider

    def _connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path, timeout=5, isolation_level=None
        )
        connection.row_factory = sqlite3.Row
        return connection

    def _check(
        self,
        connection: sqlite3.Connection,
        context: Any,
        *,
        path: str | None = None,
        host: bool = False,
    ) -> tuple[str, int, int] | None:
        lease = connection.execute(
            "SELECT * FROM fusion_leases WHERE workspace_key=?", (self.key,)
        ).fetchone()
        task_id = getattr(context, "fusion_task_id", None)
        if lease is None or lease["task_id"] is None:
            if task_id:
                raise FusionError("FUSION_LEASE_BUSY")
            return None
        if (
            not task_id
            or lease["task_id"] != task_id
            or lease["project_fingerprint"] != self.project
        ):
            raise FusionError("FUSION_LEASE_BUSY")
        expected_owner = "host" if host else "sidekick"
        if lease["owner"] != expected_owner or lease["generation"] != getattr(
            getattr(context, "fusion_state", None), "generation", None
        ):
            raise FusionError("FUSION_LEASE_BUSY")
        if not host and getattr(context, "fusion_role", None) != "sidekick":
            raise FusionError("FUSION_ROLE_DENIED")
        if current_approval_mode(
            context, fallback=getattr(context, "approval_mode", None)
        ) == "plan" or plan_constraint_active(context):
            raise FusionError("FUSION_ROLE_DENIED")
        row = connection.execute(
            "SELECT * FROM fusion_tasks WHERE project_fingerprint=? AND task_id=?",
            (self.project, task_id),
        ).fetchone()
        if (
            not row
            or not row["active"]
            or row["phase"] != ("CHECKING" if host else "WORKER_RUNNING")
        ):
            raise FusionError("FUSION_TASK_CONFLICT")
        data = json.loads(row["data_json"])
        revision = data.get("revision", 0)
        if revision != getattr(
            getattr(context, "fusion_state", None), "revision", None
        ) or (not host and data.get("report_id")):
            raise FusionError("FUSION_TASK_CONFLICT")
        if path is not None:
            if path.startswith(str(self.workspace) + "/"):
                relative = Path(path).relative_to(self.workspace).as_posix()
            else:
                relative = path.lstrip("/")
            normalized = normalize_paths(self.workspace, [relative])[0]
            order = connection.execute(
                "SELECT data_json FROM fusion_orders WHERE project_fingerprint=? AND task_id=? AND revision=?",
                (self.project, task_id, revision),
            ).fetchone()
            if not order or not path_allowed(
                normalized, json.loads(order[0])["allowed_paths"]
            ):
                raise FusionError("FUSION_PATH_INVALID")
        return task_id, revision, lease["generation"]

    def prepare(self, metadata: MutationMetadata) -> MutationMetadata:
        """准备时固定任务单和写者身份，批准后不能改用新范围。"""
        with self._connection() as connection:
            token = self._check(connection, self.context_provider(), path=metadata.path)
        return replace(metadata, fusion_authorization=token)

    @contextmanager
    def commit(self, metadata: MutationMetadata) -> Iterator[None]:
        """重查当前权限与代号；记录 running 后才允许文件实际落盘。"""
        connection = self._connection()
        operation_id = None
        try:
            connection.execute("BEGIN IMMEDIATE")
            token = self._check(connection, self.context_provider(), path=metadata.path)
            if token != metadata.fusion_authorization:
                raise FusionError("FUSION_LEASE_BUSY")
            if token:
                operation_id = new_id("file")
                task_id, revision, generation = token
                row = connection.execute(
                    "SELECT version FROM fusion_tasks WHERE project_fingerprint=? AND task_id=?",
                    (self.project, task_id),
                ).fetchone()
                connection.execute(
                    "INSERT INTO fusion_effects VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        self.project,
                        task_id,
                        operation_id,
                        getattr(self.context_provider(), "execution_id", "unknown"),
                        metadata.operation,
                        hashlib.sha256(metadata.path.encode()).hexdigest(),
                        row[0],
                        generation,
                        "running",
                        0,
                    ),
                )
            connection.commit()
            connection.execute("BEGIN IMMEDIATE")
            self._check(connection, self.context_provider(), path=metadata.path)
            try:
                yield
            except BaseException:
                if operation_id:
                    connection.execute(
                        "UPDATE fusion_effects SET state='failed',stopped=1 WHERE project_fingerprint=? AND operation_id=?",
                        (self.project, operation_id),
                    )
                connection.commit()
                raise
            else:
                if operation_id:
                    connection.execute(
                        "UPDATE fusion_effects SET state='succeeded',stopped=1 WHERE project_fingerprint=? AND operation_id=?",
                        (self.project, operation_id),
                    )
                connection.commit()
        finally:
            if connection.in_transaction:
                connection.rollback()
            connection.close()

    def check_command(self, context: Any, *, host: bool = False) -> None:
        """命令实际执行前再次检查写者；普通执行不能借用 Fusion 写者。"""
        with self._connection() as connection:
            self._check(connection, context, host=host)


class FusionEffectMiddleware(AgentMiddleware):
    """覆盖普通图写工具、Shell 和外部工具；Fusion 控制工具不持有写锁。"""

    def __init__(self, guard: FusionWriteGuard, store: FusionStateStore) -> None:
        """把普通执行和 Fusion 执行接入同一个实际工具边界。"""
        super().__init__()
        self.guard = guard
        self.store = store

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """占用已明确时由程序结束本轮；不再让模型选择重试、返工或追问。"""
        context = getattr(runtime, "context", None)
        task_id = getattr(context, "fusion_task_id", None)
        if not task_id or getattr(context, "fusion_role", None) != "lead":
            return None
        task = await self.store.get(task_id)
        if not task.active or task.data.get("reason") != "workspace_busy":
            return None
        blocker = task.data.get("workspace_blocker") or {}
        thread_id = blocker.get("thread_id")
        source = f"会话 {thread_id}" if thread_id else "另一任务"
        message = (
            f"工作区被{source}占用。当前 Fusion 任务尚未取得写权限，已暂停派单，本轮不会继续重试。"
            "\n请用 /resume 返回占用会话，查看 /fusion status；"
            "需要结束旧任务时，在旧会话执行 /fusion cancel，已修改文件会保留。"
        )
        if blocker.get("requires_inspection"):
            message += "\n旧任务有结果不明的操作，请先核查是否停止，再按原恢复流程处理，不能强行释放写权限。"
        message += (
            "\n处理占用后，回到本对话发送继续。没有首轮任务单时应使用首次派单入口。"
        )
        return {
            "messages": [
                AIMessage(
                    content=message,
                    id=f"fusion-workspace-wait-{task.task_id}-{task.version}",
                )
            ],
            "jump_to": "end",
        }

    async def awrap_tool_call(self, request: Any, handler: Callable[..., Any]) -> Any:
        """审批恢复后登记 Shell；取消无法证明停止时保留未知操作。"""
        name = request.tool_call["name"]
        context = getattr(request.runtime, "context", None)
        # 仅实际任务中的已登记控制工具免查写者；普通扩展不能借名称前缀越权。
        if (
            getattr(context, "fusion_task_id", None)
            and name in LEAD_CONTROLS | WORKER_CONTROLS
        ) or name in {
            "ls",
            "read_file",
            "glob",
            "grep",
            "lsp",
            "codebase_explore",
            "ask_user",
            "task",
            "write_todos",
            "enter_plan_mode",
            "exit_plan_mode",
            "memory_search",
            "web_search",
            "web_fetch",
            "tool_search",
        }:
            return await handler(request)
        effect = None
        try:
            self.guard.check_command(context)
            task_id = getattr(context, "fusion_task_id", None)
            if name == "execute" and task_id:
                command = str(request.tool_call.get("args", {}).get("command", ""))
                if _mutates_git(command) or re.search(
                    r"(?<!&)&(?!&)|\b(nohup|disown|setsid)\b|\.git(?:/|\b)|\.harness-index",
                    command,
                ):
                    raise FusionError("FUSION_COMMAND_INVALID")
                effect = await self.store.begin_effect(
                    task_id,
                    context.fusion_state.generation,
                    context.execution_id,
                    name,
                    hashlib.sha256(command.encode()).hexdigest(),
                )
            result = await handler(request)
            if effect:
                content = str(getattr(result, "content", "")).lower()
                codes = re.findall(
                    r"\[command (?:succeeded|failed) with exit code (\d+)\]", content
                )
                exit_code = int(codes[-1]) if codes else None
                stopped = (
                    exit_code is not None and 0 <= exit_code <= 255 and exit_code != 124
                )
                await self.store.finish_effect(
                    effect, succeeded=exit_code == 0, stopped=stopped
                )
                if not stopped:
                    await self.store.pause(task_id)
            return result
        except FusionError as exc:
            return ToolMessage(
                content=exc.code,
                tool_call_id=request.tool_call["id"],
                name=name,
                status="error",
            )
        except BaseException:
            if effect:
                import asyncio

                await asyncio.shield(
                    self.store.finish_effect(effect, succeeded=False, stopped=False)
                )
                await asyncio.shield(self.store.pause(context.fusion_task_id))
            raise
