"""ThreadPersistence 测试用的最小 Run 受理辅助函数。"""

from __future__ import annotations

import sqlite3
from collections.abc import Mapping, Sequence
from typing import Any, cast

from harness_agent.runtime.execution_binding import (
    RunExecutionBinding,
    SafeModelProfile,
    SelectionOrigin,
    ThreadExecutionSelection,
)
from harness_agent.threads.thread_persistence import (
    AcceptRun,
    ThreadPersistence,
    TranscriptAppend,
)


def create_legacy_prompt_epoch_table(connection: sqlite3.Connection) -> None:
    """为迁移测试创建 v8 前的临时 PromptEpoch 表。"""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS harness_prompt_epochs (
            project_fingerprint TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            prompt_version INTEGER NOT NULL,
            system_prompt TEXT NOT NULL,
            environment_snapshot TEXT NOT NULL,
            readonly_memory TEXT NOT NULL,
            skill_index TEXT NOT NULL,
            tool_schema_fingerprint TEXT NOT NULL,
            system_fingerprint TEXT NOT NULL,
            history_rewrite_version TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            prefix_change_reason TEXT NOT NULL DEFAULT 'new_thread',
            PRIMARY KEY (project_fingerprint, thread_id)
        )
        """
    )


def test_binding(thread_id: str, run_id: str) -> RunExecutionBinding:
    """构造不依赖真实配置的最小不可变 Run binding。"""
    return RunExecutionBinding(
        thread_id=thread_id,
        run_id=run_id,
        requested_selection=ThreadExecutionSelection("test"),
        actual_primary=SafeModelProfile(
            profile_id="test",
            model="test-model",
            provider_label="Test",
            context_window_tokens=128_000,
            capabilities=("streaming", "tool-calling"),
            is_default=True,
            available=True,
            unavailable_reason=None,
            source="test",
        ),
        selection_origin=SelectionOrigin.REQUEST,
        runtime_profile_id="test-runtime",
        created_at_ms=1,
    )


async def accept_thread(
    store: ThreadPersistence,
    thread_id: str,
    message: str,
    *,
    run_id: str | None = None,
) -> None:
    """通过唯一的 Run 生命周期入口创建测试 Thread 索引。"""
    await store.accept_run(
        AcceptRun(
            message=message,
            binding=test_binding(thread_id, run_id or f"fixture-{thread_id}-{message}"),
        )
    )


async def seed_thread(
    store: ThreadPersistence,
    thread_id: str,
    messages: Sequence[Mapping[str, str]],
) -> None:
    """预置一条可被 `session/load` 回放的线程。

    输入：`messages` 是 `{"kind": ..., "content": ...}` 序列，第一条必须是 `user`
          （线程索引由第一条用户消息建立）；`tool` 记录可带 `tool_name` 与
          `tool_call_id`，与真实 Run 写出的历史同形。
    """
    first = messages[0]
    if first.get("kind") != "user":
        raise ValueError("seed_thread 的第一条消息必须是 user")
    await accept_thread(store, thread_id, str(first["content"]))
    rest = tuple(
        TranscriptAppend(
            thread_id=thread_id,
            record_id=f"seed:{thread_id}:{index}",
            kind=cast(Any, item.get("kind")),
            content=str(item["content"]),
            tool_call_id=item.get("tool_call_id"),
            tool_name=item.get("tool_name"),
        )
        for index, item in enumerate(messages[1:], start=1)
    )
    if rest:
        await store.append_transcript_batch(rest)


def async_return(value: object):
    """构造返回固定值的 async 可调用；用于 workspace_revision 异步端口 fake。"""

    async def _return() -> object:
        return value

    return _return
