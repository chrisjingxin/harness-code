"""官方 SDK 客户端端到端：真实子进程跑完一轮 ACP 对话。

【为什么必须用官方客户端】
前面的测试都用裸行客户端，能验证线路字节，但不证明「一个真实的 ACP 客户端
能连上并正常使用」。这里用 `agent-client-protocol` 自带的 `spawn_agent_process`
起真实 `python -m harness_agent acp`，完成握手、建会话、发 prompt、收 update。
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, cast

import pytest
from acp import spawn_agent_process
from acp.schema import (
    AgentMessageChunk,
    DeniedOutcome,
    RequestPermissionResponse,
    TextContentBlock,
    ToolCallProgress,
    ToolCallStart,
)

AGENT_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = AGENT_ROOT / "tests" / "support" / "acp_scripted_main.py"


class _RecordingClient:
    """最小 ACP 客户端：记录 update，拒绝任何权限请求（S1 不该收到）。"""

    def __init__(self) -> None:
        """初始化记录表。"""
        self.updates: list[Any] = []
        self.permission_requests: list[Any] = []

    async def session_update(self, session_id: str, update: Any, **_kwargs: Any) -> None:
        """记录一条 session/update。"""
        self.updates.append(update)

    async def request_permission(self, session_id: str, tool_call: Any, options: Any, **_kwargs: Any):
        """S1 没有审批通道；真收到就记录并拒绝。"""
        self.permission_requests.append((session_id, tool_call, options))
        return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))

    async def read_text_file(self, session_id: str, path: str, **_kwargs: Any):
        """S1 不使用客户端文件系统能力。"""
        raise AssertionError("agent must not read files through the client")

    async def write_text_file(self, session_id: str, path: str, content: str, **_kwargs: Any):
        """S1 不使用客户端文件系统能力。"""
        raise AssertionError("agent must not write files through the client")

    def on_connect(self, _conn: object) -> None:
        """SDK 建立连接时回调；这里不需要额外状态。"""


def _child_env(home: Path) -> dict[str, str]:
    """构造子进程环境：隔离 HOME，注入包路径与 echo 模式。"""
    return {
        **os.environ,
        "HOME": str(home),
        "PYTHONPATH": str(AGENT_ROOT),
        "HARNESS_ECHO_MODE": "1",
    }


def test_sdk_version_is_pinned_release() -> None:
    """SDK 版本必须与设计文档锁定的一致；缺包或漂移都应当立刻失败。"""
    import importlib.metadata

    assert importlib.metadata.version("agent-client-protocol") == "0.12.1"


async def test_real_entrypoint_completes_one_round_through_sdk_client(tmp_path: Path) -> None:
    """真实入口：initialize → session/new → session/prompt → update + end_turn。"""
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    async with spawn_agent_process(
        # 测试客户端只实现本用例会走到的方法；`cast` 明确表示不满足完整 Client 协议。
        cast(Any, client),
        sys.executable,
        "-m",
        "harness_agent",
        "acp",
        env=_child_env(home),
        cwd=str(workspace),
    ) as (connection, process):
        init = await connection.initialize(protocol_version=1)
        assert init.protocol_version == 1
        assert init.agent_info is not None and init.agent_info.name == "harness-code"
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="你好")],
        )
        assert response.stop_reason == "end_turn"
        chunks = [update for update in client.updates if isinstance(update, AgentMessageChunk)]
        assert chunks, client.updates
        assert chunks[0].content.text == "你好"
        assert str(chunks[0].message_id).endswith(":m0")
        assert client.permission_requests == []
    # 上下文退出后 SDK 会关 stdin；进程必须在宽限期内以 0 退出，不能挂住。
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


async def test_real_entrypoint_host_scenario_streams_text_in_echo_mode(tmp_path: Path) -> None:
    """真实 Host 的 echo 场景：只有文字事件，走同一套 stdio 服务层。

    注意：echo 模式不产生工具事件，所以这里不断言工具卡；工具卡由下面的 `tools` 场景覆盖。
    """
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    env = _child_env(home) | {"ACP_SCENARIO": "host"}
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        await connection.initialize(protocol_version=1)
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="写点东西")],
        )
        assert response.stop_reason == "end_turn"
        chunks = [u for u in client.updates if isinstance(u, AgentMessageChunk)]
        assert chunks and chunks[0].content.text == "写点东西"
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


async def test_real_entrypoint_streams_tool_card_through_official_client(tmp_path: Path) -> None:
    """tools 场景：官方 SDK 客户端必须真的收到 tool_call → tool_call_update(completed) 再收到文字。

    Code Review 指出原用例在 echo 模式下 `tool_cards` 恒为空，断言是永真的。
    """
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    env = _child_env(home) | {"ACP_SCENARIO": "tools", "ACP_WORKSPACE": str(workspace)}
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        await connection.initialize(protocol_version=1)
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        response = await connection.prompt(
            session_id=session.session_id,
            prompt=[TextContentBlock(type="text", text="读一下 note.txt")],
        )
        assert response.stop_reason == "end_turn"
        starts = [u for u in client.updates if isinstance(u, ToolCallStart)]
        progress = [u for u in client.updates if isinstance(u, ToolCallProgress)]
        assert len(starts) == 1, client.updates
        assert starts[0].kind == "read" and starts[0].status == "pending"
        assert starts[0].tool_call_id.endswith(":call_0")
        assert any(p.tool_call_id == starts[0].tool_call_id and p.status == "completed" for p in progress)
        texts = [u.content.text for u in client.updates if isinstance(u, AgentMessageChunk)]
        assert "读完了" in texts
        # 工具卡必须出现在最终文字之前：客户端按到达顺序渲染。
        order = [type(u).__name__ for u in client.updates]
        assert order.index("ToolCallStart") < order.index("AgentMessageChunk")
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


async def test_real_entrypoint_stub_block_scenario_cancels_and_exits_cleanly(tmp_path: Path) -> None:
    """block 场景（传输层 stub，不是真实 AcpServer）：cancel 后拿到 cancelled，进程正常退出。

    名字不再声称「恢复」：取消后再发 prompt 的恢复由 `test_server_cancel.py` 用真实
    AcpServer 覆盖。"""
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    home.mkdir()
    workspace.mkdir()
    client = _RecordingClient()
    env = _child_env(home) | {"ACP_SCENARIO": "block"}
    async with spawn_agent_process(
        cast(Any, client),
        sys.executable,
        str(SCRIPT),
        env=env,
        cwd=str(workspace),
    ) as (connection, process):
        await connection.initialize(protocol_version=1)
        session = await connection.new_session(cwd=str(workspace), mcp_servers=[])
        task = asyncio.create_task(
            connection.prompt(
                session_id=session.session_id,
                prompt=[TextContentBlock(type="text", text="长时间任务")],
            )
        )
        # 等到第一条 update，确认 prompt 已被处理。
        for _ in range(400):
            if client.updates:
                break
            await asyncio.sleep(0.01)
        assert client.updates
        await connection.cancel(session_id=session.session_id)
        response = await asyncio.wait_for(task, timeout=20)
        assert response.stop_reason == "cancelled"
    await asyncio.wait_for(process.wait(), timeout=10)
    assert process.returncode == 0


@pytest.mark.skipif(os.name == "nt", reason="POSIX 专用入口")
async def test_real_entrypoint_exits_two_for_bad_arguments(tmp_path: Path) -> None:
    """`acp` 后跟多余参数：spawn 成功但进程以 2 退出，不进入协议循环。"""
    home = tmp_path / "home"
    home.mkdir()
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "harness_agent",
        "acp",
        "--cwd",
        str(tmp_path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=_child_env(home),
        cwd=str(tmp_path),
    )
    assert process.stdin is not None
    process.stdin.close()
    stderr = await asyncio.wait_for(process.stderr.read(), timeout=20)  # type: ignore[union-attr]
    await asyncio.wait_for(process.wait(), timeout=20)
    assert process.returncode == 2
    assert "Usage" in stderr.decode("utf-8", "replace")
