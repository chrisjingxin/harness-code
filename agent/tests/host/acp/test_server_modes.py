"""ACP 会话模式：四个模式、`session/set_mode` 与 `current_mode_update`（Todo 2.6）。

【为什么既有假的 spy 也有真实 Run】
「模式记在哪、什么时候发给 Host」用 spy 看得最清楚；「正在等审批时切模式」只能让
真实 `RunCoordinator` 回答——那条 `RUN_APPROVAL_MODE_BUSY` 是它内部的竞态保护。
"""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from harness_agent.host.run_coordinator import RunError
from harness_agent.host.service_types import ApprovalModeName
from tests.support.acp_harness import (
    ApprovalAgent,
    InProcessAcp,
    ScriptedAgent,
    block,
    make_host,
    prompt_response,
    text,
)

MODE_TABLE: list[tuple[str, str]] = [
    ("default", "逐项确认"),
    ("auto-edit", "自动批准编辑"),
    ("auto", "自动判断"),
    ("yolo", "全部放行"),
]
"""四个对外的审批模式（固定顺序）；`plan` 永不出现（它依赖 ACP 没有的确认交互）。"""


async def _initialize(client: Any, request_id: int = 1) -> dict[str, Any]:
    """完成握手；握手失败直接报出真实错误，而不是让后续 session/new 报 NOT_INITIALIZED。"""
    response = await client.request(
        request_id, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
    )
    assert "result" in response, response
    return response


async def _new_session(client: Any, workspace: Path, request_id: int = 2) -> str:
    """建立会话并返回 sessionId。"""
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    assert "result" in response, response
    return response["result"]["sessionId"]


async def _send_prompt(client: Any, session_id: str, request_id: int = 3) -> None:
    """只发一轮 prompt，不在这里等响应。

    裸行客户端只有一个读循环：后台任务里再读帧会和主协程抢同一个 reader
    （RuntimeError: readuntil() called while another coroutine is already waiting）。
    所以测试先写帧，再在需要的时刻用 `read_until` 单点读响应。
    """
    await client.send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/prompt",
            "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "长任务"}]},
        }
    )


async def _wait_for_run(acp: InProcessAcp) -> None:
    """等 Run 真的被受理（`on_accepted` 已登记）。"""
    for _ in range(600):
        if acp.server._runs:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("run was not registered")


def _frame_index(frames: list[dict[str, Any]], predicate: Callable[[dict[str, Any]], bool]) -> int:
    """返回第一帧满足条件的下标；找不到就失败。"""
    for index, frame in enumerate(frames):
        if predicate(frame):
            return index
    raise AssertionError(f"no matching frame in {frames}")


def _is_mode_update(frame: dict[str, Any], mode_id: str) -> bool:
    """判断是否是某模式的 `current_mode_update`。"""
    return (
        frame.get("method") == "session/update"
        and frame.get("params", {}).get("update", {}).get("sessionUpdate")
        == "current_mode_update"
        and frame["params"]["update"]["currentModeId"] == mode_id
    )


async def test_new_session_lists_four_modes_in_order_without_plan(tmp_path: Path) -> None:
    """`session/new` 广告四个模式，顺序固定，当前项取配置默认（空 HOME 是 auto）。"""
    async with InProcessAcp(make_host(tmp_path, agent=ScriptedAgent([text("好")]))) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/new", {"cwd": str(acp.host.workspace), "mcpServers": []}
        )
    modes = response["result"]["modes"]
    assert [item["id"] for item in modes["availableModes"]] == [item[0] for item in MODE_TABLE]
    assert [item["name"] for item in modes["availableModes"]] == [item[1] for item in MODE_TABLE]
    assert all(item["description"] for item in modes["availableModes"])
    assert modes["currentModeId"] == "auto"


async def test_default_mode_is_the_configured_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """配置默认是 `plan` 时回退 `default`：`plan` 不暴露给 ACP 客户端。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    original = host.ensure_ready

    async def plan_snapshot() -> Any:
        return dataclasses.replace(await original(), default_approval_mode="plan")

    monkeypatch.setattr(host, "ensure_ready", plan_snapshot)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
    assert response["result"]["modes"]["currentModeId"] == "default"
    assert len(response["result"]["modes"]["availableModes"]) == len(MODE_TABLE)


async def test_set_mode_without_run_records_and_notifies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """没有活动 Run：只记在会话上、推 `current_mode_update`，下一轮 prompt 用它。"""
    seen: list[str | None] = []
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    original = host.start_run

    async def spy(connection: Any, request: Any, *, on_accepted: Any = None) -> Any:
        seen.append(request.requested_approval_mode)
        return await original(connection, request, on_accepted=on_accepted)

    monkeypatch.setattr(host, "start_run", spy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert "result" in response, response
        response_index = _frame_index(acp.client.frames, lambda frame: frame.get("id") == 3)
        update_index = _frame_index(
            acp.client.frames, lambda frame: _is_mode_update(frame, "yolo")
        )
        assert update_index < response_index
        await _send_prompt(acp.client, session_id)
        done = await acp.client.read_until(lambda frame: frame.get("id") == 3)
        assert prompt_response(done).stop_reason == "end_turn"
    assert seen == ["yolo"]


async def test_set_same_mode_sends_no_update(tmp_path: Path) -> None:
    """切到当前模式不推 update（客户端没有可见变化）。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3, "session/set_mode", {"sessionId": session_id, "modeId": "auto"}
        )
        assert "result" in response, response
    mode_updates = [
        frame
        for frame in acp.client.frames
        if frame.get("method") == "session/update"
        and frame["params"]["update"]["sessionUpdate"] == "current_mode_update"
    ]
    assert mode_updates == []


@pytest.mark.parametrize("mode_id", ["plan", "nope"])
async def test_set_mode_rejects_plan_and_unknown(tmp_path: Path, mode_id: str) -> None:
    """`plan` 与未知模式都是参数错误，会话模式不变。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3, "session/set_mode", {"sessionId": session_id, "modeId": mode_id}
        )
        assert acp.server._sessions[session_id].approval_mode == "auto"
    assert response["error"]["code"] == -32602
    assert response["error"]["data"]["code"] == "UNKNOWN_MODE"


async def test_set_mode_unknown_session_is_minus_32002(tmp_path: Path) -> None:
    """未知会话是「资源不存在」。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        response = await acp.client.request(
            3, "session/set_mode", {"sessionId": "missing", "modeId": "yolo"}
        )
    assert response["error"]["code"] == -32002


async def test_set_mode_requires_initialize(tmp_path: Path) -> None:
    """未握手时回 -32600。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        response = await acp.client.request(
            3, "session/set_mode", {"sessionId": "missing", "modeId": "yolo"}
        )
    assert response["error"]["code"] == -32600
    assert response["error"]["data"]["code"] == "NOT_INITIALIZED"


async def test_set_mode_with_active_run_calls_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """有活动 Run 时把模式提交给 Host，参数是（连接, 会话, Run, 模式）。"""
    calls: list[tuple[str, str, str]] = []
    host = make_host(tmp_path, agent=ScriptedAgent([block()]))
    original = host.set_approval_mode

    async def spy(
        connection: Any, thread_id: str, run_id: str, approval_mode: ApprovalModeName
    ) -> Any:
        calls.append((thread_id, run_id, approval_mode))
        return await original(connection, thread_id, run_id, approval_mode)

    monkeypatch.setattr(host, "set_approval_mode", spy)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await _send_prompt(acp.client, session_id)
        await _wait_for_run(acp)
        run_id = next(iter(acp.server._runs))
        response = await acp.client.request(
            4, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert "result" in response, response
        await acp.server.cancel(session_id)
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
    assert calls == [(session_id, run_id, "yolo")]


async def test_set_mode_busy_while_approval_pending(tmp_path: Path) -> None:
    """等审批时切模式：-32603 + retryable，会话模式不变；审批仍能正常回答。"""
    agent = ApprovalAgent(
        actions=[{"name": "execute", "args": {"command": "ls"}, "description": "跑一下"}],
        on_approve=[text("批准后继续")],
    )
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await _send_prompt(acp.client, session_id)
        request = await acp.client.read_request("session/request_permission")
        response = await acp.client.request(
            4, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert response["error"]["code"] == -32603
        assert response["error"]["data"]["code"] == "RUN_APPROVAL_MODE_BUSY"
        assert response["error"]["data"]["retryable"] is True
        assert acp.server._sessions[session_id].approval_mode == "auto"
        await acp.client.answer_permission(request, "approve_once")
        done = await acp.client.read_until(lambda frame: frame.get("id") == 3)
        assert prompt_response(done).stop_reason == "end_turn"


async def test_set_mode_plan_locked_maps_to_non_retryable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """计划锁定：-32603 且不可重试，会话模式不变。"""
    host = make_host(tmp_path, agent=ScriptedAgent([block()]))

    async def locked(*_args: Any, **_kwargs: Any) -> Any:
        raise RunError("RUN_APPROVAL_MODE_PLAN_LOCKED")

    monkeypatch.setattr(host, "set_approval_mode", locked)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await _send_prompt(acp.client, session_id)
        await _wait_for_run(acp)
        response = await acp.client.request(
            4, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert acp.server._sessions[session_id].approval_mode == "auto"
        await acp.server.cancel(session_id)
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
    assert response["error"]["code"] == -32603
    assert response["error"]["data"]["code"] == "RUN_APPROVAL_MODE_PLAN_LOCKED"
    assert response["error"]["data"]["retryable"] is False


@pytest.mark.parametrize(
    "code",
    [
        "RUN_APPROVAL_MODE_NOT_FOUND",
        "RUN_APPROVAL_MODE_TERMINAL",
        "RUN_APPROVAL_MODE_CANCELLED",
    ],
)
async def test_set_mode_not_found_terminal_cancelled_only_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    """Run 刚好结束/正在取消：不报错，只记在会话上并推 `current_mode_update`。"""
    host = make_host(tmp_path, agent=ScriptedAgent([block()]))

    async def racing(*_args: Any, **_kwargs: Any) -> Any:
        raise RunError(code)

    monkeypatch.setattr(host, "set_approval_mode", racing)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await _send_prompt(acp.client, session_id)
        await _wait_for_run(acp)
        response = await acp.client.request(
            4, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert "result" in response, response
        assert acp.server._sessions[session_id].approval_mode == "yolo"
        assert [frame for frame in acp.client.frames if _is_mode_update(frame, "yolo")]
        await acp.server.cancel(session_id)
        await acp.client.read_until(lambda frame: frame.get("id") == 3)


async def test_mode_changed_during_run_preparation_is_applied_on_accept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Run 还在准备阶段时改模式：受理之后补发一次，界面与实际生效的模式一致。"""
    gate = asyncio.Event()
    calls: list[str] = []
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    original_start = host.start_run
    original_mode = host.set_approval_mode

    async def gated_start(connection: Any, request: Any, *, on_accepted: Any = None) -> Any:
        await gate.wait()
        return await original_start(connection, request, on_accepted=on_accepted)

    async def spy_mode(
        connection: Any, thread_id: str, run_id: str, approval_mode: ApprovalModeName
    ) -> Any:
        calls.append(approval_mode)
        return await original_mode(connection, thread_id, run_id, approval_mode)

    monkeypatch.setattr(host, "start_run", gated_start)
    monkeypatch.setattr(host, "set_approval_mode", spy_mode)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        await _send_prompt(acp.client, session_id)
        # 等 prompt 走到「已进入 start_run、但还没受理」的位置。
        await asyncio.sleep(0.05)
        assert acp.server._runs == {}
        changed = await acp.client.request(
            4, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert "result" in changed, changed
        gate.set()
        done = await acp.client.read_until(lambda frame: frame.get("id") == 3)
        assert prompt_response(done).stop_reason == "end_turn"
    assert calls == ["yolo"]


async def _initialize_forms(client: Any) -> dict[str, Any]:
    """握手并声明会画表单。"""
    response = await client.request(
        1,
        "initialize",
        {"protocolVersion": 1, "clientCapabilities": {"elicitation": {"form": {}}}},
    )
    assert "result" in response, response
    return response


async def test_forms_client_lists_plan_and_keeps_configured_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """声明了表单时广告五项，配置默认 plan 就停在 plan。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    original = host.ensure_ready

    async def plan_snapshot() -> Any:
        return dataclasses.replace(await original(), default_approval_mode="plan")

    monkeypatch.setattr(host, "ensure_ready", plan_snapshot)
    async with InProcessAcp(host) as acp:
        await _initialize_forms(acp.client)
        response = await acp.client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
    modes = response["result"]["modes"]
    assert [item["id"] for item in modes["availableModes"]] == [
        "plan",
        *(item[0] for item in MODE_TABLE),
    ]
    assert modes["availableModes"][0]["name"] == "先出计划"
    assert modes["currentModeId"] == "plan"


async def test_set_plan_remembers_the_previous_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """切到先出计划时记下之前的模式，下一轮 prompt 把它交给 Host。"""
    seen: list[tuple[str | None, str | None]] = []
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    original = host.start_run

    async def spy(connection: Any, request: Any, *, on_accepted: Any = None) -> Any:
        seen.append((request.requested_approval_mode, request.pre_plan_mode))
        return await original(connection, request, on_accepted=on_accepted)

    monkeypatch.setattr(host, "start_run", spy)
    async with InProcessAcp(host) as acp:
        await _initialize_forms(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        response = await acp.client.request(
            3, "session/set_mode", {"sessionId": session_id, "modeId": "plan"}
        )
        assert "result" in response, response
        assert acp.server._sessions[session_id].mode_before_plan == "auto"
        await _send_prompt(acp.client, session_id, request_id=4)
        done = await acp.client.read_until(lambda frame: frame.get("id") == 4)
        assert prompt_response(done).stop_reason == "end_turn"
    assert seen == [("plan", "auto")]


async def test_approval_mode_echo_skips_the_mode_already_shown(tmp_path: Path) -> None:
    """会话已经是这个模式时，回声不再补第二帧；变了才补一帧。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize_forms(acp.client)
        session_id = await _new_session(acp.client, host.workspace)
        changed = await acp.client.request(
            3, "session/set_mode", {"sessionId": session_id, "modeId": "yolo"}
        )
        assert "result" in changed, changed
        yolo_updates = [frame for frame in acp.client.frames if _is_mode_update(frame, "yolo")]
        assert len(yolo_updates) == 1
        await host._broadcast_approval_mode(session_id, "yolo")
        for _ in range(20):
            if acp.server._outbox.empty():
                break
            await asyncio.sleep(0.01)
        assert [frame for frame in acp.client.frames if _is_mode_update(frame, "yolo")] == yolo_updates
        await host._broadcast_approval_mode(session_id, "default")
        await acp.client.read_until(lambda frame: _is_mode_update(frame, "default"))
        assert acp.server._sessions[session_id].approval_mode == "default"
        assert acp.server._sessions[session_id].mode_before_plan is None
