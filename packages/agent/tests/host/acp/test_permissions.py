"""审批与目录信任 ⇄ ACP `session/request_permission` 的测试。

不依赖网络与协程的部分：选项映射、文本兜底、rawInput 上限、`_meta` 形状、
客户端响应 → decision 的映射表、interaction 帧解析容错；
文末是进程内集成：真实 Host + 真实 stdio 服务层 + 裸行客户端。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from acp.schema import RequestPermissionResponse

from harness_agent.host.acp.permissions import (
    InteractionFrame,
    approval_options,
    build_approval_job,
    build_trust_job,
    decision_from_response,
    parse_interaction,
    trust_options,
)
from harness_agent.host.acp.translate import ApprovalTarget
from tests.support.acp_harness import (
    ApprovalAgent,
    InProcessAcp,
    block,
    first_update,
    flush,
    make_host,
    prompt_response,
    text,
    tool_args,
    tool_result,
    tool_start,
)

_MALFORMED = object()
"""结构不合法（不是 ACP 响应对象）：只可能在 SDK 之前出现，按拒绝处理。"""

APPROVAL_DECISIONS = [
    "approve_once",
    "approve_thread",
    "approve_project",
    "reject",
    "reject_with_feedback",
]

_WORKSPACE = Path("/workspace")
"""权限请求测试用的假工作区；只用来解析相对路径，不会被读写。"""


def _frame(
    *,
    kind: str = "approval",
    payload: dict[str, object] | None = None,
    request_id: str = "req-1",
    run_id: str = "run-1",
    session_id: str = "sess-1",
    is_child: bool = False,
    agent_id: str | None = None,
) -> InteractionFrame:
    """构造一个已解析的 interaction 帧。"""
    return InteractionFrame(
        request_id=request_id,
        kind=kind,  # type: ignore[arg-type]
        session_id=session_id,
        run_id=run_id,
        payload=payload if payload is not None else {"decisions": list(APPROVAL_DECISIONS)},
        is_child=is_child,
        agent_id=agent_id,
    )


def _target(**overrides: object) -> ApprovalTarget:
    """构造一个普通的工具卡关联结果。"""
    values: dict[str, object] = {
        "tool_call_id": "run-1:call-1",
        "title": "execute npm test",
        "kind": "execute",
        "locations": [],
        "raw_input": {"command": "npm test"},
        "updates": [],
        "matched": "id",
    }
    values.update(overrides)
    return ApprovalTarget(**values)  # type: ignore[arg-type]


def _text_of(job: object) -> str:
    """取一条权限请求的文本兜底内容。"""
    content = job.tool_call.content  # type: ignore[attr-defined]
    assert content, "permission request must carry text fallback"
    return content[0].content.text  # type: ignore[union-attr]


def test_options_follow_decisions_in_fixed_order() -> None:
    """乱序的 decisions 产出固定顺序的四个选项，optionId 直接用 v3 决策名。"""
    options = approval_options(list(reversed(APPROVAL_DECISIONS)))
    assert [(o.option_id, o.kind, o.name) for o in options] == [
        ("approve_once", "allow_once", "允许一次"),
        ("approve_thread", "allow_always", "本会话内总是允许"),
        ("approve_project", "allow_always", "本项目内总是允许"),
        ("reject", "reject_once", "拒绝"),
    ]


def test_reject_with_feedback_is_offered_only_with_forms() -> None:
    """没声明表单时不给「拒绝并说明原因」；声明了就排在拒绝后面。"""
    hidden = approval_options(APPROVAL_DECISIONS)
    assert "reject_with_feedback" not in {option.option_id for option in hidden}
    shown = approval_options(APPROVAL_DECISIONS, forms=True)
    assert [(option.option_id, option.kind, option.name) for option in shown] == [
        ("approve_once", "allow_once", "允许一次"),
        ("approve_thread", "allow_always", "本会话内总是允许"),
        ("approve_project", "allow_always", "本项目内总是允许"),
        ("reject", "reject_once", "拒绝"),
        ("reject_with_feedback", "reject_once", "拒绝并说明原因"),
    ]


def test_approval_extension_writes_scope_and_truncates_huge_requests() -> None:
    """声明 approval 扩展时，选项带范围；原始请求超过 256 KiB 只留截断标记。"""
    options = approval_options(APPROVAL_DECISIONS, forms=True, ext_approval=True)
    assert [option.field_meta["harnessCode"]["scope"] for option in options] == [  # type: ignore[index]
        "once",
        "thread",
        "project",
        "once",
        "once",
    ]
    assert trust_options(["allow_session", "deny"])[0].field_meta is None

    huge = {"action_requests": [{"name": "execute", "args": {"command": "x" * (300 * 1024)}}]}
    frame = _frame(payload={"description": "太大", "requests": huge, "decisions": ["reject"]})
    job = build_approval_job(frame, _target(), ext_approval=True, workspace=_WORKSPACE)
    assert job is not None
    approval = job.tool_call.field_meta["harnessCode"]["approval"]  # type: ignore[index]
    assert approval["requestsTruncated"] is True
    assert "requests" not in approval


def test_plan_entry_offers_only_allow_once_and_reject() -> None:
    """进入计划模式只有一次性点头与拒绝两项。"""
    assert [o.option_id for o in approval_options(["approve_once", "reject"])] == [
        "approve_once",
        "reject",
    ]


def test_missing_reject_option_is_added() -> None:
    """payload 只给了允许类选项时补一个拒绝，用户永远能说不。"""
    options = approval_options(["approve_once"])
    assert [o.option_id for o in options] == ["approve_once", "reject"]


def test_no_options_returns_no_job() -> None:
    """一个选项都产不出来时不给客户端发空选项的请求。"""
    frame = _frame(payload={"requests": {"action_requests": [{"name": "execute", "args": {}}]}, "decisions": []})
    assert build_approval_job(frame, _target(), ext_approval=False, workspace=_WORKSPACE) is None
    trust = _frame(
        kind="directory_trust",
        payload={"directory": "/ext", "target_path": "/ext/a", "tool_name": "ls", "access": "read", "decisions": []},
    )
    assert build_trust_job(trust, _target(), ext_approval=False) is None


def test_fallback_text_has_description_header_and_diff_block() -> None:
    """文本兜底：描述 + 文件变更摘要 + diff 代码块，只用 v3 已有的 presentation 字段。"""
    frame = _frame(
        payload={
            "description": "写入配置",
            "requests": {"action_requests": [{"name": "write_file", "args": {"file_path": "/src/a.py"}}]},
            "decisions": list(APPROVAL_DECISIONS),
            "presentation": {
                "kind": "file_diff",
                "operation": "write",
                "path": "/src/a.py",
                "added_lines": 3,
                "removed_lines": 1,
                "truncated": False,
                "unified_diff": "+a\n+b\n+b2\n-c",
            },
        }
    )
    text = _text_of(build_approval_job(frame, _target(), ext_approval=False, workspace=_WORKSPACE))
    first_line, rest = text.split("\n", 1)
    assert first_line == "写入配置"
    assert "文件变更：写入 /src/a.py（+3 −1）" in rest
    assert "```diff" in rest
    assert "+a" in rest


def test_fence_grows_when_diff_contains_backticks() -> None:
    """diff 里有 ``` 时围栏更长，否则代码块会被提前结束。"""
    frame = _frame(
        payload={
            "description": "改文档",
            "requests": {"action_requests": [{"name": "edit_file", "args": {"file_path": "/README.md"}}]},
            "decisions": list(APPROVAL_DECISIONS),
            "presentation": {
                "kind": "file_diff",
                "operation": "edit",
                "path": "/README.md",
                "added_lines": 1,
                "removed_lines": 0,
                "truncated": True,
                "unified_diff": "+```md",
            },
        }
    )
    text = _text_of(build_approval_job(frame, _target(), ext_approval=False, workspace=_WORKSPACE))
    assert "````diff" in text
    assert "（diff 已截断）" in text


def test_non_file_diff_presentation_is_ignored() -> None:
    """presentation 不是 file_diff（或没有 diff 文本）时只放描述。"""
    frame = _frame(
        payload={
            "description": "执行命令",
            "requests": {"action_requests": [{"name": "execute", "args": {"command": "ls"}}]},
            "decisions": list(APPROVAL_DECISIONS),
            "presentation": {"kind": "file_diff", "operation": "edit", "path": "/a.py"},
        }
    )
    text = _text_of(build_approval_job(frame, _target(), ext_approval=False, workspace=_WORKSPACE))
    assert text == "执行命令"


def test_text_strips_control_and_format_characters() -> None:
    """描述与 diff 来自模型和文件：控制字符、零宽、双向覆盖必须去掉，换行与制表保留。"""
    frame = _frame(
        payload={
            "description": "a\x1b[31mb\u202ec\u200bd\n二行\t制表",
            "requests": {"action_requests": [{"name": "execute", "args": {"command": "ls"}}]},
            "decisions": list(APPROVAL_DECISIONS),
            "presentation": {
                "kind": "file_diff",
                "operation": "edit",
                "path": "/a.py",
                "added_lines": 0,
                "removed_lines": 0,
                "truncated": False,
                "unified_diff": "+x\u200by",
            },
        }
    )
    text = _text_of(build_approval_job(frame, _target(), ext_approval=False, workspace=_WORKSPACE))
    assert "\x1b" not in text and "\u202e" not in text and "\u200b" not in text
    assert "a[31mbc" in text
    assert "\n二行\t制表" in text
    assert "+xy" in text


def test_raw_input_over_limit_is_omitted() -> None:
    """审批参数超过 256 KiB 时不发 rawInput，客户端仍能靠标题识别。"""
    small = build_approval_job(
        _frame(), _target(raw_input={"command": "npm test"}), ext_approval=False, workspace=_WORKSPACE
    )
    assert small is not None and small.tool_call.raw_input == {"command": "npm test"}

    huge = build_approval_job(
        _frame(), _target(raw_input={"command": "x" * (300 * 1024)}), ext_approval=False, workspace=_WORKSPACE
    )
    assert huge is not None and huge.tool_call.raw_input is None


def test_meta_only_when_extension_declared() -> None:
    """没声明扩展的客户端一个 harnessCode 字节都收不到（`_meta` 挂在 toolCall 上）。"""
    target = _target(title="edit_file /src/a.py", kind="edit")
    without = build_approval_job(_frame(), target, ext_approval=False, workspace=_WORKSPACE)
    assert without is not None and without.tool_call.field_meta is None

    frame = _frame(
        payload={
            "description": "写入配置",
            "requests": {"action_requests": [{"name": "write_file", "args": {"file_path": "/src/a.py"}}]},
            "decisions": list(APPROVAL_DECISIONS),
            "presentation": {
                "kind": "file_diff",
                "operation": "write",
                "path": "/src/a.py",
                "added_lines": 1,
                "removed_lines": 0,
                "truncated": False,
                "unified_diff": "+a",
            },
        }
    )
    with_meta = build_approval_job(frame, target, ext_approval=True, workspace=_WORKSPACE)
    assert with_meta is not None and with_meta.tool_call.field_meta is not None
    approval = with_meta.tool_call.field_meta["harnessCode"]["approval"]  # type: ignore[index]
    assert approval == {
        "type": "approval",
        "requestId": "req-1",
        "description": "写入配置",
        "presentation": frame.payload["presentation"],
        "requests": frame.payload["requests"],
    }

    child = build_approval_job(
        _frame(is_child=True, agent_id="builder"), target, ext_approval=True, workspace=_WORKSPACE
    )
    assert child is not None and child.tool_call.field_meta is not None
    assert child.tool_call.field_meta["harnessCode"]["approval"]["agentId"] == (  # type: ignore[index]
        "builder"
    )


@pytest.mark.parametrize(
    ("kind", "response", "expected"),
    [
        ("approval", {"outcome": {"outcome": "selected", "optionId": "approve_once"}}, "approve_once"),
        ("approval", {"outcome": {"outcome": "selected", "optionId": "approve_thread"}}, "approve_thread"),
        ("approval", {"outcome": {"outcome": "selected", "optionId": "reject"}}, "reject"),
        ("approval", {"outcome": {"outcome": "selected", "optionId": "not-offered"}}, "reject"),
        ("approval", {"outcome": {"outcome": "cancelled"}}, "reject"),
        ("approval", None, "reject"),
        ("approval", _MALFORMED, "reject"),
        ("directory_trust", {"outcome": {"outcome": "selected", "optionId": "allow_session"}}, "allow_session"),
        ("directory_trust", {"outcome": {"outcome": "selected", "optionId": "deny"}}, "deny"),
        ("directory_trust", {"outcome": {"outcome": "selected", "optionId": "approve_once"}}, "deny"),
        ("directory_trust", {"outcome": {"outcome": "cancelled"}}, "deny"),
        ("directory_trust", None, "deny"),
    ],
)
def test_decision_from_response_table(kind: str, response: object, expected: str) -> None:
    """§3.3 的响应映射表：只有选中本请求真的发出去的选项才算数。"""
    if kind == "approval":
        job = build_approval_job(_frame(), _target(), ext_approval=False, workspace=_WORKSPACE)
    else:
        job = build_trust_job(
            _frame(
                kind="directory_trust",
                payload={
                    "directory": "/ext",
                    "target_path": "/ext/a.txt",
                    "tool_name": "ls",
                    "access": "read",
                    "decisions": ["allow_session", "deny"],
                },
            ),
            _target(title="访问工作区外目录：/ext", kind="read"),
            ext_approval=False,
        )
    assert job is not None
    parsed = (
        RequestPermissionResponse.model_validate(response)
        if isinstance(response, dict)
        else response
    )
    assert decision_from_response(job, parsed) == expected


def test_parse_interaction_rejects_malformed_frames() -> None:
    """缺 id、params 不是对象、未知方法、缺 thread_id 都解析成 None（调用方 fail-closed）。"""
    good = {
        "jsonrpc": "2.0",
        "method": "interaction.approval",
        "id": "req-1",
        "params": {
            "thread_id": "sess-1",
            "run_id": "run-1",
            "payload": {"decisions": ["approve_once"]},
        },
    }
    parsed = parse_interaction(good)
    assert parsed is not None
    assert (parsed.request_id, parsed.kind, parsed.session_id, parsed.run_id) == (
        "req-1",
        "approval",
        "sess-1",
        "run-1",
    )

    for broken in (
        {**good, "id": None},
        {**good, "params": "nope"},
        {**good, "method": "interaction.plugin_consent"},
        {**good, "method": "event"},
        {**good, "params": {"run_id": "run-1", "payload": {}}},
        {**good, "params": {"thread_id": "sess-1", "payload": {}}},
        {**good, "params": {"thread_id": "sess-1", "run_id": "run-1", "payload": []}},
    ):
        assert parse_interaction(broken) is None

    for method, kind in (
        ("interaction.question", "question"),
        ("interaction.plan", "plan"),
        ("interaction.goal", "goal"),
    ):
        parsed_kind = parse_interaction({**good, "method": method})
        assert parsed_kind is not None and parsed_kind.kind == kind


def test_child_frame_carries_agent_id_and_flag() -> None:
    """子代理审批的帧要能看出 parent_execution_id 与 agent_id。"""
    parsed = parse_interaction(
        {
            "method": "interaction.approval",
            "id": "req-child",
            "params": {
                "thread_id": "sess-1",
                "run_id": "run-1",
                "parent_execution_id": "root-1",
                "agent_id": "builder",
                "payload": {"decisions": ["approve_once"]},
            },
        }
    )
    assert parsed is not None
    assert parsed.is_child is True
    assert parsed.agent_id == "builder"


def test_trust_options_are_allow_session_and_deny() -> None:
    """目录信任只有「本会话信任」与「拒绝」两项。"""
    assert [(o.option_id, o.kind, o.name) for o in trust_options(["allow_session", "deny"])] == [
        ("allow_session", "allow_always", "本会话内允许访问该目录"),
        ("deny", "reject_once", "拒绝"),
    ]


# —— 进程内集成：真实 Host + 真实 stdio 服务层 + 裸行客户端 ——



_APPROVE_OPTIONS = ["approve_once", "approve_thread", "approve_project", "reject"]


@contextlib.asynccontextmanager
async def _session(
    tmp_path: Path, agent: object, *, capabilities: dict[str, Any] | None = None
) -> AsyncIterator[tuple[Any, Any, str]]:
    """起一个真实 ACP 服务并建好会话；产出 (acp, client, sessionId)。"""
    host = make_host(tmp_path, agent=agent)
    async with InProcessAcp(host) as acp:
        client = acp.client
        await client.initialize(capabilities=capabilities)
        created = await client.request(
            2, "session/new", {"cwd": str(host.workspace), "mcpServers": []}
        )
        assert "result" in created, created
        yield acp, client, created["result"]["sessionId"]


async def _start_prompt(client: Any, session_id: str, request_id: int = 3) -> None:
    """发一轮 prompt 但不等待响应（审批要穿插处理）。"""
    await client.send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/prompt",
            "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "请执行"}]},
        }
    )


async def _prompt_frame(client: Any, request_id: int = 3) -> dict[str, Any]:
    """等到 prompt 的响应帧。"""
    return await client.read_until(
        lambda frame: frame.get("id") == request_id and ("result" in frame or "error" in frame)
    )


async def _prompt_frames(client: Any, request_ids: set[int]) -> dict[int, dict[str, Any]]:
    """一次读到多个 prompt 响应；响应顺序不定，分两次 read_until 会吞掉对方。"""
    found: dict[int, dict[str, Any]] = {}

    async def _loop() -> None:
        while len(found) < len(request_ids):
            frame = await client.read_frame()
            if frame.get("id") in request_ids and ("result" in frame or "error" in frame):
                found[frame["id"]] = frame

    await asyncio.wait_for(_loop(), 20)
    return found


def _updates(client: Any) -> list[dict[str, Any]]:
    """把收到的帧摊平成 update 列表（`client.updates()` 返回的是整帧）。"""
    return [frame.get("params", {}).get("update", {}) for frame in client.updates()]


def _card_statuses(client: Any, card_id: str) -> list[str]:
    """按到达顺序列出某张工具卡的状态。"""
    return [
        str(update["status"])
        for update in _updates(client)
        if update.get("toolCallId") == card_id and update.get("status")
    ]


def _all_text(client: Any) -> str:
    """汇总所有正文 update 的文本（工具卡内容块是列表，跳过）。"""
    parts: list[str] = []
    for update in _updates(client):
        content = update.get("content")
        if isinstance(content, dict) and isinstance(content.get("text"), str):
            parts.append(content["text"])
    return "".join(parts)


def _card_ids(client: Any) -> set[str]:
    """所有出现过的工具卡 id。"""
    return {
        str(update["toolCallId"])
        for update in _updates(client)
        if update.get("sessionUpdate") in {"tool_call", "tool_call_update"}
    }


def _approval_agent(**overrides: Any) -> ApprovalAgent:
    """一个 execute 审批的标准脚本：中断前有工具卡，批准/拒绝后各自收尾。"""
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
        "on_reject": [tool_result("call_0", "User rejected the tool call", error=True), text("已拒绝")],
    }
    options.update(overrides)
    return ApprovalAgent(**options)


async def test_allow_once_resumes_the_run_and_marks_in_progress(tmp_path: Path) -> None:
    """批准：先补卡 → 权限请求 → in_progress → completed → 文字 → prompt 响应。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        card_id = first_update("tool_call", client.frames)["toolCallId"]
        assert permission["params"]["sessionId"] == session_id
        assert permission["params"]["toolCall"]["toolCallId"] == card_id
        assert [option["optionId"] for option in permission["params"]["options"]] == _APPROVE_OPTIONS
        assert permission["params"]["toolCall"]["rawInput"] == {"command": "npm test"}

        await client.answer_permission(permission, "approve_once")
        response = await _prompt_frame(client)

        assert prompt_response(response).stop_reason == "end_turn"
        assert agent.resumes == [["approve"]]
        assert _card_statuses(client, card_id) == ["pending", "in_progress", "completed"]
        assert "跑完了" in _all_text(client)
        assert "approval:" not in card_id


async def test_reject_resumes_with_reject_and_card_fails(tmp_path: Path) -> None:
    """拒绝：resume 带 reject，工具卡最终 failed。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        card_id = permission["params"]["toolCall"]["toolCallId"]
        await client.answer_permission(permission, "reject")
        response = await _prompt_frame(client)

        assert prompt_response(response).stop_reason == "end_turn"
        assert agent.resumes == [["reject"]]
        assert _card_statuses(client, card_id)[-1] == "failed"
        assert "in_progress" not in _card_statuses(client, card_id)


async def test_tool_call_id_links_to_the_announced_card(tmp_path: Path) -> None:
    """2.0 注入的 id 必须挂到已有的那张卡上，不产生额外兜底卡。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.answer_permission(permission, "approve_once")
        await _prompt_frame(client)

        cards = _card_ids(client)
        assert len(cards) == 1
        assert permission["params"]["toolCall"]["toolCallId"] in cards


async def test_approval_before_any_event_still_creates_the_card(tmp_path: Path) -> None:
    """审批帧跑在 `tool.started` 前面：先建卡，之后迟到的 started 不重复建。"""
    agent = _approval_agent(
        before=[],
        on_approve=[
            tool_start("call_0", "execute"),
            tool_args("call_0", '{"command":"npm test"}'),
            tool_result("call_0", "ok"),
            text("跑完了"),
        ],
    )
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        card_id = permission["params"]["toolCall"]["toolCallId"]
        card = first_update("tool_call", client.frames)
        assert card["toolCallId"] == card_id
        assert card["status"] == "pending"

        await client.answer_permission(permission, "approve_once")
        await _prompt_frame(client)

        starts = [
            update
            for update in _updates(client)
            if update.get("sessionUpdate") == "tool_call" and update.get("toolCallId") == card_id
        ]
        assert len(starts) == 1
        assert _card_statuses(client, card_id)[-1] == "completed"


async def test_no_tool_call_id_matches_pending_card_by_name_and_args(tmp_path: Path) -> None:
    """没有 id（同批重复/被截断/无 context）时按名字与参数降级匹配到已有卡。"""
    agent = _approval_agent(
        actions=[{"name": "execute", "args": {"command": "npm test"}, "description": "跑测试"}]
    )
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        announced = first_update("tool_call", client.frames)["toolCallId"]
        assert permission["params"]["toolCall"]["toolCallId"] == announced

        await client.answer_permission(permission, "approve_once")
        await _prompt_frame(client)
        assert _card_statuses(client, announced)[-1] == "completed"


async def test_unmatched_approval_creates_fallback_card_and_closes_it(tmp_path: Path) -> None:
    """匹配不上的审批用 `approval:{request_id}` 兜底卡，并在回答后收尾。"""
    agent = _approval_agent(before=[], actions=[{"name": "web_fetch", "args": {"url": "https://e.com"}}])
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        assert permission["params"]["toolCall"]["toolCallId"] == "approval:int-1"

        await client.answer_permission(permission, "approve_once")
        await _prompt_frame(client)
        assert _card_statuses(client, "approval:int-1") == ["pending", "completed"]


async def test_fallback_card_fails_when_rejected(tmp_path: Path) -> None:
    """兜底卡被拒绝时收尾为 failed。"""
    agent = _approval_agent(before=[], actions=[{"name": "web_fetch", "args": {"url": "https://e.com"}}])
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.answer_permission(permission, "reject")
        await _prompt_frame(client)
        assert _card_statuses(client, "approval:int-1")[-1] == "failed"


async def test_child_approval_uses_fallback_card_with_agent_prefix(tmp_path: Path) -> None:
    """子代理审批一律用兜底卡，标题带子代理名前缀（翻译器不认识子代理的卡）。"""
    agent = ApprovalAgent(before=[block()])
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        run = None
        for _ in range(200):
            run = acp.server._sessions[session_id].run
            if run is not None:
                break
            await asyncio.sleep(0.01)
        assert run is not None
        await acp.server._sender(
            {
                "jsonrpc": "2.0",
                "method": "interaction.approval",
                "id": "req-child",
                "params": {
                    "thread_id": session_id,
                    "run_id": run.run_id,
                    "parent_execution_id": "root-1",
                    "agent_id": "builder",
                    "payload": {
                        "interrupt_id": "int-child",
                        "description": "子代理需要执行",
                        "requests": {"action_requests": [{"name": "execute", "args": {"command": "ls"}}]},
                        "decisions": _APPROVE_OPTIONS,
                    },
                },
            }
        )
        permission = await client.read_request("session/request_permission")
        assert permission["params"]["toolCall"]["toolCallId"] == "approval:req-child"
        assert permission["params"]["toolCall"]["title"] == "builder: execute ls"
        await client.answer_permission(permission, "cancelled-not-an-option")
        await client.notify("session/cancel", {"sessionId": session_id})
        await _prompt_frame(client)


async def test_serial_batch_of_two_approvals_are_answered_in_order(tmp_path: Path) -> None:
    """同一批两个审批先后出现，各自的选项与 resume 顺序都对。"""
    agent = ApprovalAgent(
        before=[],
        actions=[
            {"name": "execute", "args": {"command": "npm test"}},
            {"name": "execute", "args": {"command": "npm run build"}},
        ],
        on_approve=[text("都完成了")],
        on_reject=[text("已拒绝")],
    )
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        first = await client.read_request("session/request_permission")
        assert first["params"]["toolCall"]["rawInput"] == {"command": "npm test"}
        await client.answer_permission(first, "approve_once")
        second = await client.read_request("session/request_permission")
        assert second["params"]["toolCall"]["rawInput"] == {"command": "npm run build"}
        await client.answer_permission(second, "reject")
        await _prompt_frame(client)

        assert agent.resumes == [["approve", "reject"]]


async def test_two_sessions_have_independent_pending_requests(tmp_path: Path) -> None:
    """两个会话各挂一个审批，回复顺序颠倒也各归各的。"""
    agent = ApprovalAgent(
        before=[],
        actions=[{"name": "execute", "args": {"command": "npm test"}}],
        interrupt_id=None,
        on_approve=[text("ok")],
        on_reject=[text("no")],
    )
    async with _session(tmp_path, agent) as (acp, client, first_session):
        created = await client.request(
            20, "session/new", {"cwd": str(acp.host.workspace), "mcpServers": []}
        )
        second_session = created["result"]["sessionId"]
        await _start_prompt(client, first_session, request_id=30)
        await _start_prompt(client, second_session, request_id=31)

        one = await client.read_request("session/request_permission")
        two = await client.read_request("session/request_permission")
        assert one["params"]["sessionId"] != two["params"]["sessionId"]
        await client.answer_permission(two, "reject")
        await client.answer_permission(one, "approve_once")
        responses = await _prompt_frames(client, {30, 31})
        assert prompt_response(responses[30]).stop_reason == "end_turn"
        assert prompt_response(responses[31]).stop_reason == "end_turn"

        assert sorted(agent.resumes) == [["approve"], ["reject"]]
        assert acp.server._broker is not None and acp.server._broker.pending_count == 0


async def test_interaction_handles_include_approval(tmp_path: Path) -> None:
    """连接必须声明 `approval` handle，否则 Host 会按「不支持」直接 fail-closed。"""
    async with _session(tmp_path, _approval_agent()) as (acp, _client, _session_id):
        assert "approval" in acp.server._connection.interaction_handles


async def test_interaction_for_unknown_session_or_run_fails_closed(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """找不到 Run 或会话时立刻 fail-closed，不起权限任务。"""
    async with _session(tmp_path, _approval_agent()) as (acp, _client, _session_id):
        failed: list[tuple[str, object]] = []

        def _record(connection: object, request_id: str, error: object) -> bool:
            failed.append((request_id, error))
            return True

        monkeypatch.setattr(acp.host, "fail_interaction", _record)
        await acp.server._sender(
            {
                "jsonrpc": "2.0",
                "method": "interaction.approval",
                "id": "req-ghost",
                "params": {
                    "thread_id": "sess-ghost",
                    "run_id": "run-ghost",
                    "payload": {"decisions": _APPROVE_OPTIONS},
                },
            }
        )
        for _ in range(50):
            if failed:
                break
            await asyncio.sleep(0.01)
        assert failed and failed[0][0] == "req-ghost"
        assert acp.server._broker is not None and acp.server._broker.pending_count == 0


async def test_cancelled_outcome_is_reject(tmp_path: Path) -> None:
    """客户端取消（关掉弹窗）→ resume 是 reject。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.answer_permission(permission, None)
        response = await _prompt_frame(client)
        assert prompt_response(response).stop_reason == "end_turn"
        assert agent.resumes == [["reject"]]


async def test_unknown_option_id_is_reject(tmp_path: Path) -> None:
    """客户端回了不在本次选项里的 id → reject（不能当成批准）。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.answer_permission(permission, "always-remember-please")
        await _prompt_frame(client)
        assert agent.resumes == [["reject"]]


async def test_client_error_response_is_reject(tmp_path: Path) -> None:
    """客户端回 JSON-RPC 错误（例如自己实现出错）→ reject，Run 不能挂死。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.respond_error(permission, -32603, "client exploded")
        response = await _prompt_frame(client)
        assert prompt_response(response).stop_reason == "end_turn"
        assert agent.resumes == [["reject"]]


async def test_malformed_result_is_reject(tmp_path: Path) -> None:
    """响应结构不合法（selected 但缺 optionId）→ reject。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.respond(permission, {"outcome": {"outcome": "selected"}})
        await _prompt_frame(client)
        assert agent.resumes == [["reject"]]


async def test_pending_request_has_no_timeout(tmp_path: Path) -> None:
    """审批没有超时：挂起半秒后任务仍在、Run 未结束（防止有人悄悄加计时器）。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await asyncio.sleep(0.5)
        assert acp.server._broker is not None and acp.server._broker.pending_count == 1
        assert acp.server._sessions[session_id].busy is True
        await client.answer_permission(permission, "approve_once")
        response = await _prompt_frame(client)
        assert prompt_response(response).stop_reason == "end_turn"


async def test_unsupported_interaction_types_still_fail_closed(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """没声明的交互类型（提问/计划/目标）一律立刻 fail-closed。"""
    async with _session(tmp_path, _approval_agent()) as (acp, _client, _session_id):
        failed: list[str] = []

        def _record(connection: object, request_id: str, error: object) -> bool:
            failed.append(request_id)
            return True

        monkeypatch.setattr(acp.host, "fail_interaction", _record)
        await acp.server._sender(
            {
                "jsonrpc": "2.0",
                "method": "interaction.question",
                "id": "req-q",
                "params": {"thread_id": "s", "run_id": "r", "payload": {}},
            }
        )
        for _ in range(100):
            if failed:
                break
            await asyncio.sleep(0.01)
        assert failed == ["req-q"]


# —— Code Review 后补的回归：翻译失败、id 复用、取消门、独占卡、缓存清理 ——


async def test_translation_failure_rejects_instead_of_hanging(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """翻译阶段抛异常：审批必须立刻按 reject 交回 Host，而不是无超时地挂住 Run。"""
    from harness_agent.host.acp.translate import RunTranslator

    def _boom(self: object, **_kwargs: object) -> object:
        raise RuntimeError("boom")

    monkeypatch.setattr(RunTranslator, "prepare_approval", _boom)
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        response = await asyncio.wait_for(_prompt_frame(client), 10)

        assert prompt_response(response).stop_reason == "end_turn"
        assert agent.resumes == [["reject"]]
        assert acp.server._broker is not None and acp.server._broker.pending_count == 0


async def test_second_approval_with_same_tool_call_id_gets_a_fallback_card(
    tmp_path: Path,
) -> None:
    """同一个 tool_call_id 来第二个审批：第一张卡已被占用，第二个必须落到兜底卡。"""
    agent = _approval_agent(
        actions=[
            {"name": "execute", "args": {"command": "npm test"}, "tool_call_id": "call_0"},
            {"name": "execute", "args": {"command": "npm run lint"}, "tool_call_id": "call_0"},
        ],
        on_approve=[text("都完成了")],
    )
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        first = await client.read_request("session/request_permission")
        await client.answer_permission(first, "approve_once")
        second = await client.read_request("session/request_permission")
        first_card = first["params"]["toolCall"]["toolCallId"]
        second_card = second["params"]["toolCall"]["toolCallId"]
        assert second_card != first_card
        assert second_card.startswith("approval:")
        await client.answer_permission(second, "approve_once")
        await _prompt_frame(client)


async def test_interaction_arriving_after_cancel_request_is_rejected(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """已经 session/cancel 的会话再来审批帧：不弹窗，立刻 fail-closed。"""
    agent = _approval_agent()
    async with _session(tmp_path, agent) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        run_id = acp.server._sessions[session_id].run.run_id
        failed: list[str] = []

        def _record(connection: object, request_id: str, error: object) -> bool:
            failed.append(request_id)
            return True

        monkeypatch.setattr(acp.host, "fail_interaction", _record)
        acp.server._sessions[session_id].cancel_requested = True
        await acp.server._sender(
            {
                "jsonrpc": "2.0",
                "method": "interaction.approval",
                "id": "req-late",
                "params": {
                    "thread_id": session_id,
                    "run_id": run_id,
                    "payload": {
                        "decisions": _APPROVE_OPTIONS,
                        "requests": {
                            "action_requests": [
                                {"name": "execute", "args": {"command": "x"}}
                            ]
                        },
                    },
                },
            }
        )
        for _ in range(100):
            if failed:
                break
            await asyncio.sleep(0.01)
        permission_requests = [
            frame for frame in client.frames if frame.get("method") == "session/request_permission"
        ]

        assert failed == ["req-late"]
        assert len(permission_requests) == 1

        monkeypatch.undo()
        acp.server._sessions[session_id].cancel_requested = False
        await client.answer_permission(permission, "approve_once")
        await _prompt_frame(client)


async def test_run_end_clears_the_tool_call_id_cache(tmp_path: Path, monkeypatch: Any) -> None:
    """Run 收敛时必须清空 id 缓存（缓存最多 256 条，不清会跨 Run 串号并占内存）。"""
    from harness_agent.runtime.approval_tool_calls import ToolCallIdStore

    cleared: list[int] = []
    original = ToolCallIdStore.clear

    def _spy(self: ToolCallIdStore) -> None:
        cleared.append(1)
        original(self)

    monkeypatch.setattr(ToolCallIdStore, "clear", _spy)
    async with _session(tmp_path, _approval_agent()) as (acp, client, session_id):
        await _start_prompt(client, session_id)
        permission = await client.read_request("session/request_permission")
        await client.answer_permission(permission, "approve_once")
        await _prompt_frame(client)
        for _ in range(200):
            if cleared:
                break
            await asyncio.sleep(0.01)

        assert cleared


def _diff_block(job: object):
    from acp.schema import FileEditToolCallContent
    for item in job.tool_call.content or []:
        if isinstance(item, FileEditToolCallContent):
            return item
    return None


def _presentation(old_text: str | None, new_text: str | None, *, path: str = "a.txt") -> dict:
    return {
        "kind": "file_diff", "operation": "edit", "path": path,
        "added_lines": 1, "removed_lines": 1, "truncated": False,
        "unified_diff": "@@ -1 +1 @@", "old_text": old_text, "new_text": new_text,
    }


def test_permission_tool_call_carries_standard_diff(tmp_path: Path) -> None:
    """2.6：全文键齐全时 toolCall.content 是标准 diff（新建 null/修改双串/删除空串）。"""
    target = _target()
    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": _presentation("old\n", "new\n", path="/abs/a.txt")})
    job = build_approval_job(frame, target, ext_approval=False, workspace=tmp_path)
    diff = _diff_block(job)
    assert diff is not None
    assert diff.path == "/abs/a.txt" and diff.old_text == "old\n" and diff.new_text == "new\n"

    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": _presentation(None, "hello\n", path="new.txt")})
    job = build_approval_job(frame, target, ext_approval=False, workspace=tmp_path)
    diff = _diff_block(job)
    assert diff.path == str(tmp_path / "new.txt") and diff.old_text is None and diff.new_text == "hello\n"

    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": _presentation("gone\n", None, path="/d.txt")})
    job = build_approval_job(frame, target, ext_approval=False, workspace=tmp_path)
    diff = _diff_block(job)
    assert diff.old_text == "gone\n" and diff.new_text == ""


def test_permission_without_fulltext_falls_back_to_markdown(tmp_path: Path) -> None:
    """没有全文键：与改前逐字一致的文本兜底。"""
    target = _target()
    pres = _presentation("o", "n"); pres.pop("old_text"); pres.pop("new_text")
    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": pres})
    job = build_approval_job(frame, target, ext_approval=False, workspace=tmp_path)
    assert _diff_block(job) is None
    assert "@@ -1 +1 @@" in _text_of(job)


def test_permission_diff_oversize_falls_back_to_text(tmp_path: Path) -> None:
    """全文把请求撑超 6 MiB：退文本兜底，请求仍发得出。"""
    big = "x" * (7 * 1024 * 1024)
    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": _presentation(big, big)})
    job = build_approval_job(frame, _target(), ext_approval=False, workspace=tmp_path)
    assert _diff_block(job) is None
    assert _text_of(job)  # 文本兜底仍在


def test_permission_standard_diff_has_no_harnesscode_meta(tmp_path: Path) -> None:
    """未声明 harnessCode 扩展：标准 diff 照发，帧里无 harnessCode 痕迹。"""
    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": _presentation("o", "n", path="/a.txt")})
    job = build_approval_job(frame, _target(), ext_approval=False, workspace=tmp_path)
    assert _diff_block(job) is not None
    import json
    assert "harnessCode" not in json.dumps(job.tool_call.model_dump(mode="json", by_alias=True))


def test_extension_copy_of_presentation_omits_full_text(tmp_path: Path) -> None:
    """声明扩展时：标准 diff 带全文，`harnessCode.approval.presentation` 不再重复全文。"""
    frame = _frame(payload={"decisions": list(APPROVAL_DECISIONS), "presentation": _presentation("o", "n", path="/a.txt")})
    job = build_approval_job(frame, _target(), ext_approval=True, workspace=tmp_path)
    assert _diff_block(job) is not None
    presentation = job.tool_call.field_meta["harnessCode"]["approval"]["presentation"]
    assert "old_text" not in presentation and "new_text" not in presentation
    assert presentation["unified_diff"] == "@@ -1 +1 @@"
