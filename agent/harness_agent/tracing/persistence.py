"""观察既有事务锁与写入计数，不增加 SQL 或改变提交次数。"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from harness_agent.tracing.context import current_span, current_trace

_LOGGER = logging.getLogger(__name__)


@asynccontextmanager
async def observe_transaction(lock: Any, connection: Any) -> AsyncIterator[None]:
    """保持原锁的异常和释放语义，向当前 db.persist 补入真实计数。"""
    trace, span = current_trace(), current_span()
    if trace is None or span is None or span.name != "db.persist":
        async with lock:
            yield
        return
    started = time.perf_counter_ns()
    async with lock:
        waited = (time.perf_counter_ns() - started) / 1_000_000
        try:
            before = connection.total_changes
        except Exception:
            before = None
        error = None
        try:
            yield
        except BaseException as exc:
            error = exc
            raise
        finally:
            trace, span = current_trace(), current_span()
            if trace is not None and span is not None and span.name == "db.persist":
                try:
                    attributes: dict[str, object] = {"lock_wait_ms": waited}
                    if error is None and before is not None:
                        attributes["rows"] = max(0, connection.total_changes - before)
                    trace.recorder.annotate_span(span, attributes)
                except Exception:
                    _LOGGER.warning("事务 trace 采集失败", exc_info=True)
