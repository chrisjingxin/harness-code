"""握手闸门（Spec §6.1）：三帧流水线的响应顺序与错误语义。

【为什么用延迟替身 Host】
S0 实测（tmp/hc200-s0/handshake_inprocess_probe.py）证明：真实 Host 的
`ensure_ready()` 同步跑完时，缺陷在时序上观测不到——SDK 按帧序派发，
`initialize` 任务在其它请求任务首次调度前就设好了 `_connection`。只有
`ensure_ready()` 真的让出事件循环，排队的 `session/*` 才会抢先被判
`NOT_INITIALIZED`。因此这里统一用带延迟/可失败的替身，把竞态窗口变成确定性。

【顺序不变量】每个带 id 的请求必有且只有一个响应；`session/*` 的响应必须
排在 `initialize` 响应之后（SDK 发送队列按 put 顺序串行写出，握手 Future
在 `initialize` 返回前 resolve，两者之间没有挂起点，因此顺序是天然保证的，
本文件用重复运行把它钉死）。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from tests.support.acp_harness import InProcessAcp, make_persistent_host

GATE_DELAY_S = 0.3
REPEAT_DELAY_S = 0.05
COLLECT_TIMEOUT_S = 15.0
REPEAT_TIMES = 50


class _DelayedReadyHost:
    """Host 替身：`ensure_ready()` 先睡 delay 再委托真实 Host；可注入失败。"""

    def __init__(
        self, inner: Any, delay: float, error: BaseException | None = None
    ) -> None:
        self._inner = inner
        self._delay = delay
        self._error = error

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    async def ensure_ready(self) -> Any:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._error is not None:
            raise self._error
        return await self._inner.ensure_ready()

    async def close(self) -> None:
        await self._inner.close()


def _pipeline(workspace: Path, *, init_ids: tuple[int, ...] = (1,)) -> bytes:
    """拼出一次写入的握手流水线：initialize（可多个）+ session/new + session/list。"""
    frames: list[dict[str, Any]] = [
        {
            "jsonrpc": "2.0",
            "id": i,
            "method": "initialize",
            "params": {"protocolVersion": 1, "clientCapabilities": {}},
        }
        for i in init_ids
    ]
    frames += [
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {"cwd": str(workspace), "mcpServers": []},
        },
        {"jsonrpc": "2.0", "id": 3, "method": "session/list", "params": {}},
    ]
    return "".join(json.dumps(frame) + "\n" for frame in frames).encode()


async def _collect(client: Any, want: set[int]) -> list[dict[str, Any]]:
    """读到 want 中所有 id 的终态响应；返回按到达顺序的帧列表。"""

    async def _loop() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        got: set[int] = set()
        while want - got:
            frame = await client.read_frame()
            out.append(frame)
            if "id" in frame and ("result" in frame or "error" in frame):
                got.add(frame["id"])
        return out

    return await asyncio.wait_for(_loop(), COLLECT_TIMEOUT_S)


def _order(frames: list[dict[str, Any]]) -> list[int]:
    """帧列表里的终态响应 id 到达顺序。"""
    return [
        frame["id"]
        for frame in frames
        if "id" in frame and ("result" in frame or "error" in frame)
    ]


def _response(frames: list[dict[str, Any]], request_id: int) -> dict[str, Any]:
    return next(frame for frame in frames if frame.get("id") == request_id)


async def test_pipelined_requests_respond_in_order(tmp_path: Path) -> None:
    """三帧一次写入：initialize → session/new → session/list，全部成功。"""
    inner = make_persistent_host(tmp_path)
    host = _DelayedReadyHost(inner, GATE_DELAY_S)
    async with InProcessAcp(host) as acp:
        await acp.client.write_raw(_pipeline(inner.workspace))
        frames = await _collect(acp.client, {1, 2, 3})
        assert _order(frames) == [1, 2, 3]
        assert "result" in _response(frames, 1)
        new_result = _response(frames, 2)["result"]
        assert new_result.get("sessionId"), "session/new 应建会话而不是报错"
        assert _response(frames, 3)["result"].get("sessions") == []


async def test_session_request_before_initialize_fails_fast(tmp_path: Path) -> None:
    """握手前到达的会话请求立即回 -32600 NOT_INITIALIZED，不挂起。"""
    inner = make_persistent_host(tmp_path)
    host = _DelayedReadyHost(inner, 0.0)
    async with InProcessAcp(host) as acp:
        await acp.client.write_raw(
            (
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 9,
                        "method": "session/new",
                        "params": {"cwd": str(inner.workspace), "mcpServers": []},
                    }
                )
                + "\n"
            ).encode()
        )
        frames = await _collect(acp.client, {9})
        error = _response(frames, 9)["error"]
        assert error["code"] == -32600
        assert error["data"]["code"] == "NOT_INITIALIZED"


async def test_queued_request_fails_like_initialize(tmp_path: Path) -> None:
    """initialize 失败时，排队中的 session/new 回 -32603 HOST_INIT_FAILED。"""
    inner = make_persistent_host(tmp_path)
    host = _DelayedReadyHost(inner, 0.1, error=RuntimeError("probe failure"))
    async with InProcessAcp(host) as acp:
        await acp.client.write_raw(_pipeline(inner.workspace))
        frames = await _collect(acp.client, {1, 2, 3})
        init_error = _response(frames, 1)["error"]
        assert init_error["code"] == -32603
        assert init_error["data"]["code"] == "HOST_INIT_FAILED"
        for request_id in (2, 3):
            error = _response(frames, request_id)["error"]
            assert error["code"] == -32603, f"id={request_id} 应与 initialize 同因失败"
            assert error["data"]["code"] == "HOST_INIT_FAILED"
            assert error["data"]["retryable"] is True


async def test_second_initialize_during_first_rejected(tmp_path: Path) -> None:
    """initialize 进行中再来一个 initialize：第二个回 ALREADY_INITIALIZED。"""
    inner = make_persistent_host(tmp_path)
    host = _DelayedReadyHost(inner, GATE_DELAY_S)
    async with InProcessAcp(host) as acp:
        await acp.client.write_raw(_pipeline(inner.workspace, init_ids=(1, 4)))
        frames = await _collect(acp.client, {1, 2, 3, 4})
        assert "result" in _response(frames, 1)
        error = _response(frames, 4)["error"]
        assert error["code"] == -32600
        assert error["data"]["code"] == "ALREADY_INITIALIZED"


@pytest.mark.parametrize("iteration", range(REPEAT_TIMES))
async def test_pipelined_order_is_stable(tmp_path: Path, iteration: int) -> None:
    """顺序稳定性：重复 50 次，响应到达顺序必须是 1,2,3（不允许碰巧通过）。"""
    inner = make_persistent_host(tmp_path)
    host = _DelayedReadyHost(inner, REPEAT_DELAY_S)
    async with InProcessAcp(host) as acp:
        await acp.client.write_raw(_pipeline(inner.workspace))
        frames = await _collect(acp.client, {1, 2, 3})
        assert _order(frames) == [1, 2, 3], f"第 {iteration} 次乱序"
