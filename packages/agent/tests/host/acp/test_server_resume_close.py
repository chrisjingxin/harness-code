"""session/resume 与 session/close：订阅但不回放的续接，与幂等的会话清理（§6.3）。

【为什么对照 load】
resume 与 load 共享「校验 + 占位 + 订阅 + 失败清理」这段骨架，唯一差别是
resume 不回放历史。测试把两种方法并排放，锁住「同校验、只差回放」这条不变量。

【为什么断言 watch 次数】
「已登记空闲会话 resume 幂等」的可观察差别是 Host 侧的
`open_and_watch_thread` 不被二次调用——重复订阅在外部不可见，重复读库才是。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness_agent.host.run_coordinator import RunError
from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    block,
    make_host,
    make_persistent_host,
    text,
)
from tests.support.thread_fixtures import seed_thread


async def _initialize(client: Any, request_id: int = 1) -> dict[str, Any]:
    return await client.request(
        request_id, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )


async def _seeded(tmp_path: Path, thread_id: str = "thread-1"):
    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(
        store,
        thread_id,
        [
            {"kind": "user", "content": "先看"},
            {"kind": "assistant", "content": "看完"},
        ],
    )
    return host


def _session_updates(frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        frame["params"]["update"]
        for frame in frames
        if frame.get("method") == "session/update"
    ]


async def test_initialize_advertises_resume_and_close(tmp_path: Path) -> None:
    """握手能力里声明 session/resume 与 session/close。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        response = await _initialize(acp.client)
    caps = response["result"]["agentCapabilities"]["sessionCapabilities"]
    assert caps["resume"] is not None
    assert caps["close"] is not None


async def test_resume_returns_modes_without_replay(tmp_path: Path) -> None:
    """resume 已落库线程：响应带 modes，之后推命令表，但不回放历史。"""
    host = await _seeded(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2,
            "session/resume",
            {
                "sessionId": "thread-1",
                "cwd": str(host.workspace),
                "mcpServers": [],
            },
        )
        assert "result" in response, response
        modes = response["result"]["modes"]
        assert modes["currentModeId"]
        assert [m["id"] for m in modes["availableModes"]]
        # 响应之后应有一帧空命令表；回放类 update 一律不允许出现。
        update_frame = await acp.client.read_frame()
        assert update_frame["params"]["update"]["sessionUpdate"] == "available_commands_update"
        kinds = {u["sessionUpdate"] for u in _session_updates(acp.client.frames)}
        assert kinds == {"available_commands_update"}


async def test_load_same_thread_replays_but_resume_does_not(tmp_path: Path) -> None:
    """同一线程：load 回放消息 update，resume 一条都不发（对照组）。"""
    host = await _seeded(tmp_path, "thread-1")
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        loaded = await acp.client.request(
            2,
            "session/load",
            {"sessionId": "thread-1", "cwd": str(host.workspace), "mcpServers": []},
        )
        assert "result" in loaded, loaded
        replay_kinds = {u["sessionUpdate"] for u in _session_updates(acp.client.frames)}
        assert "user_message_chunk" in replay_kinds

    host2 = await _seeded(tmp_path / "second", "thread-1")
    async with InProcessAcp(host2) as acp2:
        await _initialize(acp2.client)
        resumed = await acp2.client.request(
            2,
            "session/resume",
            {"sessionId": "thread-1", "cwd": str(host2.workspace), "mcpServers": []},
        )
        assert "result" in resumed, resumed
        await acp2.client.read_frame()  # 命令表
        kinds = {u["sessionUpdate"] for u in _session_updates(acp2.client.frames)}
        assert "user_message_chunk" not in kinds


async def test_resume_registered_idle_session_is_idempotent(tmp_path: Path) -> None:
    """已登记且空闲的会话再 resume：成功但不重复读库/订阅，仍推命令表。"""
    host = await _seeded(tmp_path)
    calls: list[str] = []
    original = host.open_and_watch_thread

    async def spy(connection: Any, thread_id: str) -> Any:
        calls.append(thread_id)
        return await original(connection, thread_id)

    host.open_and_watch_thread = spy  # type: ignore[method-assign]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        params = {"sessionId": "thread-1", "cwd": str(host.workspace), "mcpServers": []}
        first = await acp.client.request(2, "session/resume", params)
        await acp.client.read_frame()  # 第一帧命令表
        second = await acp.client.request(3, "session/resume", params)
        await acp.client.read_frame()  # 幂等成功也推一帧
        assert "result" in first and "result" in second
    assert calls == ["thread-1"], "第二次 resume 不应再 open_and_watch_thread"


async def test_resume_missing_thread_returns_not_found(tmp_path: Path) -> None:
    """不存在的线程 → -32002 THREAD_NOT_FOUND。"""
    host = make_persistent_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2,
            "session/resume",
            {"sessionId": "ghost", "cwd": str(host.workspace), "mcpServers": []},
        )
        assert response["error"]["data"]["code"] == "THREAD_NOT_FOUND"


async def test_resume_workspace_mismatch(tmp_path: Path) -> None:
    """cwd 不是本工作区 → -32602 WORKSPACE_MISMATCH。"""
    host = await _seeded(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2,
            "session/resume",
            {"sessionId": "thread-1", "cwd": str(tmp_path / "elsewhere"), "mcpServers": []},
        )
        assert response["error"]["code"] == -32602
        assert response["error"]["data"]["code"] == "WORKSPACE_MISMATCH"


async def test_resume_thread_busy_maps_minus_32603(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """线程被占用（如他连接的活动 Run）→ Host 抛 THREAD_BUSY → -32603 可重试。"""
    host = await _seeded(tmp_path)

    async def busy(_connection: Any, _thread_id: str) -> Any:
        raise RunError("THREAD_BUSY", retryable=True)

    monkeypatch.setattr(host, "open_and_watch_thread", busy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2,
            "session/resume",
            {"sessionId": "thread-1", "cwd": str(host.workspace), "mcpServers": []},
        )
        assert response["error"]["code"] == -32603
        assert response["error"]["data"]["code"] == "THREAD_BUSY"
        assert response["error"]["data"]["retryable"] is True


async def test_resume_then_prompt_reaches_run_layer(tmp_path: Path) -> None:
    """resume 之后 prompt 不再报资源未找到，能走到 Run 受理层。

    进程内夹具的两难：持久层 Host 没配模型（prompt 必回
    `MODEL_CONFIGURATION_REQUIRED`），注入脚本化 Agent 又不开持久层。
    所以这里断言「走到了模型层」而不是「跑完一轮」——它证明会话已被登记。
    """
    host = await _seeded(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await acp.client.request(
            2,
            "session/resume",
            {"sessionId": "thread-1", "cwd": str(host.workspace), "mcpServers": []},
        )
        await acp.client.read_frame()
        response = await acp.client.request(
            3,
            "session/prompt",
            {"sessionId": "thread-1", "prompt": [{"type": "text", "text": "继续"}]},
        )
        assert response["error"]["data"]["code"] == "MODEL_CONFIGURATION_REQUIRED"


async def test_close_cancels_inflight_run_and_deregisters(tmp_path: Path) -> None:
    """close 有在途 Run 的会话：Run 以 cancelled 收尾，会话被移除。"""
    agent = ScriptedAgent([text("开始"), block()])
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        session_id = created["result"]["sessionId"]
        await acp.client.read_frame()  # 空命令表
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "hi"}]},
            }
        )
        # 等到 Run 真的在流（正文块），再 close。
        await acp.client.read_until(
            lambda f: f.get("method") == "session/update"
            and f.get("params", {}).get("update", {}).get("sessionUpdate")
            == "agent_message_chunk"
        )
        closed = await acp.client.request(4, "session/close", {"sessionId": session_id})
        assert "result" in closed, closed
        prompt_resp = await acp.client.read_until(lambda f: f.get("id") == 3)
        assert prompt_resp["result"]["stopReason"] == "cancelled"
        assert session_id not in acp.server._sessions


async def test_close_is_idempotent_and_unknown_succeeds(tmp_path: Path) -> None:
    """连续 close 两次与 close 未知会话都静默成功。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        session_id = created["result"]["sessionId"]
        await acp.client.read_frame()
        first = await acp.client.request(3, "session/close", {"sessionId": session_id})
        second = await acp.client.request(4, "session/close", {"sessionId": session_id})
        unknown = await acp.client.request(5, "session/close", {"sessionId": "ghost"})
        assert "result" in first and "result" in second and "result" in unknown


async def test_prompt_after_close_is_resource_not_found(tmp_path: Path) -> None:
    """close 后再 prompt 该会话 → -32002 资源未找到。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        created = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        session_id = created["result"]["sessionId"]
        await acp.client.read_frame()
        await acp.client.request(3, "session/close", {"sessionId": session_id})
        prompt = await acp.client.request(
            4,
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": "hi"}]},
        )
        assert prompt["error"]["code"] == -32002


async def test_close_then_resume_recovers(tmp_path: Path) -> None:
    """close 之后再 resume 同一 id 可恢复，且能继续 prompt。"""
    host = await _seeded(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        params = {"sessionId": "thread-1", "cwd": str(host.workspace), "mcpServers": []}
        await acp.client.request(2, "session/resume", params)
        await acp.client.read_frame()
        await acp.client.request(3, "session/close", {"sessionId": "thread-1"})
        resumed = await acp.client.request(4, "session/resume", params)
        assert "result" in resumed, resumed
        await acp.client.read_frame()
        prompt = await acp.client.request(
            5,
            "session/prompt",
            {"sessionId": "thread-1", "prompt": [{"type": "text", "text": "hi"}]},
        )
        # 同上：无模型夹具下走到模型层即证明会话已重新登记可用。
        assert prompt["error"]["data"]["code"] == "MODEL_CONFIGURATION_REQUIRED"


async def test_resume_and_close_require_initialize(tmp_path: Path) -> None:
    """未握手：resume/close 都回 -32600 NOT_INITIALIZED（走同一握手闸门）。"""
    host = make_host(tmp_path, echo=True)
    async with InProcessAcp(host) as acp:
        resumed = await acp.client.request(
            2, "session/resume", {"sessionId": "x", "cwd": str(host.workspace)}
        )
        closed = await acp.client.request(3, "session/close", {"sessionId": "x"})
        assert resumed["error"]["code"] == -32600
        assert resumed["error"]["data"]["code"] == "NOT_INITIALIZED"
        assert closed["error"]["code"] == -32600
        assert closed["error"]["data"]["code"] == "NOT_INITIALIZED"
