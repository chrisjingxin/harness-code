"""Trace 与函数 Span 装饰器，保留业务返回、异常和函数元数据。"""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, ParamSpec, TypeVar

from harness_agent.tracing.context import (
    _bind_span,
    _bind_trace,
    _reset_span,
    _reset_trace,
    current_trace,
)
from harness_agent.tracing.recorder import TraceRecorder, TraceStatus

_P = ParamSpec("_P")
_R = TypeVar("_R")
_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class FunctionCall:
    """安全字段提供器可见的调用快照，不提供任何隐式序列化。"""

    function: Callable[..., object]
    args: tuple[object, ...]
    kwargs: dict[str, object]
    result: object = None
    error: BaseException | None = None


def trace_monitor(
    *,
    session_id: str | Callable[..., str],
    run_id: str | Callable[..., str],
    log_dir: Path | str | Callable[..., Path | str],
    capture: str | Callable[..., str] = "full",
    retention_days: int | Callable[..., int] = 14,
    manual: bool = False,
) -> Callable[[Callable[_P, _R]], Callable[_P, _R]]:
    """建立或复用 Trace；manual=True 时由调用方在 Run 清理后显式关链。"""

    def decorate(function: Callable[_P, _R]) -> Callable[_P, _R]:
        def start(*args: object, **kwargs: object):
            active = current_trace()
            if active is not None:
                return None, None
            try:
                recorder = TraceRecorder(
                    session_id=_resolve(session_id, *args, **kwargs),
                    run_id=_resolve(run_id, *args, **kwargs),
                    log_dir=_resolve(log_dir, *args, **kwargs),
                    capture=_resolve(capture, *args, **kwargs),
                    retention_days=_resolve(retention_days, *args, **kwargs),
                )
                context = recorder.start_trace()
                return context, _bind_trace(context)
            except Exception:
                _LOGGER.warning("Session Trace 创建失败", exc_info=True)
                return None, None

        def finish(
            context: object,
            token: object,
            *,
            status: TraceStatus,
            error: BaseException | None,
            force: bool,
        ) -> None:
            if context is None or token is None:
                return
            try:
                if force or not manual or error is not None:
                    context.recorder.end_trace(status, error=error)
            except Exception:
                _LOGGER.warning("Session Trace 结束失败", exc_info=True)
            finally:
                if force or not manual or error is not None:
                    _reset_trace(token)

        if inspect.isasyncgenfunction(function):

            @functools.wraps(function)
            async def async_generator_wrapper(*args: object, **kwargs: object):
                if current_trace() is not None:
                    async for item in function(*args, **kwargs):
                        yield item
                    return
                context, token = start(*args, **kwargs)
                try:
                    async for item in function(*args, **kwargs):
                        yield item
                except GeneratorExit:
                    finish(context, token, status=TraceStatus.SUCCESS, error=None, force=True)
                    raise
                except BaseException as error:
                    finish(context, token, status=_error_status(error), error=error, force=True)
                    raise
                else:
                    finish(context, token, status=TraceStatus.SUCCESS, error=None, force=True)

            return async_generator_wrapper

        if inspect.iscoroutinefunction(function):

            @functools.wraps(function)
            async def async_wrapper(*args: object, **kwargs: object):
                if current_trace() is not None:
                    return await function(*args, **kwargs)
                context, token = start(*args, **kwargs)
                try:
                    result = await function(*args, **kwargs)
                except BaseException as error:
                    finish(context, token, status=_error_status(error), error=error, force=True)
                    raise
                finish(context, token, status=TraceStatus.SUCCESS, error=None, force=False)
                return result

            return async_wrapper

        if inspect.isgeneratorfunction(function):

            @functools.wraps(function)
            def generator_wrapper(*args: object, **kwargs: object):
                if current_trace() is not None:
                    yield from function(*args, **kwargs)
                    return
                context, token = start(*args, **kwargs)
                try:
                    yield from function(*args, **kwargs)
                except GeneratorExit:
                    finish(context, token, status=TraceStatus.SUCCESS, error=None, force=True)
                    raise
                except BaseException as error:
                    finish(context, token, status=_error_status(error), error=error, force=True)
                    raise
                else:
                    finish(context, token, status=TraceStatus.SUCCESS, error=None, force=True)

            return generator_wrapper

        @functools.wraps(function)
        def sync_wrapper(*args: object, **kwargs: object):
            if current_trace() is not None:
                return function(*args, **kwargs)
            context, token = start(*args, **kwargs)
            try:
                result = function(*args, **kwargs)
            except BaseException as error:
                finish(context, token, status=_error_status(error), error=error, force=True)
                raise
            finish(context, token, status=TraceStatus.SUCCESS, error=None, force=False)
            return result

        return sync_wrapper

    return decorate


def func_monitor(
    *,
    name: str,
    kind: str = "FUNC",
    attributes: Mapping[str, object]
    | Callable[[FunctionCall], Mapping[str, object]]
    | None = None,
    idempotency_key: str | Callable[[FunctionCall], str] | None = None,
    enabled: Callable[[], bool] | None = None,
    manual: bool = False,
) -> Callable[[Callable[_P, _R]], Callable[_P, _R]]:
    """把普通或异步函数记录为 Span，无活跃 Trace 时完全透传业务。"""

    def decorate(function: Callable[_P, _R]) -> Callable[_P, _R]:
        def begin(args: tuple[object, ...], kwargs: dict[str, object]):
            context = current_trace()
            if context is None:
                return None, None, None, None
            call = FunctionCall(function=function, args=args, kwargs=kwargs)
            try:
                if enabled is not None and not enabled():
                    return None, None, None, None
                key = (
                    idempotency_key(call)
                    if callable(idempotency_key)
                    else idempotency_key
                )
                parent = context.recorder.start_span(
                    name,
                    kind=kind,
                    attributes=None if callable(attributes) else attributes,
                    idempotency_key=key,
                )
                if parent is None:
                    return context, call, key, None
                return context, call, key, (parent, _bind_span(parent))
            except Exception:
                _LOGGER.warning("函数 Span 创建失败: %s", name, exc_info=True)
                return context, call, None, None

        def finish(
            state: object,
            args: tuple[object, ...],
            kwargs: dict[str, object],
            *,
            result: object,
            error: BaseException | None,
        ) -> None:
            context, call, key, span_state = state
            if context is None or span_state is None:
                return
            span, token = span_state
            try:
                final_call = FunctionCall(
                    function=function, args=args, kwargs=kwargs, result=result, error=error
                )
                final_attributes = attributes(final_call) if callable(attributes) else attributes
            except Exception:
                _LOGGER.warning("函数 Span 安全字段生成失败: %s", name, exc_info=True)
                final_attributes = None
            finally:
                _reset_span(token)
            try:
                if manual and error is None:
                    context.recorder.annotate_span(span, final_attributes or {})
                    return
                context.recorder.end_span(
                    span,
                    TraceStatus.SUCCESS if error is None else _error_status(error),
                    attributes=final_attributes,
                    error=error,
                )
            except Exception:
                _LOGGER.warning("函数 Span 结束失败: %s", name, exc_info=True)

        if inspect.iscoroutinefunction(function):

            @functools.wraps(function)
            async def async_wrapper(*args: object, **kwargs: object):
                state = begin(args, kwargs)
                if state[0] is None:
                    return await function(*args, **kwargs)
                try:
                    result = await function(*args, **kwargs)
                except BaseException as error:
                    finish(state, args, kwargs, result=None, error=error)
                    raise
                finish(state, args, kwargs, result=result, error=None)
                return result

            return async_wrapper

        @functools.wraps(function)
        def sync_wrapper(*args: object, **kwargs: object):
            state = begin(args, kwargs)
            if state[0] is None:
                return function(*args, **kwargs)
            try:
                result = function(*args, **kwargs)
            except BaseException as error:
                finish(state, args, kwargs, result=None, error=error)
                raise
            finish(state, args, kwargs, result=result, error=None)
            return result

        return sync_wrapper

    return decorate


def _resolve(value: Any, *args: object, **kwargs: object) -> Any:
    return value(*args, **kwargs) if callable(value) else value


def _error_status(error: BaseException) -> TraceStatus:
    if isinstance(error, asyncio.CancelledError):
        return TraceStatus.CANCELLED
    return TraceStatus.FAILED
