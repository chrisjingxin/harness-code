"""真实 Host 的同处取消、停止确认及中断续接。"""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from tests.host.test_fusion_run import make_host
from tests.host.test_fusion_streaming import (
    Frames,
    StreamGate,
    install_streaming_model,
    start_fusion,
)


@pytest.fixture(autouse=True)
def credentials(monkeypatch):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake-lead")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake-worker")


async def test_unknown_command_ends_both_roles_before_another_model_request(
    tmp_path, monkeypatch
):
    from harness_agent.runtime.fusion.guard import FusionEffectMiddleware

    original = FusionEffectMiddleware.awrap_tool_call

    async def timeout_result(request):
        return ToolMessage(
            content="Command timed out\n[Command failed with exit code 124]",
            tool_call_id=request.tool_call["id"],
            name="execute",
            status="error",
        )

    async def wrapped(self, request, handler):
        return await original(
            self,
            request,
            timeout_result if request.tool_call["name"] == "execute" else handler,
        )

    monkeypatch.setattr(FusionEffectMiddleware, "awrap_tool_call", wrapped)
    calls, _ = install_streaming_model(monkeypatch)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(run.task, 20)
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "OUTCOME_UNKNOWN" and task.data["report_id"] is None
        assert task.data["active_run"] is None
        assert [item["kind"] for item in task.data["pending_operations"]] == ["execute"]
        assert len([entry for entry in calls if entry[0] == "strong-test"]) == 1
        assert len([entry for entry in calls if entry[0] == "cheap-test"]) == 1
        assert (tmp_path / "a.py").read_text() == "before"
        assert (await store.effects(task.task_id))[0]["stopped"] == 0
        assert run.completion.status == "completed"
    finally:
        await host.close()


async def test_cancel_rpc_accepts_explicit_inspection_and_retains_files(tmp_path):
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        persistence = await host._ensure_thread_persistence()
        store = persistence.fusion_state_store()
        task = await store.create(
            thread_id="old",
            profile={"profile_id": "duo"},
            workspace=tmp_path,
            source_message="旧任务",
        )
        task, _ = await store.start_round(
            task.task_id,
            task.version,
            {"revision": 1, "allowed_paths": ["./"]},
            "pending",
            "message",
        )
        await store.mark_delivery("pending", "dispatched")
        task = await store.pause(task.task_id)
        (tmp_path / "user.txt").write_text("keep")
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "cancel",
                "method": "fusion.cancel",
                "params": {
                    "task_id": task.task_id,
                    "expected_version": task.version,
                    "stopped_inspection_note": "已核实所有旧命令和进程停止",
                },
            }
        )
        response = next(f for f in frames.items if f.get("id") == "cancel")
        assert "error" not in response, response
        assert response["result"]["phase"] == "CANCELLED"
        assert (tmp_path / "user.txt").read_text() == "keep"
    finally:
        await host.close()


@pytest.mark.parametrize("existing", [False, True])
async def test_acceptance_failure_returns_ownership_without_leaving_empty_task(
    tmp_path, monkeypatch, existing
):
    from harness_agent.threads.thread_persistence import ThreadPersistenceError

    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        persistence = await host._ensure_thread_persistence()
        store = persistence.fusion_state_store()
        if existing:
            host._load_config()
            from harness_agent.runtime.fusion.profile import resolve_fusion_profile

            profile = resolve_fusion_profile(host._config, "duo")
            await store.create(
                thread_id="t",
                profile=profile.to_record(),
                workspace=tmp_path,
                source_message="保留原任务",
            )

        async def fail(*args, **kwargs):
            raise ThreadPersistenceError("TEST_ACCEPTANCE_FAILED")

        monkeypatch.setattr(persistence, "accept_run", fail)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "fail",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r",
                    "mode": "build",
                    "fusion_profile_id": "duo",
                    "input": {"kind": "user", "message": "继续"},
                },
            }
        )
        response = next(f for f in frames.items if f.get("id") == "fail")
        assert "error" in response
        task = await store.latest("t")
        assert task.data["active_run"] is None
        assert task.phase == ("PAUSED" if existing else "CANCELLED")
        assert task.active is existing
        assert "t" not in host._run_coordinator._starting_runs
    finally:
        await host.close()


@pytest.mark.parametrize("interrupted_round", [1, 2])
@pytest.mark.parametrize("failure", ["cancel", "stream"])
async def test_interrupted_model_frees_directory_and_can_continue_same_task(
    tmp_path, monkeypatch, interrupted_round, failure
):
    from tests.host.test_fusion_streaming import StreamingFusionModel

    original = StreamingFusionModel._generate

    def resume_model(self, messages, stop=None, run_manager=None, **kwargs):
        tool = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)
        if (
            self.role == "strong-test"
            and tool
            and tool.name == "fusion_status"
            and not json.loads(tool.content).get("ticket_id")
        ):
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "fusion_rework",
                                    "args": {
                                        "feedback": "读取现有文件后完成原任务",
                                        "allowed_paths": [],
                                        "reason": "",
                                    },
                                    "id": "resume-rework",
                                    "type": "tool_call",
                                }
                            ],
                        )
                    )
                ]
            )
        return original(self, messages, stop, run_manager, **kwargs)

    monkeypatch.setattr(StreamingFusionModel, "_generate", resume_model)
    gate = StreamGate(target_report=interrupted_round)
    install_streaming_model(
        monkeypatch, gate=gate, fail_after_prefix=failure == "stream"
    )
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(gate.entered.wait(), 10)
        if failure == "cancel":
            await host.dispatch(
                {
                    "jsonrpc": "2.0",
                    "id": "stop",
                    "method": "run.cancel",
                    "params": {"thread_id": "t", "run_id": "r"},
                }
            )
        else:
            gate.release.set()
        await asyncio.wait_for(run.task, 10)
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "PAUSED", task.to_record()
        assert task.data["worker_checkpoint_interrupted"] is True
        if failure == "stream":
            assert (
                frames.events("run.failed")[-1]["payload"]["error"]["code"]
                == "PROVIDER_OUTPUT_INTERRUPTED"
            )
            original_stream = StreamingFusionModel._astream

            async def healthy_stream(self, *args, **kwargs):
                self.fail_after_prefix = False
                async for chunk in original_stream(self, *args, **kwargs):
                    yield chunk

            monkeypatch.setattr(StreamingFusionModel, "_astream", healthy_stream)
        assert (await store.load_delivery(task.task_id, task.data["operation_id"]))[
            "state"
        ] == "stopped"
        other = await store.create(
            thread_id="other",
            profile=task.data["profile"],
            workspace=tmp_path,
            source_message="新任务",
        )
        lease = await store.acquire_lease(other.task_id, "sidekick")
        await store.release_lease(other.task_id, lease.generation)
        gate.release.set()
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "continue",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "r2",
                    "mode": "build",
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                    "input": {"kind": "user", "message": "继续完成原任务"},
                },
            }
        )
        response = next(f for f in frames.items if f.get("id") == "continue")
        assert "error" not in response, response
        resumed = host._run_coordinator._runs["t"]
        await asyncio.wait_for(resumed.task, 20)
        task = await store.get(task.task_id)
        assert task.phase == "COMPLETED", task.to_record()
        assert (tmp_path / "a.py").read_text() == (
            "one" if interrupted_round == 1 else "two"
        )
    finally:
        gate.release.set()
        await host.close()


async def test_status_from_second_host_does_not_interrupt_live_sidekick(
    tmp_path, monkeypatch
):
    gate = StreamGate()
    install_streaming_model(monkeypatch, gate=gate)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    observer = await make_host(tmp_path)
    frames, other_frames = Frames(), Frames()
    host.send, observer.send = frames.send, other_frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(gate.entered.wait(), 10)
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        before = await store.get(run.preparation.fusion_binding.task_id)
        await observer.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "status",
                "method": "fusion.status",
                "params": {"thread_id": "t"},
            }
        )
        after = await store.get(before.task_id)
        assert after.phase == "WORKER_RUNNING" and after.version == before.version
        gate.release.set()
        await asyncio.wait_for(run.task, 20)
        assert (await store.get(before.task_id)).phase == "COMPLETED"
    finally:
        gate.release.set()
        await observer.close()
        await host.close()


@pytest.mark.parametrize(
    ("stage", "action"), [("lead", "start"), ("worker", "start"), ("lead", "cancel")]
)
async def test_second_host_preserves_run_ownership_and_cancellation(
    tmp_path, monkeypatch, stage, action
):
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk
    from tests.host.test_fusion_streaming import StreamingFusionModel

    gate = StreamGate()
    calls, _ = install_streaming_model(
        monkeypatch, gate=None if stage == "lead" else gate
    )
    if stage == "lead":
        original = StreamingFusionModel._astream

        async def gated(self, messages, stop=None, run_manager=None, **kwargs):
            if self.role == "strong-test" and not gate.entered.is_set():
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content="正在理解任务")
                )
                gate.entered.set()
                await gate.release.wait()
            async for chunk in original(self, messages, stop, run_manager, **kwargs):
                yield chunk

        monkeypatch.setattr(StreamingFusionModel, "_astream", gated)
    (tmp_path / "a.py").write_text("before")
    host, other = await make_host(tmp_path), await make_host(tmp_path)
    frames, other_frames = Frames(), Frames()
    host.send, other.send = frames.send, other_frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(gate.entered.wait(), 10)
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        before = await store.get(run.preparation.fusion_binding.task_id)
        if action == "cancel":
            await other.dispatch(
                {
                    "jsonrpc": "2.0",
                    "id": "cancel-other",
                    "method": "fusion.cancel",
                    "params": {
                        "task_id": before.task_id,
                        "expected_version": before.version,
                    },
                }
            )
            response = next(
                f for f in other_frames.items if f.get("id") == "cancel-other"
            )
            assert response["result"]["phase"] == "CANCELLED", response
            gate.release.set()
            await asyncio.wait_for(run.task, 20)
            assert (await store.get(before.task_id)).phase == "CANCELLED"
            assert len(calls) == 1 and calls[0][0] == "strong-test"
            return
        await other.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "duplicate",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "different-run",
                    "mode": "build",
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                    "input": {"kind": "user", "message": "继续"},
                },
            }
        )
        response = next(f for f in other_frames.items if f.get("id") == "duplicate")
        assert "error" in response
        after = await store.get(before.task_id)
        assert after.phase == before.phase and after.version == before.version
        gate.release.set()
        await asyncio.wait_for(run.task, 20)
        assert (await store.get(before.task_id)).phase == "COMPLETED"
    finally:
        gate.release.set()
        await other.close()
        await host.close()


async def test_ordinary_unknown_resource_has_status_and_current_dialogue_release(
    tmp_path,
):
    from harness_agent.runtime.fusion.resources import FusionResources
    from harness_agent.runtime.fusion.store import workspace_key

    host = await make_host(tmp_path)
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        resources = FusionResources(
            store.database_path, store.project, workspace_key(tmp_path)
        )
        async with resources.operation("command") as permit:
            permit.stopped = False
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "status",
                "method": "fusion.status",
                "params": {"thread_id": "t"},
            }
        )
        result = next(
            frame["result"] for frame in frames if frame.get("id") == "status"
        )
        assert result["task"] is None
        blocker = result["workspace_blocker"]
        assert (
            blocker["operation_id"] == permit.request_id
            and blocker["requires_inspection"]
        )
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "release",
                "method": "fusion.release",
                "params": {
                    "operation_id": blocker["operation_id"],
                    "expected_sequence": blocker["sequence"],
                    "stopped_inspection_note": "已确认相关命令全部停止",
                },
            }
        )
        assert next(frame for frame in frames if frame.get("id") == "release")[
            "result"
        ] == {"released": True}
        async with resources.operation("command"):
            pass
    finally:
        await host.close()
