"""测试专用 ACP 子进程入口（不是生产代码）。

【为什么需要它】
`harness acp` 的 stdout 洁癖只能用真实子进程验证：只有在真实进程里
`claim_protocol_fds()` 才能把 fd 1 重定向到 stderr，也才能观察到子进程、
孙进程继承 fd 的行为。本脚本按环境变量 `ACP_SCENARIO` 选一个场景，
用测试自带的 `_StubAgent` 跑 `serve_acp_streams`，不碰真实模型。
"""

from __future__ import annotations

import asyncio
import json
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

    `stub*` 用本文件的假 Agent（只测传输层）；`host` / `tools` / `commands` /
    `approval` / `trust` / `history` 起真实 `AgentHost` + 真实 `run_acp_stdio`
    （测端到端链路，含 Host 的 Run 生命周期）。
    """
    streams = await open_streams(fds)
    if scenario in _HOST_SCENARIOS:
        return await _run_host(streams, grace, scenario)
    return await serve_acp_streams(_StubAgent(scenario), streams, grace_seconds=grace)


_HOST_SCENARIOS = frozenset({"host", "tools", "commands", "approval", "trust", "history"})
"""用真实 Host 跑的场景名；其余走传输层 stub。"""

TRUST_DIRECTORY = "/ext"
"""目录信任场景里待信任的外部目录。"""

TRUST_TARGET_PATH = "/ext/a.txt"
"""触发目录信任的那次调用要访问的目标路径。"""

TRUST_TOOL_NAME = "write_file"
"""目录信任场景用的工具名。

必须是**非并发安全**的工具：`ls` 这类只读工具会被 `is_concurrency_safe` 直接归入
auto-approve 分支，整批 `unsafe_indices` 为空时连中断都不会发出，目录信任根本不会弹。
真实 Agent 里有 `needs_user_decision` 把它拎回 unsafe，但脚本化 Agent 绕过那层，所以
这里直接用写工具（它本来就“始终不安全”）。
"""

TRUST_TOOL_ARGS: dict[str, object] = {"file_path": TRUST_TARGET_PATH, "content": "x"}
"""目录信任场景的工具参数（与预置 presentation 的指纹必须完全一致）。"""

HISTORY_THREAD_ID = "history-seed"
"""历史场景预置的线程 id（`session/list` 与 `session/load` 都用它）。"""


def _trust_hook(host_holder: dict[str, Any]) -> Any:
    """返回一个在中断前预置目录信任 presentation 的钩子。

    【为什么要预置】注入 Agent 时审批预检拿不到 `RunContext`，真实 Agent 里生成
    `directory_trust` presentation 的那段不会执行；`ls` 又是并发安全工具，Host 会直接
    自动放行。所以只能手工往当前 Run 的 presentation 缓存里写一条，让串行审批走到
    目录信任分支。
    """

    def prefetch() -> None:
        runs = list(host_holder["host"]._run_coordinator._runs.values())
        runs[0].approval_presentations.remember(
            TRUST_TOOL_NAME,
            TRUST_TOOL_ARGS,
            {
                "kind": "directory_trust",
                "directory": TRUST_DIRECTORY,
                "target_path": TRUST_TARGET_PATH,
                "tool_name": TRUST_TOOL_NAME,
                "access": "write",
                "shadows_workspace": False,
            },
        )

    return prefetch


async def _run_host(streams: AcpStreams, grace: float, scenario: str) -> int:
    """用真实 Host 跑指定场景；不碰真实模型与用户目录。

    场景表：
      - `host`：echo 模式，只有文字事件；
      - `tools`：脚本化 Agent，一次完整工具调用再回一段文字；
      - `commands`：装一个带 `commands/audit.md` 的插件，回「命令完成」；
      - `approval`：脚本化 HITL Agent，一次 `execute` 审批（带 `tool_call_id`）；
      - `trust`：同上，但中断前预置目录信任 presentation；
      - `history`：带真实线程存储的 Host，预置一条可回放的历史。
    """
    from harness_agent.host.acp.stdio import run_acp_stdio
    from harness_agent.host.agent_host import AgentHost

    workspace = os.environ.get("ACP_WORKSPACE")
    root = Path(workspace) if workspace else Path.cwd()
    home = Path(os.environ["HOME"])
    if scenario == "commands":
        from tests.support.acp_harness import (
            ScriptedAgent,
            install_command_plugin,
            text,
        )

        install_command_plugin(home, home / "plugin-src")
        host = AgentHost(
            agent=ScriptedAgent([text("命令完成")]),
            config_home=home,
            workspace=root,
        )
    elif scenario == "tools":
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
            config_home=home,
            workspace=root,
        )
    elif scenario in {"approval", "trust"}:
        from tests.support.acp_harness import (
            ApprovalAgent,
            flush,
            text,
            tool_args,
            tool_result,
            tool_start,
        )

        holder: dict[str, Any] = {}
        tool_name = TRUST_TOOL_NAME if scenario == "trust" else "execute"
        args = TRUST_TOOL_ARGS if scenario == "trust" else {"command": "npm test"}
        agent = ApprovalAgent(
            before=[
                tool_start("call-1", tool_name),
                tool_args("call-1", json.dumps(args)),
                flush(),
            ],
            actions=[
                {
                    "name": tool_name,
                    "args": args,
                    "description": "跑一下",
                    "tool_call_id": "call-1",
                }
            ],
            before_interrupt=_trust_hook(holder) if scenario == "trust" else None,
            on_approve=[
                tool_result("call-1", "已执行"),
                text("信任已登记" if scenario == "trust" else "批准后继续"),
            ],
            on_reject=[
                tool_result("call-1", "User rejected the tool call", error=True),
                text("已拒绝信任" if scenario == "trust" else "已拒绝"),
            ],
        )
        holder["host"] = host = AgentHost(agent=agent, config_home=home, workspace=root)
        if scenario == "trust":
            # 测试用的 `WorkspaceRootRegistry` 会把任何绝对路径都解成 primary 根
            # （`/ext/a.txt` 也不例外），于是「目标已被稳定作用域信任」的短路成立，
            # 目录信任卡片会被静默跳过。恒为 False 等价于「第一次访问、还没信任过」。
            host._run_coordinator._directory_trust_already_granted = (  # type: ignore[method-assign]
                lambda _presentation, *, run_id: False
            )
    elif scenario == "history":
        from tests.support.thread_fixtures import seed_thread

        host = AgentHost(config_home=home, workspace=root)
        store = await host._ensure_thread_persistence()
        await seed_thread(
            store,
            HISTORY_THREAD_ID,
            [
                {"kind": "user", "content": "先看一眼"},
                {"kind": "assistant", "content": "看完了。"},
                {"kind": "tool", "content": "工具输出", "tool_name": "read_file"},
            ],
        )
    else:
        host = AgentHost(allow_echo=True, config_home=home, workspace=root)
    return await run_acp_stdio(host, streams=streams, grace_seconds=grace)


if __name__ == "__main__":
    sys.exit(main())
