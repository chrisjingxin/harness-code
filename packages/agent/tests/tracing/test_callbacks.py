"""通用 LangChain 回调不再建树，也不把正文写入链路日志。"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

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
        if line.strip()
    ]


def _recorder(tmp_path: Path, name: str) -> TraceRecorder:
    recorder = TraceRecorder(session_id=f"thread-{name}", run_id=f"run-{name}", log_dir=tmp_path)
    recorder.start_trace()
    return recorder


async def test_callbacks_do_not_build_spans_or_record_content(tmp_path: Path) -> None:
    """模型、节点、工具和检索回调只允许记首 token，不产生 span，也不落正文。"""
    recorder = _recorder(tmp_path, "callbacks")
    node_id = uuid4()
    llm_id = uuid4()
    tool_id = uuid4()
    retriever_id = uuid4()
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
    )
    await recorder.on_llm_new_token("秘密 token", run_id=llm_id, parent_run_id=node_id)
    await recorder.on_llm_end(
        LLMResult(
            generations=[
                [
                    ChatGeneration(
                        message=AIMessage(content="秘密 response", tool_calls=[])
                    )
                ]
            ]
        ),
        run_id=llm_id,
    )
    await recorder.on_tool_start(
        {"name": "write_file"},
        "秘密工具参数",
        run_id=tool_id,
        inputs={"path": "秘密路径"},
    )
    await recorder.on_tool_end(
        ToolMessage(content="秘密工具结果", tool_call_id="call-safe", status="error"),
        run_id=tool_id,
    )
    await recorder.on_retriever_start({}, "秘密检索词", run_id=retriever_id)
    await recorder.on_retriever_end(
        [Document(page_content="秘密文档")],
        run_id=retriever_id,
    )
    await recorder.on_chain_end({"secret_output": "不得落盘"}, run_id=node_id)

    events = _events(tmp_path)
    assert not any(str(event["event"]).startswith("span.") for event in events)
    serialized = json.dumps(events, ensure_ascii=False)
    assert "秘密" not in serialized
    assert "不得落盘" not in serialized


@pytest.mark.parametrize("category", ["llm", "chain", "tool", "retriever"])
async def test_error_callbacks_do_not_raise_or_create_spans(
    tmp_path: Path, category: str
) -> None:
    """回调出错时不把异常抛回业务，也不补一条失败 span。"""
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

    events = _events(tmp_path)
    assert not any(str(event["event"]).startswith("span.") for event in events)
    assert "原始错误" not in json.dumps(events, ensure_ascii=False)


async def test_orphan_and_replay_callbacks_do_not_create_spans(tmp_path: Path) -> None:
    """没有对应开始、重复开始、关链之后的回调都不写 span。"""
    recorder = TraceRecorder(session_id="thread-orphan", run_id="run-orphan", log_dir=tmp_path)
    run_id = uuid4()
    await recorder.on_llm_end(LLMResult(generations=[]), run_id=run_id)
    await recorder.on_chain_error(RuntimeError("orphan"), run_id=run_id)
    assert _events(tmp_path) == []

    recorder.start_trace()
    await recorder.on_chain_start({}, {}, run_id=run_id)
    await recorder.on_chain_start({}, {}, run_id=run_id)
    recorder.end_trace()
    await recorder.on_chain_end({}, run_id=run_id)

    events = _events(tmp_path)
    assert not any(str(event["event"]).startswith("span.") for event in events)


def test_trace_recorder_is_the_only_callback_handler(tmp_path: Path) -> None:
    recorder = TraceRecorder(session_id="thread-handler", run_id="run-handler", log_dir=tmp_path)
    assert isinstance(recorder, AsyncCallbackHandler)
    assert type(recorder).__name__ == "TraceRecorder"
