"""真实模型适配器收到 SSE 心跳时，仍须遵守整次响应的时限。"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from harness_agent.config.config import ModelSettings
from harness_agent.extensions.providers.harness_gateway import (
    create_openai_compatible_model,
)
from harness_agent.runtime.managed_agent_executor import (
    ManagedAgentExecutionError,
    ManagedAgentExecutor,
)
from harness_agent.runtime.provider_retry import BoundedProviderRetry
from langchain_core.messages import HumanMessage
from tests.runtime.test_managed_agent_executor import _Observer, _request, _Runtime


def sse(content: str, *, finish: bool = False) -> bytes:
    payload = {
        "id": "offline-stream",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "offline",
        "choices": [
            {
                "index": 0,
                "delta": {"content": content},
                "finish_reason": "stop" if finish else None,
            }
        ],
    }
    return f"data: {json.dumps(payload)}\n\n".encode()


class ResponseStream(httpx.AsyncByteStream):
    """先发首包，再持续保活或正常结束；记录取消时是否归还连接。"""

    def __init__(self, *, prefix: str, heartbeat: bool):
        self.prefix = prefix
        self.heartbeat = heartbeat
        self.started = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        self.started.set()
        yield sse(self.prefix)
        if self.heartbeat:
            while True:
                await asyncio.sleep(0.004)
                yield b": keepalive\n\n"
        yield sse("", finish=True) + b"data: [DONE]\n\n"

    async def aclose(self):
        self.closed = True


def make_model(client, monkeypatch, *, timeout=0.03):
    monkeypatch.setenv("TEST_RESPONSE_DEADLINE", "offline-key")
    return create_openai_compatible_model(
        ModelSettings(
            name="offline",
            base_url="https://example.invalid/v1",
            api_key_env="TEST_RESPONSE_DEADLINE",
            timeout_seconds=timeout,
            max_retries=0,
        ),
        async_client=client,
    )


@pytest.mark.parametrize("prefix", ["", "已经返回的正文"])
async def test_heartbeat_cannot_extend_model_response_deadline(monkeypatch, prefix):
    stream = ResponseStream(prefix=prefix, heartbeat=True)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            stream=stream,
        )
    )
    received = []
    async with httpx.AsyncClient(transport=transport) as client:
        model = make_model(client, monkeypatch)

        async def consume():
            async for chunk in model.astream([HumanMessage(content="离线验证")]):
                received.append(chunk.content)

        # 外层只保护测试不挂死；必须由配置的响应期限先结束，而非等到外层取消。
        with pytest.raises(TimeoutError, match="MODEL_RESPONSE_TIMEOUT"):
            await asyncio.wait_for(consume(), timeout=0.4)
    assert stream.closed
    assert "".join(received) == prefix


async def test_normal_response_finishes_and_closes_stream(monkeypatch):
    stream = ResponseStream(prefix="正常结果", heartbeat=False)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, headers={"Content-Type": "text/event-stream"}, stream=stream
            ),
        )
    ) as client:
        chunks = [
            chunk
            async for chunk in make_model(client, monkeypatch, timeout=1).astream(
                [HumanMessage(content="离线验证")]
            )
        ]
    assert "".join(chunk.content for chunk in chunks) == "正常结果"
    assert stream.closed


async def test_user_cancel_is_not_relabelled_as_response_timeout(monkeypatch):
    stream = ResponseStream(prefix="", heartbeat=True)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200, headers={"Content-Type": "text/event-stream"}, stream=stream
            ),
        )
    ) as client:

        async def consume():
            async for _ in make_model(client, monkeypatch, timeout=10).astream(
                [HumanMessage(content="离线验证")]
            ):
                pass

        pending = asyncio.create_task(consume())
        await asyncio.wait_for(stream.started.wait(), 1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    assert stream.closed


@pytest.mark.parametrize(
    "prefix,attempts,code",
    [
        ("", 3, "PROVIDER_RETRY_EXHAUSTED"),
        ("已公开正文", 1, "PROVIDER_OUTPUT_INTERRUPTED"),
    ],
)
async def test_response_deadline_uses_existing_retry_and_output_rules(
    monkeypatch, prefix, attempts, code
):
    streams = []

    def respond(request):
        stream = ResponseStream(prefix=prefix, heartbeat=True)
        streams.append(stream)
        return httpx.Response(
            200, headers={"Content-Type": "text/event-stream"}, stream=stream
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        model = make_model(client, monkeypatch)

        class AdapterGraph:
            async def astream(self, stream_input, **kwargs):
                async for chunk in model.astream([HumanMessage(content="离线验证")]):
                    yield ("messages", (chunk, {}))

        runtime = _Runtime(AdapterGraph())
        request = _request(runtime)
        object.__setattr__(
            request,
            "provider_retry",
            BoundedProviderRetry(
                max_attempts=3,
                base_delay_seconds=0,
                max_delay_seconds=0,
            ),
        )
        observer = _Observer()
        with pytest.raises(ManagedAgentExecutionError) as failure:
            await ManagedAgentExecutor().execute(request, observer)
        assert failure.value.code == code
        assert len(streams) == attempts
        assert all(stream.closed for stream in streams)
        assert runtime.release_calls == 1
        text = "".join(
            signal.payload["text"]
            for signal in observer.signals
            if signal.type == "content.delta"
        )
        assert text == prefix
