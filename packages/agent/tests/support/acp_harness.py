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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self

from acp.schema import AgentMessageChunk, PromptResponse, ToolCallStart
from langchain_core.messages import AIMessageChunk, ToolMessage

from harness_agent.host.acp.server import AcpServer
from harness_agent.host.acp.stdio import AcpStreams, serve_acp_streams
from harness_agent.host.agent_host import AgentHost
from harness_agent.protocol.generated import MAX_FRAME_BYTES


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


def make_persistent_host(tmp_path: Path) -> AgentHost:
    """构造带真实 Thread 存储的 Host：不注入 Agent，也不开 echo。

    只有「默认 Agent 工厂 + 非 echo」的 Host 才会打开 Thread 持久化（见
    `AgentHost._thread_persistence_enabled`）；`session/list` 与 `session/load` 的回放
    必须靠它。代价是这类 Host 没配模型，`session/prompt` 会回 MODEL_CONFIGURATION_REQUIRED，
    所以用它写的用例只验证会话读写，不验证「恢复后继续对话」。
    """
    workspace = tmp_path / "ws"
    workspace.mkdir(parents=True, exist_ok=True)
    return AgentHost(config_home=tmp_path / "home", workspace=workspace)


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
        self.inputs: list[object] = []

    async def astream(self, stream_input: object = None, **_kwargs: Any) -> AsyncIterator[Any]:
        """依次重放步骤；`block` 步骤一直等到 Run 被取消。

        `inputs` 记录每次收到的流输入：`/命令` 测试靠它断言 Host 实际渲染出的正文。
        """
        self.inputs.append(stream_input)
        for kind, payload in self._steps:
            if kind == "block":
                await asyncio.Event().wait()
            yield (kind, payload)


@dataclass(frozen=True, slots=True)
class _FakeInterrupt:
    """模拟 LangGraph 的 Interrupt：Host 只读 `value` 与 `id`。"""

    value: dict[str, Any]
    id: str


def resume_decisions(stream_input: object) -> list[str] | None:
    """从 `Command(resume=...)` 里抽出本批决策类型；不是恢复调用时返回 None。"""
    resume = getattr(stream_input, "resume", None)
    if not isinstance(resume, Mapping):
        return None
    for value in resume.values():
        if isinstance(value, Mapping):
            decisions = value.get("decisions")
            if isinstance(decisions, list):
                return [
                    str(decision.get("type"))
                    for decision in decisions
                    if isinstance(decision, Mapping)
                ]
    return None


class ApprovalAgent:
    """脚本化 HITL Agent：首轮发 `__interrupt__`，恢复轮按用户决定走不同后续。

    `ScriptedAgent` 不能触发审批：它忽略 resume 输入、每轮从头重放整张表，真放一个
    interrupt 进去会死循环。这个类保留 `ScriptedAgent` 行为不变，只多一条「首轮中断 /
    恢复轮按决定分叉」的路径。
    """

    def __init__(
        self,
        *,
        before: Sequence[tuple[str, Any]] = (),
        actions: Sequence[Mapping[str, Any]] = (),
        interrupt_id: str | None = "int-1",
        on_approve: Sequence[tuple[str, Any]] = (),
        on_reject: Sequence[tuple[str, Any]] = (),
        before_interrupt: Any | None = None,
    ) -> None:
        """保存三段脚本：中断前、批准后、拒绝后。"""
        self._before = list(before)
        self._actions = [dict(action) for action in actions]
        self._interrupt_id = interrupt_id
        self._on_approve = list(on_approve)
        self._on_reject = list(on_reject)
        self._before_interrupt = before_interrupt
        # `interrupt_id=None` 时自增：两个会话并发跑同一个 Agent 需要不同的中断 id，
        # 否则两次审批的 v3 request_id 会撞在一起。
        self._auto_interrupt = interrupt_id is None
        self._interrupt_seq = 1
        self.resumes: list[list[str]] = []

    async def astream(self, stream_input: object = None, **_kwargs: Any) -> AsyncIterator[Any]:
        """首轮发中断；恢复轮按 `resume` 里的决定重放对应步骤表。"""
        decisions = resume_decisions(stream_input)
        if decisions is None:
            for kind, payload in self._before:
                if kind == "block":
                    await asyncio.Event().wait()
                yield (kind, payload)
            if self._before_interrupt is not None:
                self._before_interrupt()
            interrupt_id = self._next_interrupt_id()
            yield (
                "updates",
                {
                    "__interrupt__": [
                        _FakeInterrupt({"action_requests": list(self._actions)}, interrupt_id)
                    ]
                },
            )
            return
        self.resumes.append(decisions)
        steps = self._on_approve if "approve" in decisions else self._on_reject
        for kind, payload in steps:
            if kind == "block":
                await asyncio.Event().wait()
            yield (kind, payload)

    def _next_interrupt_id(self) -> str:
        """返回本次中断 id：显式指定就固定，否则自增。"""
        if not self._auto_interrupt:
            return str(self._interrupt_id)
        interrupt_id = f"int-{self._interrupt_seq}"
        self._interrupt_seq += 1
        return interrupt_id


class JourneyAgent:
    """按用户那句话走提问、计划确认或卡住。官方 SDK 端到端用它，不调用模型。

    提问和计划都做成 LangGraph 的 interrupt，Host 会收成对应的交互。
    恢复轮只看客户端交回来的结果，回一句让测试能判断走通了哪一步。
    """

    async def astream(self, stream_input: object = None, **_kwargs: Any) -> AsyncIterator[Any]:
        """首轮按正文分支；恢复轮按回答、计划决定或「不能提问」的错误收尾。"""
        resume = getattr(stream_input, "resume", None)
        if isinstance(resume, Mapping):
            for value in resume.values():
                if not isinstance(value, Mapping):
                    continue
                if value.get("status") == "error":
                    yield text(str(value.get("error") or "提问失败"))
                    return
                if value.get("status") == "answered":
                    answers = value.get("answers")
                    chosen = answers[0] if isinstance(answers, list) and answers else ""
                    yield text(f"已回答：{chosen}")
                    return
                if "decision" in value:
                    yield text(f"计划{value.get('decision')}")
                    return
            yield text("已结束")
            return
        rendered = str(stream_input)
        if "请提问" in rendered:
            yield _interrupt(
                {
                    "type": "ask_user",
                    "questions": [
                        {
                            "question": "用哪种方案？",
                            "choices": [{"value": "甲"}, {"value": "乙"}],
                        }
                    ],
                },
                "ask-1",
            )
            return
        if "请出计划" in rendered:
            yield _interrupt(
                {
                    "type": "plan",
                    "plan_markdown": "先改说明文件",
                    "has_plan": True,
                    "revision": 1,
                    "tool_call_id": "plan-1",
                    "plan_virtual_path": "/.harness/plan.md",
                    "plan_display_path": "计划",
                },
                "plan-1",
            )
            return
        if "请卡住" in rendered:
            yield text("开始卡住")
            await asyncio.Event().wait()
            return
        yield text("好")


def _interrupt(value: dict[str, Any], interrupt_id: str) -> tuple[str, dict[str, Any]]:
    """一步：抛出一个 Host 认得的 interrupt。"""
    return ("updates", {"__interrupt__": [_FakeInterrupt(value, interrupt_id)]})


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

    async def read_request(self, method: str, timeout: float = 20.0) -> dict[str, Any]:
        """读一帧带 `method` 与 `id` 的 agent→client 请求（权限请求等）。"""

        async def _loop() -> dict[str, Any]:
            while True:
                frame = await self.read_frame(timeout)
                if frame.get("method") == method and "id" in frame:
                    return frame

        return await asyncio.wait_for(_loop(), timeout)

    async def respond(self, frame: Mapping[str, Any], result: object) -> None:
        """回答一帧 agent→client 请求。"""
        await self.send({"jsonrpc": "2.0", "id": frame["id"], "result": result})

    async def respond_error(self, frame: Mapping[str, Any], code: int, message: str) -> None:
        """用 JSON-RPC 错误回答一帧请求。"""
        await self.send(
            {"jsonrpc": "2.0", "id": frame["id"], "error": {"code": code, "message": message}}
        )

    async def answer_permission(self, frame: Mapping[str, Any], option_id: str | None) -> None:
        """回答权限请求；`None` 表示客户端取消（用户关掉弹窗）。"""
        if option_id is None:
            await self.respond(frame, {"outcome": {"outcome": "cancelled"}})
            return
        await self.respond(
            frame, {"outcome": {"outcome": "selected", "optionId": option_id}}
        )

    async def initialize(
        self, request_id: int = 1, capabilities: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """握手；`capabilities` 走 `clientCapabilities._meta`（扩展协商用例）。"""
        params: dict[str, Any] = {"protocolVersion": 1, "clientCapabilities": {}}
        if capabilities is not None:
            params["clientCapabilities"] = {"field_meta": dict(capabilities)}
        return await self.request(request_id, "initialize", params)

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
        agent_reader, agent_writer = await asyncio.open_connection(
            sock=agent_sock, limit=MAX_FRAME_BYTES + 1
        )
        client_reader, client_writer = await asyncio.open_connection(
            sock=client_sock, limit=MAX_FRAME_BYTES + 1
        )
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
        await self.host.close()
        return self.exit_code

    async def __aenter__(self) -> Self:
        """支持 `async with`。"""
        return await self.start()

    async def __aexit__(self, *_exc: object) -> None:
        """无论用例成败都要收尾（含 Host 的持久化线程），避免拖住 pytest。"""
        if self._task is not None and not self._task.done():
            await self.client.close()
            await asyncio.gather(self._task, return_exceptions=True)
        await self.host.close()


def install_command_plugin(home: Path, workdir: Path, name: str = "audit", *, hint: str | None = None) -> str:
    """装一个带 `commands/<name>.md` 的插件，返回它对外的斜杠命令名。

    返回值就是 Host 在 `agent_commands` 里给出的 `name`（`plugin:<id>:<name>`）；
    ACP 侧原样展示（不带前导 `/`），测试用它拼 `/name 参数` 的 prompt。
    `hint` 非空时会写进命令的 `argument-hint`，用来验证 `available_commands[].input`。
    """
    from harness_agent.plugins.manager import PluginManager

    source = workdir / f"{name}-plugin"
    source.mkdir(parents=True)
    (source / "plugin.json").write_text(
        json.dumps(
            {
                "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                "name": f"{name}-plugin",
                "version": "1.0.0",
            }
        ),
        encoding="utf-8",
    )
    command = source / "commands" / f"{name}.md"
    command.parent.mkdir(parents=True)
    front_matter = f"---\ndescription: Audit from plugin\nargument-hint: {hint}\n---\n" if hint else (
        "---\ndescription: Audit from plugin\n---\n"
    )
    command.write_text(f"{front_matter}Audit the requested files.\n", encoding="utf-8")
    manifest = json.loads((source / "plugin.json").read_text(encoding="utf-8"))
    manifest["extensions"] = {
        "com.za38.harness": {"schemaVersion": "1.0.0", "commands": "./commands"}
    }
    (source / "plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    manager = PluginManager(home=home)
    manager.install(source)
    plugin_id = manager.catalog().plugins[0].plugin_id
    return f"plugin:{plugin_id.replace('/', ':')}:{name}"


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
    "ApprovalAgent",
    "InProcessAcp",
    "RawAcpClient",
    "ScriptedAgent",
    "ToolCallStart",
    "agent_text",
    "block",
    "first_update",
    "flush",
    "install_command_plugin",
    "make_host",
    "make_persistent_host",
    "primary_path_resolver",
    "prompt_response",
    "reasoning",
    "resume_decisions",
    "text",
    "tool_args",
    "tool_result",
    "tool_start",
]


def primary_path_resolver(workspace):
    """测试用：只认主工作区的展示路径解析（对应 HostServicePort.resolve_display_path 的最小子集）。

    与 `PathLocator` 新构造签名配套；外部授权根只在 AgentHost 真身上才有。
    """
    from harness_agent.policy.workspace_boundary import WorkspacePathPolicy

    policy = WorkspacePathPolicy(workspace)

    def resolve(raw, *, tool_name):
        try:
            resolved = policy.validate_direct_path(raw, tool_name=tool_name)
        except Exception:
            return None
        return str(resolved) if resolved.is_absolute() else None

    return resolve
