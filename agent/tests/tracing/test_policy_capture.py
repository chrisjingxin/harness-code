"""审批决定和等人等待写入同一份 v2 链路日志。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from harness_agent.host.run_coordinator import (
    ConnectionRef,
    RunCoordinator,
    RunPreparation,
    RunState,
    StartRun,
    UserRunInput,
)
from harness_agent.policy.approval_policy import evaluate_permission
from harness_agent.runtime.interactions import InteractionRequest, InteractionResult
from harness_agent.tracing import TraceRecorder, use_trace


def _events(root: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for path in root.glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _ends(events: list[dict[str, object]], name: str) -> list[dict[str, object]]:
    return [event for event in events if event.get("event") == "span.end" and event.get("name") == name]


def test_parent_preflight_records_allow_and_ask(tmp_path: Path) -> None:
    """父代理预检的放行和询问各留下一条决定，询问带层级和参数载荷。"""
    from harness_agent.runtime.agent import _make_approval_preflight

    preflight = _make_approval_preflight("default", None, lambda: [], str(tmp_path))
    assert preflight is not None
    recorder = TraceRecorder(session_id="thread", run_id="run", log_dir=tmp_path)
    context = recorder.start_trace()
    with use_trace(context):
        assert preflight(SimpleNamespace(tool_call={"name": "read_file", "id": "call-read", "args": {"file_path": "README.md"}})) is False
        assert preflight(SimpleNamespace(tool_call={"name": "write_file", "id": "call-write", "args": {"file_path": "a.py", "content": "x"}})) is True
    recorder.end_trace()

    ends = _ends(_events(tmp_path), "policy.evaluate")
    assert [event["attributes"]["decision"] for event in ends] == ["allow", "ask"]
    assert ends[0]["attributes"]["layer"] == "L3"
    assert ends[0]["attributes"]["tool"] == "read_file"
    ask = ends[1]["attributes"]
    assert ask["layer"]
    assert ask["call_id"] == "call-write"
    payload_id = ask["args_ref"]
    payloads = [event for event in _events(tmp_path) if event.get("event") == "payload"]
    body = next(event["body"] for event in payloads if event["payload_id"] == payload_id)
    assert body["file_path"] == "a.py"


def test_child_permission_records_the_same_fields(tmp_path: Path) -> None:
    """子代理审批流水线写出与父代理相同的决定字段。"""
    recorder = TraceRecorder(session_id="thread-child", run_id="run", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        assert evaluate_permission("read_file", {"file_path": "README.md"}, "default", call_id="call-read") == "allow"
        assert evaluate_permission("write_file", {"file_path": "a.py", "content": "x"}, "default", call_id="call-write") == "ask"
    recorder.end_trace()

    ends = _ends(_events(tmp_path), "policy.evaluate")
    assert [event["attributes"]["decision"] for event in ends] == ["allow", "ask"]
    assert ends[0]["attributes"]["layer"] == "L3"
    assert ends[1]["attributes"]["call_id"] == "call-write"
    assert ends[1]["attributes"]["args_ref"]


class _ApprovingPort:
    async def request(self, _owner: object, _ref: object, _spec: InteractionRequest) -> InteractionResult:
        return InteractionResult(value={"decision": "approve_once"})


async def test_serial_approval_wait_uses_run_trace(tmp_path: Path) -> None:
    """串行审批的等待写在这次 Run 的 trace 上，并带上等待时间和选择。"""

    async def no_persistence() -> None:
        return None

    async def no_preparation(_command: object, _persistence: object) -> None:
        return None

    async def no_runtime(_run: object) -> None:
        return None

    coordinator = RunCoordinator(
        persistence_provider=no_persistence,
        preparation_provider=no_preparation,  # type: ignore[arg-type]
        runtime_provider=no_runtime,  # type: ignore[arg-type]
        interaction_port=_ApprovingPort(),
    )
    recorder = TraceRecorder(session_id="thread-wait", run_id="run-wait", log_dir=tmp_path)
    context = recorder.start_trace()
    run = RunState(
        start=StartRun(
            mode="build",
            thread_id="thread-wait",
            run_id="run-wait",
            input=UserRunInput(message="改文件"),
        ),
        owner=ConnectionRef("owner"),
        persistence=None,
        preparation=RunPreparation(),
        trace_context=context,
    )
    await coordinator._collect_serial_approvals(
        run,
        InteractionRequest(
            request_id="req-1",
            type="approval",
            payload={"interrupt_id": "int-1", "description": "写文件", "requests": {}, "decisions": ["approve_once"]},
            interrupt_id="int-1",
            serial_context={
                "all_action_requests": [{"name": "write_file", "args": {"file_path": "a.py"}}],
                "safe_indices": [],
                "unsafe_indices": [0],
            },
        ),
    )
    recorder.end_trace()

    ends = _ends(_events(tmp_path), "interaction.wait")
    assert len(ends) == 1
    assert ends[0]["attributes"]["choice"] == "approve_once"
    assert ends[0]["attributes"]["wait_ms"] >= 0
    assert ends[0]["attributes"]["tool"] == "write_file"
    assert ends[0]["attributes"]["interaction_type"] == "approval"
