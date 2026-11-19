"""审批预检回调捕获 provider `tool_call_id` 的行为测试。

覆盖三条链路：
1. 只有确定要弹窗的调用才登记（自动放行的调用不登记，避免同批覆盖）；
2. 全部 HITL 工具族都会被登记（一次覆盖，不再按工具逐个补）；
3. 真实 LangGraph 图里预检拿到的 id 与 `action_requests` 能对上（LangChain 升级护栏）。
"""

from __future__ import annotations

from collections.abc import Sequence
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.runnables import Runnable
from langgraph.checkpoint.memory import MemorySaver

from harness_agent.runtime.run_context import RunContext
from harness_agent.threads.context_lifecycle import prepare_embedded_context_snapshot

_UNSET = object()


def _context(*, workspace: str = "") -> RunContext:
    """构造最小 RunContext；审批预检只读取模式、计划约束与 tool_call_ids。"""
    snapshot = prepare_embedded_context_snapshot(
        thread_id="capture-thread",
        system_prompt="test",
        workspace=workspace or ".",
        sandboxed=False,
        provider=None,
        approval_mode="default",
        skill_registry=None,
        enable_memory=False,
        enable_skills=False,
        enable_ask_user=False,
    )
    return RunContext(
        thread_id="capture-thread",
        run_id="run-capture",
        approval_mode="default",
        context_snapshot=snapshot,
    )


def _request(
    name: str,
    args: dict[str, object] | None = None,
    *,
    call_id: str = "call-1",
    context: object = _UNSET,
) -> SimpleNamespace:
    """构造 HITL 预检收到的 ToolCallRequest 形状。"""
    resolved = _context() if context is _UNSET else context
    return SimpleNamespace(
        tool_call={"name": name, "args": args or {}, "id": call_id},
        runtime=SimpleNamespace(context=resolved),
    )


def _preflight(mode: str = "default"):
    """构造不带规则与边界预检的最简组合预检。"""
    from harness_agent.runtime.agent import _make_approval_preflight

    preflight = _make_approval_preflight(mode, None, lambda: [], "/tmp")
    assert preflight is not None
    return preflight


def test_preflight_records_id_only_when_it_asks() -> None:
    """弹窗的调用记 id；自动放行的只读调用不记。"""
    preflight = _preflight()
    executing = _request("execute", {"command": "rm -rf build"}, call_id="call-9")
    assert preflight(executing) is True
    assert executing.runtime.context.tool_call_ids.take("execute", {"command": "rm -rf build"}) == "call-9"

    readonly = _request("read_file", {"file_path": "/tmp/a.txt"}, call_id="call-10")
    assert preflight(readonly) is False
    assert readonly.runtime.context.tool_call_ids.take("read_file", {"file_path": "/tmp/a.txt"}) is None


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("write_file", {"file_path": "/src/a.py", "content": "x"}),
        ("edit_file", {"file_path": "/src/a.py", "old_string": "a", "new_string": "b"}),
        ("delete_file", {"file_path": "/src/a.py"}),
        ("execute", {"command": "rm -rf build"}),
        ("web_fetch", {"url": "https://example.com"}),
        ("task", {"subagent_type": "general-purpose", "description": "改文件"}),
        ("mcp__demo__query", {"query": "x"}),
    ],
)
def test_every_hitl_tool_records_its_tool_call_id(name: str, args: dict[str, object]) -> None:
    """全部 HITL 工具族都登记：一次覆盖，不漏 `execute` 与 MCP 工具。"""
    preflight = _preflight()
    request = _request(name, dict(args), call_id="call-2")
    assert preflight(request) is True
    assert request.runtime.context.tool_call_ids.take(name, args) == "call-2"


def test_missing_context_is_silently_skipped() -> None:
    """注入 Agent 的测试路径没有 RunContext：不登记也不抛，审批结论不变。"""
    preflight = _preflight()
    request = _request("execute", {"command": "rm -rf build"}, context=None)
    assert preflight(request) is True


def test_missing_tool_call_id_is_silently_skipped() -> None:
    """没有 id 的畸形请求同样不影响审批结论。"""
    preflight = _preflight()
    request = _request("execute", {"command": "rm -rf build"})
    request.tool_call.pop("id")
    assert preflight(request) is True


class _ToolCallingFakeChatModel(GenericFakeChatModel):
    """deepagents `bind_tools` 所需的最小假模型。"""

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        return self


async def test_real_graph_interrupt_carries_provider_tool_call_id(tmp_path) -> None:
    """真实 LangGraph HITL：预检里的 provider id 与该批 `action_requests` 能对上。

    这是 LangChain 升级护栏：将来 `ToolCallRequest.tool_call["id"]` 消失、
    或预检拿到的参数被 `ActionRequest` 改写，这里会失败。
    """
    from harness_agent.runtime.agent import create_harness_agent

    workspace = tmp_path / "ws"
    workspace.mkdir()
    model = _ToolCallingFakeChatModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "execute",
                            "args": {"command": "rm -rf build"},
                            "id": "call-1",
                            "type": "tool_call",
                        },
                        {
                            "name": "web_fetch",
                            "args": {"url": "https://example.com"},
                            "id": "call-2",
                            "type": "tool_call",
                        },
                    ],
                )
            ]
        )
    )
    model.profile = {"max_input_tokens": 200000}
    agent = create_harness_agent(
        model,
        checkpointer=MemorySaver(),
        enable_skills=False,
        enable_memory=False,
        enable_ask_user=False,
        approval_mode="default",
        cwd=str(workspace),
        shared_engine=True,
    )
    context = _context(workspace=str(workspace))
    config = {"configurable": {"thread_id": "capture-thread"}}

    interrupts: list[Any] = []
    async for event in agent.astream(
        {"messages": []}, config=config, stream_mode="updates", context=context
    ):
        data = event[1] if isinstance(event, tuple) and len(event) == 2 else event
        if isinstance(data, dict) and data.get("__interrupt__"):
            interrupts.append(data["__interrupt__"][0])

    assert len(interrupts) == 1, "两个越界调用应在同一个 interrupt 里"
    value = interrupts[0].value
    requests = value["action_requests"]
    assert len(requests) == 2
    # ActionRequest 本身已经丢掉 id，id 只能来自预检登记。
    assert all("tool_call_id" not in request for request in requests)
    assert context.tool_call_ids.take("execute", {"command": "rm -rf build"}) == "call-1"
    assert context.tool_call_ids.take("web_fetch", {"url": "https://example.com"}) == "call-2"
