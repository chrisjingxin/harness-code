"""ACP 进程内测试夹具：真实 Host + 真实 stdio 服务层 + 裸行客户端。

【为什么用 socketpair 而不是进程】
`serve_acp_streams` 只要求 `StreamReader`/`StreamWriter`，用一对 socket 就能
让 SDK 的类型检查通过，同时保留「写端断开」「逐行读取」这些真实行为。
客户端刻意用裸行读写而不是官方 SDK 客户端：只有这样才看得到帧到达顺序，
才能断言「所有 session/update 都排在 prompt 响应之前」。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Self

from acp.schema import AgentMessageChunk, PromptResponse, ToolCallStart
from langchain_core.messages import AIMessageChunk, ToolMessage

from harness_agent.host.acp.server import AcpServer
from harness_agent.host.acp.stdio import AcpStreams, serve_acp_streams
from harness_agent.host.agent_host import AgentHost


def make_host(
    tmp_path: Path,
    *,
    agent: object | None = None,
    echo: bool = False,
) -> AgentHost:
    """构造一个隔离到 tmp_path 的 Host：不读用户目录、不连真实模型。"""
    workspace = tmp_path / "ws"
    workspace.mkdir(parents=True, exist_ok=True)
    return AgentHost(
        agent=agent,
        allow_echo=echo,
        config_home=tmp_path / "home",
        workspace=workspace,
    )


def text(value: str) -> tuple[str, tuple[AIMessageChunk, dict[str, Any]]]:
    """一步：正文增量（真实 `AIMessageChunk`）。"""
    return ("messages", (AIMessageChunk(content=value), {}))


def reasoning(value: str) -> tuple[str, tuple[Any, dict[str, Any]]]:
    """一步：思考增量（用带 `additional_kwargs` 的真实 chunk）。"""
    return ("messages", (AIMessageChunk(content="", additional_kwargs={"reasoning_content": value}), {}))


def tool_start(tool_id: str, name: str) -> tuple[str, tuple[AIMessageChunk, dict[str, Any]]]:
    """一步：工具开始（`tool_call_chunks` 只有 name，没有参数）。"""
    return (
        "messages",
        (
            AIMessageChunk(
                content="",
                tool_call_chunks=[{"name": name, "args": "", "id": tool_id, "index": 0}],
            ),
            {},
        ),
    )


def tool_args(tool_id: str, arguments: str) -> tuple[str, tuple[AIMessageChunk, dict[str, Any]]]:
    """一步：工具参数增量；可以分多次推送拼成合法 JSON。"""
    return (
        "messages",
        (
            AIMessageChunk(
                content="",
                tool_call_chunks=[{"name": None, "args": arguments, "id": tool_id, "index": 0}],
            ),
            {},
        ),
    )


def tool_result(
    tool_id: str, output: str, *, error: bool = False
) -> tuple[str, dict[str, Any]]:
    """一步：工具结果（`updates` 流里的真实 `ToolMessage`）。"""
    return (
        "updates",
        {
            "tools": {
                "messages": [
                    ToolMessage(
                        content=output,
                        tool_call_id=tool_id,
                        status="error" if error else "success",
                    )
                ]
            }
        },
    )


def flush() -> tuple[str, Any]:
    """一步：空的 `updates` 事件。

    它是「图边界」：executor 会在此把挂起的非实时 signal（`tool.started` 等）
    冲刷出来。没有这个边界，流被阻塞时工具卡永远不会公告出去。
    """
    return ("updates", {"tools": {"messages": []}})


def block() -> tuple[str, Any]:
    """一步：永远阻塞，用来制造「Run 还在跑」的窗口。"""
    return ("block", None)


class ScriptedAgent:
    """按固定步骤产出 LangGraph 风格事件的假 Agent（不依赖模型）。"""

    def __init__(self, steps: Sequence[tuple[str, Any]]) -> None:
        """保存步骤表；每轮 astream 从头上再放一遍。"""
        self._steps = list(steps)

    async def astream(self, _stream_input: object, **_kwargs: Any) -> AsyncIterator[Any]:
        """依次重放步骤；`block` 步骤一直等到 Run 被取消。"""
        for kind, payload in self._steps:
            if kind == "block":
                await asyncio.Event().wait()
            yield (kind, payload)


class RawAcpClient:
    """裸行 ACP 客户端：负责发帧、按顺序收集帧。"""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """绑定客户端一侧的读写流。"""
        self._reader = reader
        self._writer = writer
        self.frames: list[dict[str, Any]] = []

    async def send(self, payload: Mapping[str, Any]) -> None:
        """写一帧并 drain。"""
        self._writer.write((json.dumps(payload) + "\n").encode())
        await self._writer.drain()

    async def write_raw(self, data: bytes) -> None:
        """写入原始字节：用于验证 FrameGuard 对坏帧的处理（不经 JSON 编码）。"""
        self._writer.write(data)
        await self._writer.drain()

    async def notify(self, method: str, params: Mapping[str, Any]) -> None:
        """发通知（没有 id）。"""
        await self.send({"jsonrpc": "2.0", "method": method, "params": dict(params)})

    async def read_frame(self, timeout: float = 10.0) -> dict[str, Any]:
        """读一帧；EOF 视为失败。"""
        line = await asyncio.wait_for(self._reader.readline(), timeout)
        assert line, "ACP stream closed unexpectedly"
        frame = json.loads(line)
        self.frames.append(frame)
        return frame

    async def request(
        self, request_id: int, method: str, params: Mapping[str, Any], timeout: float = 20.0
    ) -> dict[str, Any]:
        """发请求并读到对应 id 的响应；中间帧留在 `self.frames`。"""

        async def _loop() -> dict[str, Any]:
            while True:
                frame = await self.read_frame(timeout)
                if frame.get("id") == request_id and ("result" in frame or "error" in frame):
                    return frame

        await self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)})
        return await asyncio.wait_for(_loop(), timeout)

    async def read_until(
        self, predicate: Any, timeout: float = 20.0
    ) -> dict[str, Any]:
        """一直读到满足 predicate 的帧。"""

        async def _loop() -> dict[str, Any]:
            while True:
                frame = await self.read_frame(timeout)
                if predicate(frame):
                    return frame

        return await asyncio.wait_for(_loop(), timeout)

    def updates(self) -> list[dict[str, Any]]:
        """返回已收到的 session/update 帧。"""
        return [frame for frame in self.frames if frame.get("method") == "session/update"]

    async def close(self) -> None:
        """关闭客户端写端以便服务端收尾。"""
        self._writer.close()
        with contextlib.suppress(ConnectionError, OSError):
            await self._writer.wait_closed()


class InProcessAcp:
    """在进程内启动真实 `AcpServer` + 真实 stdio 服务层。"""

    def __init__(
        self,
        host: AgentHost,
        *,
        grace_seconds: float = 2.0,
        log: object | None = None,
    ) -> None:
        """保存 Host；流与服务任务在 `start()` 里创建。"""
        self.host = host
        self.server = AcpServer(host, log=log)
        self._client: RawAcpClient | None = None
        self._task: asyncio.Task[int] | None = None
        self._grace = grace_seconds
        self.exit_code: int | None = None

    async def start(self) -> Self:
        """建立 socketpair、打开流并启动服务任务。"""
        agent_sock, client_sock = socket.socketpair()
        agent_sock.setblocking(False)
        client_sock.setblocking(False)
        agent_reader, agent_writer = await asyncio.open_connection(sock=agent_sock)
        client_reader, client_writer = await asyncio.open_connection(sock=client_sock)
        streams = AcpStreams(reader=agent_reader, writer=agent_writer, lost=asyncio.Event())
        self._client = RawAcpClient(client_reader, client_writer)
        self._task = asyncio.create_task(
            serve_acp_streams(
                self.server,
                streams,
                install_signals=False,
                grace_seconds=self._grace,
            )
        )
        return self

    @property
    def client(self) -> RawAcpClient:
        """已连接的裸行客户端；`start()` 之前访问是编程错误。"""
        assert self._client is not None, "InProcessAcp.start() has not run"
        return self._client

    async def stop(self) -> int:
        """关闭客户端并等服务端收尾，返回退出码。"""
        assert self._task is not None
        await self.client.close()
        self.exit_code = await asyncio.wait_for(self._task, 20)
        return self.exit_code

    async def __aenter__(self) -> Self:
        """支持 `async with`。"""
        return await self.start()

    async def __aexit__(self, *_exc: object) -> None:
        """无论用例成败都要收尾，避免悬挂任务。"""
        if self._task is not None and not self._task.done():
            await self.client.close()
            await asyncio.gather(self._task, return_exceptions=True)


def prompt_response(frame: Mapping[str, Any]) -> PromptResponse:
    """把 prompt 响应帧解析成 SDK 模型，便于断言 stopReason。"""
    return PromptResponse.model_validate(frame["result"])


def first_update(frame_type: str, frames: Iterable[Mapping[str, Any]]) -> Mapping[str, Any]:
    """按 `sessionUpdate` 类型找第一条 update。"""
    for frame in frames:
        update = frame.get("params", {}).get("update", {})
        if update.get("sessionUpdate") == frame_type:
            return update
    raise AssertionError(f"no {frame_type} update in {list(frames)}")


def agent_text(update: Mapping[str, Any]) -> str:
    """取一条 agent_message_chunk 的文本。"""
    return str(update.get("content", {}).get("text", ""))


__all__ = [
    "AgentMessageChunk",
    "InProcessAcp",
    "RawAcpClient",
    "ScriptedAgent",
    "ToolCallStart",
    "agent_text",
    "block",
    "first_update",
    "flush",
    "make_host",
    "prompt_response",
    "reasoning",
    "text",
    "tool_args",
    "tool_result",
    "tool_start",
]
