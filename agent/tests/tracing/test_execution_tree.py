"""HC-192：同级 Step 与根用量的可观察契约。"""

import json
from contextvars import copy_context
from pathlib import Path
from types import SimpleNamespace

from harness_agent.tracing import TraceRecorder, use_trace
from harness_agent.tracing.context import _bind_span, _reset_span


def _events(path: Path) -> list[dict[str, object]]:
    return [json.loads(line) for file in path.glob('*.jsonl')
            for line in file.read_text(encoding='utf-8').splitlines()]


def test_steps_are_siblings_and_root_aggregates_usage(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id='t', run_id='r', log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        first = recorder.open_step()
        token = _bind_span(first)
        llm = recorder.start_span('llm.call')
        recorder.end_span(llm, attributes={'usage': {'input_tokens': 10, 'cache_read_tokens': 4}})
        second = recorder.open_step()
        _reset_span(token)
        recorder.end_trace()
    rows = _events(tmp_path)
    assert second.parent_span_id == recorder.root_span_id
    assert rows[-1]['attributes']['usage']['input_tokens'] == 10
    assert rows[-1]['attributes']['cache_hit_ratio'] == 0.4


def test_child_step_keeps_tool_parent(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id='t', run_id='r', log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        tool = recorder.start_span('tool.call', kind='TOOL')
        token = _bind_span(tool)
        try:
            child = recorder.open_step()
            assert child.parent_span_id == tool.span_id
        finally:
            _reset_span(token)
            recorder.end_trace()


def test_interleaved_child_steps_do_not_close_parent_step(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        parent = recorder.open_step()
        parent_token = _bind_span(parent)
        tool = recorder.start_span("tool.call", kind="TOOL")
        child_context = copy_context()
        child_context.run(_bind_span, tool)
        first_child = child_context.run(recorder.open_step)
        child_context.run(_bind_span, first_child)
        second_child = child_context.run(recorder.open_step)
        child_context.run(_bind_span, second_child)
        child_context.run(recorder.close_step)
        ended = {row["span_id"] for row in _events(tmp_path) if row["event"] == "span.end"}
        assert parent.span_id not in ended
        assert first_child.span_id in ended
        assert second_child.span_id in ended
        assert second_child.parent_span_id == tool.span_id
        _reset_span(parent_token)
        recorder.end_trace()
    ended = [row["span_id"] for row in _events(tmp_path) if row["event"] == "span.end"]
    assert ended.count(parent.span_id) == 1


def test_root_close_finishes_all_remaining_branch_steps(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        parent = recorder.open_step()
        token = _bind_span(parent)
        tool = recorder.start_span("tool.call", kind="TOOL")
        child_context = copy_context()
        child_context.run(_bind_span, tool)
        child = child_context.run(recorder.open_step)
        assert not [row for row in _events(tmp_path) if row["event"] == "span.end"]
        _reset_span(token)
        recorder.end_trace()
    ended = [row["span_id"] for row in _events(tmp_path) if row["event"] == "span.end"]
    assert ended.count(parent.span_id) == ended.count(child.span_id) == 1


async def test_real_agent_graph_builds_step_tool_tree_without_bookkeeping_spans(tmp_path: Path) -> None:
    """真实 DeepAgents 图的两轮模型和工具必须落成同一棵 v2 执行树。"""
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from langgraph.checkpoint.memory import MemorySaver

    from harness_agent.runtime.agent import create_harness_agent
    from tests.runtime.test_agent import ToolCallingFakeChatModel

    call = AIMessage(
        content="",
        tool_calls=[{"name": "read_file", "args": {"file_path": "/README.md"}, "id": "read-1"}],
        usage_metadata={"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
    )
    answer = AIMessage(
        content="done",
        usage_metadata={"input_tokens": 20, "output_tokens": 3, "total_tokens": 23},
    )
    model = ToolCallingFakeChatModel(messages=iter([call, answer]))
    model.profile = {"max_input_tokens": 200000}
    (tmp_path / "README.md").write_text("trace integration", encoding="utf-8")
    agent = create_harness_agent(
        model,
        cwd=str(tmp_path),
        checkpointer=MemorySaver(),
        approval_mode="yolo",
        enable_skills=False,
        enable_memory=False,
        enable_ask_user=False,
    )
    recorder = TraceRecorder(session_id="thread-graph", run_id="run-graph", log_dir=tmp_path / "trace")
    with use_trace(recorder.start_trace()):
        result = await agent.ainvoke(
            {"messages": [HumanMessage(content="read README")]},
            config={"configurable": {"thread_id": "thread-graph"}},
        )
        recorder.end_trace()

    assert result["messages"][-1].content == "done"
    assert any(isinstance(message, ToolMessage) for message in result["messages"]), result["messages"]
    rows = _events(tmp_path / "trace")
    ends = [row for row in rows if row["event"] == "span.end"]
    steps = [row for row in ends if row["name"] == "step"]
    models = [row for row in ends if row["name"] == "llm.call"]
    tools = [row for row in ends if row["name"] == "tool.call"]
    assert len(steps) == len(models) == 2
    assert len(tools) == 1, [(message.type, message.content) for message in result["messages"]]
    assert tools[0]["parent_span_id"] == models[0]["parent_span_id"] == steps[0]["span_id"]
    assert models[1]["parent_span_id"] == steps[1]["span_id"]
    assert not {"run.complete", "runtime.acquire", "runtime.release", "run.execute", "agent.run"}.intersection(
        row["name"] for row in rows if "name" in row
    )
    root = next(row for row in rows if row["event"] == "trace.end")
    assert root["attributes"]["usage"]["input_tokens"] == 30


async def test_native_child_graph_step_is_nested_under_parent_tool(tmp_path: Path) -> None:
    """子图在原生异步 Task 中运行时仍显式继承父 tool.call 分支。"""
    from langchain_core.messages import AIMessage, HumanMessage
    from langgraph.checkpoint.memory import MemorySaver

    from harness_agent.runtime.agent import create_harness_agent
    from harness_agent.runtime.agent_delegation import AgentDelegator
    from harness_agent.runtime.run_context import RunCancellationToken
    from tests.runtime.test_agent import ToolCallingFakeChatModel

    model = ToolCallingFakeChatModel(messages=iter([AIMessage(content="child done")]))
    model.profile = {"max_input_tokens": 200000}
    child = create_harness_agent(
        model,
        cwd=str(tmp_path),
        checkpointer=MemorySaver(),
        approval_mode="yolo",
        enable_skills=False,
        enable_memory=False,
        enable_ask_user=False,
    )

    async def runner(_command: object) -> dict[str, object]:
        return await child.ainvoke(
            {"messages": [HumanMessage(content="child task")]},
            config={"configurable": {"thread_id": "child-thread"}},
        )

    recorder = TraceRecorder(session_id="thread-parent", run_id="run-parent", log_dir=tmp_path / "trace")
    with use_trace(recorder.start_trace()):
        recorder.open_step()
        tool = recorder.start_span("tool.call", kind="TOOL", attributes={"tool": "task", "source": "subagent"})
        token = _bind_span(tool)
        try:
            command = SimpleNamespace(
                cancellation_token=RunCancellationToken(),
                target_agent_id="general-purpose",
            )
            await AgentDelegator._run_with_cancellation(object(), runner, command, 10)
        finally:
            _reset_span(token)
            recorder.end_span(tool)
            recorder.end_trace()

    rows = _events(tmp_path / "trace")
    child_step = next(
        row
        for row in rows
        if row["event"] == "span.start"
        and row["name"] == "step"
        and row["parent_span_id"] == tool.span_id
    )
    child_model = next(row for row in rows if row["event"] == "span.end" and row["name"] == "llm.call")
    assert child_step["parent_span_id"] == tool.span_id
    assert child_model["parent_span_id"] == child_step["span_id"]

