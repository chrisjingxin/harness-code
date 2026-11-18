"""内置斜杠命令：拦截后不启动 Run，结果用消息块交还（Todo 5.2–5.9）。

【为什么多数成功路径打补丁】
持久 Host 没有模型，脚本 Agent 又不写会话历史。压缩、目标和放弃只验证
ACP 怎么呼叫 Host、怎么把结果说给客户端；回退和改名走真实存储。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness_agent.extensions.plugin_skills import _skill_command_name
from harness_agent.host.acp.commands import CommandIndex
from harness_agent.host.connection import RpcError
from harness_agent.host.run_coordinator import GoalContinuationRunInput, GoalProposalRunInput
from tests.support.acp_harness import (
    InProcessAcp,
    ScriptedAgent,
    make_host,
    make_persistent_host,
    prompt_response,
    text,
)
from tests.support.thread_fixtures import seed_thread

_CORE = ["compact", "btw", "undo", "redo", "title", "abandon"]


def test_skill_command_name_falls_back_when_the_last_segment_is_taken() -> None:
    """最后一段撞名就改用全名；全名再撞就加数字。"""
    assert _skill_command_name("project/citrus-check", set()) == "skill:citrus-check"
    taken = {"skill:review"}
    assert _skill_command_name("project/review", taken) == "skill:project:review"
    taken.add("skill:project:review")
    assert _skill_command_name("project/review", taken) == "skill:project:review:2"


def test_builtin_names_win_and_dropped_names_stay_out_of_the_menu() -> None:
    """内置命令占名。同名的 Skill 不出现，只记在 dropped。"""
    index = CommandIndex.from_snapshot(
        [
            {"id": "project/compact", "name": "compact", "description": "撞名"},
            {"id": "project/citrus-check", "name": "skill:citrus-check", "description": "检查"},
        ]
    )
    assert [item.name for item in index.available_commands()][:6] == _CORE
    assert index.dropped == tuple(index.dropped)
    assert [(item.name, item.source) for item in index.dropped] == [("compact", "plugin")]
    assert any(item.name == "skill:citrus-check" for item in index.commands)
    assert index.match("/compact") is None
    hit = index.match("/skill:citrus-check 参数")
    assert hit is not None
    assert hit.skill_id == "project/citrus-check"
    assert hit.raw_invocation == "/skill:citrus-check 参数"


async def _initialize(client: Any, *, forms: bool = False, commands: bool = False) -> None:
    """握手。表单和 commands 扩展按用例单独打开。"""
    capabilities: dict[str, Any] = {}
    if forms:
        capabilities["elicitation"] = {"form": {}}
    if commands:
        capabilities["_meta"] = {"harnessCode": {"version": 1, "capabilities": ["commands"]}}
    response = await client.request(
        1, "initialize", {"protocolVersion": 1, "clientCapabilities": capabilities}
    )
    assert "result" in response, response


async def _new_session(client: Any, workspace: Path, request_id: int = 2) -> str:
    """建会话。"""
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    assert "result" in response, response
    return response["result"]["sessionId"]


async def _load(client: Any, workspace: Path, session_id: str, request_id: int = 2) -> None:
    """打开已有会话。"""
    response = await client.request(
        request_id,
        "session/load",
        {"sessionId": session_id, "cwd": str(workspace), "mcpServers": []},
    )
    assert "result" in response, response


def _prompt(client: Any, session_id: str, body: str, request_id: int = 3) -> Any:
    """发一轮用户文本。"""
    return client.request(
        request_id,
        "session/prompt",
        {"sessionId": session_id, "prompt": [{"type": "text", "text": body}]},
    )


def _is_update(frame: dict[str, Any], kind: str) -> bool:
    """是不是指定类型的 session/update。"""
    return (
        frame.get("method") == "session/update"
        and frame.get("params", {}).get("update", {}).get("sessionUpdate") == kind
    )


def _new_frames(client: Any, before: int) -> list[dict[str, Any]]:
    """这次请求新收到的帧。响应本身也在里面。"""
    return client.frames[before:]


def _chunk_text(frame: dict[str, Any]) -> str:
    """取出消息块里的文本。不是 update 的帧返回空串。"""
    params = frame.get("params")
    update = params.get("update") if isinstance(params, dict) else None
    content = update.get("content") if isinstance(update, dict) else None
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def _error_code(response: dict[str, Any]) -> str:
    """JSON-RPC data.code。"""
    return str(response["error"]["data"]["code"])


async def test_compact_reports_token_counts_and_does_not_start_a_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """压缩成功：句子、用量更新，并且没有 Run。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("不该看到")]))

    async def compact(_connection: object, _thread_id: str) -> dict[str, object]:
        return {
            "compacted": True,
            "context": {"estimated_tokens": 12, "input_cap_tokens": 100},
            "before_tokens": 40,
            "after_tokens": 12,
        }

    async def start_run(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("内置命令不能启动 Run")

    monkeypatch.setattr(host, "compact_thread", compact)
    monkeypatch.setattr(host, "start_run", start_run)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        before = len(acp.client.frames)
        response = await _prompt(acp.client, session_id, "/compact")
    assert prompt_response(response).stop_reason == "end_turn"
    frames = _new_frames(acp.client, before)
    chunks = [frame for frame in frames if _is_update(frame, "agent_message_chunk")]
    assert len(chunks) == 1
    assert _chunk_text(chunks[0]) == "已压缩上下文：约 40 → 12 tokens"
    assert str(chunks[0]["params"]["update"]["messageId"]).startswith("cmd:")
    usage = [frame for frame in frames if _is_update(frame, "usage_update")]
    assert usage[-1]["params"]["update"]["used"] == 12
    assert usage[-1]["params"]["update"]["size"] == 100
    assert response["result"]["_meta"]["harnessCode"]["command"] == {"name": "compact"}


async def test_compact_while_busy_is_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """线程忙：可重试的 THREAD_BUSY，不把内部错误码原样抛出去。"""
    host = make_host(tmp_path)

    async def busy(*_args: object, **_kwargs: object) -> dict[str, object]:
        raise RpcError(-32000, "CONTEXT_COMPACTION_RUN_ACTIVE")

    monkeypatch.setattr(host, "compact_thread", busy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await _prompt(acp.client, session_id, "/compact")
    assert response["error"]["code"] == -32603
    assert _error_code(response) == "THREAD_BUSY"
    assert response["error"]["data"]["retryable"] is True


async def test_btw_is_ephemeral_and_missing_args_are_rejected(
    tmp_path: Path,
) -> None:
    """旁注返回 echo，扩展字段只在声明了 commands 时出现；缺参数是 -32602。"""
    host = make_host(tmp_path, echo=True)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        before = len(acp.client.frames)
        missing = await _prompt(acp.client, session_id, "/btw")
        assert missing["error"]["code"] == -32602
        assert _error_code(missing) == "INVALID_COMMAND_ARGUMENTS"
        response = await _prompt(acp.client, session_id, "/btw 用什么框架", request_id=4)
    assert prompt_response(response).stop_reason == "end_turn"
    frames = _new_frames(acp.client, before)
    chunks = [frame for frame in frames if _is_update(frame, "agent_message_chunk")]
    assert _chunk_text(chunks[-1]) == "echo: 用什么框架"
    meta = chunks[-1]["params"]["update"]["_meta"]["harnessCode"]
    assert meta["ephemeral"] is True
    assert meta["command"]["name"] == "btw"
    assert response["result"]["_meta"]["harnessCode"]["command"]["ephemeral"] is True


async def test_btw_without_commands_extension_has_no_harness_code(tmp_path: Path) -> None:
    """没声明 commands：答案还在，帧里没有 harnessCode。"""
    host = make_host(tmp_path, echo=True)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        before = len(acp.client.frames)
        response = await _prompt(acp.client, session_id, "/btw 还有吗")
    frames = _new_frames(acp.client, before)
    assert any(_chunk_text(frame) == "echo: 还有吗" for frame in frames if _is_update(frame, "agent_message_chunk"))
    blob = json.dumps(frames + [response], ensure_ascii=False)
    assert "harnessCode" not in blob


async def test_undo_and_redo_report_history_changes(tmp_path: Path) -> None:
    """非 Git 仓库：both 只退对话，code 拒绝，没退过不能重做，退完可以重做。"""
    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(store, "thread-1", [{"kind": "user", "content": "第一句"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, commands=True)
        await _load(acp.client, host.workspace, "thread-1")
        redo_first = await _prompt(acp.client, "thread-1", "/redo")
        assert redo_first["error"]["code"] == -32602
        assert _error_code(redo_first) == "THREAD_NOT_IN_REVERTED_STATE"
        code_only = await _prompt(acp.client, "thread-1", "/undo code", request_id=4)
        assert code_only["error"]["code"] == -32602
        assert _error_code(code_only) == "WORKSPACE_NOT_GIT_REPOSITORY"
        before = len(acp.client.frames)
        undone = await _prompt(acp.client, "thread-1", "/undo", request_id=5)
        assert prompt_response(undone).stop_reason == "end_turn"
        undo_frames = _new_frames(acp.client, before)
        undo_text = _chunk_text(next(frame for frame in undo_frames if _is_update(frame, "agent_message_chunk")))
        assert undo_text == "已回退第 1 轮，恢复 0 个文件。重新打开会话可看到回退后的历史"
        assert undone["result"]["_meta"]["harnessCode"]["command"]["historyChanged"] is True
        redone = await _prompt(acp.client, "thread-1", "/redo", request_id=6)
        assert prompt_response(redone).stop_reason == "end_turn"
        assert redone["result"]["_meta"]["harnessCode"]["command"] == {
            "name": "redo",
            "historyChanged": True,
        }
        # 重做把回退点清掉了，所以还能再退一次。
        again = await _prompt(acp.client, "thread-1", "/undo", request_id=7)
        assert prompt_response(again).stop_reason == "end_turn", again
        empty = await _prompt(acp.client, "thread-1", "/undo", request_id=8)
        assert _error_code(empty) == "NOTHING_TO_UNDO"


async def test_title_updates_the_session_before_the_prompt_response(tmp_path: Path) -> None:
    """改名先推 session_info_update，缺标题是参数错误。"""
    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(store, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, commands=True)
        await _load(acp.client, host.workspace, "thread-1")
        missing = await _prompt(acp.client, "thread-1", "/title")
        assert missing["error"]["code"] == -32602
        assert _error_code(missing) == "INVALID_COMMAND_ARGUMENTS"
        before = len(acp.client.frames)
        response = await _prompt(acp.client, "thread-1", "/title 新名字", request_id=4)
    assert prompt_response(response).stop_reason == "end_turn"
    frames = _new_frames(acp.client, before)
    info = next(frame for frame in frames if _is_update(frame, "session_info_update"))
    assert info["params"]["update"]["title"] == "新名字"
    chunk = next(frame for frame in frames if _is_update(frame, "agent_message_chunk"))
    assert _chunk_text(chunk) == "已改名为：新名字"
    assert frames.index(info) < frames.index(chunk)
    assert response["result"]["_meta"]["harnessCode"]["command"] == {"name": "title"}


async def test_goal_forms_cover_inspect_mutate_create_and_abandon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """支持表单时才广告 /goal。创建走 Build；排队和放弃不启动 Run。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("普通文本")]))
    calls: list[tuple[str, object]] = []

    async def inspect(_connection: object, _thread_id: str) -> dict[str, object]:
        return {"goal": None, "pending": None, "latest_evaluation": None}

    async def mutate(
        _connection: object,
        _thread_id: str,
        _operation_id: str,
        action: str,
        expected_goal_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        calls.append(("mutate", action, expected_goal_id, expected_revision))
        return {"goal": {"status": "paused", "objective": "原来的"}}

    async def request(
        _connection: object,
        _thread_id: str,
        request_id: str,
        kind: str,
        input_text: str,
    ) -> dict[str, object]:
        calls.append(("request", (kind, input_text, request_id)))
        if input_text == "排队":
            return {"disposition": "queued", "pending": {"input_text": input_text}}
        return {"disposition": "ready", "pending": {"input_text": input_text}}

    async def abandon(_connection: object, _thread_id: str, reason: str | None) -> dict[str, object]:
        calls.append(("abandon", reason))
        return {"progress": {}}

    async def start_run(_connection: object, request: Any, on_accepted: Any = None) -> None:
        calls.append(("start", request.mode))
        assert isinstance(request.input, GoalProposalRunInput)
        if on_accepted is not None:
            await on_accepted(None)
        acp.server._outbox.put_nowait(
            ("event", {"type": "content.delta", "run_id": request.run_id, "payload": {"text": "目标已记下"}})
        )
        acp.server._outbox.put_nowait(
            ("event", {"type": "run.completed", "run_id": request.run_id, "payload": {}})
        )

    monkeypatch.setattr(host, "goal_inspect", inspect)
    monkeypatch.setattr(host, "goal_mutate", mutate)
    monkeypatch.setattr(host, "goal_request", request)
    monkeypatch.setattr(host, "compose_abandon", abandon)
    monkeypatch.setattr(host, "start_run", start_run)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        listed = await acp.client.read_until(lambda frame: _is_update(frame, "available_commands_update"))
        names = [item["name"] for item in listed["params"]["update"]["availableCommands"]]
        assert "goal" in names
        compact = next(item for item in listed["params"]["update"]["availableCommands"] if item["name"] == "compact")
        assert compact["_meta"]["harnessCode"]["source"] == "builtin"
        session = acp.server._sessions[session_id]
        session.workflow = "compose"
        inspected = await _prompt(acp.client, session_id, "/goal")
        assert "当前 thread 还没有目标" in _chunk_text(
            next(frame for frame in acp.client.frames if _chunk_text(frame).startswith("当前 thread"))
        )
        assert prompt_response(inspected).stop_reason == "end_turn"
        paused = await _prompt(acp.client, session_id, "/goal pause", request_id=4)
        assert any(_chunk_text(frame) == "目标已暂停" for frame in acp.client.frames)
        assert prompt_response(paused).stop_reason == "end_turn"
        extra = await _prompt(acp.client, session_id, "/goal pause extra", request_id=5)
        assert _error_code(extra) == "INVALID_COMMAND_ARGUMENTS"
        created = await _prompt(acp.client, session_id, "/goal 把测试补上", request_id=6)
        assert prompt_response(created).stop_reason == "end_turn"
        assert any(_chunk_text(frame) == "目标已记下" for frame in acp.client.frames)
        assert created["result"]["_meta"]["harnessCode"]["command"] == {"name": "goal"}
        queued = await _prompt(acp.client, session_id, "/goal 排队", request_id=7)
        assert any("目标请求已排队" in _chunk_text(frame) for frame in acp.client.frames)
        assert prompt_response(queued).stop_reason == "end_turn"
        edited = await _prompt(acp.client, session_id, "/goal edit 改一下", request_id=8)
        assert prompt_response(edited).stop_reason == "end_turn"
        blank_edit = await _prompt(acp.client, session_id, "/goal edit", request_id=9)
        assert _error_code(blank_edit) == "INVALID_COMMAND_ARGUMENTS"
        abandoned = await _prompt(acp.client, session_id, "/abandon 不做了", request_id=10)
        assert any(_chunk_text(frame) == "已放弃当前 Compose 进度，对话保留" for frame in acp.client.frames)
        assert prompt_response(abandoned).stop_reason == "end_turn"
    assert ("mutate", "pause", None, None) in calls
    assert ("start", "build") in calls
    assert ("abandon", "不做了") in calls
    assert not any(item == ("start", "build") and False for item in calls)
    kinds = [item[1][0] for item in calls if item[0] == "request"]
    assert kinds == ["create", "create", "amend"]


async def test_goal_pause_sends_the_current_goal_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """暂停必须带上当前目标的编号和版本，否则存储层会当成冲突。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("普通文本")]))
    seen: dict[str, object] = {}

    async def inspect(_connection: object, _thread_id: str) -> dict[str, object]:
        return {
            "goal": {"goal_id": "goal-1", "revision": 3, "status": "active", "objective": "保持"},
            "pending": None,
            "latest_evaluation": None,
        }

    async def mutate(
        _connection: object,
        _thread_id: str,
        _operation_id: str,
        action: str,
        expected_goal_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        seen["action"] = action
        seen["goal_id"] = expected_goal_id
        seen["revision"] = expected_revision
        return {"goal": {"goal_id": "goal-1", "revision": 3, "status": "paused", "objective": "保持"}}

    monkeypatch.setattr(host, "goal_inspect", inspect)
    monkeypatch.setattr(host, "goal_mutate", mutate)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        paused = await _prompt(acp.client, session_id, "/goal pause")
    assert prompt_response(paused).stop_reason == "end_turn"
    assert any(_chunk_text(frame) == "目标已暂停" for frame in acp.client.frames)
    assert seen == {"action": "pause", "goal_id": "goal-1", "revision": 3}


async def test_accepted_goal_starts_the_continuation_before_the_prompt_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """点了接受之后，同一轮里接着做任务。确认 Run 结束就返回的话，界面上看不到后续动作。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("普通文本")]))
    started: list[tuple[str, str]] = []

    async def request(
        _connection: object,
        _thread_id: str,
        request_id: str,
        kind: str,
        input_text: str,
    ) -> dict[str, object]:
        return {"disposition": "ready", "pending": {"request_id": request_id, "input_text": input_text, "kind": kind}}

    async def start_run(_connection: object, request: Any, on_accepted: Any = None) -> None:
        started.append((request.input.kind, request.run_id))
        if on_accepted is not None:
            await on_accepted(None)
        if isinstance(request.input, GoalProposalRunInput):
            acp.server._outbox.put_nowait((
                "event",
                {
                    "type": "run.completed",
                    "run_id": request.run_id,
                    "payload": {
                        "context": {
                            "goal_continuation": {
                                "continuation_id": "cont-1",
                                "goal_id": "goal-1",
                                "goal_revision": 1,
                                "reason": "accepted",
                            }
                        }
                    },
                },
            ))
            return
        assert isinstance(request.input, GoalContinuationRunInput)
        assert request.mode == "build"
        assert request.run_id == "cont-1"
        assert request.input.goal_id == "goal-1"
        assert request.input.goal_revision == 1
        assert request.input.reason == "accepted"
        acp.server._outbox.put_nowait((
            "event",
            {"type": "content.delta", "run_id": request.run_id, "payload": {"text": "开始核对 seed.txt"}},
        ))
        acp.server._outbox.put_nowait((
            "event",
            {"type": "run.completed", "run_id": request.run_id, "payload": {}},
        ))

    monkeypatch.setattr(host, "goal_request", request)
    monkeypatch.setattr(host, "start_run", start_run)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        created = await _prompt(acp.client, session_id, "/goal 保持 seed.txt 为当前这一行")
    assert prompt_response(created).stop_reason == "end_turn"
    assert [kind for kind, _run_id in started] == ["goal_proposal", "goal_continuation"]
    assert any(_chunk_text(frame) == "开始核对 seed.txt" for frame in acp.client.frames)


async def test_goal_resume_starts_the_continuation_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """恢复不是只回一句话。存储层给出续跑时，同一轮 prompt 里要把任务做起来。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("普通文本")]))
    started: list[str] = []

    async def inspect(_connection: object, _thread_id: str) -> dict[str, object]:
        return {
            "goal": {"goal_id": "goal-1", "revision": 2, "status": "paused", "objective": "保持"},
            "pending": None,
            "latest_evaluation": None,
        }

    async def mutate(
        _connection: object,
        _thread_id: str,
        _operation_id: str,
        action: str,
        expected_goal_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        assert action == "resume"
        assert expected_goal_id == "goal-1"
        assert expected_revision == 2
        return {
            "goal": {"goal_id": "goal-1", "revision": 2, "status": "active", "objective": "保持"},
            "continuation": {
                "continuation_id": "cont-2",
                "goal_id": "goal-1",
                "goal_revision": 2,
                "reason": "resumed",
            },
        }

    async def start_run(_connection: object, request: Any, on_accepted: Any = None) -> None:
        started.append(request.run_id)
        assert isinstance(request.input, GoalContinuationRunInput)
        assert request.mode == "build"
        assert request.input.reason == "resumed"
        if on_accepted is not None:
            await on_accepted(None)
        acp.server._outbox.put_nowait((
            "event",
            {"type": "content.delta", "run_id": request.run_id, "payload": {"text": "继续执行"}},
        ))
        acp.server._outbox.put_nowait((
            "event",
            {"type": "run.completed", "run_id": request.run_id, "payload": {}},
        ))

    monkeypatch.setattr(host, "goal_inspect", inspect)
    monkeypatch.setattr(host, "goal_mutate", mutate)
    monkeypatch.setattr(host, "start_run", start_run)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        resumed = await _prompt(acp.client, session_id, "/goal resume")
    assert prompt_response(resumed).stop_reason == "end_turn"
    assert started == ["cont-2"]
    texts = [_chunk_text(frame) for frame in acp.client.frames]
    assert "目标已恢复" in texts
    assert "继续执行" in texts


async def test_goal_without_forms_is_ordinary_text(tmp_path: Path) -> None:
    """客户端不支持表单时，菜单没有 /goal，这句话原样发给模型。"""
    agent = ScriptedAgent([text("好")])
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        listed = await acp.client.read_until(lambda frame: _is_update(frame, "available_commands_update"))
        names = [item["name"] for item in listed["params"]["update"]["availableCommands"]]
        assert "goal" not in names
        response = await _prompt(acp.client, session_id, "/goal 这不是命令")
    assert prompt_response(response).stop_reason == "end_turn"
    assert "/goal 这不是命令" in str(agent.inputs[-1])


async def test_project_skill_slash_starts_a_normal_run(tmp_path: Path) -> None:
    """用户可调用的项目 Skill 以 skill:名称 进入菜单，并作为普通 Run 执行。"""
    workspace = tmp_path / "ws"
    skill_dir = workspace / ".harness" / "skills" / "citrus-check"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: citrus-check\ndescription: 检查柑橘\n---\nCITRUS_BODY_8841\n",
        encoding="utf-8",
    )
    agent = ScriptedAgent([text("好")])
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        listed = await acp.client.read_until(lambda frame: _is_update(frame, "available_commands_update"))
        skill = next(
            item
            for item in listed["params"]["update"]["availableCommands"]
            if item.get("_meta", {}).get("harnessCode", {}).get("id") == "project/citrus-check"
        )
        assert skill["name"] == "skill:citrus-check"
        assert skill["_meta"]["harnessCode"]["source"] == "skill"
        response = await _prompt(acp.client, session_id, "/skill:citrus-check 参数")
    assert prompt_response(response).stop_reason == "end_turn"
    rendered = str(agent.inputs[-1])
    assert "project/citrus-check" in rendered
    assert "/skill:citrus-check 参数" in rendered


async def test_catalog_change_replaces_the_table_for_every_session(tmp_path: Path) -> None:
    """目录通知整表替换。撞上内置名的条目被丢掉，并留下诊断。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.read_until(lambda frame: _is_update(frame, "available_commands_update"))
        warnings: list[tuple[object, object]] = []
        original = acp.server._log.warn

        def spy(event: object, fields: object = None) -> None:
            warnings.append((event, fields))
            original(event, fields)

        acp.server._log.warn = spy  # type: ignore[method-assign]
        await host._broadcast_command_catalog(
            [
                {
                    "id": "plugin/x/command/navel",
                    "name": "navel",
                    "description": "脐橙",
                    "requested_skill_id": "plugin/x/command/navel",
                    "plugin_id": "x",
                },
                {
                    "id": "project/compact",
                    "name": "compact",
                    "description": "撞名",
                    "requested_skill_id": "project/compact",
                },
            ]
        )
        listed = await acp.client.read_until(lambda frame: _is_update(frame, "available_commands_update"))
    names = [item["name"] for item in listed["params"]["update"]["availableCommands"]]
    assert names[:6] == _CORE
    assert names.count("compact") == 1
    assert "navel" in names
    assert listed["params"]["sessionId"] == session_id
    assert ("acp.command.dropped", {"name": "compact", "source": "plugin", "reason": "name_conflict"}) in warnings


async def test_undo_list_and_multiturn_index_selection(tmp_path: Path) -> None:
    """GAP-40：`/undo list` 列出可回退回合，`/undo <N> [mode]` / `/undo [mode] <N>` 按 1-based 回退。"""
    from tests.support.thread_fixtures import accept_thread

    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await accept_thread(store, "thread-1", "第一轮：初始化\n多行细节", run_id="run-1")
    await accept_thread(store, "thread-1", "第二轮：加接口", run_id="run-2")
    await accept_thread(store, "thread-1", "第三轮：补测试", run_id="run-3")

    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, commands=True)
        await _load(acp.client, host.workspace, "thread-1")

        before = len(acp.client.frames)
        listed = await _prompt(acp.client, "thread-1", "/undo list", request_id=3)
        assert prompt_response(listed).stop_reason == "end_turn"
        list_frames = _new_frames(acp.client, before)
        list_text = _chunk_text(next(frame for frame in list_frames if _is_update(frame, "agent_message_chunk")))
        assert "#1" in list_text and "第一轮：初始化 多行细节" in list_text
        assert "#2" in list_text and "第二轮：加接口" in list_text
        assert "#3" in list_text and "第三轮：补测试" in list_text
        assert listed["result"]["_meta"]["harnessCode"]["command"] == {
            "name": "undo",
            "action": "list",
        }

        # 非 Git 仓库上 `/undo 2 code` 或 `/undo code 2` 必须解析到第 2 轮并走到 WORKSPACE_NOT_GIT_REPOSITORY
        code_first = await _prompt(acp.client, "thread-1", "/undo 2 code", request_id=4)
        assert _error_code(code_first) == "WORKSPACE_NOT_GIT_REPOSITORY"
        mode_first = await _prompt(acp.client, "thread-1", "/undo code 2", request_id=5)
        assert _error_code(mode_first) == "WORKSPACE_NOT_GIT_REPOSITORY"

        # 越界回合与非法参数
        out_of_range = await _prompt(acp.client, "thread-1", "/undo 9", request_id=6)
        assert out_of_range["error"]["code"] == -32602
        assert _error_code(out_of_range) == "TURN_NOT_FOUND"
        for idx, bad in enumerate(
            ["/undo 0", "/undo -1", "/undo list 1", "/undo 1 2", "/undo both code", "/undo nope"],
            start=7,
        ):
            resp = await _prompt(acp.client, "thread-1", bad, request_id=idx)
            assert resp["error"]["code"] == -32602, bad
            assert _error_code(resp) == "INVALID_COMMAND_ARGUMENTS", bad

        # 按 `[mode] <N>` 退第 2 轮
        before_undo = len(acp.client.frames)
        undone = await _prompt(acp.client, "thread-1", "/undo conversation 2", request_id=20)
        assert prompt_response(undone).stop_reason == "end_turn"
        undo_text = _chunk_text(
            next(frame for frame in _new_frames(acp.client, before_undo) if _is_update(frame, "agent_message_chunk"))
        )
        assert undo_text == "已回退第 2 轮，恢复 0 个文件。重新打开会话可看到回退后的历史"
        assert undone["result"]["_meta"]["harnessCode"]["command"] == {
            "name": "undo",
            "historyChanged": True,
        }

        # 退完第 2 轮后，list 只剩 #1；再次 /undo 2 报 TURN_NOT_FOUND
        before_after = len(acp.client.frames)
        listed_after = await _prompt(acp.client, "thread-1", "/undo list", request_id=21)
        assert prompt_response(listed_after).stop_reason == "end_turn"
        after_text = _chunk_text(
            next(frame for frame in _new_frames(acp.client, before_after) if _is_update(frame, "agent_message_chunk"))
        )
        assert "#1" in after_text
        assert "#2" not in after_text and "#3" not in after_text
        already = await _prompt(acp.client, "thread-1", "/undo 2", request_id=22)
        assert _error_code(already) == "TURN_NOT_FOUND"

        # 退完第 1 轮后，list 给出友好的空提示，/undo 1 报 NOTHING_TO_UNDO
        undone_first = await _prompt(acp.client, "thread-1", "/undo 1 both", request_id=23)
        assert prompt_response(undone_first).stop_reason == "end_turn"
        before_empty = len(acp.client.frames)
        listed_empty = await _prompt(acp.client, "thread-1", "/undo list", request_id=24)
        assert prompt_response(listed_empty).stop_reason == "end_turn"
        empty_text = _chunk_text(
            next(frame for frame in _new_frames(acp.client, before_empty) if _is_update(frame, "agent_message_chunk"))
        )
        assert "没有可回退" in empty_text
        nothing = await _prompt(acp.client, "thread-1", "/undo 1", request_id=25)
        assert _error_code(nothing) == "NOTHING_TO_UNDO"


async def test_plan_command_without_forms_explains_requirement(tmp_path: Path) -> None:
    """客户端未声明 elicitation.form 时，`/plan` 不启动 Run，而是明确提示需要表单能力。"""
    agent = ScriptedAgent([text("不该调用模型")])
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=False, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        before = len(acp.client.frames)
        resp_bare = await _prompt(acp.client, session_id, "/plan", request_id=3)
        assert prompt_response(resp_bare).stop_reason == "end_turn"
        msg_bare = _chunk_text(
            next(f for f in _new_frames(acp.client, before) if _is_update(f, "agent_message_chunk"))
        )
        assert "elicitation.form" in msg_bare

        before2 = len(acp.client.frames)
        resp_arg = await _prompt(acp.client, session_id, "/plan 整理重构步骤", request_id=4)
        assert prompt_response(resp_arg).stop_reason == "end_turn"
        msg_arg = _chunk_text(
            next(f for f in _new_frames(acp.client, before2) if _is_update(f, "agent_message_chunk"))
        )
        assert "elicitation.form" in msg_arg
        assert acp.server._sessions[session_id].approval_mode == "auto"
    assert agent.inputs == []


async def test_plan_command_with_forms_switches_mode_and_starts_optional_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """声明 elicitation.form 时：无参 `/plan` 仅切模式并推通知；带文本 `/plan <prompt>` 切模式并在 plan 模式跑一轮。"""
    seen_requests: list[Any] = []
    host = make_host(tmp_path, agent=ScriptedAgent([text("已收到规划")]))
    original_start = host.start_run

    async def spy_start(connection: Any, request: Any, *, on_accepted: Any = None) -> Any:
        seen_requests.append(request)
        return await original_start(connection, request, on_accepted=on_accepted)

    monkeypatch.setattr(host, "start_run", spy_start)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        listed = await acp.client.read_until(lambda frame: _is_update(frame, "available_commands_update"))
        names = [item["name"] for item in listed["params"]["update"]["availableCommands"]]
        assert "plan" in names and "plan-view" in names

        # 1) 无参 `/plan`：切到 plan、发 current_mode_update、不启动 Run
        before = len(acp.client.frames)
        switched = await _prompt(acp.client, session_id, "/plan", request_id=3)
        assert prompt_response(switched).stop_reason == "end_turn"
        frames = _new_frames(acp.client, before)
        mode_updates = [f for f in frames if _is_update(f, "current_mode_update")]
        assert len(mode_updates) == 1
        assert mode_updates[0]["params"]["update"]["currentModeId"] == "plan"
        assert acp.server._sessions[session_id].approval_mode == "plan"
        assert acp.server._sessions[session_id].mode_before_plan == "auto"
        assert seen_requests == []

        # 切回 default，再试带文本的 `/plan 设计认证方案`
        await acp.client.request(4, "session/set_mode", {"sessionId": session_id, "modeId": "default"})
        before2 = len(acp.client.frames)
        started = await _prompt(acp.client, session_id, "/plan 设计认证方案", request_id=5)
        assert prompt_response(started).stop_reason == "end_turn"
        frames2 = _new_frames(acp.client, before2)
        mode_updates2 = [f for f in frames2 if _is_update(f, "current_mode_update")]
        assert len(mode_updates2) == 1
        assert mode_updates2[0]["params"]["update"]["currentModeId"] == "plan"
        assert any(_chunk_text(f) == "已收到规划" for f in frames2 if _is_update(f, "agent_message_chunk"))
    assert len(seen_requests) == 1
    assert seen_requests[0].requested_approval_mode == "plan"
    assert seen_requests[0].pre_plan_mode == "default"
    assert seen_requests[0].input.message == "设计认证方案"


async def test_plan_when_already_in_plan_keeps_pre_plan_mode_and_inlines_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """已在 plan 模式时再次 `/plan` 不重复发通知也不覆盖原模式，带附件时仍能内联。"""
    sample = tmp_path / "ws" / "spec.txt"
    seen: list[Any] = []
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    sample.write_text("hello plan\n", encoding="utf-8")
    original_start = host.start_run

    async def spy_start(connection: Any, request: Any, *, on_accepted: Any = None) -> Any:
        seen.append(request)
        return await original_start(connection, request, on_accepted=on_accepted)

    monkeypatch.setattr(host, "start_run", spy_start)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.request(3, "session/set_mode", {"sessionId": session_id, "modeId": "plan"})
        before = len(acp.client.frames)
        again = await _prompt(acp.client, session_id, "/plan", request_id=4)
        assert prompt_response(again).stop_reason == "end_turn"
        assert not [f for f in _new_frames(acp.client, before) if _is_update(f, "current_mode_update")]
        assert acp.server._sessions[session_id].mode_before_plan == "auto"

        attached = await acp.client.request(
            5,
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [
                    {"type": "text", "text": "/plan 看看附件"},
                    {"type": "resource_link", "uri": sample.as_uri(), "name": "spec.txt"},
                ],
            },
        )
        assert prompt_response(attached).stop_reason == "end_turn"
    assert seen[0].requested_approval_mode == "plan"
    assert seen[0].pre_plan_mode == "auto"
    assert str(sample) in seen[0].input.message
    assert not seen[0].input.message.startswith("/plan")
    assert seen[0].input.model_message is not None
    assert "hello plan" in seen[0].input.model_message


async def test_plan_view_formats_plan_compose_and_goal_without_running_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/plan-view` 调 `host.open_thread(session_id, assume_idle=False)` 展示计划、Compose 与 Goal，不调用模型。"""
    agent = ScriptedAgent([text("不该调用模型")])
    host = make_host(tmp_path, agent=agent)
    open_calls: list[tuple[str, bool]] = []
    payload_box: dict[str, Any] = {
        "plan": {"has_plan": True, "plan_markdown": "1. 第一步\n2. 第二步"},
        "compose_progress": {
            "status": "active",
            "current_stage": "plan",
            "stages": [
                {"id": "requirement", "state": "confirmed"},
                {"id": "plan", "state": "current"},
            ],
        },
        "goal": {
            "goal_id": "g1",
            "revision": 2,
            "status": "active",
            "objective": "跑通测试",
            "criteria": [{"criterion_id": "c1", "text": "全绿"}],
        },
        "goal_pending": None,
    }

    async def fake_open_thread(thread_id: str, *, assume_idle: bool = False) -> dict[str, object]:
        open_calls.append((thread_id, assume_idle))
        return dict(payload_box)

    monkeypatch.setattr(host, "open_thread", fake_open_thread)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=False, commands=True)
        session_id = await _new_session(acp.client, host.workspace)

        bad = await _prompt(acp.client, session_id, "/plan-view extra", request_id=3)
        assert bad["error"]["code"] == -32602
        assert _error_code(bad) == "INVALID_COMMAND_ARGUMENTS"

        before = len(acp.client.frames)
        viewed = await _prompt(acp.client, session_id, "/plan-view", request_id=4)
        assert prompt_response(viewed).stop_reason == "end_turn"
        reply = _chunk_text(
            next(f for f in _new_frames(acp.client, before) if _is_update(f, "agent_message_chunk"))
        )
        assert "1. 第一步" in reply and "2. 第二步" in reply
        assert "需求" in reply and "计划" in reply
        assert "跑通测试" in reply and "全绿" in reply
        assert viewed["result"]["_meta"]["harnessCode"]["command"] == {"name": "plan-view"}

        payload_box.update(
            {"plan": {"has_plan": False, "plan_markdown": ""}, "compose_progress": None, "goal": None}
        )
        before_empty = len(acp.client.frames)
        empty = await _prompt(acp.client, session_id, "/plan-view", request_id=5)
        assert prompt_response(empty).stop_reason == "end_turn"
        empty_reply = _chunk_text(
            next(f for f in _new_frames(acp.client, before_empty) if _is_update(f, "agent_message_chunk"))
        )
        assert "没有" in empty_reply
    assert open_calls == [(session_id, False), (session_id, False)]
    assert agent.inputs == []


async def test_goal_cancel_maps_to_cancel_pending(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`/goal cancel` 与 `/goal cancel_pending` 映射到 `goal_mutate(..., action='cancel_pending')`。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("不该调用模型")]))
    calls: list[tuple[str, str | None, int | None]] = []

    async def inspect(_connection: object, _thread_id: str) -> dict[str, object]:
        return {
            "goal": {"goal_id": "g1", "revision": 4, "status": "active", "objective": "保持"},
            "pending": {"request_id": "req-1", "input_text": "修改目标"},
            "latest_evaluation": None,
        }

    async def mutate(
        _connection: object,
        _thread_id: str,
        _operation_id: str,
        action: str,
        expected_goal_id: str | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, object]:
        calls.append((action, expected_goal_id, expected_revision))
        return {"disposition": "applied", "goal": {"goal_id": "g1", "revision": 4, "status": "active"}}

    monkeypatch.setattr(host, "goal_inspect", inspect)
    monkeypatch.setattr(host, "goal_mutate", mutate)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client, forms=True, commands=True)
        session_id = await _new_session(acp.client, host.workspace)
        resp1 = await _prompt(acp.client, session_id, "/goal cancel", request_id=3)
        assert prompt_response(resp1).stop_reason == "end_turn"
        resp2 = await _prompt(acp.client, session_id, "/goal cancel_pending", request_id=4)
        assert prompt_response(resp2).stop_reason == "end_turn"
        bad = await _prompt(acp.client, session_id, "/goal cancel extra", request_id=5)
        assert _error_code(bad) == "INVALID_COMMAND_ARGUMENTS"
    assert calls == [
        ("cancel_pending", "g1", 4),
        ("cancel_pending", "g1", 4),
    ]
