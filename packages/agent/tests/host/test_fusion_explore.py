"""真实 Host 链路验证探索独立身份、实时过程与角色用量。"""

import asyncio
import json
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host


class ExploreModel(FusionModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        tool = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)
        if self.role == "strong-test":
            name, args = (
                ("fusion_explore", {"question": "找到 a.py 的入口，给出路径依据"})
                if tool is None
                else ("fusion_finish_direct", {"summary": "已核实入口"})
            )
        elif tool is None:
            name, args = "read_file", {"file_path": "/a.py"}
        else:
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(content="入口位于 a.py，内容为 before。")
                    )
                ]
            )
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "id": f"explore-{len(messages)}",
                                "name": name,
                                "args": args,
                                "type": "tool_call",
                            }
                        ],
                    )
                )
            ]
        )

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        message = self._generate(messages, stop, None, **kwargs).generations[0].message
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content=message.content,
                tool_call_chunks=[
                    {
                        "name": call["name"],
                        "args": json.dumps(call["args"]),
                        "id": call["id"],
                        "index": i,
                    }
                    for i, call in enumerate(message.tool_calls)
                ],
                usage_metadata={
                    "input_tokens": 10,
                    "output_tokens": 2,
                    "total_tokens": 12,
                    "input_token_details": {"cache_read": 5},
                },
                chunk_position="last",
            )
        )


async def test_native_explore_has_visible_process_durable_usage_and_no_write_checkpoint(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setattr(
        gateway,
        "create_openai_compatible_model",
        lambda settings, **kwargs: ExploreModel(role=settings.name, calls=[]),
    )
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r",
                    "mode": "build",
                    "input": {"kind": "user", "message": "调查一下项目入口。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        assert "error" not in next(f for f in frames if f.get("id") == "start")
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        assert run.completion.status == "completed", run.completion
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "COMPLETED" and task.data.get("round", 0) == 0
        assert not task.data.get("checkpoint_id")
        assert (tmp_path / "a.py").read_text() == "before"
        assert task.to_record()["usage"]["lead"]["input_tokens"] == 20
        assert task.to_record()["usage"]["sidekick"]["input_tokens"] == 20
        assert task.to_record()["usage"]["sidekick"]["cache_hit_rate"] == 0.5
        events = [f["params"] for f in frames if f.get("method") == "event"]
        records = [e for e in events if e["type"] == "fusion.execution"]
        assert [e["payload"]["status"] for e in records] == ["running", "completed"]
        assert all(e["payload"]["kind"] == "exploration" for e in records)
        assert any(
            e["type"] == "content.delta" and e.get("agent_id") == "fusion-sidekick"
            for e in events
        )
        assert len(await store.list_records(task.task_id, "exploration")) == 1
    finally:
        await host.close()


class ExploreThenImplementModel(ExploreModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        ctx = get_runtime().context
        tool = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)
        if ctx.fusion_state.exploration_only or (
            self.role == "strong-test" and tool is None
        ):
            return super()._generate(messages, stop, run_manager, **kwargs)
        if self.role == "strong-test" and tool.name in {
            "fusion_explore",
            "fusion_delegate",
        }:
            if tool.name == "fusion_delegate":
                name, args = (
                    "fusion_explore",
                    {"question": "返工前再只读检查一次，保留已有任务单和票据"},
                )
            elif ctx.fusion_state.revision:
                name, args = (
                    "fusion_rework",
                    {
                        "feedback": "按调查结果再修正一次",
                        "allowed_paths": [],
                        "reason": "",
                    },
                )
            else:
                name, args = (
                    "fusion_delegate",
                    {
                        "goal": "修改实现",
                        "brief": "保持接口",
                        "allowed_paths": ["a.py"],
                        "check_plan_ids": [],
                    },
                )
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "id": "lead-" + name,
                                    "name": name,
                                    "args": args,
                                    "type": "tool_call",
                                }
                            ],
                        )
                    )
                ]
            )
        return FusionModel._generate(self, messages, stop, run_manager, **kwargs)


async def test_explore_does_not_poison_later_worker_checkpoint_or_rework(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setattr(
        gateway,
        "create_openai_compatible_model",
        lambda settings, **kwargs: ExploreThenImplementModel(
            role=settings.name, calls=[]
        ),
    )
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    with (tmp_path / "trusted.toml").open("a") as config:
        config.write("\n[runtime_pool]\nmax_profiles=2\n")
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r",
                    "mode": "build",
                    "input": {"kind": "user", "message": "先调查，再修改实现。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        assert run.completion.status == "completed", run.completion
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "COMPLETED" and task.data["round"] == 2
        assert host._config.agent_engine_pool.max_profiles == 2
        assert (tmp_path / "a.py").read_text() == "two"
        events = [
            f["params"]
            for f in frames
            if f.get("method") == "event"
            and f["params"]["type"] == "fusion.execution"
            and f["params"]["payload"]["status"] == "running"
        ]
        assert len(events) == 4 and events[0]["payload"]["kind"] == "exploration"
        assert [event["payload"]["round"] for event in events] == [0, 1, 1, 2]
        assert len({event["execution_id"] for event in events}) == 4
    finally:
        await host.close()


class CancelExploreModel(ExploreModel):
    gate: object = None

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        if get_runtime().context.fusion_state.exploration_only:
            self.gate.set()
            await asyncio.Event().wait()
        async for chunk in super()._astream(messages, stop, run_manager, **kwargs):
            yield chunk


async def test_cancel_exploration_releases_runtime_without_unknown_write_effects(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    gate = asyncio.Event()
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setattr(
        gateway,
        "create_openai_compatible_model",
        lambda settings, **kwargs: CancelExploreModel(
            role=settings.name, calls=[], gate=gate
        ),
    )
    host = await make_host(tmp_path)
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    host._owner_connection.enabled_capabilities.add("run.cancel")
    try:
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r",
                    "mode": "build",
                    "input": {"kind": "user", "message": "调查项目。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(gate.wait(), 10)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "cancel",
                "method": "run.cancel",
                "params": {"thread_id": "t", "run_id": "r"},
            }
        )
        await asyncio.wait_for(run.task, 10)
        assert run.completion.status == "cancelled"
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert (
            task.phase != "OUTCOME_UNKNOWN"
            and task.data["exploration"]["status"] == "cancelled"
        )
        assert not task.data.get("checkpoint_id") and not await store.effects(
            task.task_id
        )
        events = [
            f["params"]
            for f in frames
            if f.get("method") == "event" and f["params"]["type"] == "fusion.execution"
        ]
        assert [event["payload"]["status"] for event in events] == [
            "running",
            "cancelled",
        ]
    finally:
        await host.close()


async def test_exploration_uses_real_approval_in_default_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setattr(
        gateway,
        "create_openai_compatible_model",
        lambda settings, **kwargs: ExploreModel(role=settings.name, calls=[]),
    )
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path, handles=("approval",))
    approvals = []
    replies = []

    async def send(frame):
        if frame.get("method") == "interaction.approval":
            approvals.append(frame["params"])
            replies.append(
                asyncio.create_task(
                    host.dispatch(
                        {
                            "jsonrpc": "2.0",
                            "id": frame["id"],
                            "result": {"decision": "approve_once"},
                        }
                    )
                )
            )

    host.send = send
    try:
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r",
                    "mode": "build",
                    "input": {"kind": "user", "message": "调查一下项目入口。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "default",
                },
            }
        )
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 20)
        assert run.completion.status == "completed", run.completion
        assert any(
            "fusion_explore" in json.dumps(card, ensure_ascii=False)
            for card in approvals
        )
        assert (tmp_path / "a.py").read_text() == "before"
        if replies:
            await asyncio.gather(*replies)
    finally:
        await host.close()


async def test_exploration_pool_pressure_returns_actionable_tool_error(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    import harness_agent.extensions.providers.harness_gateway as gateway
    import harness_agent.host.fusion_worker as worker
    from harness_agent.runtime.agent_engine import AgentEnginePoolCapacityError

    monkeypatch.setattr(
        gateway,
        "create_openai_compatible_model",
        lambda settings, **kwargs: ExploreModel(role=settings.name, calls=[]),
    )

    async def unavailable(**kwargs):
        raise AgentEnginePoolCapacityError("RUNTIME_POOL_CAPACITY_EXHAUSTED")

    monkeypatch.setattr(worker, "acquire_pooled_agent_runtime", unavailable)
    host = await make_host(tmp_path)
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r",
                    "mode": "build",
                    "input": {"kind": "user", "message": "调查项目入口。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 20)
        assert run.completion.status == "completed", run.completion
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert not await store.effects(task.task_id) and task.data.get("round", 0) == 0
        events = [f["params"] for f in frames if f.get("method") == "event"]
        tool_ids = {
            event["payload"]["tool_call_id"]
            for event in events
            if event["type"] == "tool.started"
            and event["payload"].get("name") == "fusion_explore"
        }
        tool = [
            event["payload"]
            for event in events
            if event["type"] == "tool.completed"
            and event["payload"]["tool_call_id"] in tool_ids
        ]
        assert tool and any(
            "资源暂忙" in json.dumps(item, ensure_ascii=False) for item in tool
        )
    finally:
        await host.close()
