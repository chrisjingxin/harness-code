"""ACP 斜杠命令：命令列表推送与 `/名称 参数` 补全 `requested_skill`（Todo 2.5）。

【为什么用脚本化 Agent】
`ScriptedAgent.inputs` 记录它收到的流输入，断言「Host 实际渲染出的命令正文」是最
接近真实行为的方式；用真实模型就得读模型回复，反而绕远。

【为什么裸行客户端】
`available_commands_update` 必须排在 `session/new` 响应之后，这条顺序只有按到达
顺序读真实帧才看得见。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from harness_agent.host.acp.commands import CommandIndex, parse_slash
from harness_agent.host.agent_host import _parse_raw_command_invocation
from harness_agent.host.connection import RpcError
from harness_agent.host.run_coordinator import RequestedSkill
from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    install_command_plugin,
    make_host,
    prompt_response,
    text,
)


async def _initialize(client: Any) -> dict[str, Any]:
    """完成握手。"""
    return await client.request(
        1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )


async def _new_session(client: Any, workspace: Path, request_id: int = 2) -> str:
    """建立会话并返回 sessionId。"""
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    assert "result" in response, response
    return response["result"]["sessionId"]


def _prompt(client: Any, session_id: str, body: str, request_id: int = 3) -> Any:
    """发一轮 prompt。"""
    return client.request(
        request_id,
        "session/prompt",
        {"sessionId": session_id, "prompt": [{"type": "text", "text": body}]},
    )


def _is_update(frame: dict[str, Any], session_update: str) -> bool:
    """判断一帧是不是指定类型的 session/update。"""
    return (
        frame.get("method") == "session/update"
        and frame.get("params", {}).get("update", {}).get("sessionUpdate") == session_update
    )


def _rendered(agent: ScriptedAgent) -> str:
    """把最近一次流输入压成文本，便于断言渲染结果。"""
    return str(agent.inputs[-1])


async def test_available_commands_sent_after_session_new_response(tmp_path: Path) -> None:
    """命令列表在 session/new 响应之后到达；名字不带 `/`，有 hint 才有 input。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    name = install_command_plugin(tmp_path / "home", tmp_path, hint="要审的文件")
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": str(host.workspace), "mcpServers": []},
            }
        )
        frames: list[dict[str, Any]] = []
        while True:
            frame = await acp.client.read_frame()
            frames.append(frame)
            if frame.get("id") == 2:
                break
    update_frame = await acp.client.read_frame()
    assert _is_update(update_frame, "available_commands_update")
    commands = update_frame["params"]["update"]["availableCommands"]
    names = [item["name"] for item in commands]
    assert names[:6] == ["compact", "btw", "undo", "redo", "title", "abandon"]
    assert "goal" not in names
    assert all(not item["name"].startswith("/") for item in commands)
    plugin = next(item for item in commands if item["name"] == name)
    assert plugin["description"] == "Audit from plugin"
    assert plugin["input"] == {"hint": "要审的文件"}


async def test_empty_commands_still_sends_update(tmp_path: Path) -> None:
    """没有命令也推一帧空表（§11.1 性能优化 1）：客户端靠它判断「表已落定」。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await _new_session(acp.client, host.workspace)
        update_frame = await acp.client.read_frame()
    assert _is_update(update_frame, "available_commands_update")
    names = [item["name"] for item in update_frame["params"]["update"]["availableCommands"]]
    assert names[:6] == ["compact", "btw", "undo", "redo", "title", "abandon"]
    assert "goal" not in names


async def test_empty_commands_update_after_load(tmp_path: Path) -> None:
    """session/load 同样在响应后推一次空命令表。"""
    from tests.support.acp_harness import make_persistent_host
    from tests.support.thread_fixtures import seed_thread

    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(store, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2,
            "session/load",
            {"sessionId": "thread-1", "cwd": str(host.workspace), "mcpServers": []},
        )
        assert "result" in response, response
        update_frame = await acp.client.read_frame()
    assert _is_update(update_frame, "available_commands_update")
    names = [item["name"] for item in update_frame["params"]["update"]["availableCommands"]]
    assert names[:6] == ["compact", "btw", "undo", "redo", "title", "abandon"]
    assert "goal" not in names


async def test_slash_command_completes_requested_skill(tmp_path: Path) -> None:
    """`/名称 参数` 会被 Host 渲染成命令正文；名称大小写不敏感。"""
    agent = ScriptedAgent([text("命令完成")])
    host = make_host(tmp_path, agent=agent)
    name = install_command_plugin(tmp_path / "home", tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.read_until(
            lambda frame: _is_update(frame, "available_commands_update")
        )
        response = await _prompt(acp.client, session_id, f"/{name} 这些文件")
        assert prompt_response(response).stop_reason == "end_turn"
        rendered = _rendered(agent)
        assert "Audit the requested files." in rendered
        assert "这些文件" in rendered
        upper = await _prompt(acp.client, session_id, f"/{name.upper()} 大写", request_id=4)
        assert prompt_response(upper).stop_reason == "end_turn"
        assert "Audit the requested files." in _rendered(agent)


async def test_command_without_arguments(tmp_path: Path) -> None:
    """只有名称、没有参数也当命令处理。"""
    agent = ScriptedAgent([text("好")])
    host = make_host(tmp_path, agent=agent)
    name = install_command_plugin(tmp_path / "home", tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await _prompt(acp.client, session_id, f"/{name}")
        assert prompt_response(response).stop_reason == "end_turn"
    assert "Audit the requested files." in _rendered(agent)


async def test_multi_block_prompt_keeps_raw_invocation_equal_to_message(tmp_path: Path) -> None:
    """文本 + resource_link 两块时命令仍生效：raw_invocation 必须等于整条消息。"""
    agent = ScriptedAgent([text("好")])
    host = make_host(tmp_path, agent=agent)
    name = install_command_plugin(tmp_path / "home", tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "text", "text": f"/{name} 检查"},
                    {"type": "resource_link", "uri": "file:///note.txt", "name": "note"},
                ],
            },
        )
        assert prompt_response(response).stop_reason == "end_turn", response
    rendered = _rendered(agent)
    assert "Audit the requested files." in rendered
    assert "@file:///note.txt" in rendered


async def test_escaped_unknown_and_skill_slash_are_plain_text(tmp_path: Path) -> None:
    """`//x`、未知名称、`/skill:x` 都按普通文本发给模型。"""
    agent = ScriptedAgent([text("好")])
    host = make_host(tmp_path, agent=agent)
    name = install_command_plugin(tmp_path / "home", tmp_path)
    bodies = [f"//{name}", "/nope 参数", "/skill:review 参数"]
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        for index, body in enumerate(bodies):
            response = await _prompt(acp.client, session_id, body, request_id=3 + index)
            assert prompt_response(response).stop_reason == "end_turn", response
            rendered = _rendered(agent)
            assert body in rendered
            assert "Audit the requested files." not in rendered


async def test_bind_commands_called_once_per_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """绑定在握手时做一次，早于第一个 session/new；多开会话不重复绑定。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    install_command_plugin(tmp_path / "home", tmp_path)
    events: list[str] = []
    original = host.bind_commands

    async def spy(*args: Any, **kwargs: Any) -> None:
        events.append("bind")
        await original(*args, **kwargs)

    monkeypatch.setattr(host, "bind_commands", spy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        await _new_session(acp.client, host.workspace)
        events.append("new")
        await _new_session(acp.client, host.workspace, request_id=3)
        events.append("new")
    assert events == ["bind", "new", "new"]


async def test_bind_failure_degrades_to_plain_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """绑定失败不影响握手：菜单只剩内置命令，插件 `/名称` 当普通文本。"""
    agent = ScriptedAgent([text("好")])
    host = make_host(tmp_path, agent=agent)
    name = install_command_plugin(tmp_path / "home", tmp_path)

    async def boom(*_args: Any, **_kwargs: Any) -> None:
        raise RpcError(-32602, "COMMAND_BINDING_SET_MISMATCH")

    monkeypatch.setattr(host, "bind_commands", boom)
    async with InProcessAcp(host) as acp:
        assert "result" in await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        body = f"/{name} 这些文件"
        response = await _prompt(acp.client, session_id, body)
        assert prompt_response(response).stop_reason == "end_turn", response
    # 绑定失败也要给客户端一个「已落定」信号。插件表丢了，六个内置命令还在。
    updates = [
        frame for frame in acp.client.frames if _is_update(frame, "available_commands_update")
    ]
    assert updates
    for frame in updates:
        assert [item["name"] for item in frame["params"]["update"]["availableCommands"]] == [
            "compact",
            "btw",
            "undo",
            "redo",
            "title",
            "abandon",
        ]
    rendered = _rendered(agent)
    assert body in rendered
    assert "Audit the requested files." not in rendered


async def test_skill_error_maps_to_invalid_params_with_code(tmp_path: Path) -> None:
    """绑定过期 → -32602，`data.code` 是 Host 的原始错误码。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    name = install_command_plugin(tmp_path / "home", tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        connection = acp.server._connection
        assert connection is not None
        # 模拟「命令表已变」：连接上记的快照 id 与当前 registry 不一致。
        connection.command_binding_snapshot_id = "stale-snapshot"
        response = await _prompt(acp.client, session_id, f"/{name} 参数")
    assert response["error"]["code"] == -32602
    assert response["error"]["data"]["code"] == "COMMAND_INVOCATION_BINDING_STALE"
    assert response["error"]["data"]["retryable"] is False


def test_parse_slash_matches_host_parser() -> None:
    """漂移测试：ACP 侧的斜杠解析必须与 Host 逐字一致。"""
    corpus = [
        "/audit",
        "/audit x",
        "  /audit  x  ",
        "//audit",
        "/a/b",
        "/ audit",
        "/",
        "",
        "普通文本",
        "/audit\n多行 参数",
        "/audit ",
        "/skill:x y",
        "/a\tb",
    ]
    for value in corpus:
        assert parse_slash(value) == _parse_raw_command_invocation(value), value


def test_command_index_table() -> None:
    """命令表的纯函数口径：顺序、input、大小写、命中与未命中、畸形条目。"""
    index = CommandIndex.from_snapshot(
        [
            {
                "id": "plugin/a/command/audit",
                "name": "plugin:a:audit",
                "description": "Audit",
                "argument_hint": "文件",
            },
            {"id": "plugin/a/command/plain", "name": "plain", "description": ""},
            {"id": 7, "name": 8},
            {"description": "没有 id 与名字"},
        ]
    )
    available = index.available_commands()
    names = [item.name for item in available]
    assert names[:6] == ["compact", "btw", "undo", "redo", "title", "abandon"]
    assert names[6:] == ["plugin:a:audit", "plain"]
    audit = next(item for item in available if item.name == "plugin:a:audit")
    plain = next(item for item in available if item.name == "plain")
    assert audit.input is not None
    assert audit.input.root.hint == "文件"
    assert plain.input is None
    assert index.match("/compact") is None
    hit = index.match("/PLUGIN:a:audit 这些")
    assert hit == RequestedSkill(
        skill_id="plugin/a/command/audit",
        args="这些",
        raw_invocation="/PLUGIN:a:audit 这些",
        command_name="plugin:a:audit",
    )
    assert index.match("/plugin:a:audit") == RequestedSkill(
        skill_id="plugin/a/command/audit",
        args="",
        raw_invocation="/plugin:a:audit",
        command_name="plugin:a:audit",
    )
    for miss in ("//plain", "/nope", "plain", "/", ""):
        assert index.match(miss) is None, miss
    assert [item.name for item in CommandIndex.from_snapshot([]).available_commands()] == [
        "compact",
        "btw",
        "undo",
        "redo",
        "title",
        "abandon",
    ]
    with_goal = CommandIndex.from_snapshot([], forms=True).available_commands()
    assert [item.name for item in with_goal] == [
        "compact",
        "btw",
        "undo",
        "redo",
        "title",
        "goal",
        "abandon",
    ]
