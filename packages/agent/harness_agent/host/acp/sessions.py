"""ACP 会话列表与历史回放：线程摘要 → `SessionInfo`，历史消息 → `session/update`。

【这是做什么的？】
把 Host 的线程数据翻译成 ACP 的会话数据，供三处使用：
1. `session/list`：`ThreadSummary` → `SessionInfo`（标题、cwd、最后活动时间）；
2. `session/load`：历史 `ThreadMessage` → 一串 `session/update`（用户消息、助手正文、
   已完成的工具卡）；
3. `thread.summary` 广播：摘要 → `session_info_update`（后台起好标题后追加通知）。

【上下游】
- 上游：`server.py` 的 `list_sessions` / `load_session` / `_pump_thread_summary`。
- 下游：`tool_display.py` 的标题与类别规则、`translate.py` 的工具输出上限常量，
  以及官方 SDK 的 schema 类型。

【回放规则（输入 → 判断 → 输出）】
    ThreadMessage 列表
      → kind=user      → user_message_chunk，messageId = "{sessionId}:h{下标}"
      → kind=assistant → agent_message_chunk（超 64 K 切块，所有块共用一个 messageId）
      → kind=tool      → 一条 completed 的 tool_call，toolCallId = "{sessionId}:h{下标}"
      → 正文为空或未知类型 → 跳过，但下标照样占位

两个 id 前缀刻意不同：历史用会话 id，直播用 run id，永远不会撞车。下标占位（跳过的
消息也占一格）保证同一份历史每次回放得到同样的 id，客户端刷新页面不会把旧消息当新消息。

【已知取舍】回放不设条数上限：`open_thread` 本来就把全部消息读进内存，截断只会让历史
与检查点对不上；`# ponytail:` 注释标了天花板与升级路径。
"""

from __future__ import annotations

import datetime as _datetime
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Final

from acp.helpers import SessionUpdate, start_tool_call, text_block, tool_content
from acp.schema import (
    AgentMessageChunk,
    SessionInfo,
    SessionInfoUpdate,
    UserMessageChunk,
)

from harness_agent.host.acp.tool_display import sanitize_line, tool_kind, tool_title
from harness_agent.host.acp.translate import MAX_OUTPUT_CHARS
from harness_agent.threads.thread_records import ThreadSummary

LIST_SESSIONS_LIMIT: Final = 200
"""`session/list` 服务端固定条数：Host 只有一个工作区，一期不分页。"""

SESSION_TITLE_FALLBACK_CHARS: Final = 40
"""没有标题时取首条消息的前 40 个字符；再长客户端也放不下。"""

REPLAY_CHUNK_CHARS: Final = 64 * 1024
"""回放时单条 `agent_message_chunk` 的字符上限；超长历史切成多块同 id。"""


def iso_from_ms(ms: int) -> str:
    """把毫秒时间戳转成 UTC ISO 8601（固定毫秒精度、`Z` 结尾）。

    输入：`ms` 是 Host 侧的 epoch 毫秒；非法值由调用方过滤，这里不接 `None`。
    输出：形如 `2026-11-05T08:00:00.123Z`；用整数除法拼毫秒，避免浮点丢精度。
    """
    seconds, millis = divmod(int(ms), 1000)
    moment = _datetime.datetime.fromtimestamp(seconds, tz=_datetime.UTC)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{millis:03d}Z"


def session_info(summary: ThreadSummary, workspace: Path) -> SessionInfo:
    """把一条线程摘要翻成 `SessionInfo`：标题缺省取首条消息前 40 字。"""
    return SessionInfo(
        session_id=summary.thread_id,
        cwd=str(workspace),
        title=summary.title or _fallback_title(summary.first_message),
        updated_at=iso_from_ms(summary.updated_at_ms),
    )


def session_info_update(params: Mapping[str, object]) -> SessionInfoUpdate | None:
    """把 `thread.summary` 的 params 变成 `session_info_update`。

    输入：Host 的 `thread.summary` 广播参数（`thread_id`、`title`、
          `updated_at_ms` 等）。
    输出：标题为空时返回 `None`（标题刚刚生成才有通知的必要），否则带 title 与
          可选的 `updatedAt`。
    """
    title = params.get("title")
    if not isinstance(title, str) or not title:
        return None
    payload: dict[str, object] = {
        "sessionUpdate": "session_info_update",
        "title": sanitize_line(title),
    }
    updated_at = params.get("updated_at_ms")
    if isinstance(updated_at, int) and not isinstance(updated_at, bool):
        payload["updatedAt"] = iso_from_ms(updated_at)
    return SessionInfoUpdate.model_validate(payload)


def replay_updates(
    session_id: str, messages: Sequence[Mapping[str, object]]
) -> Iterator[SessionUpdate]:
    """按历史顺序产出回放 update；空正文与未知类型跳过，下标照样占位。

    历史里的 `tool` 记录没有成功/失败状态（`ThreadMessage` 不带），所以一律回放成
    `completed`；失败工具的回放差异登记在缺口表（GAP-22）。
    """
    # ponytail: 上万条历史会让首帧很慢；升级路径是只回放最近 N 条并在末尾补一条提示。
    for index, message in enumerate(messages):
        content = message.get("content")
        if not isinstance(content, str) or not content:
            continue
        kind = message.get("kind")
        if kind == "user":
            yield UserMessageChunk(
                session_update="user_message_chunk",
                content=text_block(content),
                message_id=f"{session_id}:h{index}",
            )
        elif kind == "assistant":
            message_id = f"{session_id}:h{index}"
            for offset in range(0, len(content), REPLAY_CHUNK_CHARS):
                yield AgentMessageChunk(
                    session_update="agent_message_chunk",
                    content=text_block(content[offset : offset + REPLAY_CHUNK_CHARS]),
                    message_id=message_id,
                )
        elif kind == "tool":
            raw_name = message.get("tool_name")
            tool_name = raw_name if isinstance(raw_name, str) and raw_name else "tool"
            yield start_tool_call(
                f"{session_id}:h{index}",
                tool_title(tool_name, None),
                kind=tool_kind(tool_name),
                status="completed",
                content=[tool_content(text_block(content[:MAX_OUTPUT_CHARS]))],
            )
        else:
            # `context` 等内部记录不是对话内容：跳过但保留下标。
            continue


def _fallback_title(first_message: str) -> str | None:
    """取首条消息的单行前 40 字；全空白时返回 `None`（不编造标题）。"""
    line = sanitize_line(first_message)[:SESSION_TITLE_FALLBACK_CHARS]
    return line or None


__all__ = [
    "LIST_SESSIONS_LIMIT",
    "REPLAY_CHUNK_CHARS",
    "SESSION_TITLE_FALLBACK_CHARS",
    "iso_from_ms",
    "replay_updates",
    "session_info",
    "session_info_update",
]
