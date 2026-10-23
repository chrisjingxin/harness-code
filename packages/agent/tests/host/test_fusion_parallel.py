"""两个真实 Host 共享 SQLite 与目录，使用可控模型验证不同文件并行。"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host


class ConcurrentModel(FusionModel):
    rendezvous: Any
    entries: Any

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        ctx = get_runtime().context
        thread = ctx.thread_id
        filename = thread + ".py"
        tool = next(
            (item for item in reversed(messages) if isinstance(item, ToolMessage)), None
        )

        def call(name, args):
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": name,
                        "args": args,
                        "id": name + "-" + thread + "-" + str(len(messages)),
                        "type": "tool_call",
                    }
                ],
            )

        if self.role == "strong-test":
            if tool is None:
                answer = call(
                    "fusion_delegate",
                    {
                        "goal": "创建文件",
                        "brief": "创建 " + filename,
                        "allowed_paths": [filename],
                        "check_plan_ids": ["unit"],
                    },
                )
            else:
                result = json.loads(tool.content)
                if result.get("phase") == "COMPLETED":
                    answer = AIMessage(content="已检查并完成。")
                else:
                    assert result.get("ticket_id"), result
                    answer = call(
                        "fusion_review_result",
                        {
                            "ticket_id": result["ticket_id"],
                            "decision": "accept",
                            "requirements": [
                                {
                                    "id": "r1",
                                    "satisfied": True,
                                    "evidence": ["file:" + filename, "check:unit"],
                                }
                            ],
                            "test_review_reason": "",
                        },
                    )
        elif tool is None:
            self.entries.append(thread)
            # 如果仍有整目录单写者，第二个 Sidekick 到不了这里，测试会直接失败。
            self.rendezvous.wait(timeout=10)
            answer = call(
                "write_file", {"file_path": "/" + filename, "content": "answer = 42\n"}
            )
        else:
            assert json.loads(tool.content).get("ok") is True, tool.content
            answer = call(
                "fusion_submit_result",
                {
                    "status": "completed",
                    "summary": "已创建 " + filename,
                    "unresolved": [],
                },
            )
        return ChatResult(generations=[ChatGeneration(message=answer)])


async def test_two_hosts_run_sidekicks_for_disjoint_files_simultaneously(
    tmp_path, monkeypatch
):
    import harness_agent.extensions.providers.harness_gateway as gateway
    from harness_agent.host.agent_host import AgentHost

    monkeypatch.setenv("TEST_FUSION_LEAD", "fake")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake")
    barrier = threading.Barrier(2)
    entries = []
    monkeypatch.setattr(
        gateway,
        "create_openai_compatible_model",
        lambda settings, **kwargs: ConcurrentModel(
            role=settings.name, calls=[], rendezvous=barrier, entries=entries
        ),
    )
    first = await make_host(tmp_path)
    with (tmp_path / "trusted.toml").open("a") as config:
        config.write(
            'check_plan_ids=["unit"]\n[fusion.check_plans.unit]\ncommand="true"\ncwd="."\n'
        )
    second = AgentHost(
        allow_echo=False,
        config_path=str(tmp_path / "trusted.toml"),
        config_home=tmp_path.parent / (tmp_path.name + "-home"),
        workspace=tmp_path,
    )
    frames = [[], []]

    async def send_first(frame):
        frames[0].append(frame)

    async def send_second(frame):
        frames[1].append(frame)

    first.send = send_first
    second.send = send_second
    await second.dispatch(
        {
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {
                "protocol": {"major": 3, "min_minor": 0, "max_minor": 11},
                "client": {"name": "test", "version": "1", "kind": "test"},
                "capabilities": {
                    "requests": ["fusion.read", "fusion.manage"],
                    "handles": [],
                },
            },
        }
    )

    async def start(host, thread):
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "start-" + thread,
                "method": "run.start",
                "params": {
                    "thread_id": thread,
                    "run_id": "run-" + thread,
                    "mode": "build",
                    "input": {"kind": "user", "message": "创建 " + thread + ".py"},
                    "fusion_profile_id": "duo",
                    "approval_mode": "yolo",
                },
            }
        )
        return host._run_coordinator._runs[thread]

    try:
        a, b = await asyncio.gather(start(first, "a"), start(second, "b"))
        await asyncio.wait_for(asyncio.gather(a.task, b.task), 30)
        store = (await first._ensure_thread_persistence()).fusion_state_store()
        for run in (a, b):
            task = await store.get(run.preparation.fusion_binding.task_id)
            assert (
                task.phase == "COMPLETED" and task.data["verification"] == "verified"
            ), (
                json.dumps(task.to_record(), ensure_ascii=False),
                [
                    [
                        f.get("params", {})
                        for f in side
                        if f.get("params", {}).get("type")
                        in {
                            "run.failed",
                            "run.completed",
                            "tool.result",
                            "execution.failed",
                        }
                    ]
                    for side in frames
                ],
            )
            assert task.data["round"] == 1
        assert sorted(entries) == ["a", "b"]
        assert (
            (tmp_path / "a.py").read_text()
            == (tmp_path / "b.py").read_text()
            == "answer = 42\n"
        )
        assert await store.workspace_owner(tmp_path) is None
    finally:
        await second.close()
        await first.close()
