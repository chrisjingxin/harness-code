"""Trace ContextVar：在同步、异步及后台任务间传播当前调用关系。"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from typing import TYPE_CHECKING, Iterator

if TYPE_CHECKING:
    from harness_agent.tracing.recorder import SpanHandle, TraceContext

_CURRENT_TRACE: ContextVar[TraceContext | None] = ContextVar("harness_trace", default=None)
_CURRENT_SPAN: ContextVar[SpanHandle | None] = ContextVar("harness_span", default=None)


def current_trace() -> TraceContext | None:
    """返回仍可写入的当前 Trace，已关闭上下文不会泄漏给新业务。"""
    context = _CURRENT_TRACE.get()
    if context is None or context.recorder.closed:
        return None
    return context


def current_span() -> SpanHandle | None:
    """返回当前 Span，供下一次 start_span 推导父子关系。"""
    return _CURRENT_SPAN.get()


@contextmanager
def use_trace(context: TraceContext) -> Iterator[TraceContext]:
    """显式绑定 Trace；用于不能依赖隐式 ContextVar 继承的调用边界。"""
    token = _CURRENT_TRACE.set(context)
    span_token = _CURRENT_SPAN.set(None)
    try:
        yield context
    finally:
        _CURRENT_SPAN.reset(span_token)
        _CURRENT_TRACE.reset(token)


def _bind_trace(context: TraceContext) -> Token[TraceContext | None]:
    return _CURRENT_TRACE.set(context)


def _reset_trace(token: Token[TraceContext | None]) -> None:
    _CURRENT_TRACE.reset(token)


def _bind_span(span: SpanHandle | None) -> Token[SpanHandle | None]:
    return _CURRENT_SPAN.set(span)


def _reset_span(token: Token[SpanHandle | None]) -> None:
    _CURRENT_SPAN.reset(token)
