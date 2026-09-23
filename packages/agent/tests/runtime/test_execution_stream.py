"""共享 execution stream 的行为基线：Build passthrough 与 capture_only。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessageChunk, ToolMessage

from harness_agent.runtime.execution_stream import (
    CONTENT_DELTA,
    REASONING_DELTA,
    TOOL_COMPLETED,
    TOOL_STARTED,
    ExecutionStreamError,
    ExecutionSignal,
    ExecutionStreamRequest,
    StreamSession,
    execute,
    extract_interaction,
    message_stream_chunk,
    translate_stream_event,
)


class _RecordingPorts:
    """记录 emit/observe 的测试 Ports。"""

    def __init__(self) -> None:
        self.signals: list[ExecutionSignal] = []
        self.messages: list[object] = []
        self.interactions: list[object] = []

    def emit(self, signal: ExecutionSignal) -> None:
        self.signals.append(signal)

    async def interact(self, request: object) -> object:
        self.interactions.append(request)
        return {"answers": {"question-1": ["ok"]}}

    async def observe_message(self, chunk: object, session: StreamSession) -> bool:
        self.messages.append(chunk)
        return type(chunk).__name__ == "ToolMessage"

    async def after_tool_boundary(self) -> None:
        return None

    def on_stream_event(self) -> None:
        return None


class _FakeAgent:
    """按预设事件序列产出 astream。"""

    def __init__(self, events: list[Any]) -> None:
        self.events = events
        self.calls: list[dict[str, Any]] = []

    async def astream(self, stream_input: object, **kwargs: Any):
        self.calls.append({"input": stream_input, **kwargs})
        for event in self.events:
            yield event


@pytest.mark.asyncio
async def test_cancelled_root_stream_ignores_partial_child_tool_call() -> None:
    """取消前泄漏的 child 半截参数不得进入 root observer 并毒化下一轮投影。"""
    cancelled = False

    class CancellingAgent:
        async def astream(self, _stream_input: object, **kwargs: Any):
            nonlocal cancelled
            root_execution_id = kwargs["config"]["metadata"][
                "harness_execution_id"
            ]
            yield (
                "messages",
                (
                    AIMessageChunk(
                        content="",
                        tool_call_chunks=[
                            {
                                "index": 0,
                                "id": "task-call",
                                "name": "task",
                                "args": '{"description":"查代码","subagent_type":"explore"}',
                            }
                        ],
                    ),
                    {"harness_execution_id": root_execution_id},
                ),
            )
            yield (
                "messages",
                (
                    AIMessageChunk(
                        content="",
                        tool_call_chunks=[
                            {
                                "index": 0,
                                "id": "child-call",
                                "name": "read_file",
                                "args": '{"file_path":',
                            }
                        ],
                    ),
                    {"harness_execution_id": "child-explore"},
                ),
            )
            cancelled = True
            yield ("updates", {})

    ports = _RecordingPorts()
    with pytest.raises(ExecutionStreamError) as caught:
        await execute(
            ExecutionStreamRequest(
                agent=CancellingAgent(),
                stream_input={"messages": []},
                graph_config={"configurable": {"thread_id": "t-cancel"}},
                context=SimpleNamespace(execution_id="root-cancel"),
                content_visibility="passthrough",
                session=StreamSession(run_id="run-cancel"),
                is_cancelled=lambda: cancelled,
            ),
            ports,
        )

    assert caught.value.code == "RUN_CANCELLED"
    assert [signal.payload.get("tool_call_id") for signal in ports.signals] == [
        "task-call",
        "task-call",
    ]
    assert len(ports.messages) == 1


@pytest.mark.asyncio
async def test_passthrough_emits_text_reasoning_and_tool_in_order() -> None:
    """passthrough 固定 text → Reasoning → Tool 的事件顺序。"""
    agent = _FakeAgent(
        [
            (
                "messages",
                (
                    AIMessageChunk(
                        content=[
                            {"type": "text", "text": "结论"},
                            {"type": "reasoning", "reasoning": "内部思考"},
                        ],
                        tool_call_chunks=[
                            {
                                "index": 0,
                                "id": "call-1",
                                "name": "read_file",
                                "args": '{"path":"a.py"}',
                            }
                        ],
                        usage_metadata={
                            "input_tokens": 3,
                            "output_tokens": 2,
                            "total_tokens": 5,
                        },
                    ),
                    {},
                ),
            ),
            (
                "messages",
                (
                    ToolMessage(
                        content="file body",
                        tool_call_id="call-1",
                        name="read_file",
                    ),
                    {},
                ),
            ),
        ]
    )
    session = StreamSession(run_id="run-stream")
    ports = _RecordingPorts()
    result = await execute(
        ExecutionStreamRequest(
            agent=agent,
            stream_input={"messages": []},
            graph_config={"configurable": {"thread_id": "t1"}},
            context=None,
            content_visibility="passthrough",
            session=session,
            is_cancelled=lambda: False,
        ),
        ports,
    )

    types = [signal.type for signal in ports.signals]
    assert types == [
        CONTENT_DELTA,
        REASONING_DELTA,
        TOOL_STARTED,
        "tool.delta",
        TOOL_COMPLETED,
    ]
    assert ports.signals[0].payload == {"text": "结论"}
    assert ports.signals[1].payload == {"text": "内部思考"}
    assert ports.signals[2].payload["tool_call_id"] == "call-1"
    assert result.final_content == "结论"
    assert result.usage == {"input_tokens": 3, "output_tokens": 2}
    assert result.resume is None
    assert len(ports.messages) == 2


@pytest.mark.asyncio
async def test_passthrough_content_is_visible_before_model_stream_finishes() -> None:
    """长模型输出不能等到最后一片才把首片正文投影给用户。"""
    first_chunk_seen = asyncio.Event()
    release_second_chunk = asyncio.Event()

    class GatedAgent:
        async def astream(self, _stream_input: object, **_kwargs: object):
            yield ("messages", (AIMessageChunk(content="A"), {}))
            first_chunk_seen.set()
            await release_second_chunk.wait()
            last = AIMessageChunk(content="B")
            object.__setattr__(last, "chunk_position", "last")
            yield ("messages", (last, {}))

    ports = _RecordingPorts()
    task = asyncio.create_task(
        execute(
            ExecutionStreamRequest(
                agent=GatedAgent(),
                stream_input={"messages": []},
                graph_config={},
                context=None,
                content_visibility="passthrough",
                session=StreamSession(run_id="run-realtime"),
                is_cancelled=lambda: False,
            ),
            ports,
        )
    )

    await asyncio.wait_for(first_chunk_seen.wait(), timeout=1)
    assert [signal.payload["text"] for signal in ports.signals] == ["A"]

    release_second_chunk.set()
    result = await asyncio.wait_for(task, timeout=1)
    assert result.final_content == "AB"


@pytest.mark.asyncio
async def test_capture_only_suppresses_content_delta_but_returns_final_text() -> None:
    """capture_only 不发 content.delta，但 final_content 保留完整正文。"""
    agent = _FakeAgent(
        [
            (
                "messages",
                (
                    AIMessageChunk(
                        content='{"goal":"x"}',
                        additional_kwargs={"reasoning_content": "思考"},
                    ),
                    {},
                ),
            ),
        ]
    )
    session = StreamSession(run_id="run-capture")
    ports = _RecordingPorts()
    result = await execute(
        ExecutionStreamRequest(
            agent=agent,
            stream_input={"messages": []},
            graph_config={},
            context=None,
            content_visibility="capture_only",
            session=session,
            is_cancelled=lambda: False,
        ),
        ports,
    )

    types = [signal.type for signal in ports.signals]
    assert CONTENT_DELTA not in types
    assert REASONING_DELTA in types
    assert result.final_content == '{"goal":"x"}'


@pytest.mark.asyncio
async def test_auto_resume_for_concurrency_safe_tools() -> None:
    """全部并发安全工具时返回 auto resume，不进入 interact。"""
    interrupt = type(
        "Interrupt",
        (),
        {
            "id": "int-1",
            "value": {
                "action_requests": [
                    {"name": "read_file", "args": {"file_path": "a.txt"}},
                ]
            },
        },
    )()
    agent = _FakeAgent([("updates", {"__interrupt__": [interrupt]})])
    session = StreamSession(run_id="run-safe")
    ports = _RecordingPorts()
    result = await execute(
        ExecutionStreamRequest(
            agent=agent,
            stream_input={"messages": []},
            graph_config={},
            context=None,
            content_visibility="passthrough",
            session=session,
            is_cancelled=lambda: False,
        ),
        ports,
    )
    assert result.resume == {"int-1": {"decisions": [{"type": "approve"}]}}
    assert ports.interactions == []


def test_translate_does_not_leak_private_reasoning_fields() -> None:
    """未知/私有 reasoning 字段不得进入 signal payload。"""
    session = StreamSession(run_id="run-private")
    chunk = AIMessageChunk(
        content=[
            {
                "type": "reasoning",
                "reasoning": "公开",
                "encrypted_content": "secret",
                "vendor_private": "私有",
            }
        ]
    )
    signals = list(
        translate_stream_event(
            ("messages", (chunk, {})),
            session,
            content_visibility="passthrough",
        )
    )
    assert [s.type for s in signals] == [REASONING_DELTA]
    assert signals[0].payload == {"text": "公开"}
    assert "secret" not in str(signals)
    assert "vendor_private" not in str(signals)


def test_extract_interaction_plan_submit_payload() -> None:
    """exit_plan_mode 的 interrupt 应投影为 plan 交互，而不是工具审批。"""
    interrupt = type(
        "Interrupt",
        (),
        {
            "id": "plan-int",
            "value": {
                "type": "plan",
                "tool_call_id": "call-1",
                "has_plan": True,
                "plan_markdown": "# 方案",
                "plan_virtual_path": "/.harness/plan.md",
                "plan_display_path": "~/.harness/plans/t.md",
                "revision": 2,
            },
        },
    )()
    request, auto = extract_interaction(("updates", {"__interrupt__": [interrupt]}))
    assert auto is None
    assert request is not None
    assert request.type == "plan"
    assert request.payload["decisions"] == ["approved", "revise", "abandoned"]
    assert request.payload["plan_markdown"] == "# 方案"
    assert request.payload["has_plan"] is True


def test_enter_plan_mode_interrupt_requires_user_approval() -> None:
    """运行时进入计划不能被并发安全规则静默批准。"""
    interrupt = type(
        "Interrupt",
        (),
        {
            "id": "enter-plan-int",
            "value": {
                "action_requests": [
                    {
                        "name": "enter_plan_mode",
                        "args": {},
                        "description": "Agent 建议进入计划模式",
                    }
                ]
            },
        },
    )()

    request, auto = extract_interaction(("updates", {"__interrupt__": [interrupt]}))

    assert auto is None
    assert request is not None
    assert request.type == "approval"
    assert request.serial_context["unsafe_indices"] == [0]


def test_child_namespace_interrupt_is_ignored_at_root() -> None:
    """非空 namespace 的 child interrupt 不得投影为 root Interaction。"""
    interrupt = type(
        "Interrupt",
        (),
        {"id": "child-int", "value": {"action_requests": [{"name": "execute"}]}},
    )()
    request, auto = extract_interaction(
        (("child",), "updates", {"__interrupt__": [interrupt]})
    )
    assert request is None
    assert auto is None


def test_update_usage_with_openai_and_langchain_cached_tokens() -> None:
    """update_usage 正确提取 OpenAI prompt_tokens_details 与 LangChain usage_metadata 中的 cached_tokens。"""
    session = StreamSession(run_id="run-usage")

    # 1. 模拟 LangChain input_token_details.cache_read
    chunk_lc = AIMessageChunk(content="hi")
    setattr(chunk_lc, "usage_metadata", {
        "input_tokens": 1000,
        "output_tokens": 100,
        "input_token_details": {"cache_read": 800},
    })
    translate_stream_event(("messages", (chunk_lc, {})), session, content_visibility="passthrough")
    assert session.usage == {"input_tokens": 1000, "output_tokens": 100, "cached_tokens": 800}

    # 2. 模拟 OpenAI response_metadata.token_usage.prompt_tokens_details.cached_tokens
    chunk_oai = AIMessageChunk(content="there")
    setattr(chunk_oai, "response_metadata", {
        "token_usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 150,
            "prompt_tokens_details": {"cached_tokens": 950},
        }
    })
    translate_stream_event(("messages", (chunk_oai, {})), session, content_visibility="passthrough")
    assert session.usage == {"input_tokens": 1200, "output_tokens": 150, "cached_tokens": 950}


def test_classifier_message_events_are_suppressed_by_metadata_and_tags() -> None:
    """分类器内部事件通过 tags/metadata 识别并被完全静默，不产生任何领域信号与消息块。"""
    session = StreamSession(run_id="run-suppress")
    raw_content = '{"decision": "allow", "confidence": "high", "reason": "只读查询"}'
    chunk = AIMessageChunk(content=raw_content)

    test_cases = [
        {"tags": ["harness:classifier"]},
        {"tags": ["harness:internal"]},
        {"tags": ["nostream"]},
        {"harness_classifier": True},
        {"harness_internal": True},
        {"harness_execution_id": "__harness_classifier_internal__"},
        {"run_name": "SafetyClassifier"},
        {"metadata": {"harness_classifier": True}},
        {"metadata": {"harness_execution_id": "__harness_classifier_internal__"}},
    ]

    for metadata in test_cases:
        event = ("messages", (chunk, metadata))
        # 1. message_stream_chunk 返回 None
        assert message_stream_chunk(event, execution_id="root") is None
        assert message_stream_chunk(event, execution_id="") is None

        # 2. translate_stream_event 返回空列表，且不向 session.content_parts 写入
        signals = list(translate_stream_event(event, session, content_visibility="passthrough", execution_id="root"))
        assert signals == []
        assert raw_content not in session.content_parts


def test_classifier_verdict_content_fallback_suppression() -> None:
    """即使 metadata 意外丢失，分类器判定 JSON 也被兜底逻辑丢弃，不向 TUI 派发 CONTENT_DELTA。"""
    session = StreamSession(run_id="run-fallback")
    classifier_content = '{"decision": "allow", "confidence": "high", "reason": "只读操作"}'
    chunk = AIMessageChunk(content=classifier_content)

    # 没有任何 metadata 标记
    event = ("messages", (chunk, {}))
    signals = list(translate_stream_event(event, session, content_visibility="passthrough"))

    assert signals == []
    assert classifier_content not in session.content_parts

    # 普通合法正文正常放行
    normal_chunk = AIMessageChunk(content="正常助手文本回复")
    normal_event = ("messages", (normal_chunk, {}))
    normal_signals = list(translate_stream_event(normal_event, session, content_visibility="passthrough"))

    assert len(normal_signals) == 1
    assert normal_signals[0].type == CONTENT_DELTA
    assert normal_signals[0].payload["text"] == "正常助手文本回复"
    assert "正常助手文本回复" in session.content_parts


@pytest.mark.asyncio
async def test_execute_stream_completely_silences_internal_classifier_chunks() -> None:
    """端到端验证：主执行流中混入的分类器 chunks 被静默，TUI 不会收到任何分类器决策文本。"""
    session = StreamSession(run_id="run-e2e")
    ports = _RecordingPorts()

    classifier_json = '{"decision": "allow", "confidence": "high", "reason": "检查已安装工具"}'
    events = [
        (
            "messages",
            (
                AIMessageChunk(content="正在为您查询..."),
                {"harness_execution_id": "root"},
            ),
        ),
        (
            "messages",
            (
                AIMessageChunk(content=classifier_json),
                {
                    "tags": ["harness:classifier", "nostream"],
                    "harness_classifier": True,
                    "harness_execution_id": "__harness_classifier_internal__",
                    "run_name": "SafetyClassifier",
                },
            ),
        ),
        (
            "messages",
            (
                AIMessageChunk(content="查询完成，共发现 3 个工具。"),
                {"harness_execution_id": "root"},
            ),
        ),
    ]

    request = ExecutionStreamRequest(
        agent=_FakeAgent(events),
        stream_input={"messages": []},
        graph_config={"metadata": {"harness_execution_id": "root"}},
        context=SimpleNamespace(execution_id="root"),
        content_visibility="passthrough",
        session=session,
        is_cancelled=lambda: False,
    )

    result = await execute(request, ports)

    # 验证领域信号中绝不包含分类器文本
    content_deltas = [
        sig.payload["text"]
        for sig in ports.signals
        if sig.type == CONTENT_DELTA
    ]
    assert content_deltas == ["正在为您查询...", "查询完成，共发现 3 个工具。"]
    assert classifier_json not in content_deltas

    # 验证最终正文与 captured messages 中不含分类器输出
    assert classifier_json not in result.final_content
    assert result.final_content == "正在为您查询...查询完成，共发现 3 个工具。"
    for captured in ports.messages:
        assert getattr(captured, "content", "") != classifier_json

