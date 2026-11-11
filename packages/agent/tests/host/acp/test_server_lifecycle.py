"""ACP 会话生命周期：initialize / session/new / session/prompt 的线路行为。

【为什么用裸行客户端】
官方 SDK 客户端会把帧重新排序、丢弃未知字段，看不到「update 是否真的先于响应」
「能力字段有没有显式出现在线路上」这类关键事实。这里用 socketpair + 裸行读写，
断言的是真实字节顺序。
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    agent_text,
    first_update,
    make_host,
    prompt_response,
    text,
    tool_args,
    tool_result,
    tool_start,
)


async def _initialize(client: Any, *, version: int = 1, request_id: int = 1) -> dict[str, Any]:
    """完成 initialize 握手，返回响应帧。"""
    return await client.request(
        request_id,
        "initialize",
        {"protocolVersion": version, "clientCapabilities": {}},
    )


async def _new_session(client: Any, cwd: Path, *, request_id: int = 2) -> str:
    """建立会话并返回 sessionId。"""
    response = await client.request(
        request_id,
        "session/new",
        {"cwd": str(cwd), "mcpServers": []},
    )
    assert "result" in response, response
    return response["result"]["sessionId"]


def _prompt_params(session_id: str, prompt_text: str = "你好") -> dict[str, Any]:
    """构造 session/prompt 参数。"""
    return {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt_text}]}


async def test_initialize_advertises_minimal_honest_capabilities(tmp_path: Path) -> None:
    """initialize 只广告真的实现了的能力：会 load/list，但不做 prompt 多媒体。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        response = await _initialize(acp.client)
        result = response["result"]
        assert result["protocolVersion"] == 1
        capabilities = result["agentCapabilities"]
        # S2 实现了 session/load 与 session/list；能力声明必须跟上，否则客户端不会调。
        assert capabilities["loadSession"] is True
        assert capabilities["promptCapabilities"] == {
            "image": False,
            "audio": False,
            "embeddedContext": True,
        }
        assert capabilities["mcpCapabilities"] == {"http": True, "sse": False, "acp": False}
        assert capabilities["sessionCapabilities"]["list"] == {}
        assert capabilities["sessionCapabilities"]["additionalDirectories"] == {}
        assert result["agentInfo"]["name"] == "harness-code"
        assert result["agentInfo"]["version"]
        assert result["authMethods"] == []


async def test_initialize_replies_protocol_version_one_for_any_request(tmp_path: Path) -> None:
    """客户端要求版本 2 也只回 1：S1 只支持 1。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        response = await _initialize(acp.client, version=2)
        assert response["result"]["protocolVersion"] == 1


async def test_meta_fields_do_not_break_handlers(tmp_path: Path) -> None:
    """客户端带 `_meta` 不会 TypeError：每个 handler 都接受额外关键字参数。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        response = await acp.client.request(
            1,
            "initialize",
            {"protocolVersion": 1, "clientCapabilities": {}, "_meta": {"client": "x"}},
        )
        assert "result" in response, response
        created = await acp.client.request(
            2,
            "session/new",
            {"cwd": str(acp.host.workspace), "mcpServers": [], "_meta": {"k": 1}},
        )
        assert "result" in created, created


async def test_repeated_initialize_is_invalid_request(tmp_path: Path) -> None:
    """重复 initialize 回 -32600，不重新握手。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        second = await _initialize(acp.client, request_id=9)
        assert second["error"]["code"] == -32600


async def test_new_session_before_initialize_is_invalid_request(tmp_path: Path) -> None:
    """没 initialize 就 session/new 回 -32600。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        response = await acp.client.request(
            1, "session/new", {"cwd": str(acp.host.workspace), "mcpServers": []}
        )
        assert response["error"]["code"] == -32600


@pytest.mark.parametrize("cwd_kind", ["relative", "other"])
async def test_new_session_rejects_cwd_outside_workspace(tmp_path: Path, cwd_kind: str) -> None:
    """cwd 必须是绝对路径且解析为同一个工作区，否则 -32602。"""
    other = tmp_path / "other"
    other.mkdir()
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        cwd = "relative/path" if cwd_kind == "relative" else str(other)
        response = await acp.client.request(2, "session/new", {"cwd": cwd, "mcpServers": []})
        error = response["error"]
        assert error["code"] == -32602
        assert error["data"]["code"] == "WORKSPACE_MISMATCH"
        assert error["data"]["expected"] == str(acp.host.workspace)


async def test_new_session_accepts_symlink_to_workspace(tmp_path: Path) -> None:
    """符号链接指向同一目录也算同一个工作区。"""
    host = make_host(tmp_path, echo=True)
    link = tmp_path / "link"
    link.symlink_to(host.workspace)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(2, "session/new", {"cwd": str(link), "mcpServers": []})
        assert "result" in response, response


async def test_untrustable_directory_rejects_the_whole_new_session(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """附加目录不合格时整单拒绝，密钥不能出现在 stderr。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        missing = tmp_path / "missing-dir"
        response = await acp.client.request(
            2,
            "session/new",
            {
                "cwd": str(acp.host.workspace),
                "mcpServers": [
                    {"name": "x", "command": "secret-cmd", "args": [], "env": []}
                ],
                "additionalDirectories": [str(missing)],
            },
        )
        error = response["error"]
        assert error["code"] == -32602
        assert error["data"]["code"] == "INVALID_ADDITIONAL_DIRECTORY"
        assert error["data"]["path"] == str(missing)
        assert acp.server._sessions == {}
    captured = capsys.readouterr()
    assert "secret-cmd" not in captured.err


@pytest.mark.parametrize(
    ("method", "params"),
    [
        ("authenticate", {"methodId": "x"}),
        ("session/fork", {"sessionId": "s", "cwd": "/w", "mcpServers": []}),
    ],
)
async def test_unimplemented_methods_return_method_not_found(
    tmp_path: Path, method: str, params: dict[str, Any]
) -> None:
    """未实现的标准方法由 SDK 统一回 -32601，而不是假装成功。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(7, method, params)
        assert response["error"]["code"] == -32601, response


async def test_echo_prompt_streams_update_then_end_turn(tmp_path: Path) -> None:
    """echo 模式一轮：先收到 update，再收到 end_turn 响应。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        response = await acp.client.request(3, "session/prompt", _prompt_params(session_id))
        assert prompt_response(response).stop_reason == "end_turn"
        chunk = first_update("agent_message_chunk", acp.client.frames)
        # echo 模式把输入原样回显，证明 Run 真的执行了一轮。
        assert agent_text(chunk) == "你好"
        assert str(chunk["messageId"]).endswith(":m0")


async def test_updates_arrive_before_prompt_response(tmp_path: Path) -> None:
    """所有 session/update 的行号都小于 prompt 响应：客户端先看到内容再看到结束。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.request(3, "session/prompt", _prompt_params(session_id))
        frames = acp.client.frames
        response_index = next(
            index for index, frame in enumerate(frames) if frame.get("id") == 3
        )
        update_indexes = [
            index for index, frame in enumerate(frames) if frame.get("method") == "session/update"
        ]
        assert update_indexes
        assert max(update_indexes) < response_index


async def test_message_id_is_scoped_to_run(tmp_path: Path) -> None:
    """正文 chunk 的 messageId 形如 `{run_id}:m0`，思考与正文前缀不同。"""
    agent = ScriptedAgent([text("回答"), text("继续")])
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.request(3, "session/prompt", _prompt_params(session_id))
        updates = [
            frame["params"]["update"]
            for frame in acp.client.updates()
            if "messageId" in frame["params"]["update"]
        ]
        message_ids = {update["messageId"] for update in updates}
        assert len(message_ids) == 1
        assert next(iter(message_ids)).endswith(":m0")


async def test_reasoning_and_content_use_different_message_ids(tmp_path: Path) -> None:
    """思考与正文分属不同消息（前缀 t 与 m），客户端才能分栏渲染。"""
    from tests.support.acp_harness import reasoning

    agent = ScriptedAgent([reasoning("想一想"), text("答案")])
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.request(3, "session/prompt", _prompt_params(session_id))
        updates = [frame["params"]["update"] for frame in acp.client.updates()]
        thoughts = [u for u in updates if u["sessionUpdate"] == "agent_thought_chunk"]
        contents = [u for u in updates if u["sessionUpdate"] == "agent_message_chunk"]
        assert thoughts and contents
        assert thoughts[0]["messageId"].endswith(":t0")
        assert contents[0]["messageId"].endswith(":m0")


async def test_tool_call_lifecycle_reaches_completed_with_display_fields(tmp_path: Path) -> None:
    """工具卡：pending → completed，并带上 rawInput / rawOutput / locations。"""
    agent = ScriptedAgent(
        [
            tool_start("call_0", "edit_file"),
            tool_args("call_0", '{"file_path":"/src/a.py"}'),
            tool_result("call_0", "wrote"),
            text("完成"),
        ]
    )
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.request(3, "session/prompt", _prompt_params(session_id))
        start = first_update("tool_call", acp.client.frames)
        assert start["status"] == "pending"
        assert start["kind"] == "edit"
        completed = [
            frame["params"]["update"]
            for frame in acp.client.updates()
            if frame["params"]["update"]["sessionUpdate"] == "tool_call_update"
        ][-1]
        assert completed["status"] == "completed"
        assert completed["rawInput"] == {"file_path": "/src/a.py"}
        assert completed["rawOutput"] == "wrote"
        assert completed["locations"][0]["path"] == str(acp.host.workspace / "src" / "a.py")
        assert completed["toolCallId"].startswith(start["toolCallId"].rsplit(":", 1)[0])


async def test_second_prompt_on_busy_session_is_retryable(tmp_path: Path) -> None:
    """同一会话同时只能有一个 Run：第二个 prompt 回 THREAD_BUSY 且可重试。"""
    from tests.support.acp_harness import block

    agent = ScriptedAgent([block()])
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.send(
            {"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": _prompt_params(session_id)}
        )
        await asyncio.sleep(0.05)
        second = await acp.client.request(4, "session/prompt", _prompt_params(session_id))
        assert second["error"]["code"] == -32603
        assert second["error"]["data"]["code"] == "THREAD_BUSY"
        assert second["error"]["data"]["retryable"] is True


async def test_two_sessions_run_concurrently(tmp_path: Path) -> None:
    """不同会话可以并发（ACP 进程启用了 run.multithread）。"""
    agent = ScriptedAgent([text("答案")])
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        first = await _new_session(acp.client, acp.host.workspace)
        second = await _new_session(acp.client, acp.host.workspace, request_id=3)
        assert first != second
        await acp.client.send(
            {"jsonrpc": "2.0", "id": 4, "method": "session/prompt", "params": _prompt_params(first)}
        )
        await acp.client.send(
            {"jsonrpc": "2.0", "id": 5, "method": "session/prompt", "params": _prompt_params(second)}
        )
        done = await acp.client.read_until(
            lambda frame: frame.get("id") == 5, timeout=20
        )
        first_response = next(
            (frame for frame in acp.client.frames if frame.get("id") == 4), None
        )
        if first_response is None:
            first_response = await acp.client.read_until(lambda frame: frame.get("id") == 4)
        assert prompt_response(first_response).stop_reason == "end_turn"
        assert prompt_response(done).stop_reason == "end_turn"


async def test_unknown_session_prompt_is_resource_not_found(tmp_path: Path) -> None:
    """未知会话回 -32002。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(3, "session/prompt", _prompt_params("nope"))
        assert response["error"]["code"] == -32002


async def test_cancel_of_unknown_session_is_ignored(tmp_path: Path) -> None:
    """对未知会话发 cancel 只是被忽略，不报错、不断连。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        await acp.client.notify("session/cancel", {"sessionId": "nope"})
        response = await _new_session(acp.client, acp.host.workspace, request_id=4)
        assert response


async def test_clean_eof_exits_zero(tmp_path: Path) -> None:
    """空闲时关闭 stdin：服务端正常收尾，退出码 0。"""
    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    await _initialize(acp.client)
    assert await acp.stop() == 0


async def test_no_stdout_pollution_from_server_messages(tmp_path: Path) -> None:
    """服务端所有出站帧都是 JSON-RPC 2.0 对象，没有一行是脏文本。"""
    async with InProcessAcp(make_host(tmp_path, echo=True)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await acp.client.request(3, "session/prompt", _prompt_params(session_id))
        for frame in acp.client.frames:
            assert isinstance(frame, dict)
            assert frame.get("jsonrpc") == "2.0"


def test_acp_server_does_not_import_agent_host() -> None:
    """AST 锁：`AcpServer` 只依赖 `service_types` 的窄接口，不反向耦合 Host。"""
    import ast

    path = (
        Path(__file__).resolve().parents[3]
        / "harness_agent"
        / "host"
        / "acp"
        / "server.py"
    )
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
    assert not any(name.startswith("harness_agent.host.agent_host") for name in imported), imported


@pytest.mark.skipif(os.name == "nt", reason="POSIX 专用")
def test_workspace_helper_is_isolated(tmp_path: Path) -> None:
    """夹具把 HOME 与 workspace 都指到 tmp_path，不会读真实用户目录。"""
    host = make_host(tmp_path, echo=True)
    assert host.workspace == (tmp_path / "ws").resolve()
