"""在真正发给模型的那一层记录 step 和 llm.call。"""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from collections.abc import Awaitable, Callable, Iterator
from typing import Any
from urllib.parse import urlparse

from langchain.agents.middleware.types import AgentMiddleware

from harness_agent.tracing.context import _bind_span, _reset_span, current_span, current_trace
from harness_agent.tracing.recorder import TraceStatus

_LOGGER = logging.getLogger(__name__)

_REQUEST_FIELDS = (
    "temperature",
    "top_p",
    "max_tokens",
    "reasoning_effort",
    "stop",
    "tool_choice",
    "parallel_tool_calls",
    "timeout",
    "request_timeout",
    "max_retries",
)


def _message_body(message: object) -> dict[str, object]:
    """把一条模型消息收成可落盘的字典，不包含密钥字段。"""
    content = getattr(message, "content", None)
    role = getattr(message, "type", None) or getattr(message, "role", "unknown")
    tool_calls = getattr(message, "tool_calls", None)
    body: dict[str, object] = {"role": str(role)}
    if content is not None:
        body["content"] = content if isinstance(content, (str, list, dict)) else str(content)
    if tool_calls:
        body["tool_calls"] = [
            {
                "id": call.get("id"),
                "name": call.get("name"),
                "arguments": call.get("args"),
            }
            for call in tool_calls
            if isinstance(call, dict)
        ]
    return body


def _request_attributes(request: object) -> dict[str, object]:
    """从模型对象上摘出采样参数和主机名。拿不到的字段省略。"""
    model = getattr(request, "model", None)
    attributes: dict[str, object] = {}
    name = getattr(model, "model_name", None) or getattr(model, "model", None)
    if isinstance(name, str) and name:
        attributes["model"] = name
    profile = getattr(request, "model_profile", None)
    if isinstance(profile, str) and profile:
        attributes["profile"] = profile
    request_fields: dict[str, object] = {}
    for field in _REQUEST_FIELDS:
        value = getattr(model, field, None)
        if value is not None and not callable(value):
            key = "timeout_s" if field in {"timeout", "request_timeout"} else field
            request_fields[key] = value
    base_url = getattr(model, "openai_api_base", None) or getattr(model, "base_url", None)
    if isinstance(base_url, str) and base_url:
        host = urlparse(base_url).hostname
        if host:
            request_fields["base_url_host"] = host
    if request_fields:
        attributes["request"] = request_fields
    return attributes


class TraceModelMiddleware(AgentMiddleware):
    """包住实际模型调用，记录这一轮的输入、输出和用量。"""

    @contextmanager
    def _observe(self, request: Any) -> Iterator[dict[str, Any]]:
        """采集与业务分离，任何序列化或写入错误都不能阻断模型调用。"""
        state: dict[str, Any] = {}
        context = current_trace()
        if context is None:
            yield state
            return
        recorder = context.recorder
        step = llm = token = None
        try:
            parent = current_span()
            if parent is None or parent.name != "context.compact":
                step = recorder.open_step()
            llm = recorder.start_span(
                "llm.call", kind="LLM",
                parent_span_id=None if step is None else step.span_id,
                attributes=self._start_attributes(request),
            )
            if llm is not None:
                token = _bind_span(llm)
        except Exception:
            _LOGGER.warning("模型 trace 创建失败", exc_info=True)
        error = None
        try:
            yield state
        except BaseException as exc:
            error = exc
            raise
        finally:
            if token is not None:
                _reset_span(token)
            try:
                if error is None and llm is not None:
                    self._end_success(recorder, llm, state["response"])
                elif error is not None:
                    status = TraceStatus.CANCELLED if isinstance(error, asyncio.CancelledError) else TraceStatus.FAILED
                    recorder.end_span(llm, status, error=error)
                    if step is not None:
                        recorder.close_step(status, error=error)
            except Exception:
                _LOGGER.warning("模型 trace 关闭失败", exc_info=True)

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Awaitable[Any]]) -> Any:
        """异步调用与同步路径共用采集，取消和业务异常原样传播。"""
        with self._observe(request) as state:
            response = await handler(request)
            state["response"] = response
            return response

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        """同步模型调用原样返回结果，不让采集故障进入业务。"""
        with self._observe(request) as state:
            response = handler(request)
            state["response"] = response
            return response

    def _start_attributes(self, request: Any) -> dict[str, object]:
        """写入模型参数，并把消息、系统提示词和工具 schema 收成载荷引用。"""
        context = current_trace()
        attributes = _request_attributes(request)
        if context is None or context.recorder._capture != "full":
            messages = getattr(request, "messages", None) or []
            attributes["message_count"] = len(messages)
            return attributes
        recorder = context.recorder
        messages = list(getattr(request, "messages", None) or [])
        system = getattr(request, "system_message", None) or getattr(request, "system_prompt", None)
        if system is not None:
            attributes["system_ref"] = recorder.payload("system", _message_body(system) if not isinstance(system, str) else {"role": "system", "content": system})
        attributes["message_refs"] = [recorder.payload("message", _message_body(message)) for message in messages]
        attributes["message_count"] = len(messages)
        tools = getattr(request, "tools", None)
        if tools:
            attributes["tools_ref"] = recorder.payload(
                "tools",
                [{"name": getattr(tool, "name", None)} for tool in tools],
            )
        return attributes

    def _end_success(self, recorder: Any, llm: Any, response: Any) -> None:
        """把用量和输出补进 llm.call。step 保持打开，直到下一轮或 Run 结束。"""
        attributes: dict[str, object] = {}
        message = getattr(response, "result", None)
        if isinstance(message, list) and message:
            message = message[0]
        if message is not None and recorder._capture == "full":
            attributes["output_ref"] = recorder.payload("output", _message_body(message))
        usage = getattr(message, "usage_metadata", None)
        if isinstance(usage, dict):
            attributes["usage"] = {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "cache_read_tokens": (usage.get("input_token_details") or {}).get("cache_read", 0)
                if isinstance(usage.get("input_token_details"), dict)
                else usage.get("cache_read_tokens", 0),
                "cache_write_tokens": usage.get("cache_write_tokens", 0),
                "reasoning_tokens": (usage.get("output_token_details") or {}).get("reasoning", 0)
                if isinstance(usage.get("output_token_details"), dict)
                else usage.get("reasoning_tokens", 0),
            }
            input_tokens = attributes["usage"]["input_tokens"]
            cache_read = attributes["usage"]["cache_read_tokens"]
            if isinstance(input_tokens, int) and input_tokens > 0 and isinstance(cache_read, int):
                attributes["cache_hit_ratio"] = round(cache_read / input_tokens, 3)
        metadata = getattr(message, "response_metadata", None) or {}
        if isinstance(metadata, dict) and isinstance(metadata.get("finish_reason"), str):
            attributes["finish_reason"] = metadata["finish_reason"]
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls is not None:
            attributes["tool_calls"] = len(tool_calls)
        if llm is not None:
            first = recorder.first_token_ms(llm.span_id)
            if first is not None:
                attributes["first_token_ms"] = first
        recorder.end_span(llm, attributes=attributes)
