"""实际 Host/Pool/LangGraph/工具/SQLite 链路，模型是可控替身。"""

import asyncio
import json
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_run import make_host


class FusionModel(BaseChatModel):
    role: str
    calls: list[Any]
    stop_after_delegate: bool = False

    @property
    def _llm_type(self):
        return "fusion-test"

    def bind_tools(self, tools, **kwargs):
        return self

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        message = (
            self._generate(messages, stop, run_manager, **kwargs).generations[0].message
        )
        chunk = AIMessageChunk(
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
        )
        if run_manager:
            run_manager.on_llm_new_token("", chunk=ChatGenerationChunk(message=chunk))
        yield ChatGenerationChunk(message=chunk)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        ctx = get_runtime().context
        self.calls.append((self.role, ctx.execution_id, ctx.checkpoint_thread_id))
        tool = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)

        def call(name, args):
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": name,
                        "args": args,
                        "id": f"call-{len(self.calls)}",
                        "type": "tool_call",
                    }
                ],
            )

        if self.role == "strong-test":
            if tool is None and ctx.fusion_state.revision:
                answer = call("fusion_status", {})
            elif tool is None:
                answer = call(
                    "fusion_delegate",
                    {
                        "goal": "修改实现",
                        "brief": "保持兼容，更新 a.py",
                        "allowed_paths": ["a.py"],
                        "check_plan_ids": [],
                    },
                )
            elif tool.name == "fusion_delegate" and self.stop_after_delegate:
                answer = AIMessage(content="等待继续审阅。")
            elif tool.name == "fusion_delegate":
                answer = call(
                    "fusion_rework",
                    {"feedback": "再修正一次", "allowed_paths": [], "reason": ""},
                )
            elif tool.name in {"fusion_rework", "fusion_status"}:
                result = json.loads(tool.content)
                if not result.get("ticket_id"):
                    return ChatResult(
                        generations=[
                            ChatGeneration(
                                message=AIMessage(content="需要核查子会话历史。")
                            )
                        ]
                    )
                answer = call(
                    "fusion_review_result",
                    {
                        "ticket_id": result["ticket_id"],
                        "decision": "accept",
                        "requirements": [
                            {"id": "r1", "satisfied": True, "evidence": ["file:a.py"]}
                        ],
                        "test_review_reason": "",
                    },
                )
            else:
                answer = AIMessage(content="已完成并审阅。")
        else:
            if tool is not None and tool.name == "execute":
                answer = call(
                    "fusion_submit_result",
                    {"status": "completed", "summary": "已修改实现", "unresolved": []},
                )
            elif tool is not None and tool.name == "fusion_submit_result":
                # 新一轮的人类输入位于上一报告之后；从位置而非模型对象计数区分返工。
                later = messages[messages.index(tool) + 1 :]
                if any(getattr(item, "type", "") == "human" for item in later):
                    answer = call(
                        "execute",
                        {
                            "command": "python3 -c \"from pathlib import Path; Path('a.py').write_text('two')\""
                        },
                    )
                else:
                    answer = AIMessage(content="本轮完成。")
            else:
                answer = call(
                    "execute",
                    {
                        "command": "python3 -c \"from pathlib import Path; Path('a.py').write_text('one')\""
                    },
                )
        return ChatResult(generations=[ChatGeneration(message=answer)])


class LeaseRetryModel(FusionModel):
    """即使模型总想重试，程序也必须在占用后结束本轮。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        ctx = get_runtime().context
        self.calls.append((self.role, ctx.execution_id, ctx.checkpoint_thread_id))
        if ctx.fusion_state.inspection_only:
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(
                            content="已只读核查，目录仍由原任务使用，停止情况未确认。"
                        )
                    )
                ]
            )
        latest = messages[-1]
        tool = latest if isinstance(latest, ToolMessage) else None
        args = {}
        if self.role == "strong-test":
            if tool and tool.name == "fusion_review_result":
                return ChatResult(
                    generations=[
                        ChatGeneration(message=AIMessage(content="已完成并审阅。"))
                    ]
                )
            result = (
                json.loads(tool.content)
                if tool and str(tool.content).startswith("{")
                else {}
            )
            if result.get("ticket_id"):
                name = "fusion_review_result"
                args = {
                    "ticket_id": result["ticket_id"],
                    "decision": "accept",
                    "requirements": [
                        {
                            "id": "r1",
                            "satisfied": True,
                            "evidence": ["file:created.py", "check:unit"],
                        }
                    ],
                    "test_review_reason": "",
                }
            else:
                name = "fusion_delegate"
                args = {
                    "goal": "新建文件",
                    "brief": "新建 created.py",
                    "allowed_paths": ["created.py"],
                    "check_plan_ids": [],
                }
        elif tool and tool.name == "fusion_submit_result":
            return ChatResult(
                generations=[ChatGeneration(message=AIMessage(content="本轮完成。"))]
            )
        elif tool and tool.name == "write_file":
            name = "fusion_submit_result"
            args = {"status": "completed", "summary": "已创建文件", "unresolved": []}
        else:
            name = "write_file"
            args = {"file_path": "/created.py", "content": "answer = 42\n"}
        answer = AIMessage(
            content="",
            tool_calls=[
                {
                    "name": name,
                    "args": args,
                    "id": f"lease-{len(self.calls)}",
                    "type": "tool_call",
                }
            ],
        )
        return ChatResult(generations=[ChatGeneration(message=answer)])


async def test_two_models_real_tools_same_worker_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    calls = []
    import harness_agent.extensions.providers.harness_gateway as gateway

    def model_factory(settings, **kwargs):
        model = FusionModel(role=settings.name, calls=[])
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", model_factory)
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
                    "input": {"kind": "user", "message": "保持兼容，修改实现。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        response = next(f for f in frames if f.get("id") == "start")
        assert "error" not in response, response
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        task = (
            await (await host._ensure_thread_persistence())
            .fusion_state_store()
            .get(run.preparation.fusion_binding.task_id)
        )
        assert task.phase == "COMPLETED", (task.to_record(), frames[-3:])
        assert run.completion.status == "completed", run.completion
        assert task.data["round"] == 2
        worker = [entry for entry in calls if entry[0] == "cheap-test"]
        assert len({entry[1] for entry in worker}) == 2
        assert len({entry[2] for entry in worker}) == 1
        assert {"strong-test", "cheap-test"} == {entry[0] for entry in calls}
        assert (tmp_path / "a.py").read_text() == "two"
        effects = (
            await (await host._ensure_thread_persistence())
            .fusion_state_store()
            .effects(task.task_id)
        )
        assert len(effects) == 2 and all(effect["stopped"] for effect in effects)
    finally:
        await host.close()


async def wait_frame(frames, predicate):
    async with asyncio.timeout(20):
        while True:
            found = next((frame for frame in frames if predicate(frame)), None)
            if found is not None:
                return found
            await asyncio.sleep(0.01)


def install_model(monkeypatch, *, stop_after_delegate=False):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    calls = []
    import harness_agent.extensions.providers.harness_gateway as gateway

    def factory(settings, **kwargs):
        model = FusionModel(
            role=settings.name, calls=[], stop_after_delegate=stop_after_delegate
        )
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    return calls


async def test_default_approval_delegate_worker_and_host_check_are_real_cards(
    tmp_path, monkeypatch
):
    calls = install_model(monkeypatch)
    host = await make_host(tmp_path, handles=("approval",))
    (tmp_path / "a.py").write_text("before")
    with (tmp_path / "trusted.toml").open("a") as config:
        command = "python3 -c \"from pathlib import Path; assert Path('a.py').read_text() in ('one', 'two')\""
        config.write(
            'check_plan_ids=["unit"]\n[fusion.check_plans.unit]\ncommand='
            + json.dumps(command)
            + '\ncwd="."\n'
        )
    frames = []
    approvals = []
    replies = []

    async def send(frame):
        frames.append(frame)
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
                    "input": {"kind": "user", "message": "保持兼容，修改实现。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "default",
                },
            }
        )
        response = next(frame for frame in frames if frame.get("id") == "start")
        assert "error" not in response, response
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        task = (
            await (await host._ensure_thread_persistence())
            .fusion_state_store()
            .get(run.preparation.fusion_binding.task_id)
        )
        assert task.phase == "COMPLETED", (task.to_record(), frames[-5:])
        assert task.data["verification"] == "verified"
        assert run.completion.status == "completed", run.completion
        names = []
        for approval in approvals:
            requests = approval["payload"]["requests"]
            for request in (
                requests if isinstance(requests, list) else requests["action_requests"]
            ):
                names.append(request["name"])
        worker_cards = [
            card for card in approvals if card.get("agent_id") == "fusion-sidekick"
        ]
        assert len(worker_cards) >= 2
        assert len({card["execution_id"] for card in worker_cards}) == 2
        assert "fusion_delegate" in names and "fusion_rework" in names
        assert names.count("execute") >= 4  # 两轮工具执行和两轮独立 Host 检查。
        assert (tmp_path / "a.py").read_text() == "two"
        assert len({entry[2] for entry in calls if entry[0] == "cheap-test"}) == 1
    finally:
        await asyncio.gather(*replies, return_exceptions=True)
        await host.close()


async def test_cancel_fusion_stops_current_run_waiting_for_approval(
    tmp_path, monkeypatch
):
    install_model(monkeypatch)
    host = await make_host(tmp_path, handles=("approval",))
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
                    "input": {"kind": "user", "message": "保持兼容，修改实现。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "default",
                },
            }
        )
        await wait_frame(
            frames, lambda frame: frame.get("method") == "interaction.approval"
        )
        run = host._run_coordinator._runs["t"]
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.active("t")
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "cancel",
                "method": "fusion.cancel",
                "params": {"task_id": task.task_id, "expected_version": task.version},
            }
        )
        response = next(frame for frame in frames if frame.get("id") == "cancel")
        assert "error" not in response, response
        assert response["result"]["phase"] == "CANCELLED"
        await asyncio.wait_for(run.task, 10)
        assert not (tmp_path / "a.py").exists()
        assert not await store.effects(task.task_id)
    finally:
        await host.close()


async def test_restart_restores_ticket_and_never_replays_completed_worker(
    tmp_path, monkeypatch
):
    calls = install_model(monkeypatch, stop_after_delegate=True)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    try:
        persistence = await host._ensure_thread_persistence()
        from harness_agent.host.run_coordinator import StartRun, UserRunInput

        prepared = await host._prepare_run(
            StartRun(
                "t",
                "r",
                "build",
                UserRunInput("保持兼容，修改实现。"),
                fusion_profile_id="duo",
            ),
            persistence,
        )
        task_id = prepared.fusion_binding.task_id
        await prepared.snapshot_reservation.release()
        from types import SimpleNamespace

        from harness_agent.runtime.run_context import FusionRunState

        context = SimpleNamespace(
            fusion_task_id=task_id,
            fusion_role="lead",
            fusion_state=FusionRunState(),
            thread_id="t",
            run_id="r",
            approval_mode="yolo",
            approval_state=None,
            approval_mode_provider=None,
            plan_constraint=None,
            execution_id="root",
            event_port=None,
        )

        async def worker(context, task, message):
            (tmp_path / "a.py").write_text("one")
            await host._fusion_runtime.service.submit_result(
                SimpleNamespace(**{**vars(context), "fusion_role": "sidekick"}),
                status="completed",
                summary="已修改",
                unresolved=[],
            )

        host._fusion_runtime.service.worker = worker
        result = await host._fusion_runtime.service.delegate(
            context,
            goal="修改实现",
            brief="保持兼容",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        task = await persistence.fusion_state_store().pause(task_id)
        ticket_id = result["ticket_id"]
    finally:
        await host.close()
    restarted = await make_host(tmp_path)
    try:
        from harness_agent.host.run_coordinator import StartRun, UserRunInput

        persistence = await restarted._ensure_thread_persistence()
        preparation = await restarted._prepare_run(
            StartRun(
                "t", "next", "build", UserRunInput("继续审阅"), fusion_profile_id="duo"
            ),
            persistence,
        )
        task = await persistence.fusion_state_store().get(task_id)
        assert task.phase == "REVIEWING" and task.data["ticket_id"] == ticket_id
        assert task.data["round"] == 1 and not calls
        await preparation.snapshot_reservation.release()
    finally:
        await restarted.close()


@pytest.mark.parametrize("corruption", ["missing", "identity", "unfinished"])
async def test_worker_checkpoint_loss_stops_rework_without_new_model_calls(
    tmp_path, monkeypatch, corruption
):
    """历史丢失后停止，不能静默创建空会话后再次改文件。"""
    calls = install_model(monkeypatch)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    persistence = await host._ensure_thread_persistence()
    runtime = await host._ensure_fusion_runtime(persistence)
    original_worker = runtime.service.worker
    removed = False

    async def worker(context, task, message):
        nonlocal removed
        await original_worker(context, task, message)
        if not removed:
            current = await runtime.store.get(task.task_id)
            if corruption == "missing":
                await persistence.delete_execution_checkpoint(
                    current.data["checkpoint_id"]
                )
            else:
                field = (
                    "checkpoint_id"
                    if corruption == "identity"
                    else "completed_checkpoint_id"
                )
                await runtime.store.update(
                    task.task_id, current.version, data={field: "changed-history"}
                )
            removed = True

    runtime.service.worker = worker
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
                    "input": {"kind": "user", "message": "保持兼容，修改实现。"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        assert "error" not in next(f for f in frames if f.get("id") == "start")
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        task = await runtime.store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "WAITING_USER", task.to_record()
        assert task.data["reason"] == "worker_checkpoint_invalid"
        assert len({call[1] for call in calls if call[0] == "cheap-test"}) == 1
        assert (tmp_path / "a.py").read_text() == "one"
        assert len(await runtime.store.effects(task.task_id)) == 1
        assert not task.data.get("ticket_id")
    finally:
        await host.close()


async def test_real_run_resumes_prepared_order_and_reviews_without_new_round(
    tmp_path, monkeypatch
):
    """恢复实际经过 Build Adapter、稳定 Worker 会话与 Lead 审阅。"""
    calls = install_model(monkeypatch)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    persistence = await host._ensure_thread_persistence()
    from harness_agent.host.run_coordinator import StartRun, UserRunInput
    from harness_agent.runtime.fusion.snapshot import capture_snapshot

    prepared = await host._prepare_run(
        StartRun(
            "t",
            "saved",
            "build",
            UserRunInput("保持兼容，修改实现。"),
            fusion_profile_id="duo",
        ),
        persistence,
    )
    store = persistence.fusion_state_store()
    task = await store.get(prepared.fusion_binding.task_id)
    order = {
        "revision": 1,
        "goal": "修改",
        "brief": "保持兼容",
        "source_message": task.data["source_message"],
        "requirements": [{"id": "r1", "quote": "保持兼容"}],
        "allowed_paths": ["a.py"],
        "check_plan_ids": [],
        "baseline": capture_snapshot(tmp_path, ["a.py"]),
    }
    await store.start_round(
        task.task_id,
        task.version,
        order,
        "saved-dispatch",
        "首次任务：保持兼容，修改 a.py",
    )
    await store.release_run(task.task_id, prepared.fusion_binding.owner_id, "saved")
    await prepared.snapshot_reservation.release()
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "resume",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "resumed",
                    "mode": "build",
                    "input": {"kind": "user", "message": "继续原任务"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        assert "error" not in next(
            frame for frame in frames if frame.get("id") == "resume"
        ), frames
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        current = await store.get(task.task_id)
        assert current.phase == "COMPLETED", (current.to_record(), frames[-3:])
        assert (
            current.data["round"] == 1
            and current.data["operation_id"] == "saved-dispatch"
        )
        assert len({item[1] for item in calls if item[0] == "cheap-test"}) == 1
        assert (tmp_path / "a.py").read_text() == "one"
    finally:
        await host.close()


async def test_busy_workspace_stops_model_retry_then_creates_and_verifies(
    tmp_path, monkeypatch
):
    """真实图、文件工具与检查：阻塞后没有第二次模型调用，解除后完整完成。"""
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    calls = []
    import harness_agent.extensions.providers.harness_gateway as gateway

    def factory(settings, **kwargs):
        model = LeaseRetryModel(role=settings.name, calls=[])
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    host = await make_host(tmp_path)
    with (tmp_path / "trusted.toml").open("a") as config:
        command = "python3 -B -c \"from pathlib import Path; assert Path('created.py').read_text() == 'answer = 42\\n'\""
        config.write(
            'check_plan_ids=["unit"]\n[fusion.check_plans.unit]\ncommand='
            + json.dumps(command)
            + '\ncwd="."\n'
        )
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        owner = await store.create(
            thread_id="older-thread",
            profile={"profile_id": "old"},
            workspace=tmp_path,
            source_message="旧任务",
        )
        lease = await store.acquire_lease(owner.task_id, "sidekick")
        owner = await store.update(
            owner.task_id,
            owner.version,
            phase="WORKER_RUNNING",
            data={"round": 4, "reason": "rework_limit"},
        )

        async def run(run_id):
            await host.dispatch(
                {
                    "jsonrpc": "2.0",
                    "id": run_id,
                    "method": "run.start",
                    "params": {
                        "thread_id": "t",
                        "run_id": run_id,
                        "mode": "build",
                        "input": {"kind": "user", "message": "新建 created.py"},
                        "fusion_profile_id": "duo",
                        "approval_mode": "yolo",
                    },
                }
            )
            response = next(frame for frame in frames if frame.get("id") == run_id)
            assert "error" not in response, response
            current = host._run_coordinator._runs["t"]
            await asyncio.wait_for(current.task, 30)
            return await store.get(current.preparation.fusion_binding.task_id)

        first = await run("blocked-run")
        assert (
            first.phase == "WAITING_USER" and first.data["reason"] == "workspace_busy"
        ), first.to_record()
        assert first.data["round"] == 0 and not (tmp_path / "created.py").exists()
        assert len(calls) == 1 and calls[0][0] == "strong-test", calls
        assert (
            await store.acquire_lease(owner.task_id, "sidekick")
        ).generation == lease.generation
        second = await run("still-blocked-run")
        assert second.task_id == first.task_id and second.phase == "WAITING_USER"
        assert len(calls) == 2 and calls[-1][0] == "strong-test", (
            "明确的新消息只进行 Lead 只读核查，不启动 Sidekick"
        )
        persistence = await host._ensure_thread_persistence()
        history = (await persistence.load_context("t")).messages
        assert isinstance(history[-1], AIMessage), (
            "本次等待说明应追加在本次用户消息之后"
        )
        await store.cancel(owner.task_id, owner.version)
        completed = await run("available-run")
        assert completed.task_id == first.task_id
        assert (
            completed.phase == "COMPLETED"
            and completed.data["verification"] == "verified"
        ), completed.to_record()
        assert (
            completed.data["round"] == 1
            and (tmp_path / "created.py").read_text() == "answer = 42\n"
        )
        assert any(call[0] == "cheap-test" for call in calls)
        text = "".join(
            frame.get("params", {}).get("payload", {}).get("text", "")
            for frame in frames
            if frame.get("method") == "event"
            and frame.get("params", {}).get("type") == "content.delta"
        )
        assert "占用" in text and "older-thread" in text
        assert "fusion_rework" not in text
    finally:
        await host.close()
