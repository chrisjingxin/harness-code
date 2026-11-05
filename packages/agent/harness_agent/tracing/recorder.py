"""统一 TraceRecorder：图内外入口共享同一事件 envelope 与生命周期。"""

from __future__ import annotations

import functools
import logging
import math
import threading
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.documents import Document
from langchain_core.messages import BaseMessage
from langchain_core.outputs import LLMResult

from harness_agent.tracing.context import current_span
from harness_agent.tracing.writer import JsonlTraceWriter

_LOGGER = logging.getLogger(__name__)

_SCHEMA_VERSION = 1
_MAX_STATUS_MESSAGE = 512
_SENSITIVE_ATTRIBUTES = {
    "api_key",
    "apikey",
    "authorization",
    "command",
    "content",
    "cookie",
    "document",
    "documents",
    "env",
    "message",
    "messages",
    "payload",
    "prompt",
    "response",
    "tool_args",
    "tool_result",
    "workspace_path",
}


class TraceStatus(str, Enum):
    """Trace 与 Span 的稳定终态。"""

    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class TraceContext:
    """可显式传递到后台任务或其他 callback 的不可变 Trace 绑定。"""

    recorder: TraceRecorder
    session_id: str
    run_id: str
    trace_id: str
    root_span_id: str


@dataclass(frozen=True)
class SpanHandle:
    """手动 end_span 所需的稳定身份、关联字段和单调时钟起点。"""

    span_id: str
    parent_span_id: str
    name: str
    kind: str
    idempotency_key: str | None
    start_time_ms: int
    started_ns: int


def _callback_safe(method):
    """隔离埋点解析异常，避免 LangChain 将 tracing 故障抛回业务。"""
    @functools.wraps(method)
    async def guarded(self, *args, **kwargs):
        try:
            return await method(self, *args, **kwargs)
        except Exception:
            _LOGGER.warning("图内 Span 回调失败: %s", method.__name__, exc_info=True)
            return None

    return guarded


@dataclass
class _CallbackSpan:
    """图内回调的打开状态；首 Token 只更新内存，不产生日志事件。"""

    handle: SpanHandle
    first_token_latency_ms: int | None = None


class TraceRecorder(AsyncCallbackHandler):
    """一条 Run 对应一个 Recorder，同时统一图外装饰器与图内 LangChain 回调。"""

    def __init__(
        self,
        *,
        session_id: str,
        run_id: str,
        log_dir: Path | str,
        writer: JsonlTraceWriter | None = None,
    ) -> None:
        self.session_id = session_id
        self.run_id = run_id
        self.trace_id = uuid.uuid4().hex
        self.root_span_id = uuid.uuid4().hex
        self._writer = writer or JsonlTraceWriter(log_dir)
        self._context = TraceContext(
            recorder=self,
            session_id=session_id,
            run_id=run_id,
            trace_id=self.trace_id,
            root_span_id=self.root_span_id,
        )
        self._lock = threading.Lock()
        self._started = False
        self._closed = False
        self._root_started_ns = 0
        self._root_start_time_ms = 0
        self._root_attributes: dict[str, object] = {}
        self._open_spans: set[str] = set()
        self._span_ids: set[str] = set()
        self._idempotency_keys: set[str] = set()
        self._callback_spans: dict[uuid.UUID, _CallbackSpan] = {}

    @property
    def closed(self) -> bool:
        """根 Trace 是否已关闭；关闭后拒绝任何迟到写入。"""
        return self._closed

    def start_trace(self, *, attributes: Mapping[str, object] | None = None) -> TraceContext:
        """发出唯一 trace.start；重复 start 返回同一上下文。"""
        with self._lock:
            if self._started:
                return self._context
            self._started = True
            self._root_started_ns = time.perf_counter_ns()
            self._root_start_time_ms = _now_ms()
            self._root_attributes = _safe_attributes(attributes)
            self._write(
                "trace.start",
                span_id=self.root_span_id,
                parent_span_id=None,
                name="run",
                kind="ROOT",
                start_time_ms=self._root_start_time_ms,
                attributes=self._root_attributes,
            )
            return self._context

    def end_trace(
        self,
        status: TraceStatus | str = TraceStatus.SUCCESS,
        *,
        error: BaseException | None = None,
    ) -> None:
        """恰好发出一次 trace.end，并让所有后续 Span 写入失效。"""
        with self._lock:
            if not self._started or self._closed:
                return
            self._closed = True
            self._write(
                "trace.end",
                span_id=self.root_span_id,
                parent_span_id=None,
                name="run",
                kind="ROOT",
                start_time_ms=self._root_start_time_ms,
                end_time_ms=_now_ms(),
                duration_ms=_elapsed_ms(self._root_started_ns),
                status=_status_value(status),
                attributes=self._root_attributes,
                **_error_fields(status, error),
            )
            self._open_spans.clear()
            self._callback_spans.clear()

    def start_span(
        self,
        name: str,
        *,
        kind: str = "FUNC",
        attributes: Mapping[str, object] | None = None,
        parent_span_id: str | None = None,
        idempotency_key: str | None = None,
        span_id: str | None = None,
    ) -> SpanHandle | None:
        """开始图外或手动 Span；相同幂等键及关闭后的 start 均被抑制。"""
        with self._lock:
            if not self._started or self._closed:
                return None
            if idempotency_key is not None:
                if idempotency_key in self._idempotency_keys:
                    return None
                self._idempotency_keys.add(idempotency_key)
                span_id = uuid.uuid5(
                    uuid.NAMESPACE_URL, f"{self.trace_id}:{name}:{idempotency_key}"
                ).hex
            elif span_id is None:
                span_id = uuid.uuid4().hex
            if span_id in self._span_ids:
                return None
            self._span_ids.add(span_id)
            parent = parent_span_id
            if parent is None:
                active = current_span()
                parent = active.span_id if active is not None else self.root_span_id
            span = SpanHandle(
                span_id=span_id,
                parent_span_id=parent,
                name=name,
                kind=kind,
                idempotency_key=idempotency_key,
                start_time_ms=_now_ms(),
                started_ns=time.perf_counter_ns(),
            )
            self._open_spans.add(span_id)
            event: dict[str, object] = {
                "start_time_ms": span.start_time_ms,
                "attributes": _safe_attributes(attributes),
            }
            if idempotency_key is not None:
                event["idempotency_key"] = idempotency_key
            self._write(
                "span.start",
                span_id=span_id,
                parent_span_id=parent,
                name=name,
                kind=kind,
                **event,
            )
            return span

    def end_span(
        self,
        span: SpanHandle | None,
        status: TraceStatus | str = TraceStatus.SUCCESS,
        *,
        attributes: Mapping[str, object] | None = None,
        error: BaseException | None = None,
    ) -> None:
        """结束已打开 Span；重复或孤立 end 不制造事件与虚假耗时。"""
        if span is None:
            return
        with self._lock:
            if self._closed or span.span_id not in self._open_spans:
                return
            self._open_spans.remove(span.span_id)
            event: dict[str, object] = {
                "start_time_ms": span.start_time_ms,
                "end_time_ms": _now_ms(),
                "duration_ms": _elapsed_ms(span.started_ns),
                "status": _status_value(status),
                "attributes": _safe_attributes(attributes),
            }
            if span.idempotency_key is not None:
                event["idempotency_key"] = span.idempotency_key
            self._write(
                "span.end",
                span_id=span.span_id,
                parent_span_id=span.parent_span_id,
                name=span.name,
                kind=span.kind,
                **_error_fields(status, error),
                **event,
            )

    @_callback_safe
    async def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """开始传统补全模型 Span，只记录模型标识和消息数量。"""
        self._start_callback_span(
            run_id,
            parent_run_id,
            name="graph.llm",
            kind="LLM",
            attributes={"model": _model_name(serialized, metadata), "message_count": len(prompts)},
        )

    @_callback_safe
    async def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[BaseMessage]],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """开始聊天模型 Span，不访问任何消息正文。"""
        self._start_callback_span(
            run_id,
            parent_run_id,
            name="graph.llm",
            kind="LLM",
            attributes={
                "model": _model_name(serialized, metadata),
                "message_count": sum(len(group) for group in messages),
            },
        )

    @_callback_safe
    async def on_llm_new_token(
        self,
        token: str | list[str | dict[str, Any]],
        *,
        chunk: Any = None,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """仅记录首 Token 延迟，token/chunk 内容既不读取也不落盘。"""
        state = self._callback_spans.get(run_id)
        if state is not None and state.first_token_latency_ms is None:
            state.first_token_latency_ms = _elapsed_ms(state.handle.started_ns)

    @_callback_safe
    async def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """结束模型 Span，只提取 usage、finish_reason 和工具调用数量。"""
        self._end_callback_span(run_id, attributes=_llm_result_attributes(response))

    @_callback_safe
    async def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """以原异常类型关链，不改变 LangChain 的错误传播。"""
        self._end_callback_span(run_id, status=TraceStatus.FAILED, error=error)

    @_callback_safe
    async def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """把 LangGraph chain 统一记录为 AGENT 或 NODE，忽略输入内容。"""
        marker = _chain_marker(serialized, metadata)
        kind = "AGENT" if "agent" in marker.lower() else "NODE"
        self._start_callback_span(
            run_id,
            parent_run_id,
            name="agent.run" if kind == "AGENT" else "graph.node",
            kind=kind,
            attributes={"node": marker} if marker else None,
        )

    @_callback_safe
    async def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """结束 AGENT/NODE Span，不读取图输出。"""
        self._end_callback_span(run_id)

    @_callback_safe
    async def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """以失败状态结束 AGENT/NODE Span。"""
        self._end_callback_span(run_id, status=TraceStatus.FAILED, error=error)

    @_callback_safe
    async def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """开始工具 Span，只保留工具名、调用 ID 和参数键名。"""
        tool_name = _tool_name(serialized, metadata)
        call_id = _metadata_text(metadata, "tool_call_id", "call_id") or str(run_id)
        attributes: dict[str, object] = {"tool": tool_name, "call_id": call_id}
        if inputs is not None:
            attributes["input_keys"] = [key for key in inputs if isinstance(key, str)]
        self._start_callback_span(
            run_id, parent_run_id, name="tool.call", kind="TOOL", attributes=attributes
        )

    @_callback_safe
    async def on_tool_end(
        self,
        output: Any,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """结束工具 Span，只记录结果状态与关联 ID，忽略结果正文。"""
        status = output.get("status") if isinstance(output, Mapping) else getattr(output, "status", None)
        call_id = (
            output.get("tool_call_id")
            if isinstance(output, Mapping)
            else getattr(output, "tool_call_id", None)
        )
        attributes: dict[str, object] = {}
        if isinstance(status, str):
            attributes["result_status"] = status
        if isinstance(call_id, str):
            attributes["tool_call_id"] = call_id
        failed = status == "error"
        self._end_callback_span(
            run_id,
            status=TraceStatus.FAILED if failed else TraceStatus.SUCCESS,
            attributes=attributes,
            error=RuntimeError("Tool result status: error") if failed else None,
        )

    @_callback_safe
    async def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """以原异常结束工具 Span。"""
        self._end_callback_span(run_id, status=TraceStatus.FAILED, error=error)

    @_callback_safe
    async def on_retriever_start(
        self,
        serialized: dict[str, Any],
        query: str,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """开始检索 Span，只记录查询长度。"""
        self._start_callback_span(
            run_id,
            parent_run_id,
            name="graph.retriever",
            kind="RETRIEVER",
            attributes={"query_length": len(query)},
        )

    @_callback_safe
    async def on_retriever_end(
        self,
        documents: Sequence[Document],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """结束检索 Span，只记录文档数量。"""
        self._end_callback_span(run_id, attributes={"document_count": len(documents)})

    @_callback_safe
    async def on_retriever_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        """以原异常结束检索 Span。"""
        self._end_callback_span(run_id, status=TraceStatus.FAILED, error=error)

    def _start_callback_span(
        self,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None,
        *,
        name: str,
        kind: str,
        attributes: Mapping[str, object] | None = None,
    ) -> None:
        if run_id in self._callback_spans:
            return
        active_span = current_span()
        parent_span_id = (
            parent_run_id.hex
            if parent_run_id is not None
            else active_span.span_id
            if active_span is not None
            else self.root_span_id
        )
        handle = self.start_span(
            name,
            kind=kind,
            attributes=attributes,
            parent_span_id=parent_span_id,
            span_id=run_id.hex,
        )
        if handle is not None:
            self._callback_spans[run_id] = _CallbackSpan(handle=handle)

    def _end_callback_span(
        self,
        run_id: uuid.UUID,
        status: TraceStatus = TraceStatus.SUCCESS,
        *,
        attributes: Mapping[str, object] | None = None,
        error: BaseException | None = None,
    ) -> None:
        state = self._callback_spans.pop(run_id, None)
        if state is None:
            return
        final_attributes = dict(attributes or {})
        if state.first_token_latency_ms is not None:
            final_attributes["first_token_latency_ms"] = state.first_token_latency_ms
        self.end_span(state.handle, status, attributes=final_attributes, error=error)

    def _write(self, event: str, **fields: object) -> None:
        record = {
            "schema_version": _SCHEMA_VERSION,
            "event": event,
            "timestamp_ms": _now_ms(),
            "session_id": self.session_id,
            "trace_id": self.trace_id,
            "run_id": self.run_id,
            **fields,
        }
        self._writer.append(self.session_id, record)


def _metadata_text(metadata: Mapping[str, Any] | None, *keys: str) -> str | None:
    for key in keys:
        value = (metadata or {}).get(key)
        if isinstance(value, (str, int)) and str(value):
            return str(value)[:256]
    return None


def _model_name(
    serialized: Mapping[str, Any], metadata: Mapping[str, Any] | None
) -> str:
    configured = _metadata_text(metadata, "model", "model_name", "model_id", "ls_model_name")
    if configured is not None:
        return configured
    name = serialized.get("name")
    if isinstance(name, str):
        return name[:256]
    identifier = serialized.get("id")
    if isinstance(identifier, list) and identifier and isinstance(identifier[-1], str):
        return identifier[-1][:256]
    return "unknown"


def _chain_marker(
    serialized: Mapping[str, Any], metadata: Mapping[str, Any] | None
) -> str:
    configured = _metadata_text(metadata, "langgraph_node", "graph_node", "node", "chain_type")
    if configured is not None:
        return configured
    name = serialized.get("name")
    return name[:256] if isinstance(name, str) else "chain"


def _tool_name(serialized: Mapping[str, Any], metadata: Mapping[str, Any] | None) -> str:
    configured = _metadata_text(metadata, "tool_name", "name")
    if configured is not None:
        return configured
    name = serialized.get("name")
    return name[:256] if isinstance(name, str) else "unknown"


def _llm_result_attributes(response: LLMResult) -> dict[str, object]:
    """只从 LangChain 结果提取数值和枚举字段，不序列化 generations。"""
    attributes: dict[str, object] = {}
    output = response.llm_output or {}
    usage = output.get("token_usage") or output.get("usage")
    for candidates in response.generations:
        if not candidates:
            continue
        generation = candidates[0]
        message = getattr(generation, "message", None)
        message_usage = getattr(message, "usage_metadata", None)
        if usage is None and isinstance(message_usage, Mapping):
            usage = message_usage
        generation_info = getattr(generation, "generation_info", None) or {}
        response_metadata = getattr(message, "response_metadata", None) or {}
        finish_reason = generation_info.get("finish_reason") or response_metadata.get("finish_reason")
        if isinstance(finish_reason, str) and "finish_reason" not in attributes:
            attributes["finish_reason"] = finish_reason
        tool_calls = getattr(message, "tool_calls", None)
        if tool_calls is not None and "tool_calls" not in attributes:
            attributes["tool_calls"] = len(tool_calls)
    if isinstance(usage, Mapping):
        attributes["token_usage"] = dict(usage)
    return attributes


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _elapsed_ms(started_ns: int) -> int:
    return max(0, (time.perf_counter_ns() - started_ns) // 1_000_000)


def _status_value(status: TraceStatus | str) -> str:
    return status.value if isinstance(status, TraceStatus) else str(status).upper()


def _error_fields(
    status: TraceStatus | str, error: BaseException | None
) -> dict[str, object]:
    if _status_value(status) == TraceStatus.SUCCESS.value:
        return {}
    fields: dict[str, object] = {
        "error_type": type(error).__name__ if error is not None else "TraceFailed"
    }
    if error is not None and str(error):
        fields["status_message"] = str(error)[:_MAX_STATUS_MESSAGE]
    return fields


def _safe_attributes(attributes: Mapping[str, object] | None) -> dict[str, object]:
    if attributes is None:
        return {}
    safe: dict[str, object] = {}
    for key, value in attributes.items():
        if not isinstance(key, str) or key.lower() in _SENSITIVE_ATTRIBUTES:
            continue
        sanitized = _safe_value(value, depth=0)
        if sanitized is not _OMIT:
            safe[key] = sanitized
    return safe


_OMIT = object()


def _safe_value(value: object, *, depth: int) -> object:
    if isinstance(value, Enum):
        return _safe_value(value.value, depth=depth)
    if value is None or isinstance(value, (str, bool, int)):
        return value[:2048] if isinstance(value, str) else value
    if isinstance(value, float):
        return value if math.isfinite(value) else _OMIT
    if depth >= 3:
        return _OMIT
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in _SENSITIVE_ATTRIBUTES:
                continue
            sanitized = _safe_value(item, depth=depth + 1)
            if sanitized is not _OMIT:
                result[key] = sanitized
        return result
    if isinstance(value, (list, tuple)):
        result_list = []
        for item in value[:100]:
            sanitized = _safe_value(item, depth=depth + 1)
            if sanitized is not _OMIT:
                result_list.append(sanitized)
        return result_list
    return _OMIT
