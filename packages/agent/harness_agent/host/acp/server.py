"""ACP Agent 服务：把 ACP 方法翻译成 `HostServicePort` 调用。

【这是做什么的？】
`AcpServer` 实现官方 SDK 的 Agent 接口（`initialize` / `newSession` / `prompt` /
`cancel`），只依赖 `host/service_types.py` 的窄接口 `HostServicePort`。它不继承
`acp.Agent`：那个 Protocol 的方法体是 `...`，继承后没实现的方法会回成功的 `{}`，
等于谎报能力；只实现需要的方法时，SDK 统一回 `-32601`。

【上下游】
- 上游：`stdio.py` 的 `run_acp_stdio`（真正实现）与测试里的传输层替身。
- 下游：`AgentHost` 服务面、`translate.RunTranslator`、`tool_display.PathLocator`。

【为什么出站要走一条队列】
SDK 的 `session_update` 每次 await 都会把整行写进 stdout 并 drain，但事件是由
Host 的扇出任务并发调 `sender` 进来的。如果直接在 `sender` 里 `await` 发送，
既可能乱序，也可能因为一个慢客户端把 Host 的扇出任务拖住（进而关闭连接）。
所以 `sender` 只做 `put_nowait`，由一个 pump 任务串行翻译 + 发送 + 决定终态。

【会话并发】
    同一会话：至多一个活动 Run（第二个 prompt 回 THREAD_BUSY，retryable）
    不同会话：允许并发（连接启用 run.multithread）

【一次 prompt 的顺序】
    prompt 请求 → 校验 → 转文本 → start_run(on_accepted 登记 Run)
              → await run.done（由 pump 在推完终态之前的所有 update 之后 resolve）
              → 返回 PromptResponse / 错误
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import sys
import time
import uuid
from collections.abc import Coroutine, Mapping, Sequence
from urllib.parse import unquote, urlparse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from acp.exceptions import RequestError
from acp.helpers import SessionUpdate
from acp.schema import (
    AgentCapabilities,
    AvailableCommandsUpdate,
    ConfigOptionUpdate,
    CurrentModeUpdate,
    Implementation,
    CloseSessionResponse,
    InitializeResponse,
    ListSessionsResponse,
    LoadSessionResponse,
    McpCapabilities,
    NewSessionResponse,
    PromptCapabilities,
    PromptResponse,
    ResumeSessionResponse,
    SessionAdditionalDirectoriesCapabilities,
    SessionCapabilities,
    SessionCloseCapabilities,
    SessionConfigOptionSelect,
    SessionListCapabilities,
    SessionResumeCapabilities,
    SetSessionConfigOptionResponse,
    SetSessionModeResponse,
    ToolCallUpdate,
    Usage,
)

from harness_agent import __version__
from harness_agent.diagnostic_log.runtime import ensure_log
from harness_agent.extensions.plugin_skills import SkillError
from harness_agent.extensions.skills import SkillError as CatalogSkillError
from harness_agent.host.acp.commands import CommandIndex
from harness_agent.host.acp.config import (
    MODEL_CONFIG_ID,
    WORKFLOW_CONFIG_ID,
    build_config_options,
    option_values,
)
from harness_agent.host.acp.inline import (
    MAX_SINGLE_FILE_BYTES,
    InlineBudget,
    InlinePiece,
    join_model_message,
    piece_for_bytes,
    placeholder,
)
from harness_agent.host.acp.ext import (
    Negotiation,
    agent_capabilities_meta,
    negotiate,
    run_meta,
)
from harness_agent.host.acp.elicitation import (
    ElicitationBroker,
    FormJob,
    forms_enabled,
    goal_form,
    plan_form,
    question_form,
)
from harness_agent.host.acp.modes import allowed_mode_ids, default_mode, mode_state
from harness_agent.host.acp.permissions import (
    PermissionBroker,
    PermissionDone,
    action_tool,
    build_approval_job,
    build_trust_job,
    parse_interaction,
)
from harness_agent.host.acp.sessions import (
    SESSIONS_PAGE_SIZE,
    decode_cursor,
    encode_cursor,
    replay_updates,
    session_info,
    session_info_update,
)
from harness_agent.host.acp.tool_display import PathLocator
from harness_agent.host.acp.translate import (
    MAX_OUTBOUND_FRAME_BYTES,
    TERMINAL_EVENT_TYPES,
    RunOutcome,
    RunTranslator,
    frame_chars,
)
from harness_agent.host.connection import ProtocolConnection, RpcError
from harness_agent.host.run_coordinator import RunError, UserRunInput
from harness_agent.host.service_types import (
    ApprovalModeName,
    HostServicePort,
    HostSnapshot,
    StartRunRequest,
)
from harness_agent.threads.thread_persistence import ThreadPersistenceError

PROTOCOL_VERSION = 1
"""S1 只支持 ACP 协议版本 1；客户端请求其它版本也回 1，由客户端决定是否断开。"""

MAX_PROMPT_SUMMARY_CHARS = 2000
"""错误响应里回显的 message 上限，避免把整段模型输出塞进错误帧。"""

_UPPERCASE_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
"""v3 稳定错误码的形状：全大写下划线。`RpcError.message` 就是它。"""

_SUPPORTED_INTERACTIONS: frozenset[str] = frozenset(
    {"interaction.approval", "interaction.directory_trust"}
)
"""没声明表单时能翻译的交互。提问、计划和目标只在声明了表单之后才入队。"""

_FORM_INTERACTIONS: frozenset[str] = frozenset(
    {"interaction.question", "interaction.plan", "interaction.goal"}
)
"""会画表单时改走 elicitation，不再按未知交互立刻拒绝。"""

_MODE_RACE_CODES: frozenset[str] = frozenset(
    {
        "RUN_APPROVAL_MODE_NOT_FOUND",
        "RUN_APPROVAL_MODE_TERMINAL",
        "RUN_APPROVAL_MODE_CANCELLED",
    }
)
"""「Run 刚好结束/正在被取消」的同一类竞态：模式只记在会话上，不向客户端报错。"""


@dataclass(slots=True)
class _Session:
    """一个 ACP 会话；sessionId 同时就是 Python 侧的 thread_id。"""

    session_id: str
    approval_mode: ApprovalModeName
    busy: bool = False
    cancel_requested: bool = False
    run: _ActiveRun | None = None
    # 切到 plan 之前的模式。批准计划后 Host 用它切回去。
    mode_before_plan: ApprovalModeName | None = None
    # 下一轮 prompt 才读这两项。运行中改配置不回头改已经受理的 Run。
    model_id: str | None = None
    workflow: str = "build"


@dataclass(slots=True)
class _ActiveRun:
    """在途 Run 的登记项；`done` 由 pump 在推完所有 update 后 resolve。"""

    run_id: str
    session_id: str
    translator: RunTranslator
    done: asyncio.Future[RunOutcome] = field(default=None)  # type: ignore[assignment]


def to_request_error(
    exc: BaseException,
    *,
    startup_error: str | None,
) -> RequestError:
    """把 Host 侧异常映射成 ACP 的 JSON-RPC 错误（纯函数，单独可测）。

    输入：`exc` 是 `start_run` 抛出的原始异常；`startup_error` 是 Host 当前的配置
          错误文本（用于区分「模型没配」和别的启动失败）。
    输出：带 `data = {code, message, retryable}` 的 `RequestError`。
    规则：
      - `RunError` → `-32603`，数据带稳定 code 与 retryable。
      - `RpcError(-32602)` → 保持 `-32602`（参数问题，客户端可修正）。
      - 其它 `RpcError` → `-32603`；`message` 是全大写错误码就直接用，等于
        `startup_error` 就是配置错误，其余用 `START_RUN_FAILED`。
      - 未知异常 → `-32603` + `INTERNAL_ERROR`，**不带异常文本**（可能含路径与
        内部细节），类型名只进日志。
    """
    if isinstance(exc, RunError):
        return RequestError(
            -32603,
            exc.code,
            {"code": exc.code, "message": exc.code, "retryable": exc.retryable},
        )
    if isinstance(exc, (SkillError, CatalogSkillError)):
        # `/命令` 的校验失败（绑定过期、参数不一致……）是客户端可修正的参数问题，
        # 全大写文案就是稳定的业务错误码，直接当 `data.code`，否则退化为 SKILL_ERROR。
        message = str(exc)
        code = message if _UPPERCASE_CODE.match(message) else "SKILL_ERROR"
        return RequestError(
            -32602,
            code,
            {"code": code, "message": _truncate(message), "retryable": False},
        )
    if isinstance(exc, ThreadPersistenceError):
        # 存储错误的文案里可能带路径或 SQL，只把「全大写错误码」当对外契约；
        # 其它文案统一降级为 THREAD_STORE_ERROR，不把原文写到线上。
        message = str(exc)
        code = message if _UPPERCASE_CODE.match(message) else "THREAD_STORE_ERROR"
        return RequestError(
            -32603,
            code,
            {"code": code, "message": code, "retryable": False},
        )
    if isinstance(exc, RpcError):
        if exc.code == -32004 and exc.message == "THREAD_NOT_FOUND":
            # ACP 的 -32002 才是「资源不存在」；线程损坏（THREAD_NOT_RECOVERABLE）
            # 不是客户端的错，走下面的 -32603 分支。
            return RequestError(
                -32002,
                "THREAD_NOT_FOUND",
                {"code": "THREAD_NOT_FOUND", "retryable": False},
            )
        if exc.code == -32602:
            message = exc.message or ""
            # 已经是稳定大写码的参数错误原样对外；普通文案仍收成 INVALID_PARAMS。
            code = message if _UPPERCASE_CODE.match(message) else "INVALID_PARAMS"
            data: dict[str, object] = {
                "code": code,
                "message": _truncate(message),
                "retryable": False,
            }
            if isinstance(exc.data, Mapping) and "path" in exc.data:
                data["path"] = exc.data["path"]
            return RequestError(-32602, message, data)
        message = exc.message or ""
        if _UPPERCASE_CODE.match(message):
            code = message
            detail = message
        elif startup_error is not None and message == startup_error:
            code = "CONFIGURATION_ERROR"
            detail = message
        else:
            code = "START_RUN_FAILED"
            detail = message or code
        return RequestError(
            -32603,
            code,
            {"code": code, "message": _truncate(detail), "retryable": False},
        )
    return RequestError(
        -32603,
        "INTERNAL_ERROR",
        {"code": "INTERNAL_ERROR", "message": "agent failed to start the run", "retryable": False},
    )


def _truncate(text: str) -> str:
    """把错误文案截到 `MAX_PROMPT_SUMMARY_CHARS`。"""
    if len(text) <= MAX_PROMPT_SUMMARY_CHARS:
        return text
    return text[: MAX_PROMPT_SUMMARY_CHARS - 1] + "…"


def prompt_text(prompt: Sequence[object]) -> str:
    """把 ACP prompt 内容块转成发送给模型的纯文本。

    输入：`PromptRequest.prompt`（SDK 已解析成模型对象列表）。
    输出：多块用换行拼接的文本。
    异常：`RequestError(-32602)`——嵌入资源/图片/音频不支持（能力里已声明不支持），
          文本全空白也拒绝（Run 不接受空消息）。
    """
    parts: list[str] = []
    for block in prompt:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            parts.append(str(getattr(block, "text", "")))
        elif block_type == "resource_link":
            parts.append(_resource_link_text(str(getattr(block, "uri", ""))))
        else:
            raise RequestError(
                -32602,
                "UNSUPPORTED_CONTENT_BLOCK",
                {"code": "UNSUPPORTED_CONTENT_BLOCK", "type": block_type},
            )
    text = "\n".join(parts)
    if not text.strip():
        raise RequestError(
            -32602,
            "EMPTY_PROMPT",
            {"code": "EMPTY_PROMPT", "message": "prompt must contain non-empty text"},
        )
    return text


def _resource_link_text(uri: str) -> str:
    """把 `file://` 链接转成 `@路径`；其它 scheme 原样保留为 `@uri`。

    工作区内的绝对路径交给模型更自然（与 CLI 的 `@` 提及一致）；工作区判断不在
    这里做，因为只是文本提示，越界的绝对路径仍会被文件工具自己的边界检查拒绝。
    """
    prefix = "file://"
    if uri.startswith(prefix):
        path = uri[len(prefix) :]
        return f"@{path}"
    return f"@{uri}"


class AcpServer:
    """ACP 服务端：实现 SDK 需要的四个方法，其余由 SDK 回 -32601。"""

    def __init__(self, host: HostServicePort, *, log: object | None = None) -> None:
        """保存 Host 与诊断日志；连接、会话、队列都在第一次方法调用时创建。"""
        self._host = host
        self._log = ensure_log(log)
        self._client: Any | None = None
        self._connection: ProtocolConnection | None = None
        # 握手闸门（§6.1）：initialize 一进入就创建，结束时 resolve。
        # True=成功 False=失败；不用 set_exception，避免「无等待者」告警。
        self._init_future: asyncio.Future[bool] | None = None
        self._sessions: dict[str, _Session] = {}
        self._runs: dict[str, _ActiveRun] = {}
        self._outbox: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
        self._pump_task: asyncio.Task[None] | None = None
        self._closing = False
        self._outbound_broken = False
        self._in_flight = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._snapshot: HostSnapshot | None = None
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._broker: PermissionBroker | None = None
        self._forms = False
        self._elicitation: ElicitationBroker | None = None
        # 连接级命令表（2.5）。握手时绑定一次；绑定失败就保持空表，`/x` 当普通文本。
        self._commands: CommandIndex = CommandIndex()
        # 扩展协商（2.7）。没协商成功时任何帧都不带 `_meta.harnessCode`。
        self._ext: Negotiation = Negotiation()

    # —— SDK 入口 ——

    def on_connect(self, conn: object) -> None:
        """SDK 建立连接时回调；这里拿到推 `session/update` 的客户端对象。"""
        self._client = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: object | None = None,
        client_info: object | None = None,
        **kwargs: object,
    ) -> InitializeResponse:
        """握手：初始化 Host 资源、登记连接、启动发送泵。

        异常：`RequestError(-32600)` 重复 initialize；`-32603` + `HOST_INIT_FAILED`
              资源初始化失败（客户端应重试或提示用户）。
        """
        started = time.monotonic()
        if self._init_future is not None:
            raise RequestError(-32600, "ALREADY_INITIALIZED", {"code": "ALREADY_INITIALIZED"})
        # 必须在第一个 await 之前创建：流水线到达的 session/* 会凭它判断
        # 「initialize 进行中」而不是「还没握手」。
        self._init_future = asyncio.get_running_loop().create_future()
        try:
            snapshot = await self._host.ensure_ready()
        except Exception as exc:
            self._init_future.set_result(False)
            self._log_failure("initialize", started, "ensure_ready", exc, "HOST_INIT_FAILED")
            raise RequestError(
                -32603,
                "HOST_INIT_FAILED",
                {"code": "HOST_INIT_FAILED", "retryable": True},
            ) from exc
        self._snapshot = snapshot
        # 协商只在第一次握手做；没声明或声明无效时 `self._ext` 保持默认（全部关闭）。
        self._ext = negotiate(client_capabilities)
        self._forms = forms_enabled(client_capabilities)
        handles = ["approval", "directory_trust"]
        if self._forms:
            handles.extend(("question", "plan", "goal"))
        self._connection = self._host.open_connection(
            self._sender,
            enabled_capabilities=(
                "run.multithread",
                "run.cancel",
                "threads.read",
                "run.approval_mode",
                "models.select",
            ),
            interaction_handles=tuple(handles),
            role="owner",
        )
        self._elicitation = (
            ElicitationBroker(
                host=self._host,
                connection=self._connection,
                client=self._client,
                log=self._log,
            )
            if self._forms
            else None
        )
        self._broker = PermissionBroker(
            host=self._host,
            connection=self._connection,
            client=self._client,
            log=self._log,
            on_done=self._on_permission_done,
            elicitation=self._elicitation,
        )
        await self._bind_commands(snapshot)
        self._pump_task = asyncio.create_task(self._pump(), name="harness-acp-pump")
        self._log_request("initialize", started)
        # resolve 必须发生在返回之前：从这里到 SDK 把响应 put 进发送队列之间
        # 没有挂起点（无界队列 put 不让出），被唤醒的 session/* 任务只会在
        # 本响应入队之后才得到运行机会，所以「initialize 响应一定先到达」。
        self._init_future.set_result(True)
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(
                load_session=True,
                prompt_capabilities=PromptCapabilities(
                    image=False, audio=False, embedded_context=True
                ),
                mcp_capabilities=McpCapabilities(http=True, sse=False, acp=False),
                session_capabilities=SessionCapabilities(
                    list=SessionListCapabilities(),
                    resume=SessionResumeCapabilities(),
                    close=SessionCloseCapabilities(),
                    additional_directories=SessionAdditionalDirectoriesCapabilities(),
                ),
                field_meta=agent_capabilities_meta(self._ext),
            ),
            auth_methods=[],
            agent_info=Implementation(
                name="harness-code",
                title="Harness Code",
                version=__version__,
            ),
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[object] | None = None,
        **kwargs: object,
    ) -> NewSessionResponse:
        """建立会话：校验 cwd 是本进程绑定的工作区，生成 sessionId。

        异常：`-32600` 未 initialize；`-32602` + `WORKSPACE_MISMATCH` cwd 不匹配；
              `-32602` + `INVALID_ADDITIONAL_DIRECTORY` 附加目录整单拒绝。
        会话 MCP 里跳过的项只记诊断，不让建会话失败，也不把命令或环境变量写进日志。
        """
        started = time.monotonic()
        await self._ready()
        workspace = self._host.workspace
        if not _same_workspace(cwd, workspace):
            self._log_failure("session/new", started, "workspace_check", None, "WORKSPACE_MISMATCH")
            raise RequestError(
                -32602,
                "WORKSPACE_MISMATCH",
                {"code": "WORKSPACE_MISMATCH", "expected": str(workspace)},
            )
        session_id = str(uuid.uuid4())
        await self._apply_session_resources(session_id, additional_directories, mcp_servers)
        mode = _session_mode(self._snapshot, plan=self._forms)
        session = _Session(session_id=session_id, approval_mode=mode)
        self._sessions[session_id] = session
        self._log_request("session/new", started)
        # 命令列表在响应之后到达：SDK 先把响应入队，后台任务才开始跑。
        self._spawn(self._push_commands(session_id))
        return NewSessionResponse(
            session_id=session_id,
            modes=mode_state(mode, plan=self._forms),
            config_options=await self._config_options(session),
        )

    async def load_session(
        self,
        session_id: str,
        cwd: str,
        mcp_servers: list[object] | None = None,
        additional_directories: list[str] | None = None,
        **kwargs: object,
    ) -> LoadSessionResponse:
        """恢复历史会话：校验 cwd、读历史、逐条回放，回放完才返回响应。

        输入：`session_id` 同时是 Python 侧的 thread_id；`cwd` 必须命中工作区。
        输出：带模式的 `LoadSessionResponse`；在它之前客户端会收齐全部回放 update。
        异常：`-32600` 未 initialize；`-32602` + `WORKSPACE_MISMATCH`；
              `-32603` + `THREAD_BUSY`（本会话已有在途请求或线程有活动 Run）；
              `-32002` + `THREAD_NOT_FOUND`（线程不存在，含 `session/new` 后还没落库）。
        """
        started = time.monotonic()
        await self._ready()
        connection = self._require_connection()
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        if not _same_workspace(cwd, self._host.workspace):
            self._log_failure(
                "session/load", started, "workspace_check", None, "WORKSPACE_MISMATCH"
            )
            raise RequestError(
                -32602,
                "WORKSPACE_MISMATCH",
                {"code": "WORKSPACE_MISMATCH", "expected": str(self._host.workspace)},
            )
        await self._apply_session_resources(session_id, additional_directories, mcp_servers)
        session = await self._prepare_thread_session(
            connection, session_id, "session/load", started, replay=True
        )
        self._log_request("session/load", started)
        self._spawn(self._push_commands(session_id))
        return LoadSessionResponse(
            modes=mode_state(session.approval_mode, plan=self._forms),
            config_options=await self._config_options(session),
        )

    async def resume_session(
        self,
        cwd: str,
        session_id: str,
        additional_directories: list[object] | None = None,
        mcp_servers: list[object] | None = None,
        **kwargs: object,
    ) -> ResumeSessionResponse:
        """续接已落库线程：订阅事件但不回放历史，响应带模式。

        输入/校验与 `session/load` 完全一致；已在本连接登记且空闲的会话直接
        幂等成功（不重复读库、不重复订阅），两边都会照推一次命令表。
        异常：同 `session/load`（含 THREAD_BUSY / THREAD_NOT_FOUND / WORKSPACE_MISMATCH）。
        """
        started = time.monotonic()
        await self._ready()
        connection = self._require_connection()
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        if not _same_workspace(cwd, self._host.workspace):
            self._log_failure(
                "session/resume", started, "workspace_check", None, "WORKSPACE_MISMATCH"
            )
            raise RequestError(
                -32602,
                "WORKSPACE_MISMATCH",
                {"code": "WORKSPACE_MISMATCH", "expected": str(self._host.workspace)},
            )
        await self._apply_session_resources(session_id, additional_directories, mcp_servers)
        existing = self._sessions.get(session_id)
        if existing is not None and not existing.busy:
            self._log_request("session/resume", started)
            self._spawn(self._push_commands(session_id))
            return ResumeSessionResponse(
                modes=mode_state(existing.approval_mode, plan=self._forms),
                config_options=await self._config_options(existing),
            )
        session = await self._prepare_thread_session(
            connection, session_id, "session/resume", started, replay=False
        )
        self._log_request("session/resume", started)
        self._spawn(self._push_commands(session_id))
        return ResumeSessionResponse(
            modes=mode_state(session.approval_mode, plan=self._forms),
            config_options=await self._config_options(session),
        )

    async def close_session(
        self, session_id: str, **kwargs: object
    ) -> CloseSessionResponse:
        """关闭会话：取消在途 Run 与挂起审批、退订线程、移除登记；幂等。

        未知会话静默成功；已知会话的在途 Run 按现有取消语义收尾（对应 prompt
        响应为 cancelled）。S4 在此处释放会话级 MCP 与附加目录。
        """
        await self._ready()
        connection = self._require_connection()
        session = self._sessions.get(session_id)
        if session is None:
            return CloseSessionResponse()
        # 与 session/cancel 同序：先让 Run 进取消，再取消权限任务，避免
        # 「拒绝」抢在「取消」之前多恢复一轮。
        session.cancel_requested = True
        active = session.run
        if active is not None:
            await self._cancel_active(active)
        if self._broker is not None:
            self._broker.cancel_session(session_id)
        if self._elicitation is not None:
            self._elicitation.cancel_session(session_id)
        self._host.unwatch_thread(connection, session_id)
        self._sessions.pop(session_id, None)
        await self._drop_session_resources(session_id)
        return CloseSessionResponse()

    async def _prepare_thread_session(
        self,
        connection: ProtocolConnection,
        session_id: str,
        method: str,
        started: float,
        *,
        replay: bool,
    ) -> _Session:
        """load/resume 共用段：占位 + 订阅 + 失败清理；`replay` 决定是否回放历史。

        同步段内先置 busy 占位再 await：并发 load/resume 只有一个能过 busy
        检查，另一个立刻 THREAD_BUSY，不会重复读库或重复回放。
        """
        existing = self._sessions.get(session_id)
        if existing is not None and existing.busy:
            raise RequestError(
                -32603, "THREAD_BUSY", {"code": "THREAD_BUSY", "retryable": True}
            )
        session = existing or _Session(
            session_id=session_id,
            approval_mode=_session_mode(self._snapshot, plan=self._forms),
        )
        created = existing is None
        # 失败时只摘掉本次新加的订阅：该会话之前若已订阅成功，旧订阅要保留。
        was_watching = session_id in connection.watched_threads
        session.busy = True
        if created:
            self._sessions[session_id] = session
        self._begin_request()
        try:
            opened = await self._host.open_and_watch_thread(connection, session_id)
            if replay:
                messages = opened.get("messages")
                if isinstance(messages, Sequence) and not isinstance(messages, str):
                    for update in replay_updates(session_id, messages, PathLocator(self._host.resolve_display_path)):
                        await self._send(session_id, update)
        except BaseException as exc:
            # 失败时把占位、订阅、在途计数全部收干净，否则该会话永远 busy。
            if created:
                self._sessions.pop(session_id, None)
            if not was_watching:
                self._host.unwatch_thread(connection, session_id)
            if isinstance(exc, Exception):
                self._log_failure(method, started, "open_thread", exc, "THREAD_SESSION_FAILED")
                raise to_request_error(exc, startup_error=None) from exc
            raise
        finally:
            session.busy = False
            self._finish_request()
        return session

    async def list_sessions(
        self,
        cwd: str | None = None,
        cursor: str | None = None,
        **kwargs: object,
    ) -> ListSessionsResponse:
        """列出当前工作区的会话：每页 50 条，游标 keyset 翻页。

        输入：`cwd` 必须是本进程绑定的工作区（先判，不匹配直接回空且不解游标）；
              `cursor` 是上一页 `nextCursor` 原值。
        输出：按最后活动时间倒序的 `SessionInfo` 列表；`has_more` 时带 `nextCursor`，
              取本页最后一条的 (updated_at_ms, thread_id) 编码。
        异常：`-32600` 未 initialize；`-32602` + `INVALID_CURSOR`（游标乱码或形状不对）；
              `-32603` + `THREADS_UNAVAILABLE_IN_ECHO_MODE`（echo 模式没有线程存储）。
        """
        started = time.monotonic()
        await self._ready()
        self._require_connection()
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        workspace = self._host.workspace
        if cwd is not None and not _same_workspace(cwd, workspace):
            return ListSessionsResponse(sessions=[])
        after: tuple[int, str] | None = None
        if cursor is not None:
            try:
                after = decode_cursor(cursor)
            except RequestError as exc:
                self._log_failure(
                    "session/list", started, "cursor_decode", exc, "INVALID_CURSOR"
                )
                raise
        try:
            threads, has_more = await self._host.list_threads_page(
                SESSIONS_PAGE_SIZE, after
            )
        except Exception as exc:
            # 统一交给 `to_request_error` 一个出口：这里只记日志再抛出，不吞异常。
            self._log_failure("session/list", started, "list_threads_page", exc, "LIST_FAILED")
            raise to_request_error(exc, startup_error=None) from exc
        self._log_request("session/list", started)
        next_cursor = None
        if has_more and threads:
            last = threads[-1]
            next_cursor = encode_cursor((last.updated_at_ms, last.thread_id))
        return ListSessionsResponse(
            sessions=[session_info(thread, workspace, self._ext) for thread in threads],
            next_cursor=next_cursor,
        )

    async def prompt(
        self,
        session_id: str,
        prompt: list[Any],
        **kwargs: object,
    ) -> PromptResponse:
        """执行一轮对话：校验 → 转文本 → 受理 Run → 等终态 → 映射响应。

        异常：`-32002` 未知会话；`-32603` + `SHUTTING_DOWN` / `THREAD_BUSY` /
              运行失败；`-32602` 内容块不支持或空 prompt。
        """
        started = time.monotonic()
        await self._ready()
        connection = self._connection
        session = self._sessions.get(session_id)
        if connection is None or session is None:
            raise RequestError.resource_not_found(session_id)
        # busy 必须在第一个 await 之前置位，否则两个 prompt 会同时通过检查。
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        if session.busy:
            raise RequestError(
                -32603,
                "THREAD_BUSY",
                {"code": "THREAD_BUSY", "retryable": True},
            )
        # 先占住会话再读文件：读盘会让出，不能让第二个 prompt 也通过 busy 检查。
        session.busy = True
        session.cancel_requested = False
        self._begin_request()
        try:
            text, model_message = await self._prepare_prompt(prompt)
        except BaseException:
            session.busy = False
            self._finish_request()
            raise
        run_id = str(uuid.uuid4())
        # 本次 Run 提交给 Host 的模式；若用户在准备阶段改了模式，`on_accepted` 会补发。
        effective_mode = session.approval_mode
        active = _ActiveRun(
            run_id=run_id,
            session_id=session_id,
            translator=RunTranslator(run_id, PathLocator(self._host.resolve_display_path), subagent=self._ext.subagent),
            done=asyncio.get_running_loop().create_future(),
        )

        async def on_accepted(_accepted: object) -> None:
            # 登记不晚于第一个事件：扇出任务在回调之后才创建。
            session.run = active
            self._runs[run_id] = active
            if session.cancel_requested:
                await self._cancel_active(active)
                return
            if session.approval_mode != effective_mode:
                # 用户在 Run 准备阶段改了模式：这次 Run 已用旧模式起来，补一次提交，
                # 免得上层看到的模式与实际生效的模式不一致。
                with contextlib.suppress(RunError):
                    # Run 刚好结束或被取消：模式已经记在会话上，不向客户端报错。
                    await self._host.set_approval_mode(
                        connection, session_id, run_id, session.approval_mode
                    )

        try:
            workflow = session.workflow if session.workflow == "compose" else "build"
            await self._host.start_run(
                connection,
                StartRunRequest(
                    thread_id=session_id,
                    run_id=run_id,
                    mode=workflow,
                    input=UserRunInput(
                        text,
                        requested_skill=self._commands.match(text),
                        model_message=None if model_message == text else model_message,
                    ),
                    requested_primary_profile=session.model_id,
                    requested_approval_mode=session.approval_mode,
                    pre_plan_mode=(
                        session.mode_before_plan if session.approval_mode == "plan" else None
                    ),
                ),
                on_accepted=on_accepted,
            )
            outcome = await active.done
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            if session.cancel_requested:
                self._log_request("session/prompt", started)
                return PromptResponse(stop_reason="cancelled")
            startup_error = await self._current_startup_error()
            self._log_failure("session/prompt", started, "start_run", exc, "START_RUN_FAILED")
            raise to_request_error(exc, startup_error=startup_error) from exc
        finally:
            # 无论成功、失败还是取消，会话状态与在途计数都必须在这里收干净，
            # 否则 wait_idle 会一直等到宽限期结束才返回。
            session.busy = False
            session.run = None
            self._runs.pop(run_id, None)
            # Run 终态后清掉它挂起的权限任务：客户端可能永远不回答。
            if self._broker is not None:
                self._broker.cancel_run(run_id)
            if self._elicitation is not None:
                self._elicitation.cancel_run(run_id)
            self._finish_request()
        self._log_request("session/prompt", started)
        return self._prompt_response(outcome, session)

    async def set_session_mode(
        self, session_id: str, mode_id: str, **kwargs: object
    ) -> SetSessionModeResponse:
        """切换审批模式：有活动 Run 就提交给 Host，没有就只记在会话上。

        输入：`mode_id` 必须是当前连接广告过的模式。没声明表单时 `plan` 也是非法值。
        输出：`SetSessionModeResponse`；模式真的变了才推 `current_mode_update`。
        异常：`-32600` 未 initialize；`-32002` 未知会话；`-32602` + `UNKNOWN_MODE`；
              `-32603` + `RUN_APPROVAL_MODE_BUSY`（正在等审批，可重试）或
              `RUN_APPROVAL_MODE_PLAN_LOCKED`（计划锁定，不可重试）。
              `NOT_FOUND` / `TERMINAL` / `CANCELLED` 是同一类竞态，只记在会话上。
        """
        started = time.monotonic()
        await self._ready()
        connection = self._require_connection()
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        session = self._sessions.get(session_id)
        if session is None:
            raise RequestError.resource_not_found(session_id)
        if mode_id not in allowed_mode_ids(plan=self._forms):
            raise RequestError(
                -32602, "UNKNOWN_MODE", {"code": "UNKNOWN_MODE", "retryable": False}
            )
        mode: ApprovalModeName = cast(ApprovalModeName, mode_id)
        previous_mode = session.approval_mode
        previous_before = session.mode_before_plan
        # 先记到会话上再提交 Host：模式回声可能在 await 返回前就进泵，
        # 会话已经是新值时泵不再补发第二帧。
        session.approval_mode = mode
        if mode == "plan" and previous_mode != "plan":
            session.mode_before_plan = previous_mode
        elif previous_mode == "plan" and mode != "plan":
            session.mode_before_plan = None
        active = session.run
        if active is not None:
            try:
                await self._host.set_approval_mode(
                    connection, session_id, active.run_id, mode
                )
            except RunError as exc:
                if exc.code not in _MODE_RACE_CODES:
                    session.approval_mode = previous_mode
                    session.mode_before_plan = previous_before
                    # 忙与计划锁定是真失败：模式不记，交给统一错误映射给客户端。
                    raise to_request_error(exc, startup_error=None) from exc
        changed = previous_mode != mode
        if changed:
            await self._send(
                session_id,
                CurrentModeUpdate(
                    session_update="current_mode_update", current_mode_id=mode_id
                ),
            )
        self._log_request("session/set_mode", started)
        return SetSessionModeResponse()

    async def set_config_option(
        self,
        config_id: str,
        session_id: str,
        value: str | bool,
        **kwargs: object,
    ) -> SetSessionConfigOptionResponse:
        """改模型或工作流。只影响下一轮 prompt，不改已经在跑的 Run。

        未知 id 回 `UNKNOWN_CONFIG_OPTION`，值不在可选项里回 `INVALID_CONFIG_VALUE`。
        成功时既推 `config_option_update`，也在响应里带回整套选项。
        """
        await self._ready()
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        session = self._sessions.get(session_id)
        if session is None:
            raise RequestError.resource_not_found(session_id)
        if not isinstance(value, str):
            raise RequestError(
                -32602,
                "INVALID_CONFIG_VALUE",
                {"code": "INVALID_CONFIG_VALUE", "retryable": False},
            )
        options = await self._config_options(session)
        if config_id == MODEL_CONFIG_ID:
            model = next((item for item in options if item.id == MODEL_CONFIG_ID), None)
            if model is None:
                raise RequestError(
                    -32602,
                    "UNKNOWN_CONFIG_OPTION",
                    {"code": "UNKNOWN_CONFIG_OPTION", "retryable": False},
                )
            if value not in option_values(model):
                raise RequestError(
                    -32602,
                    "INVALID_CONFIG_VALUE",
                    {"code": "INVALID_CONFIG_VALUE", "retryable": False},
                )
            session.model_id = value
        elif config_id == WORKFLOW_CONFIG_ID:
            if value not in {"build", "compose"}:
                raise RequestError(
                    -32602,
                    "INVALID_CONFIG_VALUE",
                    {"code": "INVALID_CONFIG_VALUE", "retryable": False},
                )
            session.workflow = value
        else:
            raise RequestError(
                -32602,
                "UNKNOWN_CONFIG_OPTION",
                {"code": "UNKNOWN_CONFIG_OPTION", "retryable": False},
            )
        updated = await self._config_options(session)
        await self._send(
            session_id,
            ConfigOptionUpdate(session_update="config_option_update", config_options=updated),
        )
        return SetSessionConfigOptionResponse(config_options=updated)

    async def cancel(self, session_id: str, **kwargs: object) -> None:
        """取消该会话当前 Run 与挂起的审批；未知会话或已结束的 Run 静默忽略。

        顺序不能反：先让 Run 进入取消，再取消权限任务。反过来会让权限任务的
        `fail_interaction(reject)` 抢在取消之前，Run 会带着「拒绝」多恢复一轮。
        """
        session = self._sessions.get(session_id)
        if session is None:
            return
        session.cancel_requested = True
        active = session.run
        if active is not None:
            await self._cancel_active(active)
        if self._broker is not None:
            self._broker.cancel_session(session_id)
        if self._elicitation is not None:
            self._elicitation.cancel_session(session_id)

    # —— 给 stdio.py 的关闭钩子 ——

    async def begin_shutdown(self) -> None:
        """拒绝新 prompt，并取消所有在途 Run（取消后仍会送终态事件）。"""
        self._closing = True
        # 还在 `start_run` 准备阶段的 prompt 不在 `_runs` 里：置位 cancel_requested 后，
        # `on_accepted` 看到标志会立即取消它，而不是白等宽限期、让 Run 在后台继续跑。
        for session in self._sessions.values():
            if session.busy:
                session.cancel_requested = True
        for active in list(self._runs.values()):
            await self._cancel_active(active)

    async def wait_idle(self, timeout: float) -> bool:
        """等在途请求处理完；返回 False 表示宽限期用尽。"""
        if self._in_flight == 0:
            return True
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._idle.wait(), timeout)
            return True
        return self._in_flight == 0

    async def aclose(self) -> None:
        """关闭连接、停掉权限任务与发送泵，并兜底失败仍悬挂的 Run Future。

        顺序不能反：先放掉每个会话的额外目录和 MCP，再 `close_connection`
        让 Host 把挂起的交互 fail-closed，然后取消权限任务，最后才停泵。
        """
        for session_id in list(self._sessions):
            await self._drop_session_resources(session_id)
        connection = self._connection
        self._connection = None
        if connection is not None:
            with contextlib.suppress(Exception):
                await self._host.close_connection(connection)
        broker, self._broker = self._broker, None
        if broker is not None:
            await broker.aclose()
        elicitation, self._elicitation = self._elicitation, None
        if elicitation is not None:
            await elicitation.aclose()
        if self._pump_task is not None:
            self._pump_task.cancel()
            await asyncio.gather(self._pump_task, return_exceptions=True)
            self._pump_task = None
        for active in list(self._runs.values()):
            if not active.done.done():
                active.done.set_exception(ConnectionError("ACP connection closed"))
        self._runs.clear()

    # —— 内部：发送 ——

    async def _sender(self, frame: dict[str, object]) -> None:
        """Host 扇出回调：只入队，绝不抛异常。

        `_fanout_agent_event` 对非 owner 连接的 sender 异常会直接 `close_connection`，
        等于取消这条连接上的所有 Run；`role="owner"` 并不免疫（它按对象身份比较）。
        """
        try:
            method = frame.get("method")
            if method == "event":
                params = frame.get("params")
                if isinstance(params, Mapping):
                    self._outbox.put_nowait(("event", dict(params)))
                return
            if method == "thread.summary":
                # `threads.read` 打开后连接上多出来的通知只有这一种（标题自动生成完成）；
                # 不认识的其他 method 一律静默丢弃，绝不抛异常。
                params = frame.get("params")
                if isinstance(params, Mapping):
                    self._outbox.put_nowait(("thread_summary", dict(params)))
                return
            if method == "thread.approval_mode":
                params = frame.get("params")
                if isinstance(params, Mapping):
                    self._outbox.put_nowait(("approval_mode", dict(params)))
                return
            supported = _SUPPORTED_INTERACTIONS | _FORM_INTERACTIONS if self._forms else _SUPPORTED_INTERACTIONS
            if method in supported and isinstance(frame.get("id"), str):
                # 交给 pump：那里知道 Run/会话是否可用，也可能需要先补一张工具卡。
                self._outbox.put_nowait(("interaction", dict(frame)))
                return
            if isinstance(method, str) and method.startswith("interaction.") and "id" in frame:
                # 没声明的交互类型（提问/计划/目标）：立刻 fail-closed，否则 Run 会
                # 一直等到 24 小时的交互超时，客户端只能看到一张不动的工具卡。
                self._spawn(self._fail_interaction(frame))
        except Exception:  # noqa: BLE001 - sender 抛异常会让 Host 直接关闭连接，见 docstring
            self._log.error(
                "ipc.request.failed",
                {
                    "side": "server",
                    "method": "event",
                    "failure_stage": "sender",
                    "error_type": "SenderError",
                    "summary_code": "SENDER_FAILED",
                },
            )

    async def _fail_interaction(self, frame: Mapping[str, object]) -> None:
        """对无法处理的交互请求立刻回拒绝，避免 Run 挂死。"""
        connection = self._connection
        request_id = frame.get("id")
        if connection is None or not isinstance(request_id, str):
            return
        self._host.fail_interaction(
            connection,
            request_id,
            RpcError(-32004, "INTERACTION_UNAVAILABLE"),
        )

    async def _pump(self) -> None:
        """串行消费一条队列：事件、权限请求、审批完成结果都由它驱动。

        三条路必须共用一个消费者：批准后的 `in_progress` 与后续 `tool.completed`
        只有串行才能保证先后顺序。
        """
        while True:
            kind, payload = await self._outbox.get()
            try:
                if kind == "event":
                    await self._pump_event(payload)
                elif kind == "interaction":
                    await self._pump_interaction(payload)
                elif kind == "thread_summary":
                    await self._pump_thread_summary(payload)
                elif kind == "approval_mode":
                    await self._pump_approval_mode(payload)
                else:
                    await self._pump_approval_done(payload)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 单项失败不能杀死整条泵
                self._log.error(
                    "ipc.request.failed",
                    {
                        "side": "server",
                        "method": "session/update",
                        "failure_stage": "pump",
                        "error_type": type(exc).__name__,
                        "summary_code": "PUMP_FAILED",
                    },
                )
                if kind == "interaction":
                    # 审批没有超时：翻译或补卡阶段出错时若不立刻拒绝，Host 里的请求会一直
                    # 挂着，Run 只能等用户取消。fail_interaction 对已受理的请求是幂等的。
                    await self._fail_interaction(payload)

    async def _pump_event(self, payload: dict[str, object]) -> None:
        """翻译一条事件并发送它产出的 update；终态时补发并 resolve。"""
        active: _ActiveRun | None = None
        try:
            run_id = payload.get("run_id")
            active = self._runs.get(run_id) if isinstance(run_id, str) else None
            if active is None:
                # 没有等待者的迟到事件（Run 已结束或已清理）：直接丢弃。
                return
            await self._drain_event(active, payload)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - 单个事件失败不能杀死整条泵
            self._log.error(
                "ipc.request.failed",
                {
                    "side": "server",
                    "method": "session/update",
                    "failure_stage": "translate",
                    "error_type": type(exc).__name__,
                    "summary_code": "TRANSLATE_FAILED",
                },
            )
            # 终态事件的翻译或发送失败时，prompt 的 Future 永远不会被 resolve，
            # 客户端会一直等不到响应。这里补一个失败终态，让 prompt 以 -32603 返回。
            if (
                active is not None
                and payload.get("type") in TERMINAL_EVENT_TYPES
                and not active.done.done()
            ):
                active.done.set_result(
                    RunOutcome(
                        kind="failed",
                        error={
                            "code": "INTERNAL_ERROR",
                            "message": "ACP event translation failed",
                            "retryable": False,
                        },
                    )
                )

    async def _pump_interaction(self, frame: Mapping[str, object]) -> None:
        """把一条交互帧翻译成 ACP 权限请求：先补卡，再起权限任务。"""
        parsed = parse_interaction(frame)
        active = self._runs.get(parsed.run_id) if parsed is not None else None
        session = self._sessions.get(parsed.session_id) if parsed is not None else None
        if (
            parsed is None
            or active is None
            or session is None
            or self._closing
            or session.cancel_requested
            or self._outbound_broken
            or self._broker is None
        ):
            await self._fail_interaction(frame)
            return
        if parsed.kind == "approval":
            name, args, tool_call_id = action_tool(parsed.payload)
            target = active.translator.prepare_approval(
                request_id=parsed.request_id,
                name=name,
                args=args,
                tool_call_id=tool_call_id,
                is_child=parsed.is_child,
                agent_id=parsed.agent_id,
                execution_id=parsed.execution_id,
            )
            job = build_approval_job(
                parsed,
                target,
                ext_approval=self._ext.approval,
                workspace=self._host.workspace,
                forms=self._forms,
            )
        elif parsed.kind in {"question", "plan", "goal"}:
            await self._pump_form(parsed, frame, session)
            return
        else:
            target = active.translator.prepare_trust(
                request_id=parsed.request_id,
                directory=str(parsed.payload.get("directory") or ""),
                access=str(parsed.payload.get("access") or "read"),
                target_path=str(parsed.payload.get("target_path") or ""),
            )
            job = build_trust_job(parsed, target, ext_approval=self._ext.approval)
        if job is None:
            await self._fail_interaction(frame)
            return
        # 顺序不能反：客户端必须先在卡片存在时才能把权限请求挂上去。
        for update in target.updates:
            await self._send(parsed.session_id, update)
        # 补卡期间 await 过，session/cancel 可能刚好落在这个窗口：再看一眼，别多弹一次框。
        if session.cancel_requested or self._closing:
            await self._fail_interaction(frame)
            return
        self._broker.start(job)

    async def _pump_form(
        self,
        parsed: Any,
        frame: Mapping[str, object],
        session: _Session,
    ) -> None:
        """把提问、计划或目标收成一张表单。收不成就立刻拒绝，避免 Run 挂死。"""
        if self._elicitation is None or session.cancel_requested or self._closing:
            await self._fail_interaction(frame)
            return
        spec = {"question": question_form, "plan": plan_form, "goal": goal_form}[parsed.kind](
            parsed.payload
        )
        if spec is None:
            await self._fail_interaction(frame)
            return
        self._elicitation.start(
            FormJob(
                request_id=parsed.request_id,
                session_id=parsed.session_id,
                run_id=parsed.run_id,
                spec=spec,
            )
        )

    async def _pump_approval_mode(self, params: Mapping[str, object]) -> None:
        """别的路径改了审批模式：会话还没跟上时补一条 `current_mode_update`。"""
        session = self._sessions.get(str(params.get("thread_id") or ""))
        mode = params.get("mode")
        if session is None or not isinstance(mode, str) or session.approval_mode == mode:
            return
        previous = session.approval_mode
        if mode == "plan" and previous != "plan":
            session.mode_before_plan = previous
        elif previous == "plan" and mode != "plan":
            session.mode_before_plan = None
        session.approval_mode = cast(ApprovalModeName, mode)
        await self._send(
            session.session_id,
            CurrentModeUpdate(session_update="current_mode_update", current_mode_id=mode),
        )

    async def _pump_approval_done(self, done: PermissionDone) -> None:
        """权限任务收尾：批准的真实工具卡转 `in_progress`，兜底/信任卡直接终态。"""
        active = self._runs.get(done.job.frame.run_id)
        if active is None:
            # Run 已结束：终态补发已把卡片收尾，这里不再发任何东西。
            return
        approved = done.delivered == "resolved" and done.decision in done.job.allow_ids
        updates = active.translator.finish_card(done.job.card_id, ok=approved)
        if not updates and approved:
            updates = active.translator.mark_executing(done.job.card_id)
        for update in updates:
            await self._send(done.job.frame.session_id, update)

    async def _bind_commands(self, snapshot: HostSnapshot) -> None:
        """把命令表绑定到连接（每连接只能一次），成功后记下本地命令表。

        放在握手而不是首次 `session/new`：一个连接只能绑一次，放后边会出现
        「第一个会话绑了、第二个漏了」的歧义。失败只降级为「没有命令」，
        因为命令是增强功能，不能因为它拖垮整条连接的握手。
        """
        started = time.monotonic()
        connection = self._connection
        if connection is None:
            return
        bindings = [
            (str(command["id"]), str(command["name"]))
            for command in snapshot.agent_commands
            if isinstance(command.get("id"), str) and isinstance(command.get("name"), str)
        ]
        try:
            await self._host.bind_commands(
                connection, snapshot.skills_snapshot_id, bindings
            )
        except Exception as exc:  # noqa: BLE001 - 绑定失败只能降级为「无命令」，不能拖垮握手
            self._log_failure("initialize", started, "bind_commands", exc, "BIND_COMMANDS_FAILED")
            self._commands = CommandIndex()
            return
        self._commands = CommandIndex.from_snapshot(snapshot.agent_commands)

    async def _push_commands(self, session_id: str) -> None:
        """推送 `available_commands_update`；空表也发（§11.1 性能优化 1）。

        客户端没有别的信号能区分「命令表还在路上」和「这个 Agent 本来就没有
        命令」，空表帧就是那个「已落定」信号，缺了它客户端只能按超时兜底。
        """
        commands = self._commands.available_commands()
        await self._send(
            session_id,
            AvailableCommandsUpdate(
                session_update="available_commands_update",
                available_commands=commands,
            ),
        )

    async def _pump_thread_summary(self, params: Mapping[str, object]) -> None:
        """把 `thread.summary` 变成该会话的 `session_info_update`；未知会话直接丢弃。

        标题是后台任务生成的，可能晚于该会话的 prompt 响应到达；ACP 允许这种晚到的
        `session_info_update`，客户端按会话 id 合并。
        """
        session = self._sessions.get(str(params.get("thread_id")))
        if session is None:
            return
        update = session_info_update(params)
        if update is not None:
            await self._send(session.session_id, update)

    def _on_permission_done(self, done: PermissionDone) -> None:
        """权限任务的结果回调：只入队，绝不 await（顺序由 pump 串行保证）。"""
        self._outbox.put_nowait(("approval_done", done))

    async def _drain_event(self, active: _ActiveRun, payload: dict[str, object]) -> None:
        """翻译一条事件并发送它产出的 update；终态时补发并 resolve。"""
        result = active.translator.feed(payload)
        for update in result.updates:
            await self._send(active.session_id, update)
        if result.outcome is None:
            return
        for leftover in active.translator.leftovers():
            await self._send(active.session_id, leftover)
        if not active.done.done():
            # 一定排在本 Run 所有 update 之后：prompt 的响应由 handler 返回后入队。
            active.done.set_result(result.outcome)

    async def _send(self, session_id: str, update: SessionUpdate) -> None:
        """发一条 session/update；对端已断时静默放弃（不再重试，也不抛）。"""
        client = self._client
        if client is None or self._outbound_broken:
            return
        try:
            await client.session_update(session_id, _fit_update(update))
        except (ConnectionError, BrokenPipeError, RuntimeError):
            self._outbound_broken = True

    # —— 内部：会话资源、配置与 prompt 正文 ——

    async def _apply_session_resources(
        self,
        session_id: str,
        directories: Sequence[object] | None,
        servers: Sequence[object] | None,
    ) -> None:
        """先登记附加目录，再登记会话 MCP。MCP 失败时把刚登记的目录撤掉。

        目录校验失败时会话还没放进表里，调用方不会留下半个会话。
        """
        try:
            self._host.set_session_roots(session_id, list(directories or []))
        except RpcError as exc:
            raise to_request_error(exc, startup_error=None) from exc
        try:
            await self._host.set_session_mcp(session_id, _mcp_mappings(servers))
        except Exception:
            self._host.set_session_roots(session_id, [])
            raise

    async def _drop_session_resources(self, session_id: str) -> None:
        """关闭或断线时撤销这个线程名下的会话目录和会话 MCP。重复调用无副作用。"""
        self._host.set_session_roots(session_id, [])
        await self._host.set_session_mcp(session_id, [])

    async def _config_options(self, session: _Session) -> list[SessionConfigOptionSelect]:
        """读模型目录拼配置项。目录读失败就只留下工作流，不让建会话失败。"""
        profiles: list[Mapping[str, object]] = []
        last: str | None = None
        connection = self._connection
        if connection is not None:
            try:
                listed = await self._host.list_models(connection, session.session_id)
            except RpcError:
                listed = {}
            raw = listed.get("profiles") if isinstance(listed, Mapping) else None
            if isinstance(raw, list):
                profiles = [item for item in raw if isinstance(item, Mapping)]
            selection = listed.get("thread_selection") if isinstance(listed, Mapping) else None
            if isinstance(selection, Mapping) and isinstance(selection.get("primary_profile"), str):
                last = selection["primary_profile"]
        return build_config_options(
            profiles,
            selected_model=session.model_id,
            last_profile=last,
            workflow=session.workflow,
        )

    async def _prepare_prompt(self, prompt: Sequence[object]) -> tuple[str, str]:
        """把内容块收成（记录原文, 给模型的正文）。

        记录里只有用户文本和 `@路径`。授权根内的文件内容只出现在模型正文前面。
        图片、音频和二进制嵌入资源仍然拒绝。
        """
        parts: list[str] = []
        pieces: list[str] = []
        budget = InlineBudget()
        for block in prompt:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                parts.append(str(getattr(block, "text", "")))
                continue
            if block_type == "resource_link":
                mention, piece = await self._inline_link(str(getattr(block, "uri", "")), budget)
            elif block_type == "resource":
                mention, piece = self._inline_embedded(block, budget)
            else:
                raise RequestError(
                    -32602,
                    "UNSUPPORTED_CONTENT_BLOCK",
                    {"code": "UNSUPPORTED_CONTENT_BLOCK", "type": block_type},
                )
            parts.append(mention)
            if piece:
                pieces.append(piece)
        text = "\n".join(parts)
        if not text.strip():
            raise RequestError(
                -32602,
                "EMPTY_PROMPT",
                {"code": "EMPTY_PROMPT", "message": "prompt must contain non-empty text"},
            )
        return text, join_model_message(pieces, text)

    async def _inline_link(self, uri: str, budget: InlineBudget) -> tuple[str, str | None]:
        """根内文件读入内联块；其它链接保持 `@uri`，不读盘。"""
        path = _file_uri_path(uri)
        if path is None:
            return f"@{uri}", None
        authorized = self._host.authorize_existing_file(path)
        if authorized is None:
            return f"@{uri}", None
        try:
            piece = await asyncio.to_thread(_piece_from_file, authorized, budget)
        except OSError:
            return f"@{uri}", None
        return f"@{authorized}", piece.text

    def _inline_embedded(self, block: object, budget: InlineBudget) -> tuple[str, str | None]:
        """嵌入的文本按同样预算格式化。二进制嵌入没有文本可内联，直接拒绝。"""
        resource = getattr(block, "resource", None)
        uri = str(getattr(resource, "uri", "") or "")
        text = getattr(resource, "text", None)
        blob = getattr(resource, "blob", None)
        if isinstance(blob, str) or not isinstance(text, str):
            raise RequestError(
                -32602,
                "UNSUPPORTED_CONTENT_BLOCK",
                {"code": "UNSUPPORTED_CONTENT_BLOCK", "type": "resource"},
            )
        label = _file_uri_path(uri) or uri or "resource"
        piece = piece_for_bytes(label, text.encode("utf-8"), budget)
        return f"@{uri or label}", piece.text

    # —— 内部：Run 与响应 ——

    def _prompt_response(self, outcome: RunOutcome, session: _Session) -> PromptResponse:
        """把 Run 终态映射成 ACP 响应；失败时抛 `RequestError`。"""
        if outcome.kind == "completed":
            usage = _prompt_usage(outcome.summary)
            if self._ext.run_summary and outcome.summary:
                # 只有声明了 runSummary 的客户端才拿得到运行摘要。标准 usage 始终带上。
                return PromptResponse(
                    stop_reason="end_turn",
                    usage=usage,
                    field_meta=run_meta(outcome.summary),
                )
            return PromptResponse(stop_reason="end_turn", usage=usage)
        if outcome.kind == "cancelled" or session.cancel_requested:
            # ACP 约定：取消期间出现的错误一律按 cancelled 返回。
            return PromptResponse(stop_reason="cancelled")
        error = outcome.error or {}
        code = str(error.get("code") or "RUN_FAILED")
        message = error.get("message")
        detail = message if isinstance(message, str) and message else code
        raise RequestError(
            -32603,
            _truncate(detail),
            {
                "code": code,
                "message": _truncate(detail),
                "retryable": bool(error.get("retryable")),
            },
        )

    async def _cancel_active(self, active: _ActiveRun) -> None:
        """取消一个已受理的 Run；已结束或不属于本连接时吞掉错误。"""
        connection = self._connection
        if connection is None:
            return
        try:
            await self._host.cancel_run(connection, active.session_id, active.run_id)
        except RunError as exc:
            if exc.code != "RUN_NOT_FOUND":
                self._log.error(
                    "ipc.request.failed",
                    {
                        "side": "server",
                        "method": "session/cancel",
                        "failure_stage": "cancel",
                        "error_type": exc.code,
                        "summary_code": exc.code,
                    },
                )
        except Exception as exc:  # noqa: BLE001 - 取消失败只能记日志，不能让 prompt 崩
            self._log.error(
                "ipc.request.failed",
                {
                    "side": "server",
                    "method": "session/cancel",
                    "failure_stage": "cancel",
                    "error_type": type(exc).__name__,
                    "summary_code": "CANCEL_FAILED",
                },
            )

    async def _current_startup_error(self) -> str | None:
        """读最新的配置错误文本；失败按空处理（错误映射不能因此再失败）。"""
        try:
            snapshot = await self._host.ensure_ready()
        except Exception:  # noqa: BLE001 - 错误映射本身不能再失败，只能当作「没有配置错误」
            return None
        return snapshot.startup_error

    def _finish_request(self) -> None:
        """结束一个在途请求：清 busy/run 并更新空闲事件。"""
        self._in_flight = max(0, self._in_flight - 1)
        if self._in_flight == 0:
            self._idle.set()

    def _begin_request(self) -> None:
        """登记一个在途请求并清空闲事件。

        调用方必须已经在同一个同步段内完成所有校验（不能先 await 再调它），
        否则 `wait_idle` 与并发检查都会看到不一致的计数。
        """
        self._in_flight += 1
        self._idle.clear()

    async def _ready(self) -> None:
        """握手闸门：会话类方法的第一道检查，保证握手的响应先于一切会话响应。

        输入：无。
        输出：无；返回即表示 initialize 已成功、`_connection` 可用。
        异常：`-32600` + `NOT_INITIALIZED`——还没收到 initialize（立即，不等待）；
              `-32603` + `HOST_INIT_FAILED`（retryable）——initialize 失败，
              与握手响应同因，客户端据此重试整条连接。
        """
        future = self._init_future
        if future is None:
            raise RequestError(-32600, "NOT_INITIALIZED", {"code": "NOT_INITIALIZED"})
        if not await future:
            raise RequestError(
                -32603,
                "HOST_INIT_FAILED",
                {"code": "HOST_INIT_FAILED", "retryable": True},
            )

    def _require_connection(self) -> ProtocolConnection:
        """取已协商的连接；未握手时回 -32600（ACP 要求先 initialize）。"""
        connection = self._connection
        if connection is None:
            raise RequestError(-32600, "NOT_INITIALIZED", {"code": "NOT_INITIALIZED"})
        return connection

    def _spawn(self, coroutine: Coroutine[Any, Any, None]) -> None:
        """起一个短命后台任务并持有引用，避免被 GC。"""
        task = asyncio.create_task(coroutine, name="harness-acp-request")
        self._request_tasks.add(task)
        task.add_done_callback(self._request_tasks.discard)

    # —— 诊断 ——

    def _log_request(self, method: str, started: float) -> None:
        """记一条成功的请求（只有方法名与耗时，不含参数与文本）。"""
        self._log.debug(
            "ipc.request.completed",
            {
                "side": "server",
                "method": method,
                "duration_ms": _elapsed_ms(started),
                "failure_stage": "completed",
                "error_type": "None",
                "summary_code": "ok",
            },
        )

    def _log_failure(
        self,
        method: str,
        started: float,
        stage: str,
        exc: BaseException | None,
        summary_code: str,
    ) -> None:
        """记一条失败的请求；只写类型名，不写参数、文本或路径。"""
        self._log.error(
            "ipc.request.failed",
            {
                "side": "server",
                "method": method,
                "duration_ms": _elapsed_ms(started),
                "failure_stage": stage,
                "error_type": type(exc).__name__ if exc is not None else "None",
                "summary_code": summary_code,
            },
        )


def _elapsed_ms(started: float) -> int:
    """把单调时钟差值换成毫秒。"""
    return max(0, round((time.monotonic() - started) * 1000))


def _same_workspace(cwd: str, workspace: Path) -> bool:
    """判断 cwd 是否解析到同一个工作区；`samefile` 顺带处理符号链接。"""
    candidate = Path(cwd)
    if not candidate.is_absolute():
        return False
    try:
        return os.path.samefile(candidate, workspace)
    except (OSError, ValueError):
        # 含 NUL 的 cwd 会抛 ValueError（Path 构造层），和「路径不存在」一样只能当作不匹配。
        return False


def _session_mode(snapshot: HostSnapshot | None, *, plan: bool = False) -> ApprovalModeName:
    """取会话的初始审批模式。没声明表单时 `plan` 退回 `default`。"""
    raw = snapshot.default_approval_mode if snapshot is not None else None
    return default_mode(raw, plan=plan)


def _prompt_usage(summary: Mapping[str, object] | None) -> Usage | None:
    """把 `run.completed` 的 usage 收成 ACP `Usage`。没有 usage 对象时不编造。

    缺整数或布尔值都按 0。缓存命中依次看 cached_read_tokens、cached_tokens、
    cached_input_tokens，只有非负整数才带上。
    """
    if not isinstance(summary, Mapping):
        return None
    usage = summary.get("usage")
    if not isinstance(usage, Mapping):
        return None

    def as_int(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return 0
        return value

    input_tokens = as_int(usage.get("input_tokens"))
    output_tokens = as_int(usage.get("output_tokens"))
    cached: int | None = None
    for key in ("cached_read_tokens", "cached_tokens", "cached_input_tokens"):
        value = usage.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            cached = value
            break
    return Usage(
        total_tokens=input_tokens + output_tokens,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_read_tokens=cached,
    )


def _file_uri_path(uri: str) -> str | None:
    """`file://` 取出路径；`file://localhost/tmp/a` 得到 `/tmp/a`。其它 scheme 返回 None。"""
    parsed = urlparse(uri)
    if parsed.scheme != "file" or not parsed.path:
        return None
    return unquote(parsed.path)


def _piece_from_file(path: str, budget: InlineBudget) -> InlinePiece:
    """先看大小。达到单文件上限就不再把正文读进内存。"""
    file = Path(path)
    size = file.stat().st_size
    if size >= MAX_SINGLE_FILE_BYTES:
        return InlinePiece(path, placeholder(path, size), False)
    return piece_for_bytes(path, file.read_bytes(), budget)


def _mcp_mappings(servers: Sequence[object] | None) -> list[Mapping[str, object]]:
    """把 SDK 的 MCP 模型收成 Host 认识的普通映射。命令和请求头留在映射里，诊断由 Host 去掉。"""
    mapped: list[Mapping[str, object]] = []
    for item in servers or []:
        if isinstance(item, Mapping):
            entry = dict(item)
            if not isinstance(entry.get("transport"), str) and isinstance(entry.get("type"), str):
                entry["transport"] = entry["type"]
            mapped.append(entry)
            continue
        name = getattr(item, "name", "")
        if hasattr(item, "command"):
            mapped.append(
                {
                    "name": name,
                    "transport": "stdio",
                    "command": getattr(item, "command", "") or "",
                    "args": list(getattr(item, "args", ()) or ()),
                    "env": _pair_dict(getattr(item, "env", ()) or ()),
                }
            )
            continue
        if hasattr(item, "server_id"):
            mapped.append({"name": name, "transport": "acp"})
            continue
        transport = "sse" if "Sse" in type(item).__name__ else "http"
        mapped.append(
            {
                "name": name,
                "transport": transport,
                "url": getattr(item, "url", "") or "",
                "headers": _pair_dict(getattr(item, "headers", ()) or ()),
            }
        )
    return mapped


def _pair_dict(entries: object) -> dict[str, str]:
    """把 `{name, value}` 列表收成字典。缺字段的项跳过。"""
    result: dict[str, str] = {}
    if isinstance(entries, (str, bytes)) or not isinstance(entries, Sequence):
        return result
    for entry in entries:
        if isinstance(entry, Mapping):
            key, value = entry.get("name"), entry.get("value")
        else:
            key, value = getattr(entry, "name", None), getattr(entry, "value", None)
        if isinstance(key, str) and isinstance(value, str):
            result[key] = value
    return result


def _report_ignored(name: str, values: Sequence[object] | None) -> None:
    """在 stderr 记一行「忽略了几个」，绝不回显内容（可能含命令、环境变量与密钥）。"""
    if not values:
        return
    sys.stderr.write(f"harness-agent acp: ignoring {len(values)} {name}\n")
    sys.stderr.flush()


def _fit_update(update: Any) -> Any:
    """超过单帧上限时依次丢弃 rawInput、rawOutput，最后截 content。

    估算用 `json.dumps` 的字符数：SDK 用 `ensure_ascii` 序列化，emoji 等字符会
    膨胀成 3 倍、控制字符 6 倍，所以按字符数保守估计。
    """
    if not isinstance(update, ToolCallUpdate):
        return update
    if frame_chars(update) <= MAX_OUTBOUND_FRAME_BYTES:
        return update
    trimmed = update.model_copy(update={"raw_input": None})
    if frame_chars(trimmed) <= MAX_OUTBOUND_FRAME_BYTES:
        return trimmed
    trimmed = trimmed.model_copy(update={"raw_output": None})
    if frame_chars(trimmed) <= MAX_OUTBOUND_FRAME_BYTES:
        return trimmed
    content = trimmed.content
    if content is None:
        return trimmed
    return trimmed.model_copy(
        update={
            "content": [
                item.model_copy(
                    update={"content": _cap_text_block(item, MAX_OUTBOUND_FRAME_BYTES // 4)}
                )
                if hasattr(item, "content")
                else item
                for item in content
            ]
        }
    )


def _cap_text_block(item: object, limit: int) -> Any:
    """把内容块里的文本截到 `limit` 字符；非文本块原样返回。"""
    inner = getattr(item, "content", None)
    text = getattr(inner, "text", None)
    copier = getattr(inner, "model_copy", None)
    if not isinstance(text, str) or len(text) <= limit or copier is None:
        return inner
    return copier(update={"text": text[: limit - 1] + "…"})


__all__ = [
    "MAX_PROMPT_SUMMARY_CHARS",
    "PROTOCOL_VERSION",
    "AcpServer",
    "prompt_text",
    "to_request_error",
]
