"""扩展协商：只有声明了 `_meta.harnessCode` 的客户端才收到扩展字段（Todo 2.7）。

【为什么要递归扫帧】
「没声明就一个字节都不带」这类承诺不能靠逐个字段断言来证明：漏掉一个出口就漏了。
这里把所有出站帧序列化成 JSON 全文再搜 `harnessCode`，任何新增出口都会立刻暴露。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from harness_agent.host.acp.ext import (
    CAP_APPROVAL,
    CAP_RUN_SUMMARY,
    CAP_SESSION_SUMMARY,
    EXT_KEY,
    Negotiation,
    agent_capabilities_meta,
    negotiate,
    run_meta,
)
from harness_agent.host.acp.permissions import build_trust_job
from harness_agent.host.acp.translate import ApprovalTarget
from tests.support.acp_harness import (
    ApprovalAgent,
    InProcessAcp,
    ScriptedAgent,
    block,
    make_host,
    make_persistent_host,
    prompt_response,
    text,
)

DECLARE_ALL = {
    "harnessCode": {"version": 1, "capabilities": [CAP_APPROVAL, CAP_RUN_SUMMARY]}
}
DECLARE_APPROVAL_ONLY = {"harnessCode": {"version": 1, "capabilities": [CAP_APPROVAL]}}


async def _initialize_with(
    client: Any, meta: Mapping | None = None, request_id: int = 1
) -> dict[str, Any]:
    """握手；`meta` 走 `clientCapabilities._meta`（真实线路上的形状）。"""
    params: dict[str, Any] = {"protocolVersion": 1, "clientCapabilities": {}}
    if meta is not None:
        params["clientCapabilities"] = {"_meta": dict(meta)}
    return await client.request(request_id, "initialize", params)


async def _new_session(client: Any, workspace: Path, request_id: int = 2) -> str:
    """建立会话并返回 sessionId。"""
    response = await client.request(
        request_id, "session/new", {"cwd": str(workspace), "mcpServers": []}
    )
    assert "result" in response, response
    return response["result"]["sessionId"]


async def _complete_a_run(client: Any, session_id: str, request_id: int = 3) -> dict[str, Any]:
    """跑完一轮普通对话。"""
    return await client.request(
        request_id,
        "session/prompt",
        {"sessionId": session_id, "prompt": [{"type": "text", "text": "你好"}]},
    )


def _assert_no_harness_code(frames: list[dict[str, Any]]) -> None:
    """整条连接上任何一帧都不能出现 `harnessCode` 字样。"""
    for frame in frames:
        assert "harnessCode" not in json.dumps(frame, ensure_ascii=False), frame


def _trust_target() -> ApprovalTarget:
    """构造一个目录信任卡片关联结果。"""
    return ApprovalTarget(
        tool_call_id="trust:req-1",
        title="访问工作区外目录：/ext",
        kind="read",
        locations=[],
        raw_input=None,
        updates=[],
        matched="none",
    )


@pytest.mark.parametrize(
    ("capabilities", "expected"),
    [
        (None, Negotiation()),
        ({}, Negotiation()),
        ({"_meta": None}, Negotiation()),
        ({"_meta": {}}, Negotiation()),
        ({"_meta": {"harnessCode": None}}, Negotiation()),
        ({"_meta": {"harnessCode": "1"}}, Negotiation()),
        ({"_meta": {"harnessCode": {}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": True, "capabilities": []}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": "1", "capabilities": []}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": 1.0, "capabilities": []}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": 2, "capabilities": []}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": 1}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": 1, "capabilities": "approval"}}}, Negotiation()),
        ({"_meta": {"harnessCode": {"version": 1, "capabilities": [1]}}}, Negotiation()),
        (
            {"_meta": {"harnessCode": {"version": 1, "capabilities": []}}},
            Negotiation(declared=True),
        ),
        (
            {"_meta": {"harnessCode": {"version": 1, "capabilities": ["unknown"]}}},
            Negotiation(declared=True),
        ),
        (
            {"_meta": {"harnessCode": {"version": 1, "capabilities": [CAP_APPROVAL]}}},
            Negotiation(declared=True, approval=True),
        ),
        (
            {
                "_meta": {
                    "harnessCode": {
                        "version": 1,
                        "capabilities": [CAP_RUN_SUMMARY, CAP_APPROVAL],
                    }
                }
            },
            Negotiation(declared=True, approval=True, run_summary=True),
        ),
        (
            {
                "_meta": {
                    "harnessCode": {
                        "version": 1,
                        "capabilities": [CAP_SESSION_SUMMARY],
                    }
                }
            },
            Negotiation(declared=True, session_summary=True),
        ),
        (
            {
                "_meta": {
                    "harnessCode": {
                        "version": 1,
                        "capabilities": [
                            CAP_SESSION_SUMMARY,
                            CAP_RUN_SUMMARY,
                            CAP_APPROVAL,
                            "future-cap",
                        ],
                    }
                }
            },
            Negotiation(
                declared=True,
                approval=True,
                run_summary=True,
                session_summary=True,
            ),
        ),
    ],
)
def test_negotiate_table(capabilities: object, expected: Negotiation) -> None:
    """声明有效性表：任何一项不合法都整体按「没声明」处理。"""
    assert negotiate(capabilities) == expected


def test_negotiate_accepts_sdk_capabilities_object() -> None:
    """SDK 传进来的是模型对象而不是 dict：读它的 `field_meta`。"""
    declared = SimpleNamespace(field_meta=DECLARE_ALL)
    assert negotiate(declared) == Negotiation(declared=True, approval=True, run_summary=True)
    assert negotiate(SimpleNamespace(field_meta=None)) == Negotiation()


def test_meta_helpers_only_emit_when_declared() -> None:
    """两个出口的形状：没声明必须返回 None，声明了才带版本与能力清单。"""
    assert agent_capabilities_meta(Negotiation()) is None
    assert agent_capabilities_meta(Negotiation(declared=True)) == {
        EXT_KEY: {"version": 1, "capabilities": []}
    }
    assert agent_capabilities_meta(
        Negotiation(declared=True, approval=True, run_summary=True)
    ) == {EXT_KEY: {"version": 1, "capabilities": [CAP_APPROVAL, CAP_RUN_SUMMARY]}}
    assert run_meta({"duration_ms": 12}) == {EXT_KEY: {"run": {"duration_ms": 12}}}


async def test_declared_client_gets_capabilities_echo(tmp_path: Path) -> None:
    """声明了就在握手响应里回报自己支持的能力（固定顺序）。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        response = await _initialize_with(acp.client, DECLARE_ALL)
    capabilities = response["result"]["agentCapabilities"]
    assert capabilities["_meta"]["harnessCode"] == {
        "version": 1,
        "capabilities": ["approval", "runSummary"],
    }


async def test_empty_declaration_still_echoes(tmp_path: Path) -> None:
    """空能力列表也是「声明过」：回报一个空清单，但不再下发任何扩展字段。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        response = await _initialize_with(
            acp.client, {"harnessCode": {"version": 1, "capabilities": []}}
        )
        session_id = await _new_session(acp.client, host.workspace)
        completed = await _complete_a_run(acp.client, session_id)
    assert response["result"]["agentCapabilities"]["_meta"]["harnessCode"] == {
        "version": 1,
        "capabilities": [],
    }
    assert "_meta" not in completed["result"]


async def test_undeclared_client_never_sees_harnesscode(tmp_path: Path) -> None:
    """没声明：跑完一轮含真实审批的流程，任何出站帧都不含 `harnessCode`。"""
    agent = ApprovalAgent(
        actions=[{"name": "execute", "args": {"command": "ls"}, "description": "跑一下"}],
        on_approve=[text("批准后继续")],
    )
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        response = await _initialize_with(acp.client)
        assert "_meta" not in response["result"]["agentCapabilities"]
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "跑"}]},
            }
        )
        request = await acp.client.read_request("session/request_permission")
        assert request["params"]["toolCall"].get("_meta") is None
        await acp.client.answer_permission(request, "approve_once")
        done = await acp.client.read_until(lambda frame: frame.get("id") == 3)
        assert prompt_response(done).stop_reason == "end_turn"
    _assert_no_harness_code(acp.client.frames)


async def test_invalid_declaration_behaves_like_undeclared(tmp_path: Path) -> None:
    """版本不认识（=2）按没声明处理：不回能力，也不下发审批 `_meta`。"""
    agent = ApprovalAgent(
        actions=[{"name": "execute", "args": {"command": "ls"}, "description": "跑一下"}],
        on_approve=[text("批准后继续")],
    )
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        response = await _initialize_with(
            acp.client, {"harnessCode": {"version": 2, "capabilities": [CAP_APPROVAL]}}
        )
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "跑"}]},
            }
        )
        request = await acp.client.read_request("session/request_permission")
        assert request["params"]["toolCall"].get("_meta") is None
        await acp.client.answer_permission(request, "approve_once")
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
    assert "_meta" not in response["result"]["agentCapabilities"]
    _assert_no_harness_code(acp.client.frames)


async def test_approval_meta_shape_for_declared_client(tmp_path: Path) -> None:
    """声明了 `approval`：权限请求的 toolCall 带 `_meta.harnessCode.approval`。"""
    agent = ApprovalAgent(
        actions=[{"name": "execute", "args": {"command": "ls"}, "description": "跑一下"}],
        on_approve=[text("批准后继续")],
    )
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client, DECLARE_ALL)
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "跑"}]},
            }
        )
        request = await acp.client.read_request("session/request_permission")
        await acp.client.answer_permission(request, "approve_once")
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
    body = request["params"]["toolCall"]["_meta"]["harnessCode"]["approval"]
    assert body["type"] == "approval"
    # `requestId` 是 v3 的交互 id（这里是脚本化的中断 id），不是 JSON-RPC 的整数 id。
    assert body["requestId"] == "int-1"
    assert body["description"] == "跑一下"
    # 这个脚本化审批没有 presentation：缺失时省略该键，不发空对象。
    assert "presentation" not in body


def test_trust_meta_keeps_v3_presentation_shape() -> None:
    """目录信任的 `_meta` 用 camelCase，`presentation` 子对象保持 v3 原样。"""
    from harness_agent.host.acp.permissions import approval_meta, parse_interaction

    presentation = {"kind": "file_diff", "path": "/a.txt", "added_lines": 1}
    frame = parse_interaction(
        {
            "method": "interaction.approval",
            "id": "req-1",
            "params": {
                "thread_id": "s",
                "run_id": "r",
                "payload": {"description": "改文件", "presentation": presentation},
            },
        }
    )
    assert frame is not None
    assert approval_meta(frame) == {
        EXT_KEY: {
            "approval": {
                "type": "approval",
                "requestId": "req-1",
                "description": "改文件",
                "presentation": presentation,
            }
        }
    }
    trust = parse_interaction(
        {
            "method": "interaction.directory_trust",
            "id": "req-2",
            "params": {
                "thread_id": "s",
                "run_id": "r",
                "payload": {
                    "directory": "/ext",
                    "target_path": "/ext/a.txt",
                    "tool_name": "read_file",
                    "access": "write",
                    "shadows_workspace": True,
                    "decisions": ["allow_session", "deny"],
                },
            },
        }
    )
    assert trust is not None
    job = build_trust_job(trust, _trust_target(), ext_approval=True)
    assert job is not None
    assert job.tool_call.field_meta == {
        EXT_KEY: {
            "approval": {
                "type": "directory_trust",
                "requestId": "req-2",
                "directory": "/ext",
                "targetPath": "/ext/a.txt",
                "toolName": "read_file",
                "access": "write",
                "shadowsWorkspace": True,
            }
        }
    }


async def test_run_summary_only_on_completed_for_declared_client(tmp_path: Path) -> None:
    """完成才有 `_meta.harnessCode.run`；只声明 approval 时没有它。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client, DECLARE_ALL)
        session_id = await _new_session(acp.client, host.workspace)
        completed = await _complete_a_run(acp.client, session_id)
    body = completed["result"]["_meta"]["harnessCode"]["run"]
    assert isinstance(body.get("duration_ms"), int)
    assert "harnessCode" not in json.dumps(completed["result"].get("_meta", {}).get("context", {}))


async def test_run_summary_absent_when_only_approval_declared(tmp_path: Path) -> None:
    """只声明 `approval` 时不在 prompt 响应上下发 run summary。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client, DECLARE_APPROVAL_ONLY)
        session_id = await _new_session(acp.client, host.workspace)
        completed = await _complete_a_run(acp.client, session_id)
    assert "_meta" not in completed["result"]


async def test_run_summary_absent_for_cancelled_run(tmp_path: Path) -> None:
    """取消不带 summary：Spec §6.3 只说取自 `run.completed`。"""
    host = make_host(tmp_path, agent=ScriptedAgent([block()]))
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client, DECLARE_ALL)
        session_id = await _new_session(acp.client, host.workspace)
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "长"}]},
            }
        )
        for _ in range(600):
            if acp.server._runs:
                break
            await asyncio.sleep(0.01)
        await acp.server.cancel(session_id)
        done = await acp.client.read_until(lambda frame: frame.get("id") == 3)
    assert prompt_response(done).stop_reason == "cancelled"
    assert "_meta" not in done["result"]


async def test_run_summary_absent_for_failed_run(tmp_path: Path) -> None:
    """失败的 Run 是错误帧，里面不带任何扩展字段。"""
    host = make_persistent_host(tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client, DECLARE_ALL)
        session_id = await _new_session(acp.client, host.workspace)
        failed = await _complete_a_run(acp.client, session_id)
    assert failed["error"]["code"] == -32603
    assert "harnessCode" not in json.dumps(failed, ensure_ascii=False)


async def test_re_initialize_does_not_renegotiate(tmp_path: Path) -> None:
    """第二次 initialize 仍回 -32600：协商只在第一次做。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client)
        second = await _initialize_with(acp.client, DECLARE_ALL, request_id=2)
    assert second["error"]["code"] == -32600
    assert second["error"]["data"]["code"] == "ALREADY_INITIALIZED"


async def test_undeclared_client_sees_no_harnesscode_in_list_load_and_commands(
    tmp_path: Path,
) -> None:
    """没声明：会话列表、历史回放、命令推送这些出口同样一个 `harnessCode` 都没有。"""
    from tests.support.acp_harness import install_command_plugin
    from tests.support.thread_fixtures import seed_thread

    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(
        store,
        "thread-1",
        [
            {"kind": "user", "content": "先检查"},
            {"kind": "assistant", "content": "检查完成。"},
            {"kind": "tool", "content": "工具输出", "tool_name": "read_file"},
        ],
    )
    install_command_plugin(tmp_path / "home", tmp_path)
    async with InProcessAcp(host) as acp:
        await _initialize_with(acp.client)
        listed = await acp.client.request(2, "session/list", {})
        assert listed["result"]["sessions"]
        await acp.client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/load",
                "params": {
                    "sessionId": "thread-1",
                    "cwd": str(host.workspace),
                    "mcpServers": [],
                },
            }
        )
        await acp.client.read_until(lambda frame: frame.get("id") == 3)
        # 命令推送是 load 之后的异步任务：等它到达，确保这个出口确实被扫到。
        await acp.client.read_until(
            lambda frame: frame.get("params", {}).get("update", {}).get("sessionUpdate")
            == "available_commands_update"
        )
    methods = [frame.get("method") for frame in acp.client.frames]
    assert methods.count("session/update") >= 4
    _assert_no_harness_code(acp.client.frames)


DECLARE_ALL_THREE = {
    "harnessCode": {
        "version": 1,
        "capabilities": [CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY],
    }
}

_ISO_MS = __import__("re").compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


async def test_declared_all_three_echoes_in_fixed_order(tmp_path: Path) -> None:
    """三个能力都声明时，握手回报固定顺序 approval→runSummary→sessionSummary。"""
    host = make_host(tmp_path, agent=ScriptedAgent([text("好")]))
    async with InProcessAcp(host) as acp:
        response = await _initialize_with(acp.client, DECLARE_ALL_THREE)
    assert response["result"]["agentCapabilities"]["_meta"]["harnessCode"] == {
        "version": 1,
        "capabilities": ["approval", "runSummary", "sessionSummary"],
    }


async def test_session_list_carries_summary_meta_when_declared(tmp_path: Path) -> None:
    """声明 sessionSummary：每个 SessionInfo 带 _meta.harnessCode.summary 四字段。"""
    from tests.support.thread_fixtures import seed_thread

    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    long_tail = "长" * 300
    await seed_thread(
        store,
        "thread-1",
        [
            {"kind": "user", "content": f"第一行\n第二行\t{long_tail}"},
            {"kind": "assistant", "content": "尾行\n第二段\t完"},
        ],
    )
    async with InProcessAcp(host) as acp:
        await _initialize_with(
            acp.client,
            {"harnessCode": {"version": 1, "capabilities": [CAP_SESSION_SUMMARY]}},
        )
        listed = await acp.client.request(2, "session/list", {})
    session = listed["result"]["sessions"][0]
    summary = session["_meta"]["harnessCode"]["summary"]
    assert set(summary) == {"createdAt", "messageCount", "firstMessage", "latestMessage"}
    assert _ISO_MS.match(summary["createdAt"])
    assert isinstance(summary["messageCount"], int) and summary["messageCount"] == 2
    for key in ("firstMessage", "latestMessage"):
        value = summary[key]
        assert isinstance(value, str)
        assert "\n" not in value and "\t" not in value
        assert len(value) <= 200
    assert summary["latestMessage"] == "尾行 第二段 完"
    assert summary["firstMessage"].startswith("第一行 第二行")


async def test_malformed_declaration_means_no_summary_meta(tmp_path: Path) -> None:
    """声明形状非法（version 错）按未声明处理：session/list 也不带 harnessCode。"""
    from tests.support.thread_fixtures import seed_thread

    host = make_persistent_host(tmp_path)
    store = await host._ensure_thread_persistence()
    await seed_thread(store, "thread-1", [{"kind": "user", "content": "你好"}])
    async with InProcessAcp(host) as acp:
        await _initialize_with(
            acp.client,
            {"harnessCode": {"version": 2, "capabilities": [CAP_SESSION_SUMMARY]}},
        )
        listed = await acp.client.request(2, "session/list", {})
    assert listed["result"]["sessions"]
    _assert_no_harness_code(acp.client.frames)
