"""测试专用 ACP 子进程入口（不是生产代码）。

【为什么需要它】
`harness acp` 的 stdout 洁癖只能用真实子进程验证：只有在真实进程里
`claim_protocol_fds()` 才能把 fd 1 重定向到 stderr，也才能观察到子进程、
孙进程继承 fd 的行为。本脚本按环境变量 `ACP_SCENARIO` 选一个场景，
用测试自带的 `_StubAgent` 跑 `serve_acp_streams`，不碰真实模型。
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from acp.schema import (
    AgentCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PromptResponse,
)

from harness_agent.host.acp.stdio import (
    AcpStreams,
    ProtocolFds,
    StdioStartupError,
    claim_protocol_fds,
    open_streams,
    serve_acp_streams,
)

# 子进程里探测「哪些 fd 被继承」；只读 fstat，不额外占用 fd。
_FD_PROBE = (
    "import os\n"
    "open_fds = []\n"
    "for fd in range(21):\n"
    "    try:\n"
    "        os.fstat(fd)\n"
    "    except OSError:\n"
    "        continue\n"
    "    open_fds.append(fd)\n"
    "print('pollute-child-fds:', open_fds)\n"
)


class _StubAgent:
    """最小 ACP Agent：只够跑通一轮对话，或在 prompt 里故意污染 stdout。"""

    def __init__(self, scenario: str) -> None:
        """记录场景名并准备取消信号。"""
        self._scenario = scenario
        self._client: Any | None = None
        self._cancelled = asyncio.Event()
        self._closing = False
        self._sessions: set[str] = set()
        self._in_flight = 0
        self._idle = asyncio.Event()
        self._idle.set()

    def on_connect(self, conn: object) -> None:
        """保存 SDK 给的客户端连接，prompt 里用它推 session/update。"""
        self._client = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: object | None = None,
        client_info: object | None = None,
        **kwargs: object,
    ) -> InitializeResponse:
        """固定回协议版本 1；其它客户端能力一律不使用。"""
        return InitializeResponse(
            protocol_version=1,
            agent_capabilities=AgentCapabilities(load_session=False),
            auth_methods=[],
            agent_info=Implementation(name="stub", title="Stub", version="0"),
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[object] | None = None,
        **kwargs: object,
    ) -> NewSessionResponse:
        """生成一个 sessionId；stub 不落库也不校验 cwd。"""
        session_id = str(uuid.uuid4())
        self._sessions.add(session_id)
        return NewSessionResponse(session_id=session_id)

    async def prompt(
        self,
        session_id: str,
        prompt: list[object],
        **kwargs: object,
    ) -> PromptResponse:
        """推一条 update；按场景做污染、阻塞或立即结束。"""
        self._in_flight += 1
        self._idle.clear()
        try:
            if self._scenario == "pollute":
                self._pollute()
            client = self._require_client()
            await client.session_update(session_id, _agent_message("stub-update"))
            if self._scenario in {"block", "stubborn"}:
                while not self._cancelled.is_set():
                    await asyncio.sleep(0.03)
                    await client.session_update(session_id, _agent_message("."))
            reason = "cancelled" if self._cancelled.is_set() else "end_turn"
            return PromptResponse(stop_reason=reason)
        finally:
            self._in_flight -= 1
            if not self._in_flight:
                self._idle.set()

    def _require_client(self) -> Any:
        """返回 SDK 交给我们的客户端连接；未连接即编程错误。"""
        assert self._client is not None, "ACP client is not connected"
        return self._client

    async def cancel(self, session_id: str, **kwargs: object) -> None:
        """block 场景放行；stubborn 场景故意不理会取消，用来验证宽限期兜底。"""
        if self._scenario != "stubborn":
            self._cancelled.set()

    async def begin_shutdown(self) -> None:
        """关闭开始时放行 block 场景；stubborn 场景保持阻塞。"""
        self._closing = True
        if self._scenario != "stubborn":
            self._cancelled.set()

    async def wait_idle(self, timeout: float) -> bool:
        """等在途 prompt 返回；超时返回 False。"""
        try:
            await asyncio.wait_for(self._idle.wait(), timeout)
        except TimeoutError:
            return False
        return True

    async def aclose(self) -> None:
        """stub 没有需要释放的传输资源。"""
        self._closing = False

    def _pollute(self) -> None:
        """模拟各种会写 fd 1 的库与子进程，全部应当落到 stderr。"""
        print("pollute-print")
        sys.stdout.write("pollute-write\n")
        sys.stdout.flush()
        original = sys.__stdout__
        if original is not None:
            original.write("pollute-dunder\n")
            original.flush()
        os.write(1, b"pollute-fd1\n")
        # 故意用 os.system：验证 libc 层的 system() 也写不到协议通道。
        os.system("echo pollute-system")
        subprocess.run(["sh", "-c", "echo pollute-subprocess"], check=False)
        # 后台孙进程延迟输出：父进程返回后仍在写，仍不能进协议通道。
        subprocess.Popen(["sh", "-c", "sleep 0.2; echo pollute-grandchild"])
        # 继承 stdin 的子进程必须立刻读到 EOF（fd 0 已被重定向到 /dev/null）。
        cat = subprocess.run(["cat"], capture_output=True, timeout=10, check=False)
        sys.stderr.write(f"pollute-cat-bytes:{len(cat.stdout)}\n")
        probe = subprocess.run(
            [sys.executable, "-c", _FD_PROBE], capture_output=True, text=True, timeout=20, check=False
        )
        sys.stderr.write(probe.stdout)
        sys.stderr.flush()


def _agent_message(text: str):
    """构造一条 agent_message_chunk update。"""
    from acp.helpers import update_agent_message_text

    return update_agent_message_text(text)


def main() -> int:
    """按场景跑 stdio 服务；启动失败按约定返回退出码 2。"""
    scenario = os.environ.get("ACP_SCENARIO", "stub")
    grace = float(os.environ.get("ACP_GRACE_SECONDS", "5"))
    try:
        fds = claim_protocol_fds()
    except StdioStartupError as exc:
        sys.stderr.write(f"harness-agent acp: {exc}\n")
        sys.stderr.flush()
        return 2
    return asyncio.run(_run(scenario, fds, grace))


async def _run(scenario: str, fds: ProtocolFds, grace: float) -> int:
    """按场景选服务实现；退出码由服务层决定。

    `stub*` 用本文件的假 Agent（只测传输层），`host` 起真实 `AgentHost` + 真实
    `run_acp_stdio`（测端到端链路，含 Host 的 Run 生命周期）。
    """
    streams = await open_streams(fds)
    if scenario == "host":
        return await _run_host(streams, grace)
    if scenario == "tools":
        return await _run_host(streams, grace, scripted_tools=True)
    return await serve_acp_streams(_StubAgent(scenario), streams, grace_seconds=grace)


async def _run_host(streams: AcpStreams, grace: float, *, scripted_tools: bool = False) -> int:
    """用真实 Host 跑一轮；不碰真实模型与用户目录。

    默认是 echo 模式（只有文字事件）。`scripted_tools=True` 时注入脚本化 Agent，
    产出一次完整的工具调用（started → 参数 → completed）再回一段文字，用来让官方 SDK
    客户端真的看到 tool_call / tool_call_update。
    """
    from harness_agent.host.acp.stdio import run_acp_stdio
    from harness_agent.host.agent_host import AgentHost

    workspace = os.environ.get("ACP_WORKSPACE")
    root = Path(workspace) if workspace else Path.cwd()
    if scripted_tools:
        from tests.support.acp_harness import ScriptedAgent, text, tool_args, tool_result, tool_start

        host = AgentHost(
            agent=ScriptedAgent(
                [
                    tool_start("call_0", "read_file"),
                    tool_args("call_0", '{"file_path":"/note.txt"}'),
                    tool_result("call_0", "hello from file"),
                    text("读完了"),
                ]
            ),
            config_home=Path(os.environ["HOME"]),
            workspace=root,
        )
    else:
        host = AgentHost(allow_echo=True, config_home=Path(os.environ["HOME"]), workspace=root)
    return await run_acp_stdio(host, streams=streams, grace_seconds=grace)


if __name__ == "__main__":
    sys.exit(main())
