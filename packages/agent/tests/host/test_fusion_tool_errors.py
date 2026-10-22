"""真实文件工具的结构化错误应交还模型修正，不应使 Fusion 崩溃。"""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_inspection import unknown_task
from tests.host.test_fusion_run import make_host
from tests.host.test_fusion_streaming import Frames


class FileErrorModel(FusionModel):
    scenario: str

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        context = get_runtime().context
        assert context.fusion_role == "lead"
        self.calls.append(self.role)
        assert len(self.calls) <= 4, "文件错误不应导致无限模型循环"
        tool = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)
        if tool is None or self.scenario == "repeat":
            name, args = "ls", {"path": "/workspace"}
        elif tool.name == "ls" and tool.status == "error":
            assert isinstance(json.loads(tool.content)["error"], dict)
            name, args = "ls", {"path": "/"}
        elif tool.name == "ls" and self.scenario == "normal":
            name, args = "fusion_finish_direct", {"summary": "已读取当前项目目录"}
        else:
            return ChatResult(
                generations=[
                    ChatGeneration(message=AIMessage(content="已读取当前项目目录。"))
                ]
            )
        return ChatResult(
            generations=[
                ChatGeneration(
                    message=AIMessage(
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
                )
            ]
        )


@pytest.mark.parametrize("scenario", ["normal", "inspection", "repeat"])
async def test_real_ls_error_can_be_corrected_without_crashing_fusion(
    tmp_path, monkeypatch, scenario
):
    monkeypatch.setenv("TEST_FUSION_LEAD", "offline-lead")
    monkeypatch.setenv("TEST_FUSION_WORKER", "offline-worker")
    import harness_agent.extensions.providers.harness_gateway as gateway

    calls = []

    def factory(settings, **kwargs):
        model = FileErrorModel(role=settings.name, calls=[], scenario=scenario)
        model.calls = calls
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    (tmp_path / "a.py").write_text("unchanged")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        original = None
        if scenario != "normal":
            store, original, _ = await unknown_task(host, tmp_path, foreign_run=True)
            effects = await store.effects(original.task_id)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "files",
                    "mode": "build",
                    "fusion_profile_id": "duo",
                    "input": {"kind": "user", "message": "读取当前项目目录"},
                },
            }
        )
        response = next(f for f in frames.items if f.get("id") == "start")
        assert "error" not in response, response
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 20)
        assert run.completion.status == "completed", run.completion
        assert len(calls) == 3
        assert set(calls) == {"strong-test"}
        assert (tmp_path / "a.py").read_text() == "unchanged"
        if original:
            assert await store.get(original.task_id) == original
            assert await store.effects(original.task_id) == effects
        else:
            store = (await host._ensure_thread_persistence()).fusion_state_store()
            task = await store.active("t")
            assert task is None
    finally:
        await host.close()
