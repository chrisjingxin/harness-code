"""最靠近模型的中间件写出 step 和带用量的 llm.call。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from harness_agent.tracing import TraceRecorder, use_trace
from harness_agent.tracing.model import TraceModelMiddleware


def _events(root: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for path in root.glob("*.jsonl")
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


async def test_model_middleware_records_step_usage_and_payload(tmp_path: Path) -> None:
    """一次模型调用留下打开到 Run 结束的 step，以及输入、输出和缓存命中率。"""
    recorder = TraceRecorder(session_id="thread-model", run_id="run-model", log_dir=tmp_path)
    context = recorder.start_trace()
    request = SimpleNamespace(
        messages=[SimpleNamespace(type="human", content="你好", tool_calls=[])],
        model=SimpleNamespace(model_name="mock-model", temperature=0.2),
        system_prompt="你是助手",
        tools=[],
    )
    reply = SimpleNamespace(
        content="好",
        tool_calls=[],
        usage_metadata={
            "input_tokens": 10,
            "output_tokens": 2,
            "total_tokens": 12,
            "input_token_details": {"cache_read": 4},
        },
        response_metadata={"finish_reason": "stop"},
    )

    from harness_agent.runtime.provider_retry import BoundedProviderRetry, run_with_provider_retry

    async def handler(_request: object) -> object:
        async def invoke() -> object:
            recorder.note_first_token()
            return SimpleNamespace(result=[reply])

        return await run_with_provider_retry(invoke, BoundedProviderRetry(max_attempts=2))

    with use_trace(context):
        await TraceModelMiddleware().awrap_model_call(request, handler)
        recorder.end_trace()

    events = _events(tmp_path)
    starts = [event["name"] for event in events if event["event"] == "span.start"]
    assert starts == ["step", "llm.call"]
    llm_end = next(
        event for event in events if event["event"] == "span.end" and event["name"] == "llm.call"
    )
    assert llm_end["attributes"]["model"] == "mock-model"
    assert llm_end["attributes"]["finish_reason"] == "stop"
    assert llm_end["attributes"]["cache_hit_ratio"] == 0.4
    assert llm_end["attributes"]["first_token_ms"] >= 0
    assert llm_end["attributes"]["usage"]["cache_read_tokens"] == 4
    payloads = [event for event in events if event["event"] == "payload"]
    assert any(event["kind"] == "message" and event["body"]["content"] == "你好" for event in payloads)
    assert any(event["kind"] == "output" and event["body"]["content"] == "好" for event in payloads)
    assert any(event["kind"] == "system" and event["body"]["content"] == "你是助手" for event in payloads)
    step_end = next(event for event in events if event["event"] == "span.end" and event["name"] == "step")
    assert step_end["span_id"] == next(
        event["span_id"] for event in events if event["event"] == "span.start" and event["name"] == "step"
    )
    assert llm_end["parent_span_id"] == step_end["span_id"]
