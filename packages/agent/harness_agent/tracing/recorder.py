"""统一 TraceRecorder：图内外入口共享同一事件 envelope 与生命周期。"""

from __future__ import annotations

import functools
import json
import logging
import math
import threading
import time
import uuid
from dataclasses import dataclass, field
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

_SCHEMA_VERSION = 2
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
    attributes: dict[str, object] = field(default_factory=dict)


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
        capture: str = "full",
        retention_days: int = 14,
        max_file_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        self.session_id = session_id
        self.run_id = run_id
        self.trace_id = uuid.uuid4().hex
        self.root_span_id = uuid.uuid4().hex
        self._capture = capture if capture in {"full", "meta", "off"} else "full"
        self._payloads: dict[str, str] = {}
        self._first_tokens: dict[str, int] = {}
        self._writer = writer or JsonlTraceWriter(
            log_dir,
            max_file_bytes=max_file_bytes,
            retention_days=retention_days,
        )
        self._context = TraceContext(
            recorder=self,
            session_id=session_id,
            run_id=run_id,
            trace_id=self.trace_id,
            root_span_id=self.root_span_id,
        )
        self._lock = threading.RLock()
        self._steps: dict[str, SpanHandle] = {}
        self._step_numbers: dict[str, int] = {}
        self._handles: dict[str, SpanHandle] = {}
        self._deferred_spans: dict[str, int] = {}
        self._usage: dict[str, int] = {}
        self._policy_spans: dict[str, str] = {}
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
            self._root_attributes = self._project(attributes)
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
        attributes: Mapping[str, object] | None = None,
        error: BaseException | None = None,
    ) -> None:
        """恰好发出一次 trace.end，并让所有后续 Span 写入失效。"""
        for handle in tuple(self._steps.values()):
            self.end_span(handle, status, error=error)
        self._steps.clear()
        with self._lock:
            if not self._started or self._closed:
                return
            self._closed = True
            merged = dict(self._root_attributes)
            merged["usage"] = dict(self._usage)
            if self._usage.get("input_tokens", 0) > 0:
                merged["cache_hit_ratio"] = self._usage.get("cache_read_tokens", 0) / self._usage["input_tokens"]
            merged.update(self._project(attributes))
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
                attributes=merged,
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
        minimum_duration_ms: int = 0,
        defer_start: bool = False,
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
                branch_step = self._steps.get(self._step_parent())
                if active is not None and active.span_id in self._open_spans:
                    parent = branch_step.span_id if active.name == "tool.call" and branch_step is not None else active.span_id
                else:
                    parent = branch_step.span_id if branch_step is not None else self.root_span_id
            projected = self._project(attributes)
            ancestor = self._handles.get(parent)
            while ancestor is not None:
                if ancestor.name == "step":
                    if "step" in ancestor.attributes:
                        projected.setdefault("step", ancestor.attributes["step"])
                    break
                ancestor = self._handles.get(ancestor.parent_span_id)
            span = SpanHandle(
                span_id=span_id,
                parent_span_id=parent,
                name=name,
                kind=kind,
                idempotency_key=idempotency_key,
                start_time_ms=_now_ms(),
                started_ns=time.perf_counter_ns(),
                attributes=projected,
            )
            self._open_spans.add(span_id)
            self._handles[span_id] = span
            if name == "policy.evaluate" and attributes and attributes.get("call_id"):
                self._policy_spans[str(attributes["call_id"])] = span_id
            event: dict[str, object] = {
                "start_time_ms": span.start_time_ms,
                "attributes": span.attributes,
            }
            if idempotency_key is not None:
                event["idempotency_key"] = idempotency_key
            if minimum_duration_ms > 0 or defer_start:
                self._deferred_spans[span_id] = minimum_duration_ms
            else:
                self._write(
                    "span.start", span_id=span_id, parent_span_id=parent,
                    name=name, kind=kind, **event,
                )
            return span

    def discard_deferred_span(self, span: SpanHandle | None) -> None:
        """丢弃尚未发布的 Span，供无重试的逻辑调用省略首次 attempt。"""
        if span is None:
            return
        with self._lock:
            if self._closed or span.span_id not in self._deferred_spans:
                return
            self._deferred_spans.pop(span.span_id, None)
            self._open_spans.discard(span.span_id)

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
            threshold = self._deferred_spans.pop(span.span_id, None)
            if threshold is not None:
                if threshold and _status_value(status) == TraceStatus.SUCCESS.value and _elapsed_ms(span.started_ns) < threshold:
                    return
                # 延迟节点结束时成对发布；阈值未达标的成功节点不产生孤立 start。
                self._write(
                    "span.start", span_id=span.span_id, parent_span_id=span.parent_span_id,
                    name=span.name, kind=span.kind, start_time_ms=span.start_time_ms,
                    attributes=span.attributes,
                )
            merged = dict(span.attributes)
            merged.update(self._project(attributes))
            if span.name == "llm.call" and isinstance(merged.get("usage"), Mapping):
                for key, value in merged["usage"].items():
                    if isinstance(value, int) and not isinstance(value, bool):
                        self._usage[key] = self._usage.get(key, 0) + value
            event: dict[str, object] = {
                "start_time_ms": span.start_time_ms,
                "end_time_ms": _now_ms(),
                "duration_ms": _elapsed_ms(span.started_ns),
                "status": _status_value(status),
                "attributes": merged,
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
        self.note_first_token()
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
        """只观察中间件自身的前后钩子；图和模型包装耗时不冒充中间件。"""
        marker = _chain_marker(serialized or {}, metadata)
        if not marker.endswith((".before_model", ".after_model", ".before_agent", ".after_agent")):
            return
        actual_name = kwargs.get("name") or (serialized or {}).get("name") or marker
        if actual_name != marker:
            return
        handle = self.start_span("graph.node", kind="NODE", attributes={"node": marker}, minimum_duration_ms=50)
        if handle is not None:
            self._callback_spans[run_id] = _CallbackSpan(handle)

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
        # v2 的模型、工具和节点 span 由显式中间件发出。通用回调不再建树。
        return

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

    def policy_span(self, call_id: str) -> str | None:
        """返回本次 Run 中工具调用实际对应的审批 span。"""
        return self._policy_spans.get(call_id)

    def span_for_key(self, idempotency_key: str) -> SpanHandle | None:
        """取得尚未关闭的手动 span，供生命周期所有者接手收尾。"""
        with self._lock:
            return next((span for span in self._handles.values()
                         if span.idempotency_key == idempotency_key and span.span_id in self._open_spans), None)

    def annotate_root(self, attributes: Mapping[str, object]) -> None:
        """把已观测运行信息并入根结束记录，不增加记账节点。"""
        with self._lock:
            self._root_attributes.update(self._project(attributes))

    def annotate_span(self, span: SpanHandle, attributes: Mapping[str, object]) -> None:
        """向仍打开的 span 补充已观测元数据，始终经过档位过滤。"""
        with self._lock:
            if span.span_id in self._open_spans:
                span.attributes.update(self._project(attributes))

    def _step_parent(self) -> str:
        """从当前调用祖先确定执行分支；每个父工具拥有独立 Step 窗口。"""
        active = current_span()
        while active is not None and active.span_id in self._handles:
            if active.name == "step":
                return active.parent_span_id
            if active.name == "tool.call":
                return active.span_id
            active = self._handles.get(active.parent_span_id)
        return self.root_span_id

    def open_step(self) -> SpanHandle | None:
        """打开新的一轮。上一轮还开着时先关掉，工具 span 才能挂在当前轮下面。"""
        parent = self._step_parent()
        self.close_step()
        number = self._step_numbers.get(parent, 0) + 1
        self._step_numbers[parent] = number
        handle = self.start_span("step", kind="STEP", parent_span_id=parent, attributes={"step": number})
        if handle is not None:
            self._steps[parent] = handle
        return handle

    def close_step(
        self,
        status: TraceStatus | str = TraceStatus.SUCCESS,
        *,
        error: BaseException | None = None,
    ) -> None:
        """结束当前轮次。没有打开的轮次时不写事件。"""
        handle = self._steps.pop(self._step_parent(), None)
        if handle is not None:
            self.end_span(handle, status, error=error)

    def payload(self, kind: str, body: object) -> str:
        """脱敏后按内容去重写入 payload。meta 和 off 不落正文。"""
        if self._capture != "full" or not self._started or self._closed:
            return ""
        from harness_agent.tracing.session import payload_digest, redact

        redacted = redact(body)
        digest = payload_digest(redacted)
        with self._lock:
            existing = self._payloads.get(digest)
            if existing is not None:
                return existing
            payload_id = f"p{len(self._payloads) + 1}"
            self._payloads[digest] = payload_id
            encoded = json.dumps(redacted, ensure_ascii=False, separators=(",", ":"))
            self._write(
                "payload",
                payload_id=payload_id,
                sha256=digest,
                bytes=len(encoded.encode("utf-8")),
                kind=kind,
                body=redacted,
            )
            return payload_id

    def note_first_token(self) -> None:
        """把当前 llm.call 的首 token 延迟记在内存里，结束时再写入属性。"""
        active = current_span()
        if active is None or active.name != "llm.call":
            return
        self._first_tokens.setdefault(active.span_id, _elapsed_ms(active.started_ns))

    def first_token_ms(self, span_id: str) -> int | None:
        """返回已观察到的首 token 延迟。"""
        return self._first_tokens.get(span_id)

    def _project(self, attributes: Mapping[str, object] | None) -> dict[str, object]:
        """meta 档位去掉载荷引用，避免只关正文却留下指针。"""
        safe = _safe_attributes(attributes)
        if self._capture == "full":
            return safe
        return {
            key: value
            for key, value in safe.items()
            if not key.endswith("_ref") and not key.endswith("_refs")
        }

    def _write(self, event: str, **fields: object) -> None:
        if self._capture == "off":
            return
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
