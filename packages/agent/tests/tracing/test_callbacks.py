"""LangChain/LangGraph 图内 Span 的统一关联、安全字段与终态测试。"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.documents import Document
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from harness_agent.tracing import TraceRecorder


def _events(root: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for path in root.glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


def _spans(events: list[dict[str, object]], name: str) -> list[dict[str, object]]:
    return [event for event in events if event.get("name") == name]


def _recorder(tmp_path: Path, name: str = "callbacks") -> TraceRecorder:
    recorder = TraceRecorder(session_id=f"thread-{name}", run_id=f"run-{name}", log_dir=tmp_path)
    recorder.start_trace()
    return recorder


async def test_llm_and_node_share_external_ids_usage_ttft_and_no_content(tmp_path: Path) -> None:
    recorder = _recorder(tmp_path, "llm")
    node_id = uuid4()
    llm_id = uuid4()
    await recorder.on_chain_start(
        {"name": "build_graph"},
        {"secret_input": "不得落盘"},
        run_id=node_id,
        metadata={"langgraph_node": "build"},
    )
    await recorder.on_chat_model_start(
        {},
        [[AIMessage(content="秘密 prompt")]],
        run_id=llm_id,
        parent_run_id=node_id,
        metadata={"model": "mock-chat"},
    )
    await recorder.on_llm_new_token("秘密 token", run_id=llm_id, parent_run_id=node_id)
    await recorder.on_llm_new_token("第二个 token", run_id=llm_id, parent_run_id=node_id)
    response = LLMResult(
        generations=[
            [
                ChatGeneration(
                    message=AIMessage(
                        content="秘密 response",
                        usage_metadata={"input_tokens": 11, "output_tokens": 7, "total_tokens": 18},
                        tool_calls=[{"name": "read_file", "args": {"path": "secret"}, "id": "call-1"}],
                        response_metadata={"finish_reason": "tool_calls"},
                    )
                )
            ]
        ]
    )
    await recorder.on_llm_end(response, run_id=llm_id, parent_run_id=node_id)
    await recorder.on_chain_end({"secret_output": "不得落盘"}, run_id=node_id)

    events = _events(tmp_path)
    node_events = _spans(events, "graph.node")
    llm_events = _spans(events, "graph.llm")
    assert len(node_events) == len(llm_events) == 2
    assert {event["kind"] for event in node_events} == {"NODE"}
    assert {event["kind"] for event in llm_events} == {"LLM"}
    assert all(event["span_id"] == node_id.hex for event in node_events)
    assert all(event["span_id"] == llm_id.hex for event in llm_events)
    assert all(event["parent_span_id"] == node_id.hex for event in llm_events)
    llm_start, llm_end = llm_events
    assert llm_start["attributes"] == {"model": "mock-chat", "message_count": 1}
    assert llm_end["attributes"]["token_usage"] == {
        "input_tokens": 11,
        "output_tokens": 7,
        "total_tokens": 18,
    }
    assert llm_end["attributes"]["finish_reason"] == "tool_calls"
    assert llm_end["attributes"]["tool_calls"] == 1
    assert llm_end["attributes"]["first_token_latency_ms"] >= 0
    serialized = json.dumps(events, ensure_ascii=False)
    assert "秘密" not in serialized
    assert "secret_input" not in serialized
    assert "secret_output" not in serialized
    assert len([event for event in events if event["event"] == "span.end"]) == 2


async def test_legacy_llm_usage_and_agent_chain_kind(tmp_path: Path) -> None:
    recorder = _recorder(tmp_path, "legacy")
    agent_id = uuid4()
    llm_id = uuid4()
    await recorder.on_chain_start(
        {},
        {},
        run_id=agent_id,
        metadata={"chain_type": "deepagents_agent"},
    )
    await recorder.on_llm_start(
        {},
        ["prompt one", "prompt two"],
        run_id=llm_id,
        parent_run_id=agent_id,
        metadata={"model_name": "mock-completion"},
    )
    await recorder.on_llm_end(
        LLMResult(generations=[], llm_output={"token_usage": {"total_tokens": 3}}),
        run_id=llm_id,
    )
    await recorder.on_chain_end({}, run_id=agent_id)

    events = _events(tmp_path)
    assert {event["kind"] for event in _spans(events, "agent.run")} == {"AGENT"}
    llm_start, llm_end = _spans(events, "graph.llm")
    assert llm_start["attributes"] == {"model": "mock-completion", "message_count": 2}
    assert llm_end["attributes"]["token_usage"] == {"total_tokens": 3}


async def test_tool_span_has_safe_keys_status_and_exactly_one_end(tmp_path: Path) -> None:
    recorder = _recorder(tmp_path, "tool")
    tool_id = uuid4()
    await recorder.on_tool_start(
        {"name": "write_file"},
        "秘密工具参数字符串",
        run_id=tool_id,
        metadata={"tool_call_id": "call-safe"},
        inputs={"path": "秘密路径", "content": "秘密正文"},
    )
    output = ToolMessage(content="秘密工具结果", tool_call_id="call-safe", status="error")
    await recorder.on_tool_end(output, run_id=tool_id)
    await recorder.on_tool_end(output, run_id=tool_id)

    events = _spans(_events(tmp_path), "tool.call")
    assert len(events) == 2
    start, end = events
    assert all(event["span_id"] == tool_id.hex for event in events)
    assert start["attributes"] == {
        "tool": "write_file",
        "call_id": "call-safe",
        "input_keys": ["path", "content"],
    }
    assert end["attributes"] == {"result_status": "error", "tool_call_id": "call-safe"}
    assert end["status"] == "FAILED"
    serialized = json.dumps(events, ensure_ascii=False)
    assert "秘密" not in serialized


async def test_retriever_records_only_query_length_and_document_count(tmp_path: Path) -> None:
    recorder = _recorder(tmp_path, "retriever")
    run_id = uuid4()
    await recorder.on_retriever_start({}, "秘密检索词", run_id=run_id)
    await recorder.on_retriever_end(
        [Document(page_content="秘密文档一"), Document(page_content="秘密文档二")],
        run_id=run_id,
    )

    events = _spans(_events(tmp_path), "graph.retriever")
    assert events[0]["attributes"] == {"query_length": 5}
    assert events[1]["attributes"] == {"document_count": 2}
    assert {event["kind"] for event in events} == {"RETRIEVER"}
    assert "秘密" not in json.dumps(events, ensure_ascii=False)


@pytest.mark.parametrize("category", ["llm", "chain", "tool", "retriever"])
async def test_error_callback_closes_once_and_does_not_raise(
    tmp_path: Path, category: str
) -> None:
    recorder = _recorder(tmp_path, f"error-{category}")
    run_id = uuid4()
    error = RuntimeError(f"{category} 原始错误")
    if category == "llm":
        await recorder.on_llm_start({}, ["secret"], run_id=run_id)
        error_callback = recorder.on_llm_error
    elif category == "chain":
        await recorder.on_chain_start({}, {}, run_id=run_id)
        error_callback = recorder.on_chain_error
    elif category == "tool":
        await recorder.on_tool_start({}, "secret", run_id=run_id)
        error_callback = recorder.on_tool_error
    else:
        await recorder.on_retriever_start({}, "secret", run_id=run_id)
        error_callback = recorder.on_retriever_error
    await error_callback(error, run_id=run_id)
    await error_callback(error, run_id=run_id)

    ends = [event for event in _events(tmp_path) if event["event"] == "span.end"]
    assert len(ends) == 1
    assert ends[0]["status"] == "FAILED"
    assert ends[0]["error_type"] == "RuntimeError"
    assert ends[0]["status_message"] == f"{category} 原始错误"


async def test_orphan_and_late_callbacks_do_not_create_or_reopen_spans(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="thread-orphan", run_id="run-orphan", log_dir=tmp_path)
    run_id = uuid4()
    await recorder.on_llm_end(LLMResult(generations=[]), run_id=run_id)
    await recorder.on_chain_error(RuntimeError("orphan"), run_id=run_id)
    await recorder.on_tool_end("orphan", run_id=run_id)
    await recorder.on_retriever_end([], run_id=run_id)
    assert _events(tmp_path) == []

    recorder.start_trace()
    await recorder.on_chain_start({}, {}, run_id=run_id)
    await recorder.on_chain_start({}, {}, run_id=run_id)
    recorder.end_trace()
    await recorder.on_chain_end({}, run_id=run_id)
    await recorder.on_chain_start({}, {}, run_id=run_id)

    events = _events(tmp_path)
    assert len([event for event in events if event["event"] == "span.start"]) == 1
    assert len([event for event in events if event["event"] == "span.end"]) == 0


def test_trace_recorder_is_the_only_callback_handler(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="thread-handler", run_id="run-handler", log_dir=tmp_path)
    assert isinstance(recorder, AsyncCallbackHandler)
    assert type(recorder).__name__ == "TraceRecorder"


async def test_span_id_remains_stable_across_run_replay_and_uuid_forms(tmp_path: Path) -> None:
    recorder = _recorder(tmp_path, "stable")
    run_id = UUID("12345678-1234-5678-1234-567812345678")
    await recorder.on_chain_start({}, {}, run_id=run_id)
    await recorder.on_chain_end({}, run_id=run_id)
    await recorder.on_chain_end({}, run_id=run_id)

    events = [event for event in _events(tmp_path) if event["event"].startswith("span.")]
    assert len(events) == 2
    assert {event["span_id"] for event in events} == {"12345678123456781234567812345678"}
