"""`harness acp` 的关闭顺序：EOF、信号、对端断开都要有界退出。

【为什么必须真子进程】
这些场景依赖真实信号投递和真实管道断开。关闭顺序写错时的表现是「prompt 永远不返回」
或「进程挂住」，只有在进程级别才观察得到。
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = PACKAGE_ROOT / "tests" / "support" / "acp_scripted_main.py"

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="ACP stdio 在 Windows 上不支持")


def _spawn(scenario: str, home: Path, *, extra_env: dict[str, str] | None = None) -> Any:
    """启动测试专用 ACP 子进程。"""
    home.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "HOME": str(home),
        "PYTHONPATH": str(PACKAGE_ROOT),
        "ACP_SCENARIO": scenario,
        **(extra_env or {}),
    }
    return asyncio.create_subprocess_exec(
        sys.executable,
        str(SCRIPT),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(home),
    )


def _frame(payload: dict[str, Any]) -> bytes:
    """把 JSON-RPC 对象编码成一行。"""
    return (json.dumps(payload) + "\n").encode()


async def _initialize(process: Any) -> dict[str, Any]:
    """完成 initialize 握手并返回响应。"""
    process.stdin.write(
        _frame({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}})
    )
    await process.stdin.drain()
    while True:
        line = await asyncio.wait_for(process.stdout.readline(), 20)
        frame = json.loads(line)
        if frame.get("id") == 1:
            return frame


async def _new_session(process: Any, workspace: Path) -> str:
    """建立 session 并返回 sessionId。"""
    process.stdin.write(
        _frame(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": str(workspace), "mcpServers": []},
            }
        )
    )
    await process.stdin.drain()
    while True:
        line = await asyncio.wait_for(process.stdout.readline(), 20)
        frame = json.loads(line)
        if frame.get("id") == 2:
            return frame["result"]["sessionId"]


async def _prompt(process: Any, session_id: str, request_id: int = 3) -> None:
    """发出 session/prompt，不等待响应。"""
    process.stdin.write(
        _frame(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "session/prompt",
                "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "你好"}]},
            }
        )
    )
    await process.stdin.drain()


async def _read_first_update(process: Any) -> None:
    """等到第一条 session/update，证明 prompt 已被处理。"""
    while True:
        line = await asyncio.wait_for(process.stdout.readline(), 20)
        frame = json.loads(line)
        if frame.get("method") == "session/update":
            return


async def _read_until_prompt_response(process: Any, request_id: int = 3) -> dict[str, Any]:
    """读到 prompt 响应为止，返回该响应。"""
    while True:
        line = await asyncio.wait_for(process.stdout.readline(), 20)
        frame = json.loads(line)
        if frame.get("id") == request_id and ("result" in frame or "error" in frame):
            return frame


async def _wait_exit(process: Any, timeout: float = 20.0) -> int:
    """等进程退出；超时直接判失败，避免测试挂住。"""
    await asyncio.wait_for(process.wait(), timeout)
    return process.returncode


async def test_stdin_eof_when_idle_exits_zero(tmp_path: Path) -> None:
    """空闲时 EOF 属于正常关闭，退出码 0。"""
    process = await _spawn("stub", tmp_path / "home")
    await _initialize(process)
    process.stdin.close()
    assert await _wait_exit(process) == 0


async def test_sigterm_cancels_inflight_prompt_then_exits_zero(tmp_path: Path) -> None:
    """SIGTERM 时先取消在途 Run，等到 cancelled 响应写出，再以 0 退出。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    process = await _spawn("block", tmp_path / "home")
    await _initialize(process)
    session_id = await _new_session(process, workspace)
    await _prompt(process, session_id)
    await _read_first_update(process)
    process.send_signal(signal.SIGTERM)
    response = await _read_until_prompt_response(process)
    assert response.get("result", {}).get("stopReason") == "cancelled", response
    assert await _wait_exit(process) == 0


async def test_sigint_cancels_inflight_prompt_then_exits_zero(tmp_path: Path) -> None:
    """SIGINT 与 SIGTERM 走同一条收尾路径。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    process = await _spawn("block", tmp_path / "home")
    await _initialize(process)
    session_id = await _new_session(process, workspace)
    await _prompt(process, session_id)
    await _read_first_update(process)
    process.send_signal(signal.SIGINT)
    response = await _read_until_prompt_response(process)
    assert response.get("result", {}).get("stopReason") == "cancelled", response
    assert await _wait_exit(process) == 0


async def test_eof_with_inflight_prompt_returns_cancelled(tmp_path: Path) -> None:
    """EOF 表示客户端离开：取消在途 Run 并让它拿到 cancelled 响应。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    process = await _spawn("block", tmp_path / "home")
    await _initialize(process)
    session_id = await _new_session(process, workspace)
    await _prompt(process, session_id)
    await _read_first_update(process)
    process.stdin.close()
    response = await _read_until_prompt_response(process)
    assert response.get("result", {}).get("stopReason") == "cancelled", response
    assert await _wait_exit(process) == 0


async def test_client_closing_stdout_pipe_does_not_hang(tmp_path: Path) -> None:
    """客户端关掉 stdout 管道后，进程不能因为发送挂住而永不退出。"""
    process = await _spawn("stub", tmp_path / "home")
    await _initialize(process)
    # 关闭客户端读端：后续写入会 EPIPE，写循环退出。
    process.stdout._transport.close()
    process.stdin.close()
    assert await _wait_exit(process, timeout=30.0) == 0


async def test_grace_expiry_still_exits(tmp_path: Path) -> None:
    """在途 Run 不理会取消时，宽限期到点也必须退出，不能永久挂住。"""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    process = await _spawn("stubborn", tmp_path / "home", extra_env={"ACP_GRACE_SECONDS": "0.2"})
    await _initialize(process)
    session_id = await _new_session(process, workspace)
    await _prompt(process, session_id)
    await _read_first_update(process)
    process.stdin.close()
    assert await _wait_exit(process, timeout=30.0) == 0
