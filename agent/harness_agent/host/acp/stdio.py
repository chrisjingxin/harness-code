"""ACP 的 stdio 传输层：fd 洁癖、帧长校验、信号与有序关闭。

【这是做什么的？】
把真实 stdin/stdout 变成一条只跑 ACP 帧的专用通道，并保证关闭时「先取消 Run、
等响应写出、再喂 EOF」的顺序。本模块不认识任何业务：`AcpServer` 由上层注入，
只要它满足 `ShutdownAware`。

【上下游】
- 上游：`harness_agent.__main__`（`acp` 分支）与 `host/acp/server.py`。
- 下游：官方 `agent-client-protocol` 的 `run_agent`（读写两端都由这里包好）。

【为什么需要单独一层】
1. `harness acp` 的 stdout 必须只有 ACP 帧。仓库现有 v3 路径只靠「代码里不要 print」
   的约定，没有运行期保护；这里把真实 fd 1 复制出来专供协议，再让 fd 1 指向 stderr。
2. 官方 SDK 的接收循环有三个实测缺口：非法 JSON 只记日志静默丢弃、JSON 数组或数字帧
   会让它抛 `AttributeError` 直接崩、单行没有长度上限。`FrameGuard` 在 SDK 之前补齐。

【时序】
    客户端帧 ─▶ FrameGuard ─合格 JSON 对象─▶ sdk_reader ─▶ SDK 接收循环
                  │
                  └─坏帧：直接回 -32700 / -32600（绕过 SDK 发送队列）

    停止条件：stdin EOF / SIGTERM|SIGINT|SIGHUP / 对端关掉 stdout / SDK 自己退出
    收尾顺序：begin_shutdown → wait_idle(grace) → feed_eof → 等 SDK → aclose → 关 writer
    顺序不能反：先 feed_eof 会让 SDK 取消在途 handler，prompt 响应就再也发不出去。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import stat
import sys
from dataclasses import dataclass
from typing import Any, Protocol, cast

from acp.core import run_agent

from harness_agent.protocol.generated import MAX_FRAME_BYTES

logger = logging.getLogger(__name__)

SHUTDOWN_GRACE_SECONDS = 5.0
"""取消 Run 之后等待 prompt 响应写出的上限；超时也必须退出，不能挂住进程。"""

_READ_BUFFER_LIMIT = 1024 * 1024
"""底层 StreamReader 的单次缓冲上限；超过时改走 LimitOverrun 分段读取路径。"""


class StdioStartupError(Exception):
    """启动阶段无法把 stdio 变成协议通道；调用方据此以退出码 2 结束。"""


@dataclass(frozen=True, slots=True)
class ProtocolFds:
    """复制出来的协议通道文件描述符（都不参与子进程继承）。"""

    reader: int
    writer: int


@dataclass(slots=True)
class AcpStreams:
    """协议通道的 asyncio 视图。

    `lost` 在对端关闭写端时置位：SDK 的发送循环退出后，任何 `send()` 都会永久挂住，
    上层必须据此提前收尾。测试注入的流可以不接这个事件。
    """

    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    lost: asyncio.Event


class ShutdownAware(Protocol):
    """`serve_acp_streams` 需要的关闭钩子；真实实现是 `server.AcpServer`。"""

    async def begin_shutdown(self) -> None:
        """拒绝新请求，并取消所有在途 Run。"""
        ...

    async def wait_idle(self, timeout: float) -> bool:
        """等在途请求处理完；返回 False 表示宽限期用尽。"""
        ...

    async def aclose(self) -> None:
        """关闭 Host 连接并停止内部发送泵；可重复调用。"""
        ...


def claim_protocol_fds() -> ProtocolFds:
    """把 fd 1 让给 ACP 写帧，并把 fd 0 换成 /dev/null。

    输入：进程启动时的标准 fd。
    输出：`ProtocolFds`；之后 fd 1 与 2 都指向 stderr，fd 0 指向 /dev/null。
    异常：`StdioStartupError`（stdout/stdin 不是管道、套接字或 tty；Windows 不支持）。

    顺序是先复制再重定向：任一步失败时标准 fd 保持原样，不会把启动失败变成
    「stdout 被吞掉」。`os.dup` 得到的是不可继承 fd，工具、MCP、孙进程都拿不到协议通道。
    """
    if sys.platform == "win32":
        raise StdioStartupError("ACP stdio mode is not supported on Windows yet")
    writer_fd = _dup_stream(1, "stdout")
    try:
        reader_fd = _dup_stream(0, "stdin")
    except StdioStartupError:
        with contextlib.suppress(OSError):
            os.close(writer_fd)
        raise
    sys.stdout.flush()
    sys.stderr.flush()
    _point_fd1_at_stderr()
    null_in = os.open(os.devnull, os.O_RDONLY)
    try:
        os.dup2(null_in, 0)
    finally:
        os.close(null_in)
    sys.stdout = sys.stderr
    return ProtocolFds(reader=reader_fd, writer=writer_fd)


def _dup_stream(fd: int, name: str) -> int:
    """复制 fd 并确认它是管道、套接字或 tty；普通文件不支持（写入不可靠）。"""
    try:
        duplicated = os.dup(fd)
    except OSError as exc:
        raise StdioStartupError(f"{name} is not available") from exc
    try:
        mode = os.fstat(duplicated).st_mode
    except OSError as exc:
        with contextlib.suppress(OSError):
            os.close(duplicated)
        raise StdioStartupError(f"{name} is not available") from exc
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode) or stat.S_ISCHR(mode)):
        with contextlib.suppress(OSError):
            os.close(duplicated)
        raise StdioStartupError(f"{name} must be a pipe, socket or tty")
    return duplicated


def _point_fd1_at_stderr() -> None:
    """把 fd 1 指向 stderr；stderr 不可用时先补 /dev/null，避免 fd 1 变成野指针。"""
    try:
        os.fstat(2)
    except OSError:
        null_out = os.open(os.devnull, os.O_WRONLY)
        try:
            os.dup2(null_out, 1)
            os.dup2(null_out, 2)
        finally:
            os.close(null_out)
        return
    os.dup2(2, 1)


class _WriteProtocol(asyncio.BaseProtocol):
    """自管的写端协议：比 SDK 自带的实现多一条「连接断开时唤醒所有等待者」。

    SDK 的 `_WritePipeProtocol` 在 `connection_lost` 时不唤醒 `_drain_waiter`，
    对端消失后 `drain()` 会永久挂住；这里用等待者列表并在断开时统一唤醒。
    """

    def __init__(self, lost: asyncio.Event) -> None:
        """绑定 `lost` 事件，供上层判断对端是否已经离开。"""
        self._lost = lost
        self._paused = False
        self._waiters: list[asyncio.Future[None]] = []

    def pause_writing(self) -> None:
        """底层写缓冲满时挂起 drain。"""
        self._paused = True

    def resume_writing(self) -> None:
        """写缓冲恢复时唤醒全部等待者。"""
        self._paused = False
        waiters, self._waiters = self._waiters, []
        for waiter in waiters:
            if not waiter.done():
                waiter.set_result(None)

    async def _drain_helper(self) -> None:
        """`StreamWriter.drain()` 的实际等待点。"""
        if not self._paused:
            return
        waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        await waiter

    def connection_lost(self, exc: Exception | None) -> None:
        """对端消失：置位 `lost`，并让所有 drain 立刻失败而不是挂住。"""
        self._lost.set()
        waiters, self._waiters = self._waiters, []
        error = exc if exc is not None else ConnectionResetError("stdout closed")
        for waiter in waiters:
            if not waiter.done():
                waiter.set_exception(error)


async def open_streams(fds: ProtocolFds) -> AcpStreams:
    """把复制出来的 fd 包装成 asyncio 流；不接管进程标准 fd 的所有权。

    Windows 不支持（Proactor 对继承来的非 overlapped 管道会抛 WinError 6），
    启动阶段已由 `claim_protocol_fds` 拦下。
    """
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=_READ_BUFFER_LIMIT)
    read_protocol = asyncio.StreamReaderProtocol(reader)
    read_pipe = os.fdopen(fds.reader, "rb", buffering=0)
    await loop.connect_read_pipe(lambda: read_protocol, read_pipe)
    lost = asyncio.Event()
    write_protocol = _WriteProtocol(lost)
    write_pipe = os.fdopen(fds.writer, "wb", buffering=0)
    transport, _ = await loop.connect_write_pipe(lambda: write_protocol, write_pipe)
    writer = asyncio.StreamWriter(transport, write_protocol, None, loop)
    return AcpStreams(reader=reader, writer=writer, lost=lost)


class FrameGuard:
    """在 SDK 之前读帧：校验长度与 JSON-RPC 外形，只放行 JSON 对象。"""

    def __init__(
        self,
        raw: asyncio.StreamReader,
        sdk_reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        max_frame_bytes: int = MAX_FRAME_BYTES,
    ) -> None:
        """绑定原始读端、SDK 读端与用于直写错误响应的协议写端。"""
        self._raw = raw
        self._sdk_reader = sdk_reader
        self._writer = writer
        self._max_frame_bytes = max_frame_bytes

    async def run(self) -> None:
        """读到真实 EOF 返回；不替调用方喂 EOF（关闭顺序由 `serve_acp_streams` 控制）。"""
        pending = bytearray()
        oversize = False
        while True:
            try:
                chunk = await self._raw.readuntil(b"\n")
            except asyncio.LimitOverrunError as exc:
                # 分隔符还没出现：先取走已缓冲的部分继续累积（内存上限见下方判断）。
                chunk = await self._raw.readexactly(exc.consumed)
                if oversize:
                    continue
                pending += chunk
                if len(pending) > self._max_frame_bytes:
                    oversize = True
                    pending.clear()
                continue
            except asyncio.IncompleteReadError as exc:
                # EOF：末尾没有换行的最后一帧也要处理。
                if oversize:
                    await self._reject(-32600, "JSON-RPC frame exceeds size limit")
                elif exc.partial:
                    pending += exc.partial
                    if len(pending) > self._max_frame_bytes:
                        await self._reject(-32600, "JSON-RPC frame exceeds size limit")
                    else:
                        await self._handle_line(bytes(pending))
                return
            if oversize:
                # 超限行到这里才读到换行：回一条错误后继续处理后续帧。
                # 不回错误的话客户端会一直等这一帧的响应。
                oversize = False
                pending.clear()
                await self._reject(-32600, "JSON-RPC frame exceeds size limit")
                continue
            pending += chunk
            if len(pending) > self._max_frame_bytes:
                pending.clear()
                await self._reject(-32600, "JSON-RPC frame exceeds size limit")
                continue
            line = bytes(pending)
            pending.clear()
            await self._handle_line(line)

    async def _handle_line(self, line: bytes) -> None:
        """按 JSON-RPC 外形校验一行；通过则原样交给 SDK。"""
        stripped = line.strip()
        if not stripped:
            return
        try:
            text = stripped.decode("utf-8")
        except UnicodeDecodeError:
            await self._reject(-32700, "Parse error")
            return
        try:
            message = json.loads(text)
        except (ValueError, RecursionError):
            # `JSONDecodeError` 是 `ValueError` 的子类；另外两类也必须当作坏帧拒绝而不是
            # 让守卫任务崩溃：超过 4300 位的整数会抛 `ValueError`，十万层嵌套会抛
            # `RecursionError`。守卫崩了，进程会把它当成 EOF，静默以退出码 0 收尾。
            await self._reject(-32700, "Parse error")
            return
        if not isinstance(message, dict):
            await self._reject(-32600, "Invalid Request")
            return
        request_id = _legal_request_id(message.get("id"))
        if message.get("jsonrpc") != "2.0":
            await self._reject(-32600, "Invalid Request: jsonrpc must be '2.0'", request_id)
            return
        if "method" in message and not isinstance(message["method"], str):
            await self._reject(-32600, "Invalid Request: method must be a string", request_id)
            return
        # 客户端对我们反向请求的响应没有 method，只有 id，也在这里放行。
        self._sdk_reader.feed_data(line if line.endswith(b"\n") else line + b"\n")

    async def _reject(self, code: int, message: str, request_id: object | None = None) -> None:
        """直写一条 JSON-RPC 错误行；对端已断时不抛异常。

        直写是安全的：一次 `write` 在行边界上原子追加，和 SDK 请求队列里的整行写入
        只会在行与行之间交错，不会撕坏某一行。
        """
        payload = {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
        try:
            self._writer.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._writer.drain()
        except (ConnectionError, OSError, RuntimeError):
            logger.debug("Failed to write ACP frame error to client", exc_info=True)


def _legal_request_id(value: object) -> object | None:
    """返回合法的 JSON-RPC id（字符串或整数），其它一律 null。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (str, int)):
        return value
    return None


async def serve_acp_streams(
    agent: ShutdownAware,
    streams: AcpStreams,
    *,
    install_signals: bool = True,
    grace_seconds: float = SHUTDOWN_GRACE_SECONDS,
) -> int:
    """在给定流上跑一轮 ACP 服务，返回进程退出码。

    输入：`agent`（提供 ACP 方法与关闭钩子）、已经打开的协议流。
    输出：0 表示 EOF / 信号 / 对端断开等正常收尾；1 表示 SDK 自身异常。
    异常：不向上抛（进程级入口），只记录日志并返回退出码。

    `install_signals=False` 用于进程内测试：测试进程不能被夺走 SIGINT。
    """
    sdk_reader = asyncio.StreamReader(limit=MAX_FRAME_BYTES + 1)
    guard = FrameGuard(streams.reader, sdk_reader, streams.writer)
    guard_task = asyncio.create_task(guard.run(), name="harness-acp-frames")
    sdk_task = asyncio.create_task(
        run_agent(
            cast(Any, agent),
            streams.writer,
            sdk_reader,
            # session/resume 与 session/close 在 SDK 里属于 unstable 方法集，
            # 不开这个开关路由层直接回 method_not_found。
            use_unstable_protocol=True,
        ),
        name="harness-acp-sdk",
    )
    stop = asyncio.Event()
    installed = _install_signal_handlers(stop) if install_signals else []
    exit_code = 0
    try:
        exit_code = await _wait_for_stop(streams, guard_task, sdk_task, stop)
        await _shutdown(agent, sdk_reader, sdk_task, streams, guard_task, grace_seconds)
    except Exception:
        logger.exception("ACP stdio serving failed")
        exit_code = 1
    finally:
        _remove_signal_handlers(installed)
        await _cancel(guard_task)
        # `close()` 会先把写缓冲刷出去再关管道。不再 `wait_closed()`：自定义的
        # `_WriteProtocol` 没有 `_get_close_waiter`，那一步永远抛 AttributeError 被吞掉，
        # 等于白写。
        with contextlib.suppress(Exception):
            streams.writer.close()
    return exit_code


async def _wait_for_stop(
    streams: AcpStreams,
    guard_task: asyncio.Task[None],
    sdk_task: asyncio.Task[None],
    stop: asyncio.Event,
) -> int:
    """等第一个停止条件；返回退出码（SDK 自身异常算 1）。"""
    stop_task = asyncio.create_task(stop.wait(), name="harness-acp-signal")
    lost_task = asyncio.create_task(streams.lost.wait(), name="harness-acp-lost")
    try:
        await asyncio.wait(
            {guard_task, sdk_task, stop_task, lost_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        blockers = {stop_task, lost_task}
        for task in blockers:
            task.cancel()
        await asyncio.gather(*blockers, return_exceptions=True)
    if sdk_task.done() and not sdk_task.cancelled() and sdk_task.exception() is not None:
        logger.warning("ACP SDK connection exited with an error", exc_info=sdk_task.exception())
        return 1
    if guard_task.done() and not guard_task.cancelled() and guard_task.exception() is not None:
        # 守卫任务带异常退出不是 EOF：不能让客户端看到「静默退出码 0」。
        logger.error("ACP frame guard crashed", exc_info=guard_task.exception())
        return 1
    return 0


async def _shutdown(
    agent: ShutdownAware,
    sdk_reader: asyncio.StreamReader,
    sdk_task: asyncio.Task[None],
    streams: AcpStreams,
    guard_task: asyncio.Task[None],
    grace_seconds: float,
) -> None:
    """按固定顺序收尾：取消 Run → 等写清 → 喂 EOF → 关 Host 连接。

    对端已经离开（`lost` 或 SDK 已退出）时跳过「等写清」：写循环已死，
    等待只会白等到宽限期结束。
    """
    peer_gone = streams.lost.is_set() or sdk_task.done()
    await agent.begin_shutdown()
    if not peer_gone:
        idle = await agent.wait_idle(grace_seconds)
        if not idle:
            logger.warning("ACP prompt did not finish within %.1fs; closing anyway", grace_seconds)
    if not sdk_reader.at_eof():
        sdk_reader.feed_eof()
    if not sdk_task.done():
        done, _ = await asyncio.wait({sdk_task}, timeout=grace_seconds)
        if not done:
            logger.warning("ACP SDK connection did not close within %.1fs; cancelling", grace_seconds)
            sdk_task.cancel()
            await asyncio.gather(sdk_task, return_exceptions=True)
    with contextlib.suppress(Exception):
        sdk_task.result()
    await _cancel(guard_task)
    await agent.aclose()


async def _cancel(task: asyncio.Task[Any]) -> None:
    """取消任务并吞掉取消/异常，避免关闭阶段再抛。"""
    if task.done():
        with contextlib.suppress(BaseException):
            task.result()
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def _install_signal_handlers(stop: asyncio.Event) -> list[signal.Signals]:
    """安装 POSIX 信号处理器；重复信号只置位同一个事件（不升级为强杀）。

    强杀交给宽限期和调用方的 SIGKILL，避免 TS 父进程与终端 Ctrl-C 重复投递时
    互相踩踏。
    """
    loop = asyncio.get_running_loop()
    installed: list[signal.Signals] = []
    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            continue
        installed.append(sig)
    return installed


def _remove_signal_handlers(installed: list[signal.Signals]) -> None:
    """还原默认处理器；`remove_signal_handler` 对 SIGINT 会恢复 KeyboardInterrupt。"""
    loop = asyncio.get_running_loop()
    for sig in installed:
        with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
            loop.remove_signal_handler(sig)


async def run_acp_stdio(
    host: Any,
    *,
    log: object | None = None,
    fds: ProtocolFds | None = None,
    streams: AcpStreams | None = None,
    install_signals: bool = True,
    grace_seconds: float = SHUTDOWN_GRACE_SECONDS,
) -> int:
    """`harness acp` 的进程级入口：建 AcpServer、跑一轮服务、关 Host。

    输入：`host` 是 `AgentHost`（需要 `close()`，这一步不在 `HostServicePort` 里）；
           `fds` 由 `claim_protocol_fds()` 在事件循环之前取得；`streams` 是测试缝，
           传了就不再拿 fds 开流。
    输出：进程退出码（0 正常收尾、1 SDK 异常）。
    异常：`StdioStartupError` 向上抛（启动阶段失败，由 `__main__` 转成退出码 2）。

    `server.py` 只能 import 本模块的关闭协议，本模块反过来 import `AcpServer`，
    所以这里用惰性导入避免模块加载顺序问题。
    """
    from harness_agent.host.acp.server import AcpServer

    if streams is None:
        if fds is None:
            raise StdioStartupError("run_acp_stdio requires fds or streams")
        streams = await open_streams(fds)
    server = AcpServer(host, log=log)
    try:
        return await serve_acp_streams(
            server,
            streams,
            install_signals=install_signals,
            grace_seconds=grace_seconds,
        )
    finally:
        if not getattr(streams.writer, "is_closing", lambda: True)():
            with contextlib.suppress(Exception):
                streams.writer.close()
        with contextlib.suppress(Exception):
            await host.close()


__all__ = [
    "MAX_FRAME_BYTES",
    "SHUTDOWN_GRACE_SECONDS",
    "AcpStreams",
    "FrameGuard",
    "ProtocolFds",
    "ShutdownAware",
    "StdioStartupError",
    "claim_protocol_fds",
    "open_streams",
    "serve_acp_streams",
]
