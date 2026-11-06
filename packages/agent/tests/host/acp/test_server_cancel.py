"""ACP 取消语义：取消在途 Run、取消后立刻再发 prompt、终态补发工具卡。

【为什么单独成文件】
取消是最容易写出竞态的地方：取消可能早于 Run 受理、晚于终态、或正好夹在中间。
这里逐条锁定「无论落在哪个窗口，客户端都能拿到确定的终态，且不会卡在工具转圈」。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from acp.exceptions import RequestError

from harness_agent.host.acp.translate import RunOutcome
from tests.support.acp_harness import (
    InProcessAcp,
    RawAcpClient,
    ScriptedAgent,
    block,
    first_update,
    flush,
    make_host,
    prompt_response,
    text,
    tool_args,
    tool_start,
)


async def _initialize(client: RawAcpClient, *, request_id: int = 1) -> dict[str, Any]:
    return await client.request(request_id, "initialize", {"protocolVersion": 1})


async def _new_session(client: RawAcpClient, workspace: Path, *, request_id: int = 2) -> str:
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    return response["result"]["sessionId"]


def _prompt(session_id: str, value: str = "你好") -> dict[str, Any]:
    return {"sessionId": session_id, "prompt": [{"type": "text", "text": value}]}


async def _send_prompt(client: RawAcpClient, session_id: str, request_id: int = 3) -> None:
    await client.send(
        {"jsonrpc": "2.0", "id": request_id, "method": "session/prompt", "params": _prompt(session_id)}
    )


async def _wait_for_update(client: RawAcpClient) -> None:
    """等到第一条 session/update，证明 prompt 已被处理。"""
    await client.read_until(lambda frame: frame.get("method") == "session/update")


async def test_cancel_active_run_returns_cancelled(tmp_path: Path) -> None:
    """取消在途 Run：prompt 响应是 cancelled，不是错误。"""
    agent = ScriptedAgent([text("开始"), block()])
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await _send_prompt(acp.client, session_id)
        await _wait_for_update(acp.client)
        await acp.client.notify("session/cancel", {"sessionId": session_id})
        response = await acp.client.read_until(lambda frame: frame.get("id") == 3)
        assert prompt_response(response).stop_reason == "cancelled"


async def test_cancel_marks_unfinished_tool_calls_failed_before_response(tmp_path: Path) -> None:
    """取消时未结束的工具补发 failed，且排在同一条 prompt 响应之前。"""
    agent = ScriptedAgent(
        [
            tool_start("call_0", "execute"),
            tool_args("call_0", '{"command":"sleep 100"}'),
            # 空 updates 事件是图边界：它会冲刷挂起的 tool.started/tool.delta，
            # 之后 block() 才能造出「工具卡已公告但未结束」的状态。
            flush(),
            block(),
        ]
    )
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await _send_prompt(acp.client, session_id)
        await acp.client.read_until(
            lambda frame: frame.get("params", {}).get("update", {}).get("sessionUpdate") == "tool_call"
        )
        await acp.client.notify("session/cancel", {"sessionId": session_id})
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
        frames = acp.client.frames
        response_index = next(i for i, frame in enumerate(frames) if frame.get("id") == 3)
        failed_updates = [
            (index, frame["params"]["update"])
            for index, frame in enumerate(frames)
            if frame.get("params", {}).get("update", {}).get("sessionUpdate") == "tool_call_update"
            and frame["params"]["update"].get("status") == "failed"
        ]
        assert failed_updates, frames
        assert all(index < response_index for index, _update in failed_updates)
        start = first_update("tool_call", frames)
        assert failed_updates[-1][1]["toolCallId"] == start["toolCallId"]


class _BlockFirstThenAnswer:
    """第一次执行卡住（供取消），第二次正常给一段正文并结束。"""

    def __init__(self) -> None:
        self.calls = 0

    async def astream(self, _stream_input: object, **_kwargs: object):
        from langchain_core.messages import AIMessageChunk

        self.calls += 1
        if self.calls == 1:
            yield ("messages", (AIMessageChunk(content="开始"), {}))
            await asyncio.Event().wait()
        yield ("messages", (AIMessageChunk(content="第二次回答"), {}))


async def test_prompt_after_cancel_succeeds_without_busy(tmp_path: Path) -> None:
    """拿到 cancelled 响应后立刻再发 prompt 应当成功：终态已置位，不会 THREAD_BUSY。"""
    agent = _BlockFirstThenAnswer()
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        await _send_prompt(acp.client, session_id)
        await _wait_for_update(acp.client)
        await acp.client.notify("session/cancel", {"sessionId": session_id})
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
        second = await acp.client.request(4, "session/prompt", _prompt(session_id, "再来一次"))
        assert prompt_response(second).stop_reason == "end_turn"
        assert agent.calls == 2


async def test_cancel_before_acceptance_still_ends_cancelled(tmp_path: Path) -> None:
    """取消早于 Run 受理：on_accepted 看到标志后立刻取消，最终仍是 cancelled。"""
    agent = ScriptedAgent([text("开始"), block()])
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        original_start = host.start_run

        async def slow_start(*args: Any, **kwargs: Any) -> Any:
            # 抬高受理延迟，制造「cancel 早于 on_accepted」窗口。
            await asyncio.sleep(0.1)
            return await original_start(*args, **kwargs)

        host.start_run = slow_start  # type: ignore[method-assign]
        try:
            await _send_prompt(acp.client, session_id)
            await acp.client.notify("session/cancel", {"sessionId": session_id})
            response = await acp.client.read_until(lambda frame: frame.get("id") == 3, timeout=20)
        finally:
            host.start_run = original_start  # type: ignore[method-assign]
        assert prompt_response(response).stop_reason == "cancelled"


async def test_shutdown_during_preparation_cancels_the_pending_prompt(tmp_path: Path) -> None:
    """EOF/SIGTERM 时 prompt 还在 start_run 准备阶段：受理后立即被取消，而不是白等宽限期。

    Code Review 发现：`begin_shutdown` 只取消已登记的 Run，准备阶段的 prompt 不在登记表里，
    Run 会在后台继续跑，服务端等满宽限期才退出。
    """
    acp = await InProcessAcp(make_host(tmp_path, agent=ScriptedAgent([block()])), grace_seconds=5).start()
    await _initialize(acp.client)
    session_id = await _new_session(acp.client, acp.host.workspace)

    original = acp.host.start_run

    async def slow_start_run(*args: Any, **kwargs: Any) -> Any:
        await asyncio.sleep(0.4)
        return await original(*args, **kwargs)

    acp.host.start_run = slow_start_run  # type: ignore[method-assign]
    await acp.client.send(
        {"jsonrpc": "2.0", "id": 9, "method": "session/prompt", "params": _prompt(session_id)}
    )
    await asyncio.sleep(0.1)  # 让请求进入准备阶段
    await acp.server.begin_shutdown()
    response = await acp.client.read_until(lambda f: f.get("id") == 9, timeout=3)
    assert response["result"]["stopReason"] == "cancelled"
    await acp.stop()


async def test_cancel_after_terminal_keeps_original_outcome(tmp_path: Path) -> None:
    """取消晚于终态：响应保持原终态，也不报错（RUN_NOT_FOUND 被吞掉）。"""
    agent = ScriptedAgent([text("完成")])
    async with InProcessAcp(make_host(tmp_path, agent=agent)) as acp:
        await _initialize(acp.client)
        session_id = await _new_session(acp.client, acp.host.workspace)
        response = await acp.client.request(3, "session/prompt", _prompt(session_id))
        assert prompt_response(response).stop_reason == "end_turn"
        await acp.client.notify("session/cancel", {"sessionId": session_id})
        # 之后连接仍然可用。
        again = await acp.client.request(4, "session/prompt", _prompt(session_id))
        assert prompt_response(again).stop_reason == "end_turn"


def test_failed_outcome_during_cancel_maps_to_cancelled(tmp_path: Path) -> None:
    """终态映射规则：已请求取消时的 failed 也回 cancelled（ACP 约定）。

    做成纯函数用例而不是端到端用例：端到端里取消会先 cancel 掉执行任务，
    失败终态几乎不可能与「已请求取消」同时出现，测不出这条规则。
    """
    from harness_agent.host.acp.server import AcpServer, _Session

    server = AcpServer(make_host(tmp_path, echo=True))
    session = _Session(session_id="s1", approval_mode="default")
    session.cancel_requested = True
    response = server._prompt_response(
        RunOutcome(kind="failed", error={"code": "RuntimeError", "message": "取消期间炸了"}),
        session,
    )
    assert response.stop_reason == "cancelled"


def test_failed_outcome_without_cancel_raises_request_error(tmp_path: Path) -> None:
    """没有请求取消时，failed 变成 -32603 + 稳定 code。"""
    from harness_agent.host.acp.server import AcpServer, _Session

    server = AcpServer(make_host(tmp_path, echo=True))
    session = _Session(session_id="s1", approval_mode="default")
    with pytest.raises(RequestError) as exc_info:
        server._prompt_response(
            RunOutcome(
                kind="failed",
                error={"code": "PROVIDER_RATE_LIMITED", "message": "限流", "retryable": True},
            ),
            session,
        )
    assert exc_info.value.code == -32603
    data = exc_info.value.data
    assert isinstance(data, dict)
    assert data["code"] == "PROVIDER_RATE_LIMITED"
    assert data["retryable"] is True


async def test_begin_shutdown_cancels_inflight_run(tmp_path: Path) -> None:
    """关闭开始时主动取消在途 Run，prompt 拿到 cancelled 而不是挂住。"""
    agent = ScriptedAgent([text("开始"), block()])
    acp = await InProcessAcp(make_host(tmp_path, agent=agent)).start()
    await _initialize(acp.client)
    session_id = await _new_session(acp.client, acp.host.workspace)
    await _send_prompt(acp.client, session_id)
    await _wait_for_update(acp.client)
    await acp.server.begin_shutdown()
    response = await acp.client.read_until(lambda frame: frame.get("id") == 3, timeout=20)
    assert prompt_response(response).stop_reason == "cancelled"
    assert await acp.stop() == 0


async def test_shutdown_keeps_idle_true_when_nothing_in_flight(tmp_path: Path) -> None:
    """空闲时 wait_idle 立即返回 True，不白等宽限期。"""
    acp = await InProcessAcp(make_host(tmp_path, echo=True)).start()
    await _initialize(acp.client)
    await acp.server.begin_shutdown()
    assert await acp.server.wait_idle(5.0) is True
    await acp.stop()


async def test_aclose_fails_dangling_run_future(tmp_path: Path) -> None:
    """`aclose` 兜底失败仍悬挂的 Run Future，避免 handler 永久等待。"""
    from harness_agent.host.acp.server import AcpServer, _ActiveRun
    from harness_agent.host.acp.tool_display import PathLocator
    from harness_agent.host.acp.translate import RunTranslator

    host = make_host(tmp_path, echo=True)
    server = AcpServer(host)
    await host.ensure_ready()
    loop = asyncio.get_running_loop()
    future: asyncio.Future[RunOutcome] = loop.create_future()
    server._runs["r1"] = _ActiveRun(
        run_id="r1",
        session_id="s1",
        translator=RunTranslator("r1", PathLocator(host.workspace)),
        done=future,
    )
    await server.aclose()
    assert future.done()
    assert isinstance(future.exception(), ConnectionError)
    await host.close()


# —— 挂起审批时的取消 / 断开 / 客户端异常（HC-209 S2 2.2） ——

from tests.support.acp_harness import ApprovalAgent, tool_result  # noqa: E402


def _approval_agent(**overrides: Any) -> ApprovalAgent:
    """一个 execute 审批脚本：中断前有工具卡，批准后收尾。"""
    options: dict[str, Any] = {
        "before": [
            tool_start("call_0", "execute"),
            tool_args("call_0", '{"command":"npm test"}'),
            flush(),
        ],
        "actions": [
            {
                "name": "execute",
                "args": {"command": "npm test"},
                "description": "跑测试",
                "tool_call_id": "call_0",
            }
        ],
        "on_approve": [tool_result("call_0", "ok"), text("跑完了")],
        "on_reject": [tool_result("call_0", "User rejected", error=True), text("已拒绝")],
    }
    options.update(overrides)
    return ApprovalAgent(**options)


async def test_cancel_while_waiting_for_approval_returns_cancelled(tmp_path: Path) -> None:
    """审批挂起时取消：Run 以 cancelled 收尾，卡片被补成 failed，且一条都不少地在响应之前。"""
    agent = _approval_agent()
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        client = acp.client
        await _initialize(client)
        session_id = await _new_session(client, host.workspace)
        await _send_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        card_id = permission["params"]["toolCall"]["toolCallId"]

        await client.notify("session/cancel", {"sessionId": session_id})
        response = await client.read_until(
            lambda frame: frame.get("id") == 3 and ("result" in frame or "error" in frame)
        )

        assert prompt_response(response).stop_reason == "cancelled"
        assert acp.server._broker is not None and acp.server._broker.pending_count == 0
        # 先取消 Run、再取消权限任务：Agent 不应被带着 reject 多恢复一轮。
        assert agent.resumes == []
        statuses = [
            update["status"]
            for frame in client.updates()
            for update in [frame.get("params", {}).get("update", {})]
            if update.get("toolCallId") == card_id and update.get("status")
        ]
        assert statuses[-1] == "failed"
        assert "in_progress" not in statuses


async def test_late_answer_after_cancel_resolves_nothing(tmp_path: Path) -> None:
    """取消之后客户端才点「允许」：不产生任何新帧，Run 不会带着批准继续跑。"""
    host = make_host(tmp_path, agent=_approval_agent())
    async with InProcessAcp(host) as acp:
        client = acp.client
        await _initialize(client)
        session_id = await _new_session(client, host.workspace)
        await _send_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.notify("session/cancel", {"sessionId": session_id})
        await client.read_until(
            lambda frame: frame.get("id") == 3 and ("result" in frame or "error" in frame)
        )
        before = len(client.frames)
        await client.answer_permission(permission, "approve_once")
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.read_frame(), 0.3)
        assert len(client.frames) == before


async def test_connection_close_while_pending_rejects_and_leaks_nothing(
    tmp_path: Path,
) -> None:
    """权限请求挂起时客户端断开：进程正常收尾，不留悬挂的权限任务。"""
    host = make_host(tmp_path, agent=_approval_agent())
    acp = InProcessAcp(host)
    await acp.start()
    client = acp.client
    await _initialize(client)
    session_id = await _new_session(client, host.workspace)
    await _send_prompt(client, session_id)
    await client.read_request("session/request_permission")

    exit_code = await acp.stop()

    assert exit_code == 0
    assert acp.server._broker is None or acp.server._broker.pending_count == 0


async def test_request_permission_connection_error_rejects(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """发权限请求时连接已断（SDK 抛 ConnectionError）：按 reject 交回 Host，Run 不挂。"""
    host = make_host(tmp_path, agent=_approval_agent())
    decided: list[object] = []
    original = host.resolve_interaction

    async def _boom(*_args: object, **_kwargs: object) -> object:
        raise ConnectionError("Connection closed")

    def _record(connection: Any, request_id: str, result: object) -> str:
        decided.append(result)
        return original(connection, request_id, result)

    monkeypatch.setattr(host, "resolve_interaction", _record)
    async with InProcessAcp(host) as acp:
        client = acp.client
        await _initialize(client)
        session_id = await _new_session(client, host.workspace)
        assert acp.server._broker is not None
        monkeypatch.setattr(acp.server._broker._client, "request_permission", _boom)
        await _send_prompt(client, session_id)
        response = await client.read_until(
            lambda frame: frame.get("id") == 3 and ("result" in frame or "error" in frame)
        )

        assert prompt_response(response).stop_reason == "end_turn"
        assert decided == [{"decision": "reject"}]


async def test_cancel_then_new_prompt_after_pending_approval_works(tmp_path: Path) -> None:
    """取消挂起的审批后同一会话还能再发一轮，并正常完成。"""
    host = make_host(tmp_path, agent=_approval_agent())
    async with InProcessAcp(host) as acp:
        client = acp.client
        await _initialize(client)
        session_id = await _new_session(client, host.workspace)
        await _send_prompt(client, session_id)
        await client.read_request("session/request_permission")
        await client.notify("session/cancel", {"sessionId": session_id})
        await client.read_until(
            lambda frame: frame.get("id") == 3 and ("result" in frame or "error" in frame)
        )

        await _send_prompt(client, session_id, request_id=4)
        permission = await client.read_request("session/request_permission")
        await client.answer_permission(permission, "approve_once")
        response = await client.read_until(
            lambda frame: frame.get("id") == 4 and ("result" in frame or "error" in frame)
        )
        assert prompt_response(response).stop_reason == "end_turn"


async def test_run_ending_without_session_cancel_clears_pending_permission(
    tmp_path: Path,
) -> None:
    """Run 因别的原因结束（这里用 Host 侧取消）时，挂起的权限任务必须随之清掉。

    没有 `session/cancel`，`cancel_session` 不会触发；只有 prompt 收尾的
    `cancel_run` 能防止权限任务永远等一个已经不存在的 Run。
    """
    host = make_host(tmp_path, agent=_approval_agent())
    async with InProcessAcp(host) as acp:
        client = acp.client
        await _initialize(client)
        session_id = await _new_session(client, host.workspace)
        await _send_prompt(client, session_id)
        await client.read_request("session/request_permission")
        run_id = acp.server._sessions[session_id].run.run_id

        await host.cancel_run(acp.server._connection, session_id, run_id)
        response = await client.read_until(
            lambda frame: frame.get("id") == 3 and ("result" in frame or "error" in frame)
        )

        assert prompt_response(response).stop_reason == "cancelled"
        assert acp.server._broker is not None and acp.server._broker.pending_count == 0
