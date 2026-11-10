"""GAP-35 ACP 层顺序保证：交互帧不得早于同 Run 已入队事件到达客户端。

正文 `agent_message_chunk` → `tool_call`（pending）→ `session/request_permission`。
扇出任务故意放慢放大乱序窗口：没有屏障时 request_interaction 会插队。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from tests.support.acp_harness import (
    ApprovalAgent,
    InProcessAcp,
    flush,
    make_host,
    text,
    tool_args,
    tool_result,
    tool_start,
)
from tests.host.acp.test_server_cancel import _initialize, _new_session, _send_prompt

ROUNDS = 200


def _ordering_agent() -> ApprovalAgent:
    """正文 → 审批工具卡 → 批准后收尾的脚本。

    注：脚本化 agent 的 before 段 text 不产生 agent_message_chunk 帧
    （fixture 行为），可观察的乱序面是 tool_call(pending) 与 permission。
    """
    return ApprovalAgent(
        before=[
            tool_start("call_0", "execute"),
            tool_args("call_0", '{"command":"npm test"}'),
            flush(),
        ],
        actions=[
            {
                "name": "execute",
                "args": {"command": "npm test"},
                "description": "跑测试",
                "tool_call_id": "call_0",
            }
        ],
        on_approve=[tool_result("call_0", "ok"), text("跑完了")],
        on_reject=[tool_result("call_0", "User rejected", error=True), text("已拒绝")],
    )


def _kinds(frames: list[dict[str, Any]]) -> list[str]:
    """把帧压成我们关心的顺序序列：正文块 / tool_call / request_permission。"""
    out: list[str] = []
    for frame in frames:
        method = frame.get("method")
        if method == "session/request_permission":
            out.append("permission")
        elif method == "session/update":
            update = frame.get("params", {}).get("update", {})
            kind = update.get("sessionUpdate")
            if kind == "agent_message_chunk":
                out.append("chunk")
            elif kind == "tool_call" and update.get("status") == "pending":
                out.append("tool_call")
    return out


@pytest.mark.asyncio
async def test_permission_never_overtakes_event_frames(tmp_path: Path) -> None:
    """200 轮：permission 不得早于 tool_call 与正文 chunk 到达。"""
    host = make_host(tmp_path, agent=_ordering_agent())
    # 扇出放慢：把「交互抢先于事件」的乱序窗口拉大（屏障由它解除）。
    orig_fanout = host._fanout_agent_event

    async def slow_fanout(owner: Any, event: Any) -> None:
        await asyncio.sleep(0.02)
        await orig_fanout(owner, event)

    host._fanout_agent_event = slow_fanout  # type: ignore[method-assign]

    async with InProcessAcp(host) as acp:
        client = acp.client
        await _initialize(client)
        session_id = await _new_session(client, host.workspace)
        pos = 0
        for i in range(ROUNDS):
            request_id = 1000 + i
            await _send_prompt(client, session_id, request_id=request_id)
            permission = await client.read_request("session/request_permission")
            # 读 permission 后帧已到齐（屏障保证事件先于它），切这一段检查顺序。
            segment = client.frames[pos:]
            kinds = _kinds(segment)
            # permission 不得早于 tool_call(pending)：屏障前的乱序正是它抢先。
            assert kinds[:2] == ["tool_call", "permission"], (
                f"第 {i} 轮乱序：{kinds[:5]}"
            )
            await client.answer_permission(permission, "approve_once")
            await client.read_until(
                lambda f: f.get("id") == request_id and ("result" in f or "error" in f)
            )
            pos = len(client.frames)
