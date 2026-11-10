"""整轮用量：准备压缩、两层 child、取消收拢及独立调用隔离。"""

import asyncio
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

from harness_agent.runtime.run_usage import RunUsage, current_run_usage
from tests.threads.test_run_usage_store import immediate, store


def test_preparation_has_root_usage_and_resets_after_failed_acceptance():
    from harness_agent.host.run_coordinator import StartRun, UserRunInput, ConnectionRef
    from tests.host.test_run_coordinator import _coordinator
    coordinator = _coordinator([])
    seen = []
    class StopPreparation(Exception):
        pass
    async def prepare(command, persistence):
        seen.append(current_run_usage.get())
        raise StopPreparation
    coordinator._preparation_provider = prepare
    with pytest.raises(StopPreparation):
        immediate(coordinator.start(StartRun("thread", "run", "build", UserRunInput("hello")), ConnectionRef("owner")))
    assert seen[0] is not None
    assert current_run_usage.get() is None


def test_preparation_usage_is_carried_into_accepted_run(monkeypatch):
    from harness_agent.host.run_coordinator import StartRun, UserRunInput, ConnectionRef, RunPreparation
    from tests.host.test_run_coordinator import _coordinator
    coordinator = _coordinator([])
    seen = []
    async def prepare(command, persistence):
        usage = current_run_usage.get()
        seen.append(usage)
        usage.start("prepare-summary")
        usage.finish("prepare-summary", {"input_tokens": 50, "output_tokens": 5})
        return RunPreparation()
    def create(coroutine, **kwargs):
        coroutine.close()
        return SimpleNamespace(done=lambda: False)
    coordinator._preparation_provider = prepare
    monkeypatch.setattr(asyncio, "create_task", create)
    immediate(coordinator.start(StartRun("thread", "run", "build", UserRunInput("hello")), ConnectionRef("owner")))
    assert coordinator._runs["thread"].usage_collector is seen[0]
    assert seen[0].snapshot()["input_tokens"] == 50
    assert current_run_usage.get() is None


def test_summary_model_counts_in_triggering_run_and_standalone_does_not_leak():
    from harness_agent.threads.context_compaction import ContextCompactor
    compactor = object.__new__(ContextCompactor)
    model = GenericFakeChatModel(messages=iter([AIMessage(content="summary", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}) for _ in range(2)]))
    class Model:
        async def ainvoke(self, messages, config=None):
            return model.invoke(messages, config=config)
    compactor._model = Model()
    compactor._provider_retry = None
    usage = RunUsage()
    token = current_run_usage.set(usage)
    try:
        immediate(compactor._invoke_summary([HumanMessage(content="history")]))
    finally:
        current_run_usage.reset(token)
    assert usage.snapshot() == dict(input_tokens=100, output_tokens=20, input_complete=True, output_complete=True)
    immediate(compactor._invoke_summary([HumanMessage(content="independent")]))
    assert usage.snapshot()["input_tokens"] == 100


def test_inline_child_and_managed_grandchild_share_root_without_parent_double_count(store):
    from dataclasses import replace
    from harness_agent.runtime.child_stream import stream_inline_child
    from harness_agent.runtime.execution_binding import ExecutionRef
    from harness_agent.runtime.managed_agent_executor import ManagedAgentExecutor
    from tests.runtime.test_child_stream import _context
    from tests.runtime.test_execution_stream import _FakeAgent
    from tests.runtime.test_managed_agent_executor import _FakeAgent as ManagedGraph, _Runtime, _Observer, _request
    from harness_agent.runtime.run_usage import model_usage_config
    from harness_agent.threads.context_compaction import ContextCompactor
    usage = RunUsage()
    token = current_run_usage.set(usage)
    try:
        chunk = AIMessageChunk(content="child", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120})
        parent = _context()
        child = ExecutionRef(thread_id=parent.thread_id, run_id=parent.run_id, execution_id="child", parent_execution_id="root")
        graph = ManagedGraph([[("messages", (AIMessageChunk(content="grandchild", usage_metadata={"input_tokens": 150, "output_tokens": 30, "total_tokens": 180}), {}))]])
        class NestedGraph(_FakeAgent):
            async def astream(self, stream_input, **kwargs):
                request = replace(_request(_Runtime(graph)), execution_ref="grandchild", parent_execution_ref="child")
                await ManagedAgentExecutor().execute(request, _Observer())
                async for event in super().astream(stream_input, **kwargs):
                    yield event
        main = GenericFakeChatModel(messages=iter([
            AIMessage(content="delegate", tool_calls=[{"name": "task", "args": {"task": "inspect"}, "id": "task-call"}], usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}),
            AIMessage(content="final", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}),
        ]))
        first = main.invoke([HumanMessage(content="question")], config=model_usage_config())
        child_result = immediate(stream_inline_child(graph=NestedGraph([("messages", (chunk, {}))]), parent=parent, child_ref=child, agent_id="general-purpose", task="task", cancelled=lambda: False))
        main.invoke([HumanMessage(content="question"), first, ToolMessage(content=str(child_result), tool_call_id="task-call")], config=model_usage_config())
        summary_model = GenericFakeChatModel(messages=iter([AIMessage(content="summary", usage_metadata={"input_tokens": 50, "output_tokens": 5, "total_tokens": 55})]))
        class SummaryModel:
            async def ainvoke(self, messages, config=None):
                return summary_model.invoke(messages, config=config)
        compactor = object.__new__(ContextCompactor)
        compactor._model, compactor._provider_retry = SummaryModel(), None
        immediate(compactor._invoke_summary([HumanMessage(content="history")]))
        snapshot = usage.freeze()
        assert snapshot == dict(input_tokens=500, output_tokens=95, input_complete=True, output_complete=True)
        persistence, _ = store
        immediate(persistence.save_run_summary("thread", "one", "completed", snapshot, 1234))
        restored = immediate(persistence.load_run_summaries("thread"))
        assert restored[0]["usage"] == snapshot
        assert len(restored) == 1
        from harness_agent.host.run_coordinator import RunCoordinator
        from harness_agent.tracing import TraceRecorder
        records = []
        recorder = TraceRecorder(session_id="thread", run_id="one", log_dir="unused", writer=SimpleNamespace(append=lambda session, record: records.append(record)))
        run = SimpleNamespace(trace_context=recorder.start_trace(), status="completed", completion=SimpleNamespace(usage=snapshot, duration_ms=1234, error=None))
        RunCoordinator._complete_trace(object(), run)
        assert records[-1]["attributes"]["usage"] == snapshot
    finally:
        current_run_usage.reset(token)


@pytest.mark.parametrize("signal", ["parent", "token", "timeout"])
def test_parent_cancel_drains_child_runner_before_return(monkeypatch, signal):
    from harness_agent.runtime.agent_delegation import AgentDelegator
    tasks = []
    usage = RunUsage()
    usage.start("parent")
    usage.finish("parent", {"input_tokens": 100, "output_tokens": 20})
    usage.start("child")
    class Task:
        cancelled = False
        drained = False
        def done(self):
            return self.cancelled
        def cancel(self):
            self.cancelled = True
    def create(coroutine, **kwargs):
        coroutine.close()
        task = Task()
        tasks.append(task)
        return task
    async def wait(*args, **kwargs):
        if signal == "parent":
            raise asyncio.CancelledError
        return ({tasks[1]} if signal == "token" else set()), set()
    async def gather(*pending, **kwargs):
        for task in pending:
            task.drained = True
            if task is tasks[0]:
                usage.finish("child", {"input_tokens": 50, "output_tokens": 10})
    async def nothing(*args):
        return {}
    monkeypatch.setattr(asyncio, "create_task", create)
    monkeypatch.setattr(asyncio, "wait", wait)
    monkeypatch.setattr(asyncio, "gather", gather)
    command = SimpleNamespace(cancellation_token=SimpleNamespace(cancelled=False, wait=nothing), target_agent_id="child")
    with pytest.raises(TimeoutError if signal == "timeout" else asyncio.CancelledError):
        immediate(AgentDelegator._run_with_cancellation(object(), nothing, command, 1))
    assert tasks[0].cancelled and tasks[0].drained
    assert tasks[1].cancelled and tasks[1].drained
    assert usage.freeze() == dict(input_tokens=150, output_tokens=30, input_complete=True, output_complete=True)
    usage.finish("late", {"input_tokens": 999, "output_tokens": 999})
    assert usage.snapshot()["input_tokens"] == 150


def test_summary_retry_missing_attempt_usage_remains_incomplete(monkeypatch):
    from harness_agent.threads.context_compaction import ContextCompactor
    failed = GenericFakeChatModel(messages=iter([]))
    success = GenericFakeChatModel(messages=iter([AIMessage(content="summary", usage_metadata={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120})]))
    class Model:
        calls = 0
        async def ainvoke(self, messages, config=None):
            self.calls += 1
            return (failed if self.calls == 1 else success).invoke(messages, config=config)
    class Retry:
        def should_retry(self, attempt, error):
            return attempt == 1
        def retry_delay_seconds(self, error, attempt):
            return 0
    async def sleep(delay):
        pass
    from harness_agent.threads import context_compaction
    from harness_agent.runtime.provider_retry import run_with_provider_retry
    monkeypatch.setattr(context_compaction, "run_with_provider_retry", lambda operation, policy: run_with_provider_retry(operation, policy, sleep=sleep))
    compactor = object.__new__(ContextCompactor)
    compactor._model, compactor._provider_retry = Model(), Retry()
    usage = RunUsage()
    token = current_run_usage.set(usage)
    try:
        immediate(compactor._invoke_summary([HumanMessage(content="history")]))
    finally:
        current_run_usage.reset(token)
    assert usage.snapshot() == dict(input_tokens=100, output_tokens=20, input_complete=False, output_complete=False)


@pytest.mark.asyncio
async def test_native_parent_cancel_awaits_child_final_usage():
    from harness_agent.runtime.agent_delegation import AgentDelegator
    from harness_agent.runtime.run_context import RunCancellationToken
    started, ended = asyncio.Event(), asyncio.Event()
    usage = RunUsage()
    async def runner(command):
        usage.start("child")
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            usage.finish("child", {"input_tokens": 50, "output_tokens": 10})
            ended.set()
    command = SimpleNamespace(cancellation_token=RunCancellationToken(), target_agent_id="child")
    task = asyncio.create_task(AgentDelegator._run_with_cancellation(object(), runner, command, 10))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert ended.is_set()
    assert usage.freeze() == dict(input_tokens=50, output_tokens=10, input_complete=True, output_complete=True)


@pytest.mark.parametrize("input_tokens", [None, 100])
def test_root_trace_keeps_unknown_usage_and_does_not_fabricate_cache_ratio(input_tokens):
    from harness_agent.host.run_coordinator import RunCoordinator
    from harness_agent.tracing import TraceRecorder
    usage = dict(input_tokens=input_tokens, output_tokens=None, input_complete=False, output_complete=False)
    records = []
    recorder = TraceRecorder(session_id="thread", run_id="one", log_dir="unused", writer=SimpleNamespace(append=lambda session, record: records.append(record)))
    run = SimpleNamespace(trace_context=recorder.start_trace(), status="failed", completion=SimpleNamespace(usage=usage, duration_ms=1234, error=None))
    RunCoordinator._complete_trace(object(), run)
    assert records[-1]["attributes"]["usage"] == usage
    assert records[-1]["attributes"]["cache_hit_ratio"] is None
