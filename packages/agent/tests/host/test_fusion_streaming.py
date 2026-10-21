"""双角色实时过程经过真实 Host、Pool 和 LangGraph 的离线回归。"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk
from langgraph.runtime import get_runtime
from tests.host.test_fusion_execution import FusionModel
from tests.host.test_fusion_run import make_host

pytestmark = pytest.mark.asyncio

_PREFIX = "Sidekick 正在整理结果，"
_SUFFIX = "本轮完成。"


class StreamGate:
    """首段已经交给图后暂停 provider，让测试先观察公开事件。"""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.execution_id: str | None = None


class StreamingFusionModel(FusionModel):
    """复用现有真实派单与返工脚本，只控制最后一条正文的输出节奏。"""

    gate: Any = None
    fail_after_prefix: bool = False
    lead_inputs: list[Any]

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        if self.role == "strong-test":
            self.lead_inputs.append([message.content for message in messages])
        message = self._generate(messages, stop, None, **kwargs).generations[0].message
        if self.role == "cheap-test" and any(
            call["name"] == "fusion_submit_result" for call in message.tool_calls
        ):
            # 报告保存后不会再请求模型。公开正文必须在报告的同一响应中
            # 测量，不能依赖以前那次多余的“本轮完成”请求。
            yield ChatGenerationChunk(message=AIMessageChunk(content=_PREFIX))
            gate = self.gate
            if gate is not None and not gate.entered.is_set():
                gate.execution_id = get_runtime().context.execution_id
                gate.entered.set()
                try:
                    await gate.release.wait()
                except asyncio.CancelledError:
                    gate.cancelled.set()
                    raise
            if self.fail_after_prefix:
                raise RuntimeError("FUSION_OFFLINE_STREAM_FAILURE")
            yield ChatGenerationChunk(message=AIMessageChunk(content=_SUFFIX))
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content=message.content,
                tool_call_chunks=[
                    {
                        "name": call["name"],
                        "args": json.dumps(call["args"]),
                        "id": call["id"],
                        "index": index,
                    }
                    for index, call in enumerate(message.tool_calls)
                ],
                chunk_position="last",
            )
        )


class Frames:
    """等待真实 JSON-RPC 输出；事件到达会唤醒断言，不靠固定 sleep。"""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.changed = asyncio.Event()

    async def send(self, frame) -> None:
        self.items.append(frame)
        self.changed.set()

    def events(self, kind: str | None = None):
        return [
            frame["params"]
            for frame in self.items
            if frame.get("method") == "event"
            and (kind is None or frame["params"]["type"] == kind)
        ]

    async def wait_event(self, kind: str, predicate=lambda event: True):
        async with asyncio.timeout(10):
            while True:
                self.changed.clear()
                found = next(
                    (event for event in self.events(kind) if predicate(event)), None
                )
                if found is not None:
                    return found
                await self.changed.wait()


def install_streaming_model(monkeypatch, *, gate=None, fail_after_prefix=False):
    monkeypatch.setenv("TEST_FUSION_LEAD", "fake-pro")
    monkeypatch.setenv("TEST_FUSION_WORKER", "fake-fast")
    calls, lead_inputs = [], []
    import harness_agent.extensions.providers.harness_gateway as gateway

    def factory(settings, **kwargs):
        model = StreamingFusionModel(
            role=settings.name,
            calls=[],
            lead_inputs=[],
            gate=gate,
            fail_after_prefix=fail_after_prefix,
        )
        model.calls = calls
        model.lead_inputs = lead_inputs
        return model

    monkeypatch.setattr(gateway, "create_openai_compatible_model", factory)
    return calls, lead_inputs


async def start_fusion(host, frames):
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
    response = next(frame for frame in frames.items if frame.get("id") == "start")
    assert "error" not in response, response
    return host._run_coordinator._runs["t"]


def worker_lifecycle(frames, execution_id):
    return [
        event
        for event in frames.events("fusion.execution")
        if event["execution_id"] == execution_id
    ]


def worker_text(frames, execution_id):
    return "".join(
        event["payload"]["text"]
        for event in frames.events("content.delta")
        if event.get("execution_id") == execution_id
    )


async def test_sidekick_text_arrives_before_finish_and_final_text_is_not_replayed(
    tmp_path, monkeypatch
):
    gate = StreamGate()
    _, lead_inputs = install_streaming_model(monkeypatch, gate=gate)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(gate.entered.wait(), 20)
        assert gate.execution_id is not None
        assert not gate.release.is_set() and not run.task.done()
        try:
            await frames.wait_event(
                "content.delta",
                lambda event: (
                    event.get("execution_id") == gate.execution_id
                    and _PREFIX in event["payload"]["text"]
                ),
            )
        except TimeoutError:
            pytest.fail("Sidekick 正文必须在模型 release 前进入公开事件流")
        assert worker_text(frames, gate.execution_id) == _PREFIX
        assert [
            event["payload"]["status"]
            for event in worker_lifecycle(frames, gate.execution_id)
        ] == ["running"]

        gate.release.set()
        await asyncio.wait_for(run.task, 30)
        await frames.wait_event("run.completed")
        assert worker_text(frames, gate.execution_id) == _PREFIX + _SUFFIX
        assert [
            event["payload"]["status"]
            for event in worker_lifecycle(frames, gate.execution_id)
        ] == ["running", "completed"]
        assert all(_PREFIX not in str(contents) for contents in lead_inputs)
        history = await (await host._ensure_thread_persistence()).load_context("t")
        assert all(_PREFIX not in str(message.content) for message in history.messages)
    finally:
        gate.release.set()
        await host.close()


async def test_sidekick_provider_failure_ends_child_and_parent_without_false_success(
    tmp_path, monkeypatch
):
    gate = StreamGate()
    install_streaming_model(monkeypatch, gate=gate, fail_after_prefix=True)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(gate.entered.wait(), 20)
        assert gate.execution_id is not None and not run.task.done()
        await frames.wait_event(
            "content.delta",
            lambda event: (
                event.get("execution_id") == gate.execution_id
                and _PREFIX in event["payload"]["text"]
            ),
        )
        assert worker_text(frames, gate.execution_id) == _PREFIX
        assert [
            event["payload"]["status"]
            for event in worker_lifecycle(frames, gate.execution_id)
        ] == ["running"]

        gate.release.set()
        await asyncio.wait_for(run.task, 30)
        assert [
            event["payload"]["status"]
            for event in worker_lifecycle(frames, gate.execution_id)
        ] == ["running", "failed"]
        assert worker_text(frames, gate.execution_id) == _PREFIX
        assert run.completion.status == "failed", run.completion
        await frames.wait_event("run.failed")
        assert not frames.events("run.completed")
        task = (
            await (await host._ensure_thread_persistence())
            .fusion_state_store()
            .get(run.preparation.fusion_binding.task_id)
        )
        assert task.phase in {"PAUSED", "OUTCOME_UNKNOWN"}, task.to_record()
        assert task.active
    finally:
        gate.release.set()
        await host.close()


async def test_rework_has_separate_execution_lifecycles_and_one_worker_session(
    tmp_path, monkeypatch
):
    calls, _ = install_streaming_model(monkeypatch)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(run.task, 30)
        await frames.wait_event("run.completed")
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        assert task.phase == "COMPLETED" and task.data["round"] == 2
        assert (tmp_path / "a.py").read_text() == "two"
        worker_calls = [call for call in calls if call[0] == "cheap-test"]
        execution_ids = list(dict.fromkeys(call[1] for call in worker_calls))
        assert len(execution_ids) == 2
        assert len({call[2] for call in worker_calls}) == 1

        lifecycles = frames.events("fusion.execution")
        assert {event["execution_id"] for event in lifecycles} == set(execution_ids)
        root = frames.events("run.started")[0]["execution_id"]
        events = frames.events()
        previous_end = -1
        for round_number, execution_id in enumerate(execution_ids, 1):
            lifecycle = worker_lifecycle(frames, execution_id)
            assert [event["payload"]["status"] for event in lifecycle] == [
                "running",
                "completed",
            ]
            for event, status in zip(lifecycle, ("running", "completed"), strict=True):
                assert event["thread_id"] == "t" and event["run_id"] == "r"
                assert event["agent_id"] == "fusion-sidekick"
                assert event["parent_execution_id"] == root
                assert event["payload"] == {
                    "task_id": task.task_id,
                    "role": "sidekick",
                    "round": round_number,
                    "model": "cheap-test",
                    "status": status,
                }
            start, end = (events.index(event) for event in lifecycle)
            process = [
                index
                for index, event in enumerate(events)
                if event.get("execution_id") == execution_id
                and event["type"]
                in {
                    "content.delta",
                    "reasoning.delta",
                    "tool.started",
                    "tool.delta",
                    "tool.completed",
                }
            ]
            assert process and previous_end < start < min(process) <= max(process) < end
            previous_end = end
            assert worker_text(frames, execution_id) == _PREFIX + _SUFFIX
    finally:
        await host.close()


async def test_cancelling_sidekick_stream_emits_cancelled_without_false_completion(
    tmp_path, monkeypatch
):
    gate = StreamGate()
    install_streaming_model(monkeypatch, gate=gate)
    (tmp_path / "a.py").write_text("before")
    host = await make_host(tmp_path)
    # 共享 make_host 只启用 Fusion 能力；此用例额外准备公开 Run 取消入口。
    host._owner_connection.enabled_capabilities.add("run.cancel")
    frames = Frames()
    host.send = frames.send
    try:
        run = await start_fusion(host, frames)
        await asyncio.wait_for(gate.entered.wait(), 20)
        assert gate.execution_id is not None and not run.task.done()
        store = (await host._ensure_thread_persistence()).fusion_state_store()
        task = await store.get(run.preparation.fusion_binding.task_id)
        await host.dispatch(
            {
                "jsonrpc": "2.0",
                "id": "cancel",
                "method": "run.cancel",
                "params": {"thread_id": "t", "run_id": "r"},
            }
        )
        response = next(frame for frame in frames.items if frame.get("id") == "cancel")
        assert response.get("result", {}).get("cancelled") is True, response
        await frames.wait_event("run.cancelled")
        assert gate.cancelled.is_set() and not gate.release.is_set()
        assert run.completion.status == "cancelled"
        assert (await store.get(task.task_id)).phase != "COMPLETED"
        assert not frames.events("run.completed")
        assert [
            event["payload"]["status"]
            for event in worker_lifecycle(frames, gate.execution_id)
        ] == ["running", "cancelled"]
        assert worker_text(frames, gate.execution_id) in {"", _PREFIX}
    finally:
        gate.release.set()
        await host.close()
