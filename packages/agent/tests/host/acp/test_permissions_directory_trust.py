"""目录信任 ⇄ ACP `session/request_permission` 的翻译与往返测试。

目录信任是独立交互类型：卡片 id 是 `trust:{request_id}`，只有「本会话信任 / 拒绝」
两个选项，决策回到 v3 的 `allow_session` / `deny`。

进程内集成为什么要预置 presentation：注入 Agent 时 `RunContext` 是 None，预检里登记
目录信任的那段不会执行，而 `ls` 又是并发安全工具，Host 会直接自动放行。所以用
`ApprovalAgent(before_interrupt=...)` 在中断前手工写一条 directory_trust 展示。
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from acp.schema import RequestPermissionResponse

from harness_agent.host.acp.permissions import (
    InteractionFrame,
    build_trust_job,
    decision_from_response,
    trust_options,
)
from harness_agent.host.acp.translate import ApprovalTarget
from harness_agent.host.connection import ProtocolInteractionAdapter
from harness_agent.runtime.interactions import InteractionRequest
from tests.support.acp_harness import (
    ApprovalAgent,
    InProcessAcp,
    make_host,
    prompt_response,
)


def _frame(**overrides: object) -> InteractionFrame:
    """构造一条目录信任交互帧。"""
    values: dict[str, object] = {
        "request_id": "int-trust",
        "kind": "directory_trust",
        "session_id": "sess-1",
        "run_id": "run-1",
        "payload": {
            "directory": "/ext",
            "target_path": "/ext/a.txt",
            "tool_name": "ls",
            "access": "read",
            "shadows_workspace": False,
            "decisions": ["allow_session", "deny"],
        },
        "is_child": False,
        "agent_id": None,
    }
    values.update(overrides)
    return InteractionFrame(**values)  # type: ignore[arg-type]


def _target(**overrides: object) -> ApprovalTarget:
    """构造目录信任卡片。"""
    values: dict[str, object] = {
        "tool_call_id": "trust:int-trust",
        "title": "访问工作区外目录：/ext",
        "kind": "read",
        "locations": [],
        "raw_input": None,
        "updates": [],
        "matched": "none",
    }
    values.update(overrides)
    return ApprovalTarget(**values)  # type: ignore[arg-type]


def _text_of(job: Any) -> str:
    """取权限请求里的文本内容。"""
    content = job.tool_call.content
    assert content
    return content[0].content.text


def _response(option_id: str) -> RequestPermissionResponse:
    """构造一个「选中了某个选项」的 ACP 响应。"""
    return RequestPermissionResponse.model_validate(
        {"outcome": {"outcome": "selected", "optionId": option_id}}
    )


def test_trust_options_and_tool_call_fields() -> None:
    """卡片 id、标题、类别与文本兜底都按 §4.2 的规则表生成。"""
    job = build_trust_job(
        _frame(
            payload={
                "directory": "/ext",
                "target_path": "/ext/a.txt",
                "tool_name": "write_file",
                "access": "write",
                "shadows_workspace": True,
                "decisions": ["allow_session", "deny"],
            }
        ),
        _target(kind="edit"),
        ext_approval=False,
    )
    assert job is not None
    assert job.card_id == "trust:int-trust"
    assert job.tool_call.tool_call_id == "trust:int-trust"
    assert job.tool_call.status == "pending"
    assert job.tool_call.kind == "edit"
    assert [option.option_id for option in job.options] == ["allow_session", "deny"]
    body = _text_of(job)
    assert "工具 write_file 需要写入 /ext/a.txt" in body
    assert "待信任目录：/ext" in body
    assert "遮蔽工作区内的同名路径" in body
    assert job.reject_decision == "deny"


def test_trust_meta_only_when_declared() -> None:
    """没声明扩展时 `_meta` 为空；声明后是全 camelCase 的目录信任描述（挂在 toolCall 上）。"""
    undeclared = build_trust_job(_frame(), _target(), ext_approval=False)
    assert undeclared is not None and undeclared.tool_call.field_meta is None

    declared = build_trust_job(_frame(), _target(), ext_approval=True)
    assert declared is not None and declared.tool_call.field_meta is not None
    assert declared.tool_call.field_meta["harnessCode"]["approval"] == {  # type: ignore[index]
        "type": "directory_trust",
        "requestId": "int-trust",
        "directory": "/ext",
        "targetPath": "/ext/a.txt",
        "toolName": "ls",
        "access": "read",
        "shadowsWorkspace": False,
    }


def test_trust_decision_response_table() -> None:
    """选中 allow_session / deny 才算数；未知选项与取消一律 deny。"""
    job = build_trust_job(_frame(), _target(), ext_approval=False)
    assert job is not None
    assert decision_from_response(job, _response("allow_session")) == "allow_session"
    assert decision_from_response(job, _response("deny")) == "deny"
    assert decision_from_response(job, _response("reject")) == "deny"
    assert decision_from_response(job, None) == "deny"


def test_trust_options_have_no_other_choices() -> None:
    """即使 payload 带了别的决策，也只暴露两个选项。"""
    assert [
        option.option_id for option in trust_options(["allow_session", "deny", "approve_once"])
    ] == ["allow_session", "deny"]


def test_undeclared_handles_keep_conservative_defaults() -> None:
    """没声明的交互类型沿用 v3 的保守默认值，不新增分支。"""

    def _default(kind: str) -> dict[str, object]:
        return ProtocolInteractionAdapter._default_value(
            InteractionRequest(request_id="r", type=kind, payload={}, interrupt_id="int-r")
        )

    assert _default("approval") == {"decision": "reject"}
    assert _default("directory_trust") == {"decision": "deny"}
    assert _default("plan") == {"decision": "abandoned", "expired": True}
    assert _default("goal") == {"decision": "cancelled"}
    assert _default("plugin_consent") == {"decision": "cancel"}
    assert _default("question") == {"answers": {}}


@pytest.mark.parametrize(
    ("option_id", "recorded", "decision", "final_status"),
    [
        ("allow_session", "allow_session", "approve", "completed"),
        ("deny", "deny", "reject", "failed"),
    ],
)
async def test_trust_round_trip(
    tmp_path: Path,
    monkeypatch: Any,
    option_id: str,
    recorded: str,
    decision: str,
    final_status: str,
) -> None:
    """真实 Host 往返：信任卡片字段正确，决策回到 v3，卡片被收尾。"""
    external = tmp_path / "ext"
    external.mkdir()
    target = str(external)
    agent = ApprovalAgent(before=[], actions=[{"name": "ls", "args": {"path": target}}])
    host = make_host(tmp_path, agent=agent)
    seen: list[str] = []
    original_record = host._run_coordinator._record_directory_trust

    def _record(decided: str, presentation: Mapping[str, object], *, run_id: str | None = None) -> None:
        seen.append(decided)
        original_record(decided, presentation, run_id=run_id)

    monkeypatch.setattr(host._run_coordinator, "_record_directory_trust", _record)

    def seed() -> None:
        """中断前把 directory_trust 展示写进当前 Run，模拟真实预检的登记。"""
        runs = list(host._run_coordinator._runs.values())
        assert runs, "run must be registered before the interrupt"
        runs[0].approval_presentations.remember(
            "ls",
            {"path": target},
            {
                "kind": "directory_trust",
                "directory": target,
                "target_path": target,
                "tool_name": "ls",
                "access": "read",
                "shadows_workspace": False,
            },
        )

    agent._before_interrupt = seed
    async with InProcessAcp(host) as acp:
        client = acp.client
        await client.initialize()
        assert acp.server._connection is not None
        assert acp.server._connection.interaction_handles == {"approval", "directory_trust"}
        session_id = (
            await client.request(2, "session/new", {"cwd": str(host.workspace), "mcpServers": []})
        )["result"]["sessionId"]
        await client.send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [{"type": "text", "text": "看外部目录"}],
                },
            }
        )
        permission = await client.read_request("session/request_permission")
        tool_call = permission["params"]["toolCall"]
        assert tool_call["toolCallId"] == "trust:int-1"
        # 标题按设计被 `sanitize_line` 截到 120 字符，只断言前缀。
        assert tool_call["title"].startswith("访问工作区外目录：")
        assert tool_call["kind"] == "read"
        assert tool_call["locations"] == [{"path": target}]
        assert [option["optionId"] for option in permission["params"]["options"]] == [
            "allow_session",
            "deny",
        ]

        await client.answer_permission(permission, option_id)
        response = await client.read_until(
            lambda frame: frame.get("id") == 3 and ("result" in frame or "error" in frame)
        )

        assert prompt_response(response).stop_reason == "end_turn"
        assert seen == [recorded]
        assert agent.resumes == [[decision]]
        statuses = [
            str(update["status"])
            for frame in client.updates()
            for update in [frame.get("params", {}).get("update", {})]
            if update.get("toolCallId") == "trust:int-1" and update.get("status")
        ]
        assert statuses == ["pending", final_status]
