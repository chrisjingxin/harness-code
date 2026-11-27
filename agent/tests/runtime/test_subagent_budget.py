"""P0-1 子代理治理测试：预算收敛、上下文投影跳过与取消/超时用量记账。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware.types import ModelRequest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.runnables import Runnable
from langchain_core.tools import StructuredTool
from pydantic import Field

from harness_agent.runtime.agent import create_harness_agent
from harness_agent.runtime.child_stream import child_context_for, stream_inline_child
from harness_agent.runtime.delegation_usage import DelegationUsageLedger
from harness_agent.runtime.execution_binding import ExecutionMode, ExecutionRef
from harness_agent.runtime.managed_agent_executor import (
    ManagedAgentExecutionError,
    ManagedAgentExecutor,
    ManagedAgentRequest,
)
from harness_agent.runtime.run_context import RunCancellationToken, RunContext
from harness_agent.runtime.subagent_budget import (
    DEFAULT_EXPLORE_MAX_ROUNDS,
    DEFAULT_SUBAGENT_MAX_ROUNDS,
    SubagentBudget,
    SubagentBudgetMiddleware,
    default_max_rounds_for,
)
from harness_agent.threads.context_lifecycle import prepare_embedded_context_snapshot
from harness_agent.threads.context_projection import ContextProjectionError, ContextProjector
from harness_agent.threads.context_window import ContextWindowMiddleware


class _RecordingModel(GenericFakeChatModel):
    """记录每次模型调用收到的消息，支持 bind_tools 与异步流式工具调用。"""

    received: list[list[BaseMessage]] = Field(default_factory=list)

    def bind_tools(self, _tools: Any, **_kwargs: Any) -> Runnable:
        return self

    def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any):
        self.received.append(list(messages))
        return super()._generate(messages, *args, **kwargs)

    async def _astream(
        self, messages: list[BaseMessage], stop=None, run_manager=None, **kwargs: Any
    ):
        self.received.append(list(messages))
        message = next(self.messages)
        message_ = AIMessage(content=message) if isinstance(message, str) else message
        chunk = AIMessageChunk(
            content=message_.content,
            tool_calls=message_.tool_calls,
            id=message_.id,
            usage_metadata=getattr(message_, "usage_metadata", None),
        )
        chunk.chunk_position = "last"
        yield ChatGenerationChunk(message=chunk)


def _make_context(
    *,
    execution_id: str = "root",
    parent_execution_id: str | None = None,
    execution_mode: ExecutionMode = ExecutionMode.MANAGED,
    agent_id: str | None = None,
    usage_ledger: DelegationUsageLedger | None = None,
    subagent_budget: SubagentBudget | None = None,
) -> RunContext:
    resolved_agent_id = agent_id or (
        "explore" if execution_mode is ExecutionMode.INLINE else "main"
    )
    return RunContext(
        thread_id="thread-p0",
        run_id="run-p0",
        approval_mode="yolo",
        context_snapshot=prepare_embedded_context_snapshot(
            thread_id="thread-p0",
            system_prompt="test prompt",
            workspace="/tmp",
            sandboxed=False,
            provider=None,
            approval_mode="yolo",
            skill_registry=None,
            enable_memory=False,
            enable_skills=False,
            enable_ask_user=False,
        ),
        execution_id=execution_id,
        parent_execution_id=parent_execution_id,
        agent_id=resolved_agent_id,
        execution_mode=execution_mode,
        cancellation_token=RunCancellationToken(),
        usage_ledger=usage_ledger,
        subagent_budget=subagent_budget,
    )


def test_subagent_budget_round_and_deadline_phases() -> None:
    """explore 默认 8 轮、通用默认 30 轮，且时间窗口从第 2 轮起生效。"""
    assert DEFAULT_EXPLORE_MAX_ROUNDS == 8
    assert default_max_rounds_for("explore") == DEFAULT_EXPLORE_MAX_ROUNDS
    assert default_max_rounds_for("general-purpose") == DEFAULT_SUBAGENT_MAX_ROUNDS
    assert default_max_rounds_for("explore", 12) == 12

    now = 100.0
    budget = SubagentBudget.for_delegation(
        agent_id="explore",
        configured_max_turns=4,
        timeout_seconds=100.0,
        wrap_up_window_seconds=20.0,
        clock=lambda: now,
    )
    assert budget.begin_model_round() == "normal"
    assert budget.begin_model_round() == "normal"
    assert budget.begin_model_round() == "warn"
    assert budget.tools_blocked is False
    assert budget.begin_model_round() == "force_wrap_up"
    assert budget.tools_blocked is True

    # 短超时场景下第 1 轮绝不被提前阻塞，第 2 轮进入收束窗口才强制收敛
    t = 0.0
    time_budget = SubagentBudget.for_delegation(
        agent_id="explore",
        timeout_seconds=100.0,
        wrap_up_window_seconds=30.0,
        clock=lambda: t,
    )
    t = 95.0  # 已剩 5 秒，但第 1 轮不提前截断
    assert time_budget.begin_model_round() == "normal"
    assert time_budget.begin_model_round() == "force_wrap_up"
    assert time_budget.tools_blocked is True


@pytest.mark.asyncio
async def test_subagent_budget_middleware_warns_blocks_tools_and_wraps_up() -> None:
    """子代理到达轮次上限时注入强制收束指令并拦截后续工具调用，最终正常交付摘要。"""
    tool_calls_executed = 0

    def ping(q: str) -> str:
        nonlocal tool_calls_executed
        tool_calls_executed += 1
        return f"result:{q}"

    ping_tool = StructuredTool.from_function(func=ping, name="ping", description="ping")
    model = _RecordingModel(
        messages=iter(
            [
                # Round 1: normal
                AIMessage(content="", tool_calls=[{"name": "ping", "args": {"q": "1"}, "id": "c1"}]),
                # Round 2: warn
                AIMessage(content="", tool_calls=[{"name": "ping", "args": {"q": "2"}, "id": "c2"}]),
                # Round 3: force_wrap_up，模拟模型顽固仍试图调工具 -> 必须被 middleware 拦截
                AIMessage(content="", tool_calls=[{"name": "ping", "args": {"q": "3"}, "id": "c3"}]),
                # Round 4: 收到工具已停止后立即输出摘要
                AIMessage(content="SUBAGENT_WRAPPED_UP_SUMMARY"),
            ]
        )
    )
    graph = create_agent(
        model,
        tools=[ping_tool],
        middleware=[SubagentBudgetMiddleware()],
        system_prompt="base child prompt",
        context_schema=RunContext,
    )
    parent = _make_context()
    child_ref = ExecutionRef(
        thread_id="thread-p0",
        run_id="run-p0",
        execution_id="child-1",
        parent_execution_id="root",
    )
    budget = SubagentBudget(max_rounds=3)
    res = await stream_inline_child(
        graph=graph,
        parent=parent,
        child_ref=child_ref,
        agent_id="explore",
        task="inspect repo",
        cancelled=lambda: False,
        subagent_budget=budget,
    )
    assert res["messages"][-1].content == "SUBAGENT_WRAPPED_UP_SUMMARY"
    # 前两轮 ping 执行，第 3 轮达限后被拦截不执行
    assert tool_calls_executed == 2
    # 第 2 轮应含预算提示，第 3 轮应含强制停止指令
    assert "预算提示" in str(model.received[1][0].content)
    assert "预算已达上限" in str(model.received[2][0].content)


@pytest.mark.asyncio
async def test_context_window_skips_parent_projection_for_child_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """子代理复用父 thread_id 时不触发 ContextProjector.project（消除 51 次误报 ERROR）。"""
    project_calls = 0

    async def fake_project(self: ContextProjector, thread_id: str, **_kwargs: Any) -> Any:
        nonlocal project_calls
        project_calls += 1
        raise ContextProjectionError("incomplete tool group in parent transcript")

    monkeypatch.setattr(ContextProjector, "project", fake_project)

    class _DummyPersistence:
        diagnostic_log = None

    model = GenericFakeChatModel(messages=iter([AIMessage(content="ok")]))
    middleware = ContextWindowMiddleware(
        model,
        context_window_tokens=16_384,
        thread_persistence=_DummyPersistence(),  # type: ignore[arg-type]
    )

    child_ctx = _make_context(
        execution_id="child-abc",
        parent_execution_id="root",
        execution_mode=ExecutionMode.INLINE,
    )
    child_req = ModelRequest(
        model=model,
        messages=[HumanMessage(content="child task")],
        tools=[],
        runtime=SimpleNamespace(context=child_ctx),
    )

    async def ok_handler(_req: ModelRequest) -> Any:
        from langchain.agents.middleware.types import ModelResponse

        return ModelResponse(result=[AIMessage(content="ok")])

    await middleware.awrap_model_call(child_req, ok_handler)
    assert project_calls == 0

    # 根执行仍必须走 canonical projection
    root_ctx = _make_context(execution_id="root", parent_execution_id=None)
    root_req = ModelRequest(
        model=model,
        messages=[HumanMessage(content="root task")],
        tools=[],
        runtime=SimpleNamespace(context=root_ctx),
    )
    await middleware.awrap_model_call(root_req, ok_handler)
    assert project_calls == 1


@pytest.mark.asyncio
async def test_managed_executor_records_partial_child_usage_on_cancellation() -> None:
    """子代理在单轮消耗 token 后遭遇取消/超时时，usage_ledger 仍记录已消耗用量。"""
    ledger = DelegationUsageLedger()
    child_ctx = _make_context(
        execution_id="child-cancel",
        parent_execution_id="root",
        execution_mode=ExecutionMode.MANAGED,
        agent_id="explore",
        usage_ledger=ledger,
    )

    async def slow_tool(q: str) -> str:
        await asyncio.sleep(10)
        return q

    slow = StructuredTool.from_function(coroutine=slow_tool, name="slow_tool", description="slow")
    model = _RecordingModel(
        messages=iter(
            [
                AIMessage(
                    content="",
                    tool_calls=[{"name": "slow_tool", "args": {"q": "1"}, "id": "call-slow"}],
                    usage_metadata={"input_tokens": 1200, "output_tokens": 80, "total_tokens": 1280},
                ),
            ]
        )
    )
    graph = create_agent(model, tools=[slow], context_schema=RunContext)

    class _TestRuntime:
        def __init__(self, agent: object) -> None:
            self.agent = agent
            self.run_context = child_ctx
            self.acquire_source = "reused"
            self.queue_ms = 0
            self.build_ms = 0

        def graph_config(self, namespace: str) -> dict[str, object]:
            return {"configurable": {"thread_id": namespace}}

        async def release(self) -> None:
            return None

    async def acquire() -> _TestRuntime:
        return _TestRuntime(graph)

    class _Observer:
        def on_model_round(self) -> None:
            return None

        async def on_execution_complete(self, _result: Any) -> None:
            return None

        def emit(self, _signal: Any) -> None:
            return None

        async def interact(self, _req: Any) -> Any:
            raise AssertionError("unexpected interact")

        async def observe_message(self, _chunk: Any, _session: Any) -> bool:
            return False

        async def after_tool_boundary(self) -> None:
            return None

        def on_stream_event(self) -> None:
            return None

    request = ManagedAgentRequest(
        execution_ref="child-cancel",
        parent_execution_ref="root",
        run_id="run-p0",
        input="go",
        checkpoint_namespace="ns",
        output_policy="capture_only",
        runtime_provider=acquire,
        is_cancelled=lambda: False,
        idempotency_key="idem-cancel-1",
        timeout_seconds=0.2,
        usage_ledger=ledger,
    )
    with pytest.raises(ManagedAgentExecutionError) as exc_info:
        await ManagedAgentExecutor().execute(request, _Observer())  # type: ignore[arg-type]
    assert exc_info.value.code == "MANAGED_AGENT_TIMEOUT"

    summary = ledger.summary("root")
    assert summary["child_count"] == 1
    assert summary["child_input_tokens"] == 1200
    assert summary["child_output_tokens"] == 80


@pytest.mark.asyncio
async def test_create_harness_agent_mounts_subagent_budget_middleware(tmp_path: Path) -> None:
    """create_harness_agent 默认挂载 SubagentBudgetMiddleware 且根执行零拦截。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    model = _RecordingModel(messages=iter([AIMessage(content="root ok")]))
    agent = create_harness_agent(
        model,
        cwd=str(workspace),
        approval_mode="yolo",
        enable_memory=False,
        enable_skills=False,
        enable_ask_user=False,
    )
    state = await agent.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "root-no-budget"}},
    )
    assert state["messages"][-1].content == "root ok"


@pytest.mark.asyncio
async def test_subagent_budget_blocks_read_file_before_harness_file_tools_middleware(
    tmp_path: Path,
) -> None:
    """create_harness_agent(shared_engine=True) 中预算拦截位于文件工具外层，达限后能拦住 read_file。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sample = workspace / "sample.txt"
    sample.write_text("HELLO_BUDGET_CHECK\n", encoding="utf-8")

    model = _RecordingModel(
        messages=iter(
            [
                # 第 1 轮（normal）：允许通过 HarnessFileToolsMiddleware 读取文件
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": str(sample)},
                            "id": "call_read_1",
                        }
                    ],
                ),
                # 第 2 轮（force_wrap_up）：模型仍顽固调用 read_file -> 必须在进入文件工具前被拦截
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "read_file",
                            "args": {"file_path": str(sample)},
                            "id": "call_read_2",
                        }
                    ],
                ),
                # 第 3 轮：交付最终摘要
                AIMessage(content="BUDGET_WRAPPED_UP_IN_SHARED_ENGINE"),
            ]
        )
    )
    agent = create_harness_agent(
        model,
        cwd=str(workspace),
        approval_mode="yolo",
        enable_memory=False,
        enable_skills=False,
        enable_ask_user=False,
        shared_engine=True,
    )
    budget = SubagentBudget(max_rounds=2)
    run_context = RunContext(
        thread_id="thread-budget-read",
        run_id="run-budget-read",
        approval_mode="yolo",
        context_snapshot=prepare_embedded_context_snapshot(
            thread_id="thread-budget-read",
            system_prompt="child base prompt",
            workspace=str(workspace),
            sandboxed=False,
            provider=None,
            approval_mode="yolo",
            skill_registry=None,
            enable_memory=False,
            enable_skills=False,
            enable_ask_user=False,
        ),
        execution_id="child-budget-read",
        parent_execution_id="root",
        agent_id="explore",
        execution_mode=ExecutionMode.INLINE,
        cancellation_token=RunCancellationToken(),
        subagent_budget=budget,
    )
    state = await agent.ainvoke(
        {"messages": [HumanMessage(content="read sample.txt")]},
        config={"configurable": {"thread_id": "thread-budget-read"}},
        context=run_context,
    )
    assert state["messages"][-1].content == "BUDGET_WRAPPED_UP_IN_SHARED_ENGINE"
    tool_msgs = [m for m in state["messages"] if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 2
    assert "HELLO_BUDGET_CHECK" in str(tool_msgs[0].content)
    assert tool_msgs[0].status != "error"
    assert tool_msgs[1].status == "success"
    assert "已达到子代理轮次/时间预算上限" in str(tool_msgs[1].content)
    assert "HELLO_BUDGET_CHECK" not in str(tool_msgs[1].content)
    assert len(model.received) == 3
    round2_text = "\n".join(str(getattr(m, "content", "")) for m in model.received[1])
    assert "【预算已达上限】" in round2_text


def test_subagent_budget_stop_does_not_mark_tool_failed_in_stream_or_acp(tmp_path: Path) -> None:
    """预算刹停返回的跳过提示经执行流与 ACP 翻译后为 completed，不在 UI 显红。"""
    from harness_agent.host.acp.tool_display import PathLocator
    from harness_agent.host.acp.translate import RunTranslator
    from harness_agent.runtime.execution_stream import StreamSession, translate_stream_event
    from harness_agent.runtime.subagent_budget import _blocked_tool_message
    from tests.support.acp_harness import primary_path_resolver

    blocked = _blocked_tool_message(
        SimpleNamespace(tool_call={"id": "call_budget_stop", "name": "read_file"})  # type: ignore[arg-type]
    )
    assert blocked.status == "success"

    session = StreamSession(run_id="r-budget")
    start_chunk = AIMessageChunk(
        content="",
        tool_call_chunks=[{"id": "call_budget_stop", "name": "read_file", "args": "{}", "index": 0}],
    )
    start_signals = list(translate_stream_event(("messages", (start_chunk, {})), session))
    end_signals = list(translate_stream_event(("updates", {"tools": {"messages": [blocked]}}), session))
    completed = [sig for sig in end_signals if sig.type == "tool.completed"]
    assert len(completed) == 1
    assert completed[0].payload["result"]["is_error"] is False

    translator = RunTranslator("r-budget", PathLocator(primary_path_resolver(tmp_path)))
    updates = []
    for sig in [*start_signals, *completed]:
        res = translator.feed(
            {
                "event_id": f"e-{sig.type}",
                "type": sig.type,
                "thread_id": "t1",
                "run_id": "r-budget",
                "sequence": 1,
                "timestamp_ms": 0,
                "execution_id": "root-r-budget",
                "agent_id": "main",
                "payload": sig.payload,
            }
        )
        updates.extend(res.updates)
    assert updates[-1].status == "completed"
