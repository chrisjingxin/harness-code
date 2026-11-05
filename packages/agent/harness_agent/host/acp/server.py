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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from acp.exceptions import RequestError
from acp.schema import (
    AgentCapabilities,
    Implementation,
    InitializeResponse,
    McpCapabilities,
    NewSessionResponse,
    PromptCapabilities,
    PromptResponse,
    SessionCapabilities,
    SessionMode,
    SessionModeState,
    ToolCallUpdate,
)

from harness_agent import __version__
from harness_agent.diagnostic_log.runtime import ensure_log
from harness_agent.host.acp.tool_display import PathLocator
from harness_agent.host.acp.translate import (
    TERMINAL_EVENT_TYPES,
    RunOutcome,
    RunTranslator,
    Update,
)
from harness_agent.host.connection import ProtocolConnection, RpcError
from harness_agent.host.run_coordinator import RunError, UserRunInput
from harness_agent.host.service_types import (
    ApprovalModeName,
    HostServicePort,
    HostSnapshot,
    StartRunRequest,
)

PROTOCOL_VERSION = 1
"""S1 只支持 ACP 协议版本 1；客户端请求其它版本也回 1，由客户端决定是否断开。"""

MAX_PROMPT_SUMMARY_CHARS = 2000
"""错误响应里回显的 message 上限，避免把整段模型输出塞进错误帧。"""

_UPPERCASE_CODE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
"""v3 稳定错误码的形状：全大写下划线。`RpcError.message` 就是它。"""

_KIND_LABELS: Mapping[str, str] = {
    "default": "逐项确认",
    "auto-edit": "自动批准编辑",
    "auto": "自动判断",
    "yolo": "全部放行",
}
"""会话模式的展示名；S1 只展示当前一项。"""


@dataclass(slots=True)
class _Session:
    """一个 ACP 会话；sessionId 同时就是 Python 侧的 thread_id。"""

    session_id: str
    approval_mode: ApprovalModeName
    busy: bool = False
    cancel_requested: bool = False
    run: _ActiveRun | None = None


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
    if isinstance(exc, RpcError):
        if exc.code == -32602:
            return RequestError(
                -32602,
                exc.message,
                {"code": "INVALID_PARAMS", "message": _truncate(exc.message), "retryable": False},
            )
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
        self._sessions: dict[str, _Session] = {}
        self._runs: dict[str, _ActiveRun] = {}
        self._outbox: asyncio.Queue[tuple[str, dict[str, object]]] = asyncio.Queue()
        self._pump_task: asyncio.Task[None] | None = None
        self._closing = False
        self._outbound_broken = False
        self._in_flight = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._snapshot: HostSnapshot | None = None
        self._request_tasks: set[asyncio.Task[None]] = set()

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
        if self._connection is not None:
            raise RequestError(-32600, "ALREADY_INITIALIZED", {"code": "ALREADY_INITIALIZED"})
        try:
            snapshot = await self._host.ensure_ready()
        except Exception as exc:
            self._log_failure("initialize", started, "ensure_ready", exc, "HOST_INIT_FAILED")
            raise RequestError(
                -32603,
                "HOST_INIT_FAILED",
                {"code": "HOST_INIT_FAILED", "retryable": True},
            ) from exc
        self._snapshot = snapshot
        self._connection = self._host.open_connection(
            self._sender,
            enabled_capabilities=("run.multithread", "run.cancel"),
            interaction_handles=(),
            role="owner",
        )
        self._pump_task = asyncio.create_task(self._pump(), name="harness-acp-pump")
        self._log_request("initialize", started)
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(
                load_session=False,
                prompt_capabilities=PromptCapabilities(
                    image=False, audio=False, embedded_context=False
                ),
                mcp_capabilities=McpCapabilities(http=False, sse=False, acp=False),
                session_capabilities=SessionCapabilities(),
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

        异常：`-32600` 未 initialize；`-32602` + `WORKSPACE_MISMATCH` cwd 不匹配。
        `mcpServers` / `additionalDirectories` 在 S1 只记个数到 stderr（可能含密钥，
        绝不回显），会话照常创建。
        """
        started = time.monotonic()
        if self._connection is None:
            raise RequestError(-32600, "NOT_INITIALIZED", {"code": "NOT_INITIALIZED"})
        workspace = self._host.workspace
        if not _same_workspace(cwd, workspace):
            self._log_failure("session/new", started, "workspace_check", None, "WORKSPACE_MISMATCH")
            raise RequestError(
                -32602,
                "WORKSPACE_MISMATCH",
                {"code": "WORKSPACE_MISMATCH", "expected": str(workspace)},
            )
        _report_ignored("mcpServers", mcp_servers)
        _report_ignored("additionalDirectories", additional_directories)
        session_id = str(uuid.uuid4())
        mode = _session_mode(self._snapshot)
        self._sessions[session_id] = _Session(session_id=session_id, approval_mode=mode)
        self._log_request("session/new", started)
        return NewSessionResponse(
            session_id=session_id,
            modes=SessionModeState(
                current_mode_id=mode,
                available_modes=[SessionMode(id=mode, name=_KIND_LABELS.get(mode, mode))],
            ),
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
        connection = self._connection
        session = self._sessions.get(session_id)
        if connection is None or session is None:
            raise RequestError.resource_not_found(session_id)
        # 下面这段（含内容转换）必须在一个同步段内完成，中间不能 await：
        # 否则两个并发 prompt 可能都通过 busy 检查，双双进入 start_run。
        if self._closing:
            raise RequestError(-32603, "SHUTTING_DOWN", {"code": "SHUTTING_DOWN"})
        if session.busy:
            raise RequestError(
                -32603,
                "THREAD_BUSY",
                {"code": "THREAD_BUSY", "retryable": True},
            )
        text = prompt_text(prompt)
        session.busy = True
        # 上一轮的迟到 cancel 不能误伤这一轮。
        session.cancel_requested = False
        self._in_flight += 1
        self._idle.clear()
        run_id = str(uuid.uuid4())
        active = _ActiveRun(
            run_id=run_id,
            session_id=session_id,
            translator=RunTranslator(run_id, PathLocator(self._host.workspace)),
            done=asyncio.get_running_loop().create_future(),
        )

        async def on_accepted(_accepted: object) -> None:
            # 登记不晚于第一个事件：扇出任务在回调之后才创建。
            session.run = active
            self._runs[run_id] = active
            if session.cancel_requested:
                await self._cancel_active(active)

        try:
            await self._host.start_run(
                connection,
                StartRunRequest(
                    thread_id=session_id,
                    run_id=run_id,
                    mode="build",
                    input=UserRunInput(text),
                    requested_approval_mode=session.approval_mode,
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
            self._finish_request()
        self._log_request("session/prompt", started)
        return self._prompt_response(outcome, session)

    async def cancel(self, session_id: str, **kwargs: object) -> None:
        """取消该会话当前 Run；未知会话或已结束的 Run 静默忽略。"""
        session = self._sessions.get(session_id)
        if session is None:
            return
        session.cancel_requested = True
        active = session.run
        if active is None:
            # Run 还在准备阶段：on_accepted 会看到标志并立即取消。
            return
        await self._cancel_active(active)

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
        """关闭 Host 连接、停止发送泵，并兜底失败仍悬挂的 Run Future。"""
        connection = self._connection
        self._connection = None
        if connection is not None:
            with contextlib.suppress(Exception):
                await self._host.close_connection(connection)
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
            if isinstance(method, str) and method.startswith("interaction.") and "id" in frame:
                # S1 没声明任何 handle，正常不会出现；万一出现就立刻 fail-closed，
                # 否则 Run 会一直等到交互超时（24 小时）。
                request_id = frame.get("id")
                if isinstance(request_id, str):
                    self._spawn(self._fail_interaction(request_id))
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

    async def _fail_interaction(self, request_id: str) -> None:
        """对意外到达的交互请求立刻回拒绝，避免 Run 挂死。"""
        connection = self._connection
        if connection is None:
            return
        self._host.fail_interaction(
            connection,
            request_id,
            RpcError(-32601, "INTERACTION_UNSUPPORTED"),
        )

    async def _pump(self) -> None:
        """串行消费事件队列：翻译 → 发送 → 终态时补发未结束工具 → resolve Future。"""
        while True:
            _kind, payload = await self._outbox.get()
            active: _ActiveRun | None = None
            try:
                run_id = payload.get("run_id")
                active = self._runs.get(run_id) if isinstance(run_id, str) else None
                if active is None:
                    # 没有等待者的迟到事件（Run 已结束或已清理）：直接丢弃。
                    continue
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

    async def _send(self, session_id: str, update: Update) -> None:
        """发一条 session/update；对端已断时静默放弃（不再重试，也不抛）。"""
        client = self._client
        if client is None or self._outbound_broken:
            return
        try:
            await client.session_update(session_id, _fit_update(update))
        except (ConnectionError, BrokenPipeError, RuntimeError):
            self._outbound_broken = True

    # —— 内部：Run 与响应 ——

    def _prompt_response(self, outcome: RunOutcome, session: _Session) -> PromptResponse:
        """把 Run 终态映射成 ACP 响应；失败时抛 `RequestError`。"""
        if outcome.kind == "completed":
            return PromptResponse(stop_reason="end_turn")
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
    except OSError:
        return False


def _session_mode(snapshot: HostSnapshot | None) -> ApprovalModeName:
    """取会话的初始审批模式；`plan` 不对外暴露，退回 `default`。"""
    raw = snapshot.default_approval_mode if snapshot is not None else "default"
    if raw == "plan" or raw not in _KIND_LABELS:
        return "default"
    return raw  # type: ignore[return-value]


def _report_ignored(name: str, values: Sequence[object] | None) -> None:
    """在 stderr 记一行「忽略了几个」，绝不回显内容（可能含命令、环境变量与密钥）。"""
    if not values:
        return
    sys.stderr.write(f"harness-agent acp: ignoring {len(values)} {name}\n")
    sys.stderr.flush()


_MAX_OUTBOUND_FRAME_BYTES = 6 * 1024 * 1024
"""单帧出站上限；桥（S3）会拒绝超过 8 MiB 的帧，留一段余量。"""


def _fit_update(update: Update) -> Update:
    """超过单帧上限时依次丢弃 rawInput、rawOutput，最后截 content。

    估算用 `json.dumps` 的字符数：SDK 用 `ensure_ascii` 序列化，emoji 等字符会
    膨胀成 3 倍、控制字符 6 倍，所以按字符数保守估计。
    """
    if not isinstance(update, ToolCallUpdate):
        return update
    if _frame_chars(update) <= _MAX_OUTBOUND_FRAME_BYTES:
        return update
    trimmed = update.model_copy(update={"raw_input": None})
    if _frame_chars(trimmed) <= _MAX_OUTBOUND_FRAME_BYTES:
        return trimmed
    trimmed = trimmed.model_copy(update={"raw_output": None})
    if _frame_chars(trimmed) <= _MAX_OUTBOUND_FRAME_BYTES:
        return trimmed
    content = trimmed.content
    if content is None:
        return trimmed
    return trimmed.model_copy(
        update={
            "content": [
                item.model_copy(
                    update={"content": _cap_text_block(item, _MAX_OUTBOUND_FRAME_BYTES // 4)}
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


def _frame_chars(update: Any) -> int:
    """估算一帧序列化后的字符数。"""
    import json

    try:
        payload = update.model_dump(mode="json", by_alias=True, exclude_defaults=True)
        return len(json.dumps(payload, ensure_ascii=True))
    except (TypeError, ValueError):
        return 0


__all__ = [
    "MAX_PROMPT_SUMMARY_CHARS",
    "PROTOCOL_VERSION",
    "AcpServer",
    "prompt_text",
    "to_request_error",
]
