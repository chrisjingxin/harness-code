"""`harness acp` 的 stdout 洁癖：任何库输出都不能污染协议通道。

【为什么必须是真子进程】
fd 1 的重定向只在子进程里才有意义：只有真实进程才能观察到 `print`、`os.write(1)`
以及继承 fd 1 的子进程、孙进程会写到哪里。测试用 `acp_scripted_main` 的
`pollute` 场景故意在 prompt 里污染各种输出通道。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = PACKAGE_ROOT / "tests" / "support" / "acp_scripted_main.py"


def _spawn(
    scenario: str,
    home: Path,
    *,
    stdout: Any = asyncio.subprocess.PIPE,
    extra_env: dict[str, str] | None = None,
) -> Any:
    """启动测试专用 ACP 子进程；环境隔离到临时 HOME。"""
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
        stdout=stdout,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd=str(home),
    )


def _frame(payload: dict[str, Any]) -> bytes:
    """把 JSON-RPC 对象编码成一行。"""
    return (json.dumps(payload) + "\n").encode()


async def _send(process: Any, *payloads: dict[str, Any]) -> None:
    """连写多帧并 drain。"""
    for payload in payloads:
        process.stdin.write(_frame(payload))
    await process.stdin.drain()


async def _read_until_response(process: Any, request_id: int, timeout: float = 20.0) -> list[dict[str, Any]]:
    """读到指定 id 的响应为止，返回中间所有帧（含响应）。"""
    frames: list[dict[str, Any]] = []

    async def _loop() -> None:
        while True:
            line = await process.stdout.readline()
            assert line, f"stdout closed before response {request_id}"
            frames.append(json.loads(line))
            frame = frames[-1]
            if frame.get("id") == request_id and ("result" in frame or "error" in frame):
                return

    await asyncio.wait_for(_loop(), timeout)
    return frames


def _assert_all_frames_are_json_rpc(frames: list[dict[str, Any]]) -> None:
    """每一行都必须是 JSON-RPC 2.0 对象。"""
    for frame in frames:
        assert isinstance(frame, dict), frame
        assert frame.get("jsonrpc") == "2.0", frame


async def _drain_stdout(process: Any, timeout: float = 20.0) -> list[dict[str, Any]]:
    """读完 stdout 剩余所有行，逐行解析并校验。"""
    frames: list[dict[str, Any]] = []

    async def _loop() -> None:
        while True:
            line = await process.stdout.readline()
            if not line:
                return
            frames.append(json.loads(line))

    await asyncio.wait_for(_loop(), timeout)
    return frames


async def _close_and_wait(process: Any, timeout: float = 30.0) -> int:
    """关闭 stdin 并等进程退出，返回退出码。"""
    if process.stdin is not None and not process.stdin.is_closing():
        process.stdin.close()
    await asyncio.wait_for(process.wait(), timeout)
    return process.returncode


async def test_protocol_output_survives_library_and_child_process_pollution(tmp_path: Path) -> None:
    """Run 里的 print / fd 1 写入 / 子进程孙进程输出都不进协议通道。"""
    process = await _spawn("pollute", tmp_path / "home")
    await _send(
        process,
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}},
    )
    init_frames = await _read_until_response(process, 1)
    session_id = (await _session_new(process))[0]

    await _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "你好"}]},
        },
    )
    prompt_frames = await _read_until_response(process, 3)
    exit_code = await _close_and_wait(process)
    trailing = await _drain_stdout(process)
    stderr = await asyncio.wait_for(process.stderr.read(), 20)

    frames = init_frames + prompt_frames + trailing
    _assert_all_frames_are_json_rpc(frames)
    assert any(frame.get("result", {}).get("stopReason") == "end_turn" for frame in prompt_frames)
    assert any(frame.get("method") == "session/update" for frame in prompt_frames)

    text = stderr.decode("utf-8", "replace")
    for marker in (
        "pollute-print",
        "pollute-write",
        "pollute-dunder",
        "pollute-fd1",
        "pollute-system",
        "pollute-subprocess",
        "pollute-grandchild",
    ):
        assert marker in text, (marker, text)
    # 继承 stdin 的子进程读到的是 /dev/null，必须立刻返回空输出。
    assert "pollute-cat-bytes:0" in text, text
    # fd 3 以上不能泄漏给子进程（协议通道用的是不可继承的 dup fd）。
    assert "pollute-child-fds: [0, 1, 2]" in text, text
    assert exit_code == 0


async def _session_new(process: Any) -> tuple[str, list[dict[str, Any]]]:
    """发 session/new 并取回 sessionId。"""
    await _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {"cwd": str(Path.cwd()), "mcpServers": []},
        },
    )
    frames = await _read_until_response(process, 2)
    session_id = frames[-1]["result"]["sessionId"]
    assert isinstance(session_id, str)
    return session_id, frames


async def test_redirected_regular_file_stdout_fails_fast(tmp_path: Path) -> None:
    """`harness acp > 文件` 不支持：启动时明确报错并以 2 退出。"""
    target = tmp_path / "protocol.txt"
    with target.open("wb") as handle:
        process = await _spawn("stub", tmp_path / "home", stdout=handle)
        assert process.stdin is not None
        process.stdin.close()
        stderr = await asyncio.wait_for(process.stderr.read(), 20)
        await asyncio.wait_for(process.wait(), 20)
    text = stderr.decode("utf-8", "replace")
    assert process.returncode == 2, text
    assert "stdout must be a pipe, socket or tty" in text
    assert target.read_bytes() == b""


@pytest.fixture(autouse=True)
def _require_posix() -> None:
    """fd 重定向与子进程继承语义在 Windows 上完全不同，S1 不支持。"""
    if sys.platform == "win32":
        pytest.skip("ACP stdio 在 Windows 上不支持")
