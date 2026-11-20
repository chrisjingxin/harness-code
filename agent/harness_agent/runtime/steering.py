"""一次 Build Run 的追发入口。消息在模型边界消费，退出或未取走超时可明确拒绝。"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass


@dataclass(slots=True)
class _Pending:
    request_id: str
    text: str
    result: asyncio.Future[bool]


class RunSteering:
    """只接受一条在途消息，且只有属于当前 Run 的模型边界可确认取走。"""

    def __init__(self, turn_id: str) -> None:
        self.turn_id = turn_id
        self._pending: _Pending | None = None
        self._inserting = False
        self._closed = False
        self._recorded: set[str] = set()
        self.record: Callable[[str, str], Awaitable[None]] | None = None

    async def submit(self, request_id: str, text: str) -> bool:
        """在模型收到消息前等待；若 25 秒内未到边界，撤掉该条消息。"""
        if (self._closed or self.record is None or self._pending is not None or self._inserting
            or request_id in self._recorded or len(self._recorded) >= 8):
            return False
        pending = _Pending(request_id, text, asyncio.get_running_loop().create_future())
        self._pending = pending
        try:
            async with asyncio.timeout(25):
                return await asyncio.shield(pending.result)
        except TimeoutError:
            if self._pending is pending:
                self._pending = None
                return False
            # 已取走的消息只能由模型边界确认，避免误报拒绝后重复发送。
            return await asyncio.shield(pending.result)
        except asyncio.CancelledError:
            if self._pending is pending:
                self._pending = None
            raise

    async def consume(self, *, closing_if_empty: bool = False) -> str | None:
        """先记入同一 Run 的对话记录，再把文字交给模型。"""
        pending = self._pending
        if self._closed or pending is None or self.record is None:
            if closing_if_empty:
                self.close()
            return None
        self._pending = None
        self._inserting = True
        try:
            await self.record(pending.request_id, pending.text)
        except BaseException:
            pending.result.set_result(False)
            raise
        finally:
            self._inserting = False
        self._recorded.add(pending.request_id)
        pending.result.set_result(True)
        return pending.text

    def close(self) -> None:
        """拒绝后续请求，并通知尚未被模型取走的请求。"""
        self._closed = True
        if self._pending is not None:
            self._pending.result.set_result(False)
            self._pending = None
