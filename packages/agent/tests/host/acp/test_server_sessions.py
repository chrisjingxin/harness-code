"""ACP 会话列表与历史回放（Todo 2.4）。

【为什么用裸行客户端】
`session/load` 的关键契约是「回放帧全部排在响应之前」「`messageId` / `toolCallId` 的
编号在下标被跳过后仍然稳定」，这两点只有按到达顺序读真实帧才能验证。

【为什么用带持久化的 Host】
线程存储只在「默认 Agent 工厂 + 非 echo」时打开（`AgentHost._thread_persistence_enabled`），
所以 `session/list` 与 `session/load` 的用例必须用 `make_persistent_host`；echo 模式
只能用来验证「没有存储时的错误映射」。
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from harness_agent.host.run_coordinator import RunError
from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    make_host,
    make_persistent_host,
    text,
)
from tests.support.thread_fixtures import seed_thread

_ISO_MS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


async def _initialize(client: Any, *, request_id: int = 1) -> dict[str, Any]:
    """完成 initialize 握手。"""
    return await client.request(
        request_id, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )


async def _new_session(client: Any, workspace: Path, *, request_id: int = 2) -> str:
    """建立会话并返回 sessionId。"""
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    assert "result" in response, response
    return response["result"]["sessionId"]


def _load_params(session_id: str, workspace: Path) -> dict[str, Any]:
    """构造 session/load 参数。"""
    return {"sessionId": session_id, "cwd": str(workspace), "mcpServers": []}


async def _seeded_host(tmp_path: Path, thread_id: str, messages: list[Mapping[str, str]]):
    """建一个带存储的 Host，并预置一条线程。"""
    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(store, thread_id, messages)
    return host


async def test_initialize_advertises_load_and_list(tmp_path: Path) -> None:
    """握手声明 loadSession、session/list 与 threads.read 能力。"""
    host = await _seeded_host(
        tmp_path, "thread-1", [{"kind": "user", "content": "先检查"}]
    )
    async with InProcessAcp(host) as acp:
        response = await _initialize(acp.client)
        capabilities = response["result"]["agentCapabilities"]
        assert capabilities["loadSession"] is True
        assert capabilities["sessionCapabilities"]["list"] == {}
        connection = acp.server._connection
        assert connection is not None
        assert "threads.read" in connection.enabled_capabilities


async def test_list_returns_workspace_threads_newest_first(tmp_path: Path) -> None:
    """列表按最后活动时间倒序，标题缺失时取首条消息前 40 字并折叠换行。"""
    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(
        store, "thread-old", [{"kind": "user", "content": "第一行\n第二行 " + "长" * 60}]
    )
    await seed_thread(store, "thread-new", [{"kind": "user", "content": "新的对话"}])
    await store.set_user_title("thread-new", "用户起的标题")
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/list", {"cwd": str(host.workspace)}
        )
        result = response["result"]
        sessions = result["sessions"]
        assert [item["sessionId"] for item in sessions] == ["thread-new", "thread-old"]
        assert all(item["cwd"] == str(host.workspace) for item in sessions)
        assert sessions[0]["title"] == "用户起的标题"
        fallback = sessions[1]["title"]
        assert len(fallback) == 40
        assert not fallback.startswith("第一行\n") and " " in fallback[:4]
        assert _ISO_MS.match(sessions[0]["updatedAt"])
        assert "nextCursor" not in result


async def test_list_uses_page_size_50(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """session/list 第一页固定向持久层要 50 条、游标为 None。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    calls: list[tuple[int, Any]] = []
    original = host.list_threads_page

    async def spy(limit: int, after: Any) -> Any:
        calls.append((limit, after))
        return await original(limit, after)

    monkeypatch.setattr(host, "list_threads_page", spy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await acp.client.request(2, "session/list", {"cwd": str(host.workspace)})
    assert calls == [(50, None)]


async def test_list_with_other_cwd_returns_empty_before_cursor(tmp_path: Path) -> None:
    """别的工作区回空列表，且不解析游标（非法游标也不报错）。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        other = await acp.client.request(
            2, "session/list", {"cwd": str(tmp_path / "elsewhere")}
        )
        mismatched = await acp.client.request(
            3,
            "session/list",
            {"cwd": str(tmp_path / "elsewhere"), "cursor": "not-a-cursor"},
        )
        assert other["result"]["sessions"] == []
        assert mismatched["result"]["sessions"] == []


def _fake_cursor(payload: str) -> str:
    """把任意字符串按线上编码（base64url 去填充）伪装成游标。"""
    import base64

    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


async def _seeded_many(tmp_path: Path, count: int) -> Any:
    """建带存储的 Host 并播种 count 个线程。"""
    from tests.support.thread_fixtures import accept_thread

    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    for index in range(count):
        await accept_thread(store, f"t-{index:03d}", f"消息 {index}")
    return host


async def _list_page(client: Any, request_id: int, cwd: str, cursor: str | None = None):
    params: dict[str, Any] = {"cwd": cwd}
    if cursor is not None:
        params["cursor"] = cursor
    return await client.request(request_id, "session/list", params)


async def test_list_paginates_120_threads_in_three_pages(tmp_path: Path) -> None:
    """120 个线程三页 50/50/20：不重不漏，仅中间页带 nextCursor。"""
    host = await _seeded_many(tmp_path, 120)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        seen: list[str] = []
        cursor: str | None = None
        cursors_seen = 0
        for request_id, expected in ((2, 50), (3, 50), (4, 20)):
            response = await _list_page(
                acp.client, request_id, str(host.workspace), cursor
            )
            assert "result" in response, response
            result = response["result"]
            assert len(result["sessions"]) == expected
            seen.extend(item["sessionId"] for item in result["sessions"])
            if expected == 50:
                assert result.get("nextCursor"), "前两页必须带 nextCursor"
                cursors_seen += 1
            else:
                assert "nextCursor" not in result or result["nextCursor"] is None
            cursor = result.get("nextCursor")
        assert cursors_seen == 2
        assert len(seen) == len(set(seen)) == 120


async def test_list_cursor_ties_span_page_boundary(tmp_path: Path) -> None:
    """同一 updated_at_ms 的 60 个线程跨 50 边界不重不漏（keyset 续页）。"""
    host = await _seeded_many(tmp_path, 60)
    store = await host._ensure_thread_persistence()
    async with store._lock:
        await store._connection.execute("UPDATE harness_threads SET updated_at_ms = 500")
        await store._connection.commit()
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        first = await _list_page(acp.client, 2, str(host.workspace))
        assert len(first["result"]["sessions"]) == 50
        cursor = first["result"]["nextCursor"]
        second = await _list_page(acp.client, 3, str(host.workspace), cursor)
        ids = [item["sessionId"] for item in first["result"]["sessions"]]
        ids += [item["sessionId"] for item in second["result"]["sessions"]]
        assert len(ids) == len(set(ids)) == 60
        assert "nextCursor" not in second["result"] or second["result"]["nextCursor"] is None


@pytest.mark.parametrize(
    "bad_cursor",
    [
        "!!!not-base64!!!",
        _fake_cursor("hello"),
        _fake_cursor("[1,2]"),
        _fake_cursor("{}"),
        _fake_cursor('{"u":1}'),
        _fake_cursor('{"u":"1","t":"x"}'),
        _fake_cursor('{"u":-1,"t":"x"}'),
        _fake_cursor('{"u":true,"t":"x"}'),
        _fake_cursor('{"u":1,"t":""}'),
    ],
)
async def test_list_invalid_cursor_returns_minus_32602(
    tmp_path: Path, bad_cursor: str
) -> None:
    """非法游标一律 -32602 + INVALID_CURSOR。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await _list_page(
            acp.client, 2, str(host.workspace), bad_cursor
        )
        error = response["error"]
        assert error["code"] == -32602
        assert error["data"]["code"] == "INVALID_CURSOR"


async def test_list_in_echo_mode_maps_to_minus_32603(tmp_path: Path) -> None:
    """echo 模式没有线程存储：映射成 -32603 + 稳定错误码，而不是空列表。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/list", {"cwd": str(acp.host.workspace)}
        )
        assert response["error"]["code"] == -32603
        assert response["error"]["data"]["code"] == "THREADS_UNAVAILABLE_IN_ECHO_MODE"


async def test_list_and_load_require_initialize(tmp_path: Path) -> None:
    """未握手时两个方法都回 -32600。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        listing = await acp.client.request(2, "session/list", {"cwd": str(host.workspace)})
        loading = await acp.client.request(
            3, "session/load", _load_params("thread-1", host.workspace)
        )
    assert listing["error"]["code"] == -32600
    assert loading["error"]["code"] == -32600
    assert listing["error"]["data"]["code"] == "NOT_INITIALIZED"


async def test_load_replays_history_before_the_response(tmp_path: Path) -> None:
    """回放：逐条 update 全部排在响应之前，`messageId` 用历史下标。"""
    host = await _seeded_host(
        tmp_path,
        "thread-1",
        [
            {"kind": "user", "content": "先检查"},
            {"kind": "assistant", "content": ""},
            {"kind": "assistant", "content": "检查完成。"},
            {"kind": "tool", "content": "工具输出", "tool_name": "read_file"},
        ],
    )
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/load",
                "params": _load_params("thread-1", host.workspace),
            }
        )
        frames: list[dict[str, Any]] = []
        while True:
            frame = await acp.client.read_frame()
            frames.append(frame)
            if frame.get("id") == 2:
                break
    update_index = max(index for index, frame in enumerate(frames) if frame.get("method") == "session/update")
    assert update_index < len(frames) - 1
    assert frames[-1]["result"]["modes"]["currentModeId"]
    updates = [frame["params"]["update"] for frame in frames if frame.get("method") == "session/update"]
    assert [update["sessionUpdate"] for update in updates] == [
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
    ]
    assert updates[0]["messageId"] == "thread-1:h0"
    assert updates[0]["content"]["text"] == "先检查"
    # 空正文跳过但下标不挪：assistant 用的是 h2 而不是 h1。
    assert updates[1]["messageId"] == "thread-1:h2"
    assert updates[2]["toolCallId"] == "thread-1:h3"
    assert updates[2]["status"] == "completed"
    assert updates[2]["title"] == "read_file"
    assert updates[2]["content"][0]["content"]["text"] == "工具输出"


async def test_long_assistant_text_is_split_with_same_message_id(tmp_path: Path) -> None:
    """超长正文按 64 K 切块，同一个 `messageId`：拼起来必须等于原文。"""
    body = "长" * (130 * 1024)
    host = await _seeded_host(
        tmp_path,
        "thread-1",
        [{"kind": "user", "content": "开始"}, {"kind": "assistant", "content": body}],
    )
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/load", _load_params("thread-1", host.workspace)
        )
        assert "result" in response
    chunks = [
        frame["params"]["update"]
        for frame in acp.client.frames
        if frame.get("method") == "session/update"
        and frame["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
    ]
    assert len(chunks) == 3
    assert {chunk["messageId"] for chunk in chunks} == {"thread-1:h1"}
    assert "".join(chunk["content"]["text"] for chunk in chunks) == body


async def test_load_unknown_thread_is_minus_32002(tmp_path: Path) -> None:
    """线程不存在 → -32002，数据带稳定错误码。"""
    host = make_persistent_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/load", _load_params("missing", host.workspace)
        )
    assert response["error"]["code"] == -32002
    assert response["error"]["data"]["code"] == "THREAD_NOT_FOUND"
    assert response["error"]["data"]["retryable"] is False


async def test_load_right_after_new_is_minus_32002(tmp_path: Path) -> None:
    """`session/new` 之后线程还没落库：load 该 id 回 -32002，已有会话不被丢掉。"""
    host = make_persistent_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3, "session/load", _load_params(session_id, host.workspace)
        )
        assert response["error"]["code"] == -32002
        assert session_id in acp.server._sessions
        assert acp.server._sessions[session_id].busy is False


async def test_load_busy_session_is_minus_32603_retryable(tmp_path: Path) -> None:
    """同一会话已经有一个在途请求时 load 回 -32603 + retryable。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        acp.server._sessions[session_id].busy = True
        response = await acp.client.request(
            3, "session/load", _load_params(session_id, host.workspace)
        )
    assert response["error"]["code"] == -32603
    assert response["error"]["data"] == {"code": "THREAD_BUSY", "retryable": True}


async def test_load_host_thread_busy_maps_to_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Host 侧判定线程忙（`RunError(THREAD_BUSY)`）同样映射成可重试的 -32603。"""
    host = make_persistent_host(tmp_path)

    async def busy(_connection: object, _thread_id: str) -> dict[str, object]:
        raise RunError("THREAD_BUSY", retryable=True)

    monkeypatch.setattr(host, "open_and_watch_thread", busy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/load", _load_params("thread-1", host.workspace)
        )
    assert response["error"]["code"] == -32603
    assert response["error"]["data"]["code"] == "THREAD_BUSY"
    assert response["error"]["data"]["retryable"] is True


async def test_concurrent_loads_of_same_id_second_gets_busy(tmp_path: Path) -> None:
    """同一个 id 并发 load：一个成功，另一个立刻回 THREAD_BUSY（不双写历史）。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        params = _load_params("thread-1", host.workspace)
        await acp.client.send({"jsonrpc": "2.0", "id": 2, "method": "session/load", "params": params})
        await acp.client.send({"jsonrpc": "2.0", "id": 3, "method": "session/load", "params": params})
        responses: dict[int, dict[str, Any]] = {}
        while len(responses) < 2:
            frame = await acp.client.read_frame()
            if frame.get("id") in {2, 3} and ("result" in frame or "error" in frame):
                responses[frame["id"]] = frame
    assert "result" in responses[2], responses
    assert responses[3]["error"]["code"] == -32603
    assert responses[3]["error"]["data"]["code"] == "THREAD_BUSY"


async def test_failed_load_cleans_up_placeholder_and_watch(tmp_path: Path) -> None:
    """失败的 load 不留下会话占位、watch 或未回落的在途计数。"""
    host = make_persistent_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/load", _load_params("missing", host.workspace)
        )
        assert response["error"]["code"] == -32002
        connection = acp.server._connection
        assert connection is not None
        assert connection.watched_threads == set()
        assert acp.server._sessions == {}
        assert acp.server._in_flight == 0
        assert await acp.server.wait_idle(0.01) is True


async def test_load_cwd_mismatch_and_nul_cwd(tmp_path: Path) -> None:
    """cwd 不匹配或含 NUL 都回 -32602 WORKSPACE_MISMATCH（含 NUL 不能抛 ValueError）。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        mismatch = await acp.client.request(
            2,
            "session/load",
            {"sessionId": "thread-1", "cwd": str(tmp_path / "elsewhere"), "mcpServers": []},
        )
        nul = await acp.client.request(
            3,
            "session/load",
            {"sessionId": "thread-1", "cwd": "bad\x00path", "mcpServers": []},
        )
    assert mismatch["error"]["code"] == -32602
    assert mismatch["error"]["data"]["code"] == "WORKSPACE_MISMATCH"
    assert nul["error"]["code"] == -32602
    assert nul["error"]["data"]["code"] == "WORKSPACE_MISMATCH"


async def test_thread_summary_becomes_session_info_update(tmp_path: Path) -> None:
    """标题生成后的 `thread.summary` 变成该会话的 `session_info_update`。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        connection = acp.server._connection
        assert connection is not None
        await host._broadcast_thread_summary(
            session_id,
            {
                "thread_id": session_id,
                "title": "自动标题",
                "updated_at_ms": 1_700_000_000_123,
            },
            owner_connection_id=connection.connection_id,
        )
        frame = await acp.client.read_until(
            lambda item: item.get("method") == "session/update"
            and item["params"]["update"]["sessionUpdate"] == "session_info_update"
        )
    update = frame["params"]["update"]
    assert update["title"] == "自动标题"
    assert update["updatedAt"] == "2023-11-14T22:13:20.123Z"


async def test_thread_summary_for_unknown_session_is_ignored(tmp_path: Path) -> None:
    """未知会话的 `thread.summary` 不发帧也不抛异常。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        listed = await acp.client.request(2, "session/list", {"cwd": str(host.workspace)})
        assert "result" in listed
        frame_count = len(acp.client.frames)
        await acp.server._sender(
            {"method": "thread.summary", "params": {"thread_id": "unknown", "title": "t"}}
        )
        await asyncio.sleep(0.05)
        assert len(acp.client.frames) == frame_count


async def test_thread_summary_after_close_does_not_raise(tmp_path: Path) -> None:
    """连接关闭后再收到 `thread.summary`，`_sender` 只入队，不抛异常。"""
    host = await _seeded_host(tmp_path, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await acp.server.aclose()
        await acp.server._sender(
            {"method": "thread.summary", "params": {"thread_id": "thread-1", "title": "t"}}
        )
        # 关闭之后仍然只入队：入队会失败才是真问题（pump 已停，没人消费）。
        assert acp.server._outbox.qsize() >= 1


async def test_threads_read_adds_no_other_frames(tmp_path: Path) -> None:
    """开着 `threads.read` 跑一轮：出站帧只有已知的 update 类型，没有别的通知。"""
    host = make_host(
        tmp_path,
        agent=ScriptedAgent([text("回答完了")]),
    )
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3,
            "session/prompt",
            {"sessionId": session_id, "prompt": [{"type": "text", "text": "你好"}]},
        )
        assert "result" in response
        connection = acp.server._connection
        assert connection is not None
        assert "threads.read" in connection.enabled_capabilities
    known = {
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "session_info_update",
        "available_commands_update",
        "current_mode_update",
    }
    updates = [
        frame["params"]["update"]
        for frame in acp.client.frames
        if frame.get("method") == "session/update"
    ]
    assert updates
    assert {update["sessionUpdate"] for update in updates} <= known
