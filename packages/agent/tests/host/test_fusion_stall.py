"""真实 Host 中重复遭拒绝的 Sidekick 必须收敛，不能反复请求模型。"""

import asyncio
from collections import Counter

from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host
from tests.host.test_fusion_streaming import Frames, start_fusion


class RepeatedRejectedModel(FusionModel):
    """模型即使坚持重复后台命令，也须由程序在第 4 次请求前结束。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if self.role != "cheap-test":
            return super()._generate(messages, stop, run_manager, **kwargs)
        context = get_runtime().context
        self.calls.append(
            (self.role, context.execution_id, context.checkpoint_thread_id)
        )
        count = sum(role == "cheap-test" for role, _, _ in self.calls)
        if count > 3:
            raise AssertionError("Sidekick 已连续三次遭拒绝，仍发出第 4 次模型请求")
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "execute",
                                "args": {"command": "sleep 10 &"},
                                "id": f"rejected-{count}",
                                "type": "tool_call",
                            }
                        ],
                    )
                )
            ]
        )


async def test_repeated_rejection_stops_before_fourth_request_and_records_blocked(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "offline-lead")
    monkeypatch.setenv("TEST_FUSION_WORKER", "offline-worker")
    import harness_agent.extensions.providers.harness_gateway as gateway

    calls = []

    def factory(settings, **kwargs):
        model = RepeatedRejectedModel(
            role=settings.name, calls=[], stop_after_delegate=True
        )
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(run.task, 20)
        assert len([entry for entry in calls if entry[0] == "cheap-test"]) == 3
        assert run.completion.status == "completed"
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "WAITING_USER"
        assert task.active and task.data["report_id"]
        report = await store.load_record(task.task_id, "report", task.data["report_id"])
        assert report["status"] == "blocked" and report["unresolved"]
        assert "FUSION_COMMAND_INVALID" in report["summary"]
        assert not await store.effects(task.task_id)
        assert (tmp_path / "a.py").read_text() == "before"
    finally:
        await host.close()


async def test_real_bitwise_command_completes_two_rounds_without_post_report_calls(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "offline-lead")
    monkeypatch.setenv("TEST_FUSION_WORKER", "offline-worker")
    import harness_agent.extensions.providers.harness_gateway as gateway

    calls = []

    class BitwiseModel(FusionModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            result = super()._generate(messages, stop, run_manager, **kwargs)
            message = result.generations[0].message
            if (
                self.role == "cheap-test"
                and message.tool_calls
                and message.tool_calls[0]["name"] == "execute"
            ):
                message.tool_calls[0]["args"]["command"] = (
                    "python3 -c \"from pathlib import Path; Path('a.py').write_text(str(0xff & 0x0f))\""
                )
            return result

    def factory(settings, **kwargs):
        model = BitwiseModel(role=settings.name, calls=[])
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(run.task, 20)
        assert run.completion.status == "completed"
        assert (tmp_path / "a.py").read_text() == "15"
        worker_calls = [entry for entry in calls if entry[0] == "cheap-test"]
        assert sorted(Counter(entry[1] for entry in worker_calls).values()) == [2, 2]
        assert len({entry[2] for entry in worker_calls}) == 1
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        assert (
            await store.get(run.preparation.fusion_binding.task_id)
        ).phase == "COMPLETED"
    finally:
        await host.close()
