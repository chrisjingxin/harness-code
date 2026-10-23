"""真实图中返工修改文件、扩范围和检查后的权限交接；仅使用假模型。"""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host

from harness_agent.host.run_coordinator import StartRun, UserRunInput


class FileReworkModel(FusionModel):
    expanded: bool
    echo_scope: bool = False
    observations: Any

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        ctx = get_runtime().context
        self.calls.append((self.role, ctx.execution_id, ctx.checkpoint_thread_id))
        tool = next((m for m in reversed(messages) if isinstance(m, ToolMessage)), None)

        def call(name, arguments):
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": name,
                        "args": arguments,
                        "id": f"rework-{len(self.calls)}",
                        "type": "tool_call",
                    }
                ],
            )

        if self.role == "strong-test":
            if tool is None:
                answer = call(
                    "fusion_delegate",
                    {
                        "goal": "创建实现",
                        "brief": "创建 a.py",
                        "allowed_paths": ["a.py"],
                        "check_plan_ids": [],
                    },
                )
            elif tool.name == "fusion_delegate":
                self.observations.append(("delegate", json.loads(tool.content)))
                answer = call(
                    "fusion_rework",
                    {
                        "feedback": "把 one 改为 two"
                        + ("，另建 b.py" if self.expanded else ""),
                        "allowed_paths": ["b.py"]
                        if self.expanded
                        else ["a.py"]
                        if self.echo_scope
                        else [],
                        "reason": "补充配套文件" if self.expanded else "",
                    },
                )
            elif tool.name == "fusion_rework":
                result = json.loads(tool.content)
                self.observations.append(("rework", result))
                if result.get("ticket_id"):
                    answer = call(
                        "fusion_review_result",
                        {
                            "ticket_id": result["ticket_id"],
                            "decision": "accept",
                            "requirements": [
                                {
                                    "id": "r1",
                                    "satisfied": True,
                                    "evidence": ["file:a.py"],
                                }
                            ],
                            "test_review_reason": "",
                        },
                    )
                else:
                    answer = AIMessage(content="返工受阻。")
            else:
                answer = AIMessage(content="已完成。")
        else:
            seen = self.observations
            executions = [x[1] for x in seen if x[0] == "worker"]
            if ctx.execution_id not in executions:
                seen.append(("worker", ctx.execution_id))
                executions.append(ctx.execution_id)
            second = executions.index(ctx.execution_id) > 0
            latest_user = max(
                i for i, m in enumerate(messages) if getattr(m, "type", None) == "human"
            )
            recent = [
                m for m in messages[latest_user + 1 :] if isinstance(m, ToolMessage)
            ]
            if recent and recent[-1].status == "error":
                seen.append(("tool_error", recent[-1].name, recent[-1].content))
                answer = call(
                    "fusion_submit_result",
                    {
                        "status": "blocked",
                        "summary": "文件操作被拒",
                        "unresolved": [recent[-1].content],
                    },
                )
            elif not recent:
                answer = (
                    call("read_file", {"file_path": "/a.py"})
                    if second
                    else call("write_file", {"file_path": "/a.py", "content": "one"})
                )
            elif second and recent[-1].name == "read_file":
                content = json.loads(recent[-1].content)
                answer = call(
                    "edit_file",
                    {
                        "file_path": "/a.py",
                        "snapshot_id": content["snapshot_id"],
                        "old_string": "one",
                        "new_string": "two",
                    },
                )
            elif second and self.expanded and recent[-1].name == "edit_file":
                answer = call("write_file", {"file_path": "/b.py", "content": "extra"})
            else:
                answer = call(
                    "fusion_submit_result",
                    {"status": "completed", "summary": "文件已完成", "unresolved": []},
                )
        return ChatResult(generations=[ChatGeneration(message=answer)])


@pytest.mark.parametrize("approval_mode", ["default", "auto-edit", "auto", "yolo"])
@pytest.mark.parametrize(
    "expanded,checks,echo_scope",
    [
        (False, False, False),
        (False, False, True),
        (True, False, False),
        (True, True, False),
        (False, True, True),
    ],
)
async def test_rework_file_tools_receive_current_permissions(
    tmp_path, monkeypatch, expanded, checks, echo_scope, approval_mode
):
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    calls, observations = [], []

    def factory(settings, **kwargs):
        model = FileReworkModel(
            role=settings.name,
            calls=[],
            expanded=expanded,
            echo_scope=echo_scope,
            observations=observations,
        )
        model.calls, model.observations = calls, observations
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    host = await make_host(tmp_path, handles=("approval",))
    if checks:
        with (tmp_path / "trusted.toml").open("a") as config:
            config.write(
                'check_plan_ids=["unit"]\n[fusion.check_plans.unit]\ncommand="grep -qx two a.py"\ncwd="."\n'
            )
    frames = []
    approvals = []

    async def send(frame):
        frames.append(frame)
        if frame.get("method") == "interaction.approval":
            approvals.append(
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
                    "input": {"kind": "user", "message": "创建实现并按反馈修正"},
                    "fusion_profile_id": "duo",
                    "approval_mode": approval_mode,
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
        assert task.phase == "COMPLETED", (task.to_record(), observations)
        assert (tmp_path / "a.py").read_text() == "two"
        assert not [x for x in observations if x[0] == "tool_error"], observations
        if checks:
            first = next(x[1] for x in observations if x[0] == "delegate")
            assert first["verification"] == "unverified"
            assert first["checks"][0]["exit_code"] == 1
            assert task.data["verification"] == "verified"
        assert task.data["revision"] == (2 if expanded else 1)
        if expanded:
            assert (tmp_path / "b.py").read_text() == "extra"
    finally:
        await host.close()
        if approvals:
            await asyncio.gather(*approvals, return_exceptions=True)


@pytest.mark.parametrize("message", ["继续返工，把问题修好", "请修复 a.py 的边界问题"])
async def test_new_feedback_reaches_lead_without_replaying_saved_round(
    tmp_path, monkeypatch, message
):
    import harness_agent.extensions.providers.harness_gateway as gateway

    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    calls, observations = [], []

    def factory(settings, **kwargs):
        model = FileReworkModel(
            role=settings.name, calls=[], expanded=False, observations=[]
        )
        model.calls, model.observations = calls, observations
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    host = await make_host(tmp_path)
    frames = []

    async def send(frame):
        frames.append(frame)

    host.send = send
    try:
        persistence = await host._ensure_thread_persistence()
        prepared = await host._prepare_run(
            StartRun(
                "t", "seed", "build", UserRunInput("旧要求"), fusion_profile_id="duo"
            ),
            persistence,
        )
        runtime = host._fusion_runtime
        task = await runtime.store.get(prepared.fusion_binding.task_id)
        await runtime.store.update(
            task.task_id,
            task.version,
            phase="PAUSED",
            data={
                "reason": "resource_wait_paused",
                "pending_round": {
                    "order": {"allowed_paths": ["a.py"]},
                    "message": "旧反馈，不应先执行",
                },
            },
        )
        await runtime.store.release_run(
            task.task_id, prepared.fusion_binding.owner_id, "seed"
        )
        await prepared.snapshot_reservation.release()
        old_dispatch = AsyncMock(
            side_effect=AssertionError("尚未处理新反馈就恢复了旧派单")
        )
        monkeypatch.setattr(runtime.service, "continue_pending", old_dispatch)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start",
                "method": "run.start",
                "params": {
                    "thread_id": "t",
                    "run_id": "followup",
                    "mode": "build",
                    "input": {"kind": "user", "message": message},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        assert "error" not in next(f for f in frames if f.get("id") == "start")
        run = host._run_coordinator._runs["t"]
        await asyncio.wait_for(run.task, 30)
        old_dispatch.assert_not_awaited()
        assert calls and calls[0][0] == "strong-test"
        assert (await runtime.store.get(task.task_id)).phase == "COMPLETED"
        assert (tmp_path / "a.py").read_text() == "two"
    finally:
        await host.close()
