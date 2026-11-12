"""工具采集保留业务返回、错误和完整输入输出。"""

import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage

from harness_agent.policy.approval_policy import emit_policy_decision
from harness_agent.tracing import TraceRecorder, use_trace


def _rows(root):
    return [json.loads(line) for path in root.glob("*.jsonl")
            for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.parametrize("capture", ["full", "meta", "off"])
def test_tool_capture_records_policy_and_result_without_changing_return(tmp_path, capture):
    from harness_agent.tracing.tool import TraceToolMiddleware

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path, capture=capture)
    args = {"command": "echo hello", "cwd": "/work", "env": {"TOKEN": "sk-fake"}}
    request = SimpleNamespace(tool_call={"name": "execute", "id": "c1", "args": args}, tool=None)
    result = ToolMessage(content="hello", tool_call_id="c1", artifact={"exit_code": 0})
    with use_trace(recorder.start_trace()):
        step = recorder.open_step()
        emit_policy_decision(tool="execute", tool_args=args, approval_mode="auto",
                             decision="allow", layer="L3", call_id="c1")
        assert TraceToolMiddleware().wrap_tool_call(request, lambda _: result) is result
        recorder.end_trace()
    rows = _rows(tmp_path)
    if capture == "off":
        assert rows == []
        return
    tool = next(row for row in rows if row.get("name") == "tool.call" and row["event"] == "span.end")
    policy = next(row for row in rows if row.get("name") == "policy.evaluate")
    attrs = tool["attributes"]
    assert tool["parent_span_id"] == policy["parent_span_id"] == step.span_id
    assert attrs["policy_span_id"] == policy["span_id"]
    assert attrs["exit_code"] == 0
    assert attrs["result_status"] == "success"
    assert attrs["step"] == 1
    assert "sk-fake" not in json.dumps(rows)
    payloads = {row["payload_id"]: row["body"] for row in rows if row["event"] == "payload"}
    if capture == "full":
        assert payloads[attrs["args_ref"]]["env"]["TOKEN"] == "[redacted]"
        assert payloads[attrs["result_ref"]]["content"] == "hello"
        assert payloads[attrs["command_ref"]] == "echo hello"
    else:
        assert payloads == {}
        assert not any(key.endswith("_ref") for key in attrs)


def test_tool_exception_is_preserved_and_span_closes(tmp_path):
    from harness_agent.tracing.tool import TraceToolMiddleware

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    error = ValueError("tool failed")
    def handler(_):
        raise error
    with use_trace(recorder.start_trace()):
        with pytest.raises(ValueError) as caught:
            TraceToolMiddleware().wrap_tool_call(
                SimpleNamespace(tool_call={"name": "read_file", "id": "c", "args": {}}), handler)
        assert caught.value is error
        recorder.end_trace()
    tool = next(row for row in _rows(tmp_path) if row.get("name") == "tool.call" and row["event"] == "span.end")
    assert tool["status"] == "FAILED"


def test_shell_capture_keeps_raw_backend_output_before_display_truncation(tmp_path):
    from deepagents.backends.protocol import ExecuteResponse
    from harness_agent.tracing.tool import TraceToolMiddleware
    from harness_agent.tracing.execution import TraceExecutionBackend

    response = ExecuteResponse(output="complete output", exit_code=7, truncated=False)
    backend = TraceExecutionBackend(SimpleNamespace(execute=lambda command: response), cwd="/workspace")
    def handler(_):
        assert backend.execute("command") is response
        return ToolMessage(content="short display", tool_call_id="c")
    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    with use_trace(recorder.start_trace()):
        TraceToolMiddleware().wrap_tool_call(SimpleNamespace(
            tool_call={"name": "execute", "id": "c", "args": {"command": "command"}}), handler)
        recorder.end_trace()
    rows = _rows(tmp_path)
    attrs = next(row["attributes"] for row in rows if row.get("name") == "tool.call" and row["event"] == "span.end")
    payload = next(row["body"] for row in rows if row.get("payload_id") == attrs["result_ref"])
    assert attrs["exit_code"] == 7
    assert attrs["cwd"] == "/workspace"
    assert payload["output"] == "complete output"
    assert attrs["truncated"] is False


def test_mcp_identity_comes_from_registered_tool_metadata(tmp_path):
    from harness_agent.tracing.tool import TraceToolMiddleware

    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path)
    tool = SimpleNamespace(metadata={"harness_tool_kind": "mcp", "harness_mcp_server_name": "server-a"})
    with use_trace(recorder.start_trace()):
        TraceToolMiddleware().wrap_tool_call(SimpleNamespace(
            tool=tool, tool_call={"name": "query", "id": "c", "args": {}}), lambda _: "result")
        recorder.end_trace()
    attrs = next(row["attributes"] for row in _rows(tmp_path) if row.get("name") == "tool.call" and row["event"] == "span.end")
    assert attrs["source"] == "mcp"
    assert attrs["server"] == "server-a"


@pytest.mark.parametrize("operation,added,removed", [("write", 2, 0), ("edit", 1, 1), ("delete", 0, 2)])
def test_file_mutation_trace_counts_actual_diff(tmp_path, operation, added, removed):
    from harness_agent.tools.file_mutation import FileMutationService, MutationMetadata
    from harness_agent.threads.text_backend import LocalTextMutationBackend
    from harness_agent.tracing.tool import TraceToolMiddleware

    backend = LocalTextMutationBackend(tmp_path)
    service = FileMutationService(backend)
    if operation != "write":
        (tmp_path / "target.txt").write_text("a\nb\n", encoding="utf-8")
    plan = service.prepare(
        metadata=MutationMetadata(operation, "/target.txt", "t", "c"),
        current=None if operation == "write" else backend.read_text_document("/target.txt"),
        proposed_content=None if operation == "delete" else "a\nc\n", fingerprint="fingerprint",
    )
    def handler(_):
        service.commit(plan)
        return ToolMessage(content="done", tool_call_id="c")
    recorder = TraceRecorder(session_id="t", run_id="r", log_dir=tmp_path / "trace")
    with use_trace(recorder.start_trace()):
        TraceToolMiddleware().wrap_tool_call(SimpleNamespace(tool_call={
            "name": operation + "_file", "id": "c", "args": {"file_path": "/target.txt"}}), handler)
        recorder.end_trace()
    attrs = next(row["attributes"] for row in _rows(tmp_path / "trace") if row.get("name") == "tool.call" and row["event"] == "span.end")
    assert attrs["diff_added"] == added
    assert attrs["diff_removed"] == removed
