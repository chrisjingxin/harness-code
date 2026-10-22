"""Snapshot 文件工具的窗口渲染、大小限制和稳定错误响应。"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.messages import ToolMessage

from harness_agent.threads.text_backend import TextDocument
from harness_agent.tools.file_mutation import (
    CommittedFileMutation,
    MutationChangedRange,
    PreparedFileMutation,
)
from harness_agent.tools.file_tools import FileToolContractError
from harness_agent.tools.snapshot_file_schema import MAX_READ_LIMIT

MAX_READ_RESULT_BYTES = 32 * 1024
MAX_EDIT_TEXT_BYTES = 64 * 1024
MAX_EDIT_BATCH_BYTES = 256 * 1024
"""一次 edit_file 全部 old_string + new_string 的 UTF-8 字节总和上限。"""
MAX_MUTATION_BYTES = 2 * 1024 * 1024
LOCAL_CONTEXT_PADDING_LINES = 3


def require_actual_document(document: TextDocument | None) -> TextDocument:
    """确保 mutation commit 返回可重新读取的真实文本版本。"""
    if document is None:
        raise FileToolContractError("POST_WRITE_DRIFT")
    return document


def attach_post_write_drift(
    payload: dict[str, Any], committed: CommittedFileMutation, plan: PreparedFileMutation
) -> None:
    """返回批准版本与实际版本的两段有界 diff。"""
    if committed.drift is None:
        return
    payload["warning"] = {
        "code": "POST_WRITE_DRIFT",
        "message": "提交后实际文件内容与已批准内容不同，请使用返回的实际 Snapshot。",
        "proposed_diff": plan.diff.text,
        "actual_diff": committed.drift.text,
        "added_lines": committed.drift.added_lines,
        "removed_lines": committed.drift.removed_lines,
        "truncated": plan.diff.truncated or committed.drift.truncated,
    }


def render_changed_context(
    document: TextDocument, changed_range: MutationChangedRange
) -> tuple[str, int, int, bool, bool]:
    """以实际新版本行号返回变更附近的有界窗口。"""
    line_count = len(document.content.splitlines(keepends=True))
    changed_start = min(max(changed_range.start_line - 1, 0), line_count)
    changed_end = min(max(changed_range.end_line, changed_start), line_count)
    offset = max(changed_start - LOCAL_CONTEXT_PADDING_LINES, 0)
    desired_end = min(changed_end + LOCAL_CONTEXT_PADDING_LINES, line_count)
    desired_limit = max(desired_end - offset, 0)
    limit = min(desired_limit, MAX_READ_LIMIT)
    rendered, shown_count, byte_truncated = render_window(document.content, offset, limit)
    return rendered, offset, shown_count, byte_truncated or desired_limit > limit, not byte_truncated


def tool_payload(message: ToolMessage) -> dict[str, Any] | None:
    """只解析本 contract 生成的 JSON payload。"""
    try:
        payload = json.loads(str(message.content))
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def observation_path(value: object) -> str:
    """将 virtual path 投影为有限相对日志字段。"""
    if not isinstance(value, str):
        return "-"
    relative = value.lstrip("/").replace("\n", "?").replace("\r", "?")
    return relative[:256] or "."


def render_window(content: str, offset: int, limit: int) -> tuple[str, int, bool]:
    """返回带普通源行号的局部文本；字节截断时不授予 seen range。"""
    lines = content.splitlines(keepends=True)
    selected = lines[offset : offset + limit]
    rendered = "\n".join(
        f"{offset + index + 1}\t{line.rstrip(chr(13) + chr(10))}"
        for index, line in enumerate(selected)
    )
    encoded = rendered.encode("utf-8")
    if len(encoded) <= MAX_READ_RESULT_BYTES:
        return rendered, len(selected), False
    prefix = encoded[:MAX_READ_RESULT_BYTES].decode("utf-8", errors="ignore")
    return f"{prefix}\n[输出因字节上限截断；此窗口不可用于编辑]", 0, True


def shown_lines(offset: int, count: int) -> dict[str, int | None]:
    """以 1-based source line 报告实际放入 context 的区间。"""
    if count == 0:
        return {"start_line": None, "end_line": None}
    return {"start_line": offset + 1, "end_line": offset + count}


def normalize_line_endings(value: str, document: TextDocument) -> str:
    """把模型复制的换行统一回实际文件换行风格。"""
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    if document.identity.line_ending == "crlf":
        return normalized.replace("\n", "\r\n")
    if document.identity.line_ending == "cr":
        return normalized.replace("\n", "\r")
    return normalized


def source_line_range(content: str, start: int, old_string: str) -> tuple[int, int]:
    """计算唯一 exact match 覆盖的 0-based 半开源行区间。"""
    start_line = _logical_line_break_count(content[:start])
    touched = _logical_line_break_count(old_string)
    if not old_string.endswith(("\n", "\r")):
        touched += 1
    return start_line, start_line + max(1, touched)


def _logical_line_break_count(value: str) -> int:
    """统计 CRLF、LF 与 CR 逻辑换行数，CRLF 只计一次。"""
    return value.count("\n") + value.replace("\r\n", "").count("\r")


def require_text_size(value: str, *, edit_index: int | None = None) -> None:
    """限制单个 exact-string 参数。"""
    if len(value.encode("utf-8")) > MAX_EDIT_TEXT_BYTES:
        raise FileToolContractError("EDIT_TEXT_TOO_LARGE", edit_index=edit_index)


def require_edit_batch_size(edits: Sequence[tuple[str, str]]) -> None:
    """限制 edits[] 的单串与总量；总量保护审批预览与内存，单串沿用 64 KiB。"""
    total = 0
    for index, (old_string, new_string) in enumerate(edits):
        require_text_size(old_string, edit_index=index)
        require_text_size(new_string, edit_index=index)
        total += len(old_string.encode("utf-8")) + len(new_string.encode("utf-8"))
    if total > MAX_EDIT_BATCH_BYTES:
        raise FileToolContractError("EDIT_TEXT_TOO_LARGE")


def apply_exact_edits(
    content: str,
    edits: Sequence[tuple[str, str]],
    *,
    has_seen: Callable[[int, int], bool],
    allow_empty_initialization: bool,
) -> str:
    """把一批精确替换合成一份新全文；任何一处不满足就整批拒绝，不产生部分结果。

    输入 → 每处在同一份提交前内容里精确匹配且唯一 → 落在已读行范围内 → 各处区间互不重叠
    → 从后往前一次性替换。所有匹配都针对原始 content，前一处的 new_string 不会影响后一处
    的匹配，所以模型不必推算替换后的位置。edits 里的换行风格须已统一为文件风格。

    只会抛出 FileToolContractError，错误带 edit_index（指向 edits 数组下标）。
    """
    empty = [index for index, (old_string, _new) in enumerate(edits) if old_string == ""]
    if empty:
        # 空 old_string 只允许单独初始化零行空文件，绝不在非空文件里猜插入位置。
        if len(edits) > 1 or not allow_empty_initialization:
            raise FileToolContractError("INVALID_EDIT", edit_index=empty[0])
        return edits[0][1]
    spans: list[tuple[int, int, int, str]] = []
    for index, (old_string, new_string) in enumerate(edits):
        start = content.find(old_string)
        if start < 0:
            raise FileToolContractError("EXACT_MATCH_NOT_FOUND", edit_index=index)
        # 从首个起点的下一字符继续搜索，才能把 `aaa` 中的两个 `aa` 判为歧义。
        if content.find(old_string, start + 1) >= 0:
            raise FileToolContractError("AMBIGUOUS_MATCH", edit_index=index)
        start_line, end_line = source_line_range(content, start, old_string)
        if not has_seen(start_line, end_line):
            raise FileToolContractError("UNREAD_RANGE", edit_index=index)
        spans.append((start, start + len(old_string), index, new_string))
    # 按文件位置排序后只需比较相邻两项；首尾相接（后.start == 前.end）不算重叠。
    spans.sort(key=lambda span: (span[0], span[2]))
    for previous, following in zip(spans, spans[1:]):
        if following[0] < previous[1]:
            raise FileToolContractError("OVERLAPPING_EDITS", edit_index=following[2])
    proposed = content
    for start, end, _index, new_string in reversed(spans):
        proposed = proposed[:start] + new_string + proposed[end:]
    return proposed


def require_mutation_text_size(value: str) -> None:
    """限制创建或替换后的完整文本。"""
    if len(value.encode("utf-8")) > MAX_MUTATION_BYTES:
        raise FileToolContractError("EDIT_TEXT_TOO_LARGE")


def require_mutation_size(document: TextDocument) -> None:
    """拒绝超过完整 mutation 上限的文件。"""
    if document.identity.byte_length > MAX_MUTATION_BYTES:
        raise FileToolContractError("UNSUPPORTED_FILE_TYPE")


def message(
    name: str, tool_call_id: str, payload: dict[str, Any], *, status: str = "success"
) -> ToolMessage:
    """序列化稳定工具 JSON，不把内部异常带进模型上下文。"""
    return ToolMessage(
        content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        name=name,
        tool_call_id=tool_call_id,
        status=status,
    )


def error_code(exc: Exception) -> str:
    """将受控 adapter/store 错误映射为公开稳定 code。"""
    code = getattr(exc, "code", None)
    if not isinstance(code, str) or not code:
        return "COMMIT_FAILED"
    return {
        "TEXT_ENCODING_UNSUPPORTED": "UNSUPPORTED_FILE_TYPE",
        "TEXT_NEWLINE_MIXED": "UNSUPPORTED_FILE_TYPE",
        "BACKEND_CREATE_FAILED": "COMMIT_FAILED",
        "BACKEND_REPLACE_FAILED": "COMMIT_FAILED",
        "BACKEND_DELETE_FAILED": "COMMIT_FAILED",
        "BACKEND_READ_FAILED": "COMMIT_FAILED",
        "BACKEND_TEXT_UNSUPPORTED": "BACKEND_CAS_UNSUPPORTED",
        "BACKEND_READ_UNSUPPORTED": "BACKEND_CAS_UNSUPPORTED",
        "BACKEND_DOCUMENT_INVALID": "BACKEND_CAS_UNSUPPORTED",
        "IS_DIRECTORY": "UNSUPPORTED_FILE_TYPE",
    }.get(code, code)


def error_message(code: str) -> str:
    """提供短、不会暴露文件正文或后端细节的中文错误说明。"""
    messages = {
        "SNAPSHOT_REQUIRED": "修改或删除必须先读取文件并提供 Snapshot。",
        "SNAPSHOT_EXPIRED": "Snapshot 已过期。",
        "SNAPSHOT_SCOPE_MISMATCH": "Snapshot 不属于当前 Thread、路径或 backend。",
        "STALE_FILE": "文件在读取后已变化。",
        "UNREAD_RANGE": "目标文本不完全位于已读取的源行范围。",
        "FILE_ALREADY_EXISTS": "目标文件已存在，write_file 不会覆盖。",
        "FILE_NOT_FOUND": "目标文件不存在。",
        "UNSUPPORTED_FILE_TYPE": "文件不是可安全修改的受支持文本。",
        "NO_CHANGES": "替换后内容没有变化。",
        "COMMIT_CONFLICT": "提交前文件已变化。",
        "BACKEND_CAS_UNSUPPORTED": "当前 backend 不支持安全的 compare-and-replace。",
        "POST_WRITE_DRIFT": "提交后文件被外部保存钩子改变，无法生成可用 Snapshot。",
        "PATH_SYMLINK_UNSUPPORTED": "文件路径不能包含符号链接。",
        "EXACT_MATCH_NOT_FOUND": "已读原文本不再存在。",
        "AMBIGUOUS_MATCH": "edits 中该处的 old_string 在文件中不是唯一匹配。",
        "INVALID_EDIT": "空 old_string 只允许单独初始化当前 Snapshot 对应的空文件。",
        "OVERLAPPING_EDITS": "edits 中有两处匹配到的文本区间重叠。",
        "TOO_MANY_EDITS": "edits 的项数超过单次调用上限，或该文件只允许单次修改。",
        "EDIT_TEXT_TOO_LARGE": "edits 的单个字符串或总大小超过上限。",
        "VIRTUAL_READONLY": "虚拟文件只允许读取。",
        "FILE_TOOL_SCHEMA_INVALID": (
            "文件工具参数不属于当前 canonical schema；edit_file 必须使用 edits[]，"
            "每项恰好包含 old_string 与 new_string。"
        ),
    }
    return messages.get(code, "文件工具无法安全完成该操作。")


def next_action(code: str) -> str:
    """每个公开错误仅给出一个确定的恢复动作。"""
    if code in {"SNAPSHOT_REQUIRED", "SNAPSHOT_EXPIRED", "STALE_FILE", "UNREAD_RANGE"}:
        return "重新读取受影响文件或区间后重试。"
    if code == "SNAPSHOT_SCOPE_MISMATCH":
        return "在当前 Thread 重新读取目标路径。"
    if code == "FILE_ALREADY_EXISTS":
        return "先读取现有文件，再使用 edit_file。"
    if code in {"EXACT_MATCH_NOT_FOUND", "AMBIGUOUS_MATCH"}:
        return "重新读取目标区间，修正 edit_index 指向的那一处为唯一的 old_string 后整批重试；本次没有写入任何内容。"
    if code == "INVALID_EDIT":
        return "非空文件请从已读内容复制唯一的 old_string；空文件初始化只能在 edits 中单独一项。"
    if code == "OVERLAPPING_EDITS":
        return "合并或拆开重叠的两处，使各处 old_string 的文本区间互不重叠后整批重试。"
    if code == "TOO_MANY_EDITS":
        return "拆成多次 edit_file 调用：普通文件使用上一次返回的 snapshot_id；会话计划文件没有 snapshot_id，每次只改一处。"
    if code == "EDIT_TEXT_TOO_LARGE":
        return "缩小 old_string/new_string，或拆成多次调用。"
    if code == "BACKEND_CAS_UNSUPPORTED":
        return "切换到支持安全文本 mutation 的执行模式。"
    return "检查参数后重试。"


__all__ = [
    "MAX_EDIT_BATCH_BYTES",
    "apply_exact_edits",
    "attach_post_write_drift",
    "error_code",
    "error_message",
    "message",
    "next_action",
    "normalize_line_endings",
    "observation_path",
    "render_changed_context",
    "render_window",
    "require_actual_document",
    "require_edit_batch_size",
    "require_mutation_size",
    "require_mutation_text_size",
    "require_text_size",
    "shown_lines",
    "source_line_range",
    "tool_payload",
]
