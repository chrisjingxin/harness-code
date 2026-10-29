"""文件准备和真正提交均检查持久化写者；Shell 开始前登记副作用。

准备文件 --> 固定任务/范围/写者代号 --> 用户审批
                                         |
提交文件 <-- 重查代号与范围 <-- 保存 running 记录
    |                              |
    +---- 保存成功/失败及停止确认 ---+

下游是 Snapshot 文件工具和命令中间件；崩溃留存 running，恢复不能自动重写。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shlex
import sqlite3
from collections.abc import AsyncIterator, Callable, Iterable, Iterator, Mapping
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import replace
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, ToolMessage

from harness_agent.policy.bash_parser import parse_bash, strip_wrappers
from harness_agent.runtime.fusion.resources import (
    AccessPermit,
    FusionResources,
    scopes_overlap,
)
from harness_agent.runtime.fusion.roles import LEAD_CONTROLS, WORKER_CONTROLS
from harness_agent.runtime.fusion.snapshot import (
    capture_snapshot,
    changed_paths,
    normalize_paths,
    path_allowed,
)
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


def _invalid_command(command: str, *, depth: int = 0) -> bool:
    """检查真实 Shell 操作；Python 字符串和 here-doc 内的 & 不是后台。"""
    if (
        depth >= 8
        or _mutates_git(command)
        or re.search(
            r"\b(nohup|disown|setsid)\b|\.git(?:/|\b)|\.harness-index", command
        )
    ):
        return True
    tree = parse_bash(command)
    if tree is None:
        return True
    pending = [tree]
    while pending:
        node = pending.pop()
        if node["type"] in {"&", "ERROR"}:
            return True
        if node["type"] == "command":
            text = node["text"]
            inner = strip_wrappers(text)
            if inner != text and _invalid_command(inner, depth=depth + 1):
                return True
            if inner == text:
                try:
                    words = shlex.split(text, posix=True)
                except ValueError:
                    return True
                if words and (
                    (words[0] == "cd" and "/" in words[1:])
                    or (Path(words[0]).name == "find" and "/" in words[1:])
                ):
                    # 文件工具的虚拟根不能用于 Shell，否则会离开项目并全盘搜索。
                    return True
                shells = {
                    "bash",
                    "sh",
                    "dash",
                    "zsh",
                    "ksh",
                    "fish",
                    "cmd",
                    "powershell",
                    "pwsh",
                }
                # find -exec / busybox 等尚未能展开的 Shell 载荷仍保守拒绝；
                # 放行普通 Python 数据参数不意味着放开嵌套脚本的后台语法。
                if re.search(r"(?<!&)&(?!&)", text) and any(
                    Path(word).name.lower().removesuffix(".exe") in shells
                    for word in words
                ):
                    return True
        pending.extend(node.get("children", ()))
    return False


def _repeated_rejection(
    state: Any, *, include_unknown: bool = False
) -> tuple[str, str] | None:
    """只在本轮连续三次相同工具拒绝时收尾；成功结果或新任务中断计数。"""
    if not isinstance(state, Mapping):
        return None
    previous = None
    count = 0
    codes = {
        "FUSION_COMMAND_INVALID",
        "FUSION_LEASE_BUSY",
        "FUSION_ROLE_DENIED",
        "FUSION_TASK_CONFLICT",
        "FUSION_PATH_INVALID",
        "FUSION_CHECK_INVALID",
        "FUSION_INPUT_INVALID",
        "FUSION_FIRST_ORDER_REQUIRED",
        "FUSION_EXPLORATION_BUSY",
        "FUSION_REPORT_STALE",
        "FUSION_EVIDENCE_INCOMPLETE",
        "FUSION_TEST_REVIEW_REQUIRED",
    }
    for message in reversed(state.get("messages", ())):
        if getattr(message, "type", None) == "human":
            break
        if not isinstance(message, ToolMessage):
            continue
        if message.status != "error" or not isinstance(message.content, str):
            return None
        code = message.content.split("：", 1)[0].split(":", 1)[0].strip()
        if message.content.lstrip().startswith("{"):
            try:
                data = json.loads(message.content)
            except (ValueError, TypeError):
                return None
            error = data.get("error") if isinstance(data, dict) else None
            # 文件工具用 error.code，Fusion 控制工具直接返回 error 字符串。
            code = error.get("code") if isinstance(error, dict) else error
        # 工具结果属于输入数据；异常对象或数组不能作为错误码参与集合查询。
        if not isinstance(code, str) or code not in codes:
            if not include_unknown:
                return None
            code = "TOOL_REJECTED"
        key = (message.name or "工具", code)
        if previous is not None and key != previous:
            return None
        previous = key
        count += 1
        if count == 3:
            return key
    return None


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
        self.resources = FusionResources(database_path, project_fingerprint, self.key)
        self._permit: ContextVar[AccessPermit | None] = ContextVar(
            "fusion-access-" + self.key, default=None
        )

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
        check_resources: bool = True,
    ) -> tuple[str, int, int] | None:
        if getattr(getattr(context, "fusion_state", None), "exploration_only", False):
            raise FusionError("FUSION_ROLE_DENIED")
        permit = self._permit.get()
        task_id = getattr(context, "fusion_task_id", None)
        relative = self._relative(path) if path is not None else "./"
        if check_resources:
            if (
                permit
                and not connection.execute(
                    "SELECT 1 FROM fusion_access WHERE request_id=? AND project_fingerprint=? AND state IN ('running','unknown')",
                    (permit.request_id, self.project),
                ).fetchone()
            ):
                raise FusionError("FUSION_LEASE_BUSY")
            for active in connection.execute(
                "SELECT request_id,kind,paths_json FROM fusion_access WHERE workspace_key=? AND state IN ('running','unknown') AND kind!='reservation'",
                (self.key,),
            ):
                if permit and active["request_id"] == permit.request_id:
                    continue
                if (
                    active["kind"] != "file"
                    or path is None
                    or scopes_overlap([relative], json.loads(active["paths_json"]))
                ):
                    raise FusionError("FUSION_LEASE_BUSY")
        if not task_id:
            if check_resources:
                for held in connection.execute(
                    "SELECT * FROM fusion_reservations WHERE workspace_key=? AND owner IS NOT NULL",
                    (self.key,),
                ):
                    if scopes_overlap([relative], json.loads(held["paths_json"])):
                        raise FusionError("FUSION_LEASE_BUSY")
            return None
        lease = connection.execute(
            "SELECT * FROM fusion_reservations WHERE workspace_key=? AND project_fingerprint=? AND task_id=? AND owner IS NOT NULL",
            (self.key, self.project, task_id),
        ).fetchone()
        if lease is None:
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
            token = self._check(
                connection,
                self.context_provider(),
                path=metadata.path,
                check_resources=False,
            )
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
                operation_id = (
                    self._permit.get().request_id
                    if self._permit.get()
                    else new_id("file")
                )
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
            try:
                self._check(connection, self.context_provider(), path=metadata.path)
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

    def _relative(self, path: str) -> str:
        if path.startswith(str(self.workspace) + "/"):
            value = Path(path).relative_to(self.workspace).as_posix()
        else:
            value = path.lstrip("/")
        return normalize_paths(self.workspace, [value])[0]

    @asynccontextmanager
    async def operation(
        self,
        kind: str,
        *,
        context: Any = None,
        paths: Iterable[str] = ("./",),
        host: bool = False,
        request_id: str | None = None,
    ) -> AsyncIterator[AccessPermit]:
        """先排队再进入本机工具锁；嵌套文件契约和后端复查共用同一许可。"""
        current = self._permit.get()
        wanted = (
            tuple(self._relative(path) for path in paths) if kind == "file" else ("./",)
        )
        covers = current is not None and (
            current.kind in {"command", "snapshot"}
            or current.kind == kind
            and all(path_allowed(path, current.paths) for path in wanted)
        )
        if (
            current
            and current.task_id == getattr(context, "fusion_task_id", None)
            and covers
        ):
            with self._connection() as connection:
                live = connection.execute(
                    "SELECT 1 FROM fusion_access WHERE request_id=? AND project_fingerprint=? AND state='running'",
                    (current.request_id, self.project),
                ).fetchone()
            if live:
                yield current
                return
        if getattr(getattr(context, "fusion_state", None), "inspection_only", False):
            raise FusionError("FUSION_ROLE_DENIED")

        async def notify(request: str, blocker: dict[str, Any] | None) -> None:
            service = getattr(context, "fusion_service", None)
            if service is not None:
                await service.resource_wait(context, request, blocker)

        async with self.resources.operation(
            kind,
            paths=wanted,
            task_id=getattr(context, "fusion_task_id", None),
            context=context,
            host=host,
            request_id=request_id,
            on_wait=notify,
        ) as permit:
            token = self._permit.set(permit)
            try:
                yield permit
            finally:
                self._permit.reset(token)

    def check_command(self, context: Any, *, host: bool = False) -> None:
        """执行前验证当前许可与任务；后端只能复用 Host 私有上下文中的许可。"""
        permit = self._permit.get()
        if context is None and permit is not None:
            context, host = permit.context, permit.host
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
        """已提交或反复受阻的 Worker 直接结束；Lead 占用等待保持原规则。"""
        context = getattr(runtime, "context", None)
        task_id = getattr(context, "fusion_task_id", None)
        role = getattr(context, "fusion_role", None)
        if not task_id or role not in {"lead", "sidekick"}:
            return None
        task = await self.store.get(task_id)
        if role == "lead" and context.fusion_state.inspection_only:
            # 核查只读，不取得旧运行归属，不修改未知状态，也不强制补派单。
            if _repeated_rejection(state, include_unknown=True) is not None:
                return {
                    "messages": [
                        AIMessage(
                            content="只读核查连续遇到工具错误，本轮已停止。可输入 /fusion status 查看操作归属和当前会话处理说明；停止情况尚未因此确认。"
                        )
                    ],
                    "jump_to": "end",
                }
            return None
        scope = task.data.get("active_run")
        if (
            not task.active
            or task.phase == "OUTCOME_UNKNOWN"
            or (
                scope is not None
                and scope["run_id"] != getattr(context, "run_id", None)
            )
        ):
            # 未知操作应立即核查；已结束或被接替的执行也不能再请求模型或补报告。
            return {"jump_to": "end"}
        if role == "sidekick" and context.fusion_state.exploration_only:
            if _repeated_rejection(state) is not None:
                return {
                    "messages": [
                        AIMessage(
                            content="只读探索连续受阻，停止重复调用，请 Lead 调整调查问题。"
                        )
                    ],
                    "jump_to": "end",
                }
            return None
        if role == "sidekick":
            if task.phase != "WORKER_RUNNING":
                return {"jump_to": "end"}
            if task.data.get("report_id"):
                return {"jump_to": "end"}
            rejection = _repeated_rejection(state)
            if task.phase == "WORKER_RUNNING" and rejection is not None:
                tool, code = rejection
                summary = f"Host 已暂停本轮：{tool} 连续三次返回 {code}，未取得进展。"
                await context.fusion_service.submit_result(
                    context,
                    status="blocked",
                    summary=summary,
                    unresolved=[
                        "请 Lead 检查失败原因并调整任务；不要原样重复遭拒绝的调用。"
                    ],
                )
                return {"jump_to": "end"}
            return None
        rejection = _repeated_rejection(state)
        if (
            task.active
            and task.data.get("reason") != "workspace_busy"
            and rejection is not None
        ):
            tool, code = rejection
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={"reason": "lead_control_rejected"},
            )
            if getattr(context, "fusion_service", None) is not None:
                context.fusion_service._emit(context, task)
            return {
                "messages": [
                    AIMessage(
                        content=f"{tool} 连续三次被拒绝（{code}），本轮已暂停。工具结果中有参数与修正说明；发送继续后可调整再执行。",
                        id=f"fusion-control-wait-{task.task_id}-{task.version}",
                    )
                ],
                "jump_to": "end",
            }
        if not task.active or task.data.get("reason") != "workspace_busy":
            return None
        blocker = task.data.get("workspace_blocker") or {}
        thread_id = blocker.get("thread_id")
        source = f"会话 {thread_id}" if thread_id else "另一任务"
        message = (
            f"工作区被{source}占用，当前任务已暂停派单。"
            "\n可直接在当前对话输入 /fusion resolve，结束占用任务并保留文件；成功后发送继续。"
        )
        if blocker.get("requires_inspection"):
            message += "\n若提示结果不明，请先核查相关命令和进程已停止，再在当前对话输入 /fusion resolve --stopped 核查说明；无需切换旧会话。"
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
        if getattr(getattr(context, "fusion_state", None), "exploration_only", False):
            from harness_agent.runtime.fusion.roles import READ_TOOLS

            if name not in READ_TOOLS | {"fusion_status"}:
                return ToolMessage(
                    content="FUSION_ROLE_DENIED: 只读探索不能调用此工具。",
                    tool_call_id=request.tool_call["id"],
                    name=name,
                    status="error",
                )
        # 控制工具返回的业务拒绝也必须呈现为失败，模型才能修正而非当作成功。
        if (
            getattr(context, "fusion_task_id", None)
            and name in LEAD_CONTROLS | WORKER_CONTROLS
        ):
            result = await handler(request)
            if isinstance(result, ToolMessage) and isinstance(result.content, str):
                try:
                    value = json.loads(result.content)
                except ValueError:
                    value = None
                if (
                    isinstance(value, dict)
                    and isinstance(value.get("error"), str)
                    and value["error"].startswith("FUSION_")
                ):
                    result.status = "error"
            return result
        # 仅实际任务中的已登记控制工具免查写者；普通扩展不能借名称前缀越权。
        if name in {
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
        if name in {"write_file", "edit_file", "delete_file"}:
            try:
                path = str(request.tool_call.get("args", {}).get("file_path", ""))
                async with self.guard.operation("file", context=context, paths=[path]):
                    return await handler(request)
            except ValueError as exc:
                return ToolMessage(
                    content=getattr(exc, "code", "FUSION_PATH_INVALID"),
                    tool_call_id=request.tool_call["id"],
                    name=name,
                    status="error",
                )
        effect = None
        permit = None
        scope = self.guard.operation("command", context=context)
        try:
            permit = await scope.__aenter__()
            self.guard.check_command(context)
            task_id = getattr(context, "fusion_task_id", None)
            if name == "execute" and task_id:
                command = str(request.tool_call.get("args", {}).get("command", ""))
                if _invalid_command(command):
                    raise FusionError("FUSION_COMMAND_INVALID")
                effect = await self.store.begin_effect(
                    task_id,
                    context.fusion_state.generation,
                    context.execution_id,
                    name,
                    hashlib.sha256(command.encode()).hexdigest(),
                    operation_id=permit.request_id,
                )
            source_before = None
            order = None
            if name == "execute" and task_id:
                task = await self.store.get(task_id)
                order = await self.store.load_record(
                    task_id, "order", str(task.data["revision"])
                )
                source_paths = [
                    "./",
                    *await self.store.claimed_paths(self.guard.key),
                    *order["allowed_paths"],
                ]
                source_before = await asyncio.to_thread(
                    capture_snapshot, self.guard.workspace, source_paths
                )
            permit.stopped = False
            result = await handler(request)
            permit.stopped = True
            if effect:
                content = str(getattr(result, "content", "")).lower()
                codes = re.findall(
                    r"\[command (?:succeeded|failed) with exit code (\d+)\]", content
                )
                exit_code = int(codes[-1]) if codes else None
                stopped = (
                    exit_code is not None and 0 <= exit_code <= 255 and exit_code != 124
                )
                if stopped and source_before is not None:
                    source_after = await asyncio.to_thread(
                        capture_snapshot, self.guard.workspace, source_paths
                    )
                    outside = [
                        path
                        for path in changed_paths(source_before, source_after)
                        if not path_allowed(path, order["allowed_paths"])
                    ]
                    if outside:
                        task = await self.store.get(task_id)
                        await self.store.update(
                            task_id,
                            task.version,
                            phase="WAITING_USER",
                            data={"reason": "out_of_scope", "outside_paths": outside},
                        )
                        result = ToolMessage(
                            content="FUSION_PATH_INVALID：命令执行期间，任务范围外的文件发生变化，已暂停本轮。请检查改动并调整 allowed_paths；不要原样重试。",
                            tool_call_id=request.tool_call["id"],
                            name=name,
                            status="error",
                        )
                await self.store.finish_effect(
                    effect, succeeded=exit_code == 0, stopped=stopped
                )
                permit.stopped = stopped
                if not stopped:
                    await self.store.pause(task_id)
            return result
        except FusionError as exc:
            return ToolMessage(
                content=exc.code
                + (
                    "：execute 默认就在项目目录；文件工具的 / 是虚拟根。使用项目相对路径，不要 cd /、find / 或启动后台进程。"
                    if exc.code == "FUSION_COMMAND_INVALID"
                    else ""
                ),
                tool_call_id=request.tool_call["id"],
                name=name,
                status="error",
            )
        except BaseException:
            if effect:
                await asyncio.shield(
                    self.store.finish_effect(
                        effect,
                        succeeded=False,
                        stopped=permit.stopped if permit is not None else True,
                    )
                )
                await asyncio.shield(self.store.pause(context.fusion_task_id))
            raise
        finally:
            if permit is not None:
                await scope.__aexit__(None, None, None)
