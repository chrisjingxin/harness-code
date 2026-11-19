"""FrameGuard：在 SDK 之前完成帧长校验与 JSON-RPC 外形校验。

【为什么需要这一层】
官方 SDK 的接收循环有三个已实测的缺口：非法 JSON 只写日志并静默丢弃（不回
-32700）、JSON 数组或数字帧会让 `_process_message` 抛 AttributeError 直接结束
进程、单行长度没有上限。所以读端必须先由我们自己校验一遍，只把「JSON 对象」
喂给 SDK 的 StreamReader。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
from typing import Any

import pytest

from harness_agent.host.acp.stdio import MAX_FRAME_BYTES, FrameGuard


class _GuardHarness:
    """用 socketpair 造一对真实流，客户端写帧、断言收到的响应或透传结果。"""

    def __init__(
        self,
        guard: FrameGuard,
        sdk_reader: asyncio.StreamReader,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        task: asyncio.Task[None],
    ) -> None:
        self.guard = guard
        self.sdk_reader = sdk_reader
        self.client_reader = client_reader
        self.client_writer = client_writer
        self.task = task

    async def write(self, data: bytes) -> None:
        """写入原始字节并 drain；用于模拟客户端逐段发送。"""
        self.client_writer.write(data)
        await self.client_writer.drain()

    async def read_response(self, timeout: float = 2.0) -> dict[str, Any]:
        """读一条 FrameGuard 直接回写的错误响应。"""
        line = await asyncio.wait_for(self.client_reader.readline(), timeout)
        return json.loads(line)

    async def forwarded(self, timeout: float = 2.0) -> dict[str, Any]:
        """读一条被透传给 SDK 的帧。"""
        line = await asyncio.wait_for(self.sdk_reader.readline(), timeout)
        return json.loads(line)

    async def assert_nothing_forwarded(self, timeout: float = 0.2) -> None:
        """断言 SDK 侧没有收到任何帧。"""
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(self.sdk_reader.readline(), timeout)

    async def close(self) -> None:
        """关闭客户端流并等 FrameGuard 退出，避免测试留下悬挂任务。"""
        self.client_writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.task, 2.0)


async def _make_harness() -> _GuardHarness:
    server, client = socket.socketpair()
    server.setblocking(False)
    client.setblocking(False)
    raw, writer = await asyncio.open_connection(sock=server)
    client_reader, client_writer = await asyncio.open_connection(sock=client)
    sdk_reader = asyncio.StreamReader(limit=MAX_FRAME_BYTES + 1)
    guard = FrameGuard(raw, sdk_reader, writer)
    task = asyncio.create_task(guard.run())
    return _GuardHarness(guard, sdk_reader, client_reader, client_writer, task)


def _frame(payload: object) -> bytes:
    """把 Python 对象编码成一行 NDJSON 帧。"""
    return (json.dumps(payload) + "\n").encode()


async def test_valid_frame_passes_through_unchanged() -> None:
    """合法帧原样透传，连参数一个字节都不改。"""
    harness = await _make_harness()
    payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1}}
    await harness.write(_frame(payload))
    assert await harness.forwarded() == payload
    await harness.close()


async def test_malformed_json_gets_parse_error_and_is_dropped() -> None:
    """坏 JSON 回 -32700，且不透传给 SDK（否则只会被静默丢弃）。"""
    harness = await _make_harness()
    await harness.write(b"{not json}\n")
    response = await harness.read_response()
    assert response["error"]["code"] == -32700
    assert response["id"] is None
    await harness.assert_nothing_forwarded()
    await harness.close()


@pytest.mark.parametrize(
    "raw",
    [
        # 十万层嵌套 → json.loads 抛 RecursionError；超过 4300 位的整数 → 抛 ValueError。
        # 两者都不是 JSONDecodeError，曾让守卫任务崩溃并被误判成 EOF（Code Review 发现）。
        b"[" * 100_000 + b"\n",
        b'{"jsonrpc":"2.0","id":1,"method":"x","params":{"n":' + b"9" * 5000 + b"}}\n",
    ],
)
async def test_pathological_json_gets_parse_error_and_guard_survives(raw: bytes) -> None:
    """病态 JSON 回 -32700，守卫任务不崩，后续合法帧仍能透传。"""
    harness = await _make_harness()
    await harness.write(raw)
    response = await harness.read_response()
    assert response["error"]["code"] == -32700
    assert harness.task.done() is False
    payload = {"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": 1}}
    await harness.write(_frame(payload))
    assert await harness.forwarded() == payload
    await harness.close()


@pytest.mark.parametrize(
    "raw",
    [
        b"[]\n",
        b"42\n",
        b'"text"\n',
        b'{"id":7,"method":"initialize"}\n',
        b'{"jsonrpc":"2.0","id":8,"method":123}\n',
    ],
)
async def test_non_conforming_frames_get_invalid_request(raw: bytes) -> None:
    """数组、数字、缺 jsonrpc、method 不是字符串都回 -32600。"""
    harness = await _make_harness()
    await harness.write(raw)
    response = await harness.read_response()
    assert response["error"]["code"] == -32600
    await harness.assert_nothing_forwarded()
    await harness.close()


async def test_invalid_request_keeps_legal_id_when_present() -> None:
    """缺 jsonrpc 但 id 合法时，错误响应要带回该 id，客户端才能对上请求。"""
    harness = await _make_harness()
    await harness.write(b'{"id":7,"method":"initialize"}\n')
    response = await harness.read_response()
    assert response["id"] == 7
    await harness.close()


async def test_oversize_frame_is_rejected_and_stream_continues() -> None:
    """超过 8 MiB 的帧回 -32600，之后仍能正常收帧，不断开连接。"""
    harness = await _make_harness()
    big = b'{"jsonrpc":"2.0","id":1,"method":"x","params":{"blob":"' + b"a" * (MAX_FRAME_BYTES + 1024) + b'"}}\n'
    await harness.write(big)
    response = await harness.read_response()
    assert response["error"]["code"] == -32600
    assert response["error"]["message"] == "JSON-RPC frame exceeds size limit"
    await harness.assert_nothing_forwarded()
    legal = {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {}}
    await harness.write(_frame(legal))
    assert await harness.forwarded() == legal
    await harness.close()


async def test_long_line_split_across_chunks_is_forwarded() -> None:
    """跨多次读取的超长行（未超限）要拼成完整一帧再透传。"""
    harness = await _make_harness()
    text = "x" * (2 * 1024 * 1024)
    await harness.write(b'{"jsonrpc":"2.0","id":1,"method":"x","params":{"text":"')
    await harness.write(text.encode()[:1024 * 1024])
    await harness.write(text.encode()[1024 * 1024 :])
    await harness.write(b'"}}\n')
    forwarded = await harness.forwarded(timeout=5.0)
    assert forwarded["params"]["text"] == text
    await harness.close()


async def test_final_frame_without_trailing_newline_is_forwarded() -> None:
    """stdin 末尾没有换行的最后一帧也要处理，不能丢。"""
    harness = await _make_harness()
    payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
    await harness.write(json.dumps(payload).encode())
    harness.client_writer.close()
    assert await harness.forwarded() == payload
    await asyncio.wait_for(harness.task, 2.0)


async def test_blank_lines_are_ignored() -> None:
    """空白行只跳过，不报错也不透传。"""
    harness = await _make_harness()
    await harness.write(b"\n\n   \n")
    await harness.assert_nothing_forwarded()
    payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
    await harness.write(_frame(payload))
    assert await harness.forwarded() == payload
    await harness.close()


async def test_eof_finishes_the_read_loop() -> None:
    """真实 EOF 时 run() 返回；不替调用方喂 EOF（关闭顺序由上层控制）。"""
    harness = await _make_harness()
    harness.client_writer.close()
    await asyncio.wait_for(harness.task, 2.0)
    assert not harness.sdk_reader.at_eof()
