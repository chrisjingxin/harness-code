"""故障任务仍可只读核查，不能借提问改变停止事实或写权限。"""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host
from tests.host.test_fusion_streaming import Frames, start_fusion

from harness_agent.runtime.fusion.profile import resolve_fusion_profile
from harness_agent.runtime.fusion.store import FusionError


async def unknown_task(host, workspace, thread_id="t", foreign_run=False):
    host._load_config()
    profile = resolve_fusion_profile(host._config, "duo")
    store = (await host._ensure_thread_persistence()).fusion_state_store()
    task = await store.create(
        thread_id=thread_id,
        profile=profile.to_record(),
        workspace=workspace,
        source_message="修复原任务",
    )
    if foreign_run:
        task = await store.claim_run(task.task_id, task.version, "old-host", "old-run")
    task, lease = await store.start_round(
        task.task_id,
        task.version,
        {
            "revision": 1,
            "requirements": [{"id": "r1", "quote": "修复原任务"}],
            "allowed_paths": ["a.py"],
            "check_plan_ids": [],
        },
        "dispatch",
        "original",
    )
    task = await store.update(
        task.task_id, task.version, data={"worker_execution_id": "old-worker"}
    )
    await store.mark_delivery("dispatch", "dispatched")
    effect = await store.begin_effect(
        task.task_id, lease.generation, "old-worker", "execute", "digest"
    )
    await store.finish_effect(effect, succeeded=False, stopped=False)
    task = await store.pause(task.task_id)
    return store, task, lease


class InspectionModel(FusionModel):
    """只能读状态和文件；回复不需要任何完成、报告或派单工具。"""

    bound_names: list
    contexts: list

    def bind_tools(self, tools, **kwargs):
        self.bound_names[:] = [getattr(t, "name", None) or t.get("name") for t in tools]
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        ctx = get_runtime().context
        assert self.role == "strong-test", "核查不能启动 Sidekick"
        assert ctx.fusion_state.inspection_only
        self.contexts.append(ctx)
        self.calls.append(self.role)
        last = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)
        if last is None:
            message = AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "fusion_status",
                        "args": {},
                        "id": "status",
                        "type": "tool_call",
                    }
                ],
            )
        elif last.name == "fusion_status":
            result = json.loads(last.content)
            assert result["thread_id"] == ctx.thread_id
            assert result["diagnostics"]["inspection_only"] is True
            message = AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "read_file",
                        "args": {"file_path": "/a.py"},
                        "id": "read",
                        "type": "tool_call",
                    }
                ],
            )
        else:
            message = AIMessage(
                content="已只读检查。待查记录属于该任务，尚无进程停止凭据，不能说已检测到测试进程占用。"
            )
        return ChatResult(generations=[ChatGeneration(message=message)])


def install_inspection_model(monkeypatch):
    monkeypatch.setenv("TEST_FUSION_LEAD", "offline-lead")
    monkeypatch.setenv("TEST_FUSION_WORKER", "offline-worker")
    import harness_agent.extensions.providers.harness_gateway as gateway

    calls, names, contexts = [], [], []

    def factory(settings, **kwargs):
        model = InspectionModel(
            role=settings.name, calls=[], bound_names=[], contexts=[]
        )
        model.calls, model.bound_names, model.contexts = calls, names, contexts
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    return calls, names, contexts


@pytest.mark.parametrize("state", ["unknown", "workspace_busy", "changed_profile"])
@pytest.mark.parametrize(
    "message", ["你看下测试进程是否属于当前会话", "继续返工，把问题修好"]
)
async def test_blocked_task_answers_readonly_question_without_changing_task_or_owner(
    tmp_path, monkeypatch, state, message
):
    calls, names, contexts = install_inspection_model(monkeypatch)
    (tmp_path / "a.py").write_text("unchanged")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        store, task, lease = await unknown_task(
            host,
            tmp_path,
            thread_id="old" if state == "workspace_busy" else "t",
            foreign_run=True,
        )
        if state == "changed_profile":
            task = await store.update(
                task.task_id,
                task.version,
                data={
                    "profile": {
                        **task.data["profile"],
                        "config_fingerprint": "previous-config",
                    }
                },
            )
        owner = task
        if state == "workspace_busy":
            task = await store.create(
                thread_id="t",
                profile=task.data["profile"],
                workspace=tmp_path,
                source_message="新任务",
            )
            task = await store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={
                    "reason": "workspace_busy",
                    "workspace_blocker": await store.workspace_blocker(task.task_id),
                },
            )
        before_task, before_owner = task, await store.get(owner.task_id)
        before_effects = await store.effects(owner.task_id)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "inspect",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "inspection",
                    "mode": "build",
                    "fusion_profile_id": "duo",
                    "input": {
                        "kind": "user",
                        "message": message,
                    },
                },
            }
        )
        response = next(f for f in frames.items if f.get("id") == "inspect")
        assert "error" not in response, response
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 20)
        assert run.completion.status == "completed", run.completion
        assert (await store.get(task.task_id)) == before_task
        assert (await store.get(owner.task_id)) == before_owner
        assert (await store.effects(owner.task_id)) == before_effects
        assert (tmp_path / "a.py").read_text() == "unchanged"
        assert len(calls) == 3 and set(calls) == {"strong-test"}
        assert {"fusion_status", "read_file"} <= set(names)
        assert not {
            "execute",
            "write_file",
            "edit_file",
            "fusion_delegate",
            "fusion_rework",
            "fusion_review_result",
            "fusion_finish_direct",
        } & set(names)
        service = host._fusion_runtime.service
        for method, kwargs in [
            (service.finish_direct, {"summary": "已停止"}),
            (
                service.delegate,
                {
                    "goal": "改码",
                    "brief": "步骤",
                    "allowed_paths": ["a.py"],
                    "check_plan_ids": [],
                },
            ),
            (service.rework, {"feedback": "重跑", "allowed_paths": [], "reason": ""}),
            (
                service.review,
                {
                    "ticket_id": "ticket",
                    "decision": "accept",
                    "requirements": [],
                    "test_review_reason": "",
                },
            ),
        ]:
            with pytest.raises(FusionError, match="FUSION_ROLE_DENIED"):
                await method(contexts[-1], **kwargs)
        assert (await store.get(task.task_id)) == before_task
    finally:
        await host.close()


async def test_status_without_current_task_reports_real_workspace_owner(
    tmp_path, monkeypatch
):
    install_inspection_model(monkeypatch)
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        store, owner, _ = await unknown_task(host, tmp_path, thread_id="old")
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "status",
                "method": "fusion.status",
                "params": {"thread_id": "new"},
            }
        )
        response = next(f for f in frames.items if f.get("id") == "status")
        assert response["result"]["task"] is None
        blocker = response["result"]["workspace_blocker"]
        assert blocker["task_id"] == owner.task_id and blocker["thread_id"] == "old"
        assert blocker["requires_inspection"] is True
        assert (await store.get(owner.task_id)) == owner
    finally:
        await host.close()


@pytest.mark.parametrize("failure", ["cancel", "acceptance"])
async def test_inspection_cleanup_preserves_old_run_and_checkpoint(
    tmp_path, monkeypatch, failure
):
    from langchain_core.messages import AIMessageChunk
    from langchain_core.outputs import ChatGenerationChunk

    from harness_agent.threads.thread_persistence import ThreadPersistenceError

    install_inspection_model(monkeypatch)
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    entered, release = asyncio.Event(), asyncio.Event()
    deleted = []
    try:
        store, task, _ = await unknown_task(host, tmp_path, foreign_run=True)
        task = await store.update(
            task.task_id, task.version, data={"checkpoint_id": "old-worker-checkpoint"}
        )
        persistence = await host._ensure_thread_persistence()

        async def delete(key):
            deleted.append(key)

        monkeypatch.setattr(persistence, "delete_execution_checkpoint", delete)
        if failure == "acceptance":

            async def fail(*args, **kwargs):
                raise ThreadPersistenceError("TEST_ACCEPTANCE_FAILED")

            monkeypatch.setattr(persistence, "accept_run", fail)
        else:
            original = InspectionModel._astream

            async def gated(self, *args, **kwargs):
                if not entered.is_set():
                    yield ChatGenerationChunk(
                        message=AIMessageChunk(content="正在只读核查")
                    )
                    entered.set()
                    await release.wait()
                async for chunk in original(self, *args, **kwargs):
                    yield chunk

            monkeypatch.setattr(InspectionModel, "_astream", gated)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "inspection",
                    "mode": "build",
                    "fusion_profile_id": "duo",
                    "input": {"kind": "user", "message": "自己检查下"},
                },
            }
        )
        response = next(f for f in frames.items if f.get("id") == "start")
        if failure == "acceptance":
            assert "error" in response
        else:
            assert "error" not in response, response
            run = host._run_coordinator._runs["t"]
            await asyncio.wait_for(entered.wait(), 10)
            await host.dispatch(
                {
                    "jsonrpc": "2.0",
                    "id": "cancel",
                    "method": "run.cancel",
                    "params": {"thread_id": "t", "run_id": "inspection"},
                }
            )
            await asyncio.wait_for(run.task, 10)
        assert (await store.get(task.task_id)) == task
        assert deleted == []
        await host._fusion_runtime.close()
        assert (await store.get(task.task_id)) == task
    finally:
        release.set()
        await host.close()


async def test_inspection_stops_after_three_invalid_tool_requests(
    tmp_path, monkeypatch
):
    calls, _, _ = install_inspection_model(monkeypatch)

    def invalid(self, messages, *args, **kwargs):
        assert get_runtime().context.fusion_state.inspection_only, (
            self.role,
            get_runtime().context,
        )
        assert len(calls) < 3, "只读核查不应再次请求不存在的写工具"
        calls.append(self.role)
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "fusion_delegate",
                                "args": {},
                                "id": f"bad-{len(calls)}",
                                "type": "tool_call",
                            }
                        ],
                    )
                )
            ]
        )

    monkeypatch.setattr(InspectionModel, "_generate", invalid)
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        store, task, _ = await unknown_task(host, tmp_path, foreign_run=True)
        run = await start_fusion(host, frames)
        await asyncio.wait_for(run.task, 20)
        assert run.completion.status == "completed", run.completion
        assert len(calls) == 3
        assert (await store.get(task.task_id)) == task
        assert any(
            "只读核查" in e["payload"].get("text", "")
            for e in frames.events("content.delta")
        )
    finally:
        await host.close()


@pytest.mark.parametrize(
    "message,readonly,resume_pending",
    [
        ("检查谁占用了文件", True, False),
        ("看看代码", True, False),
        ("继续等待", False, True),
        ("继续", False, True),
        ("继续返工", False, True),
        ("继续返工，把问题修好", False, False),
        ("继续返工：\n1. 修复空输入。\n2. 补充测试。", False, False),
        ("请修复 a.py 的边界问题", False, False),
        ("为什么不能继续返工？", True, False),
        ("请不要继续返工", True, False),
        ("继续之前先检查谁占用文件", True, False),
        ("“继续返工”是什么意思", True, False),
    ],
)
async def test_paused_queue_questions_are_readonly_and_explicit_continue_resumes(
    tmp_path, monkeypatch, message, readonly, resume_pending
):
    from tests.host.test_fusion_run import make_host

    from harness_agent.host.run_coordinator import StartRun, UserRunInput

    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    host = await make_host(tmp_path)
    persistence = await host._ensure_thread_persistence()
    first = await host._prepare_run(
        StartRun(
            "t", "seed", "build", UserRunInput("创建 a.py"), fusion_profile_id="duo"
        ),
        persistence,
    )
    runtime = host._fusion_runtime
    store = runtime.store
    task = await store.get(first.fusion_binding.task_id)
    await store.update(
        task.task_id,
        task.version,
        phase="PAUSED",
        data={
            "reason": "resource_wait_paused",
            "pending_round": {
                "order": {"allowed_paths": ["a.py"]},
                "message": "原任务",
            },
        },
    )
    await store.release_run(task.task_id, first.fusion_binding.owner_id, "seed")
    await first.snapshot_reservation.release()
    prepared = None
    try:
        prepared = await host._prepare_run(
            StartRun(
                "t", "followup", "build", UserRunInput(message), fusion_profile_id="duo"
            ),
            persistence,
        )
        assert prepared.fusion_binding.inspection_only is readonly
        assert prepared.fusion_binding.resume_pending is resume_pending
    finally:
        if prepared is not None and prepared.on_abandon is not None:
            await prepared.on_abandon()
        if prepared is not None and prepared.snapshot_reservation is not None:
            await prepared.snapshot_reservation.release()
        await host.close()
