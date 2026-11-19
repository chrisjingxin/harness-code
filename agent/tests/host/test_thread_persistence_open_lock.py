"""线程持久层打开锁：并发 `_ensure_thread_persistence()` 只打开一次数据库。

【为什么锁在这里】
`ThreadPersistence.open` 需要数百毫秒且会建立真实 SQLite 连接；两个并发调用
者若都通过 `_thread_persistence is None` 检查，会各开一个连接、漏关一份。
锁只包住「检查 + 打开」，打开失败不留半成品，下一个调用者可重开。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from harness_agent.threads.thread_persistence import ThreadPersistence
from tests.support.acp_harness import make_persistent_host


async def test_concurrent_ensure_shares_single_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """两个并发 _ensure_thread_persistence()：open 只执行一次，返回同一实例。"""
    host = make_persistent_host(tmp_path)
    calls = 0
    real_open = ThreadPersistence.open

    async def spy(*, project: Path, home: Path) -> Any:
        nonlocal calls
        calls += 1
        # 拉开检查窗口：无锁时两个调用者都能溜过 None 检查。
        await asyncio.sleep(0.05)
        return await real_open(project=project, home=home)

    monkeypatch.setattr(ThreadPersistence, "open", spy)
    first, second = await asyncio.gather(
        host._ensure_thread_persistence(),
        host._ensure_thread_persistence(),
    )
    assert calls == 1
    assert first is second is host._thread_persistence
    await host.close()


async def test_open_failure_leaves_no_half_open_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """打开失败不残留半成品：状态保持 None，下一个调用者可重试并抛原错误。"""
    host = make_persistent_host(tmp_path)

    async def boom(*, project: Path, home: Path) -> Any:
        raise RuntimeError("probe: open failed")

    monkeypatch.setattr(ThreadPersistence, "open", boom)
    with pytest.raises(RuntimeError, match="probe"):
        await host._ensure_thread_persistence()
    assert host._thread_persistence is None
    await host.close()
