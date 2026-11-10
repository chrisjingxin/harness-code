"""把已授权的文件字节格式化成与 CLI `@` 提及相同的附加上下文块。

【这是做什么的？】
ACP 的 `resource_link` 只带来路径。Host 确认文件在授权根内之后，这里按
10 KB/300 行的单文件上限和 20 KB/500 行的单轮预算决定内联还是占位。

【上下游】
- 上游：`server.py`。它负责读字节和问 Host 这条路径能不能看。
- 下游：无。本模块不 import policy，也不自己判断工作区边界。

格式与 `packages/cli/src/workspace/mention-resolver.ts` 对齐：行数按
`split(/\\r?\\n/)` 计算，单文件用 `>=` 判超限，累计用 `>` 判超预算。
超限、二进制和预算用尽都写成同一句「too large to inline」。
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

MAX_SINGLE_FILE_BYTES = 10 * 1024
MAX_SINGLE_FILE_LINES = 300
MAX_TOTAL_MENTIONS_BYTES = 20 * 1024
MAX_TOTAL_MENTIONS_LINES = 500

_LANGUAGE_BY_EXT = {
    "py": "python",
    "js": "javascript",
    "mjs": "javascript",
    "cjs": "javascript",
    "ts": "typescript",
    "tsx": "tsx",
    "jsx": "jsx",
    "json": "json",
    "jsonc": "json",
    "sh": "bash",
    "bash": "bash",
    "zsh": "bash",
    "go": "go",
    "java": "java",
    "c": "c",
    "h": "c",
    "cpp": "cpp",
    "cc": "cpp",
    "hpp": "cpp",
    "html": "html",
    "css": "css",
    "yaml": "yaml",
    "yml": "yaml",
    "md": "markdown",
    "txt": "plaintext",
    "text": "plaintext",
}


@dataclass(frozen=True, slots=True)
class InlinePiece:
    """一个文件贡献的模型侧文本。`inlined` 为假时正文是占位，不占累计预算。"""

    path: str
    text: str
    inlined: bool


@dataclass(slots=True)
class InlineBudget:
    """一轮 prompt 里已经内联的字节和行数。"""

    bytes: int = 0
    lines: int = 0


def language_for_path(path: str) -> str:
    """按最后一个扩展名取规范语言名；没有就用 plaintext。"""
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    dot = name.rfind(".")
    if dot <= 0 or dot == len(name) - 1:
        return "plaintext"
    return _LANGUAGE_BY_EXT.get(name[dot + 1 :].lower(), "plaintext")


def line_count(text: str) -> int:
    """与 JavaScript `split(/\\r?\\n/)` 一样，末尾换行也算一行。"""
    return len(re.split(r"\r?\n", text))


def format_bytes(size: int) -> str:
    """不足 1024 用整数 B，否则保留一位小数的 KB。"""
    if size < 1024:
        return f"{size}B"
    return f"{size / 1024:.1f}KB"


def code_fence(content: str) -> str:
    """围栏至少 3 个反引号，并且长于正文里最长的一串反引号。"""
    longest = 0
    current = 0
    for char in content:
        if char == "`":
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return "`" * max(3, longest + 1)


def format_inline_block(path: str, content: str) -> str:
    """把一小段已经决定要内联的文本格式化成附加上下文块。"""
    encoded = content.encode("utf-8")
    header = (
        f"[Attached Context: {path} ({line_count(content)} lines, {format_bytes(len(encoded))})]"
    )
    fence = code_fence(content)
    return f"{header}\n{fence}{language_for_path(path)}\n{content}\n{fence}"


def placeholder(path: str, size: int) -> str:
    """超限、二进制和预算用尽共用这一句，避免客户端靠措辞区分原因。"""
    return (
        f"[Mentioned File: {path} (Size: {format_bytes(size)}, "
        "too large to inline. Use read_file to inspect)]"
    )


def piece_for_bytes(path: str, data: bytes, budget: InlineBudget) -> InlinePiece:
    """按预算决定内联或占位，并就地更新 `budget`。占位不增加累计。"""
    size = len(data)
    if size >= MAX_SINGLE_FILE_BYTES or b"\0" in data:
        return InlinePiece(path, placeholder(path, size), False)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return InlinePiece(path, placeholder(path, size), False)
    file_bytes = len(text.encode("utf-8"))
    lines = line_count(text)
    if file_bytes >= MAX_SINGLE_FILE_BYTES or lines >= MAX_SINGLE_FILE_LINES:
        return InlinePiece(path, placeholder(path, file_bytes), False)
    if (
        budget.bytes + file_bytes > MAX_TOTAL_MENTIONS_BYTES
        or budget.lines + lines > MAX_TOTAL_MENTIONS_LINES
    ):
        return InlinePiece(path, placeholder(path, file_bytes), False)
    budget.bytes += file_bytes
    budget.lines += lines
    return InlinePiece(path, format_inline_block(path, text), True)


def join_model_message(pieces: Sequence[str], transcript: str) -> str:
    """内联块在前，原文在后，中间空一行。没有块时模型看到的就是原文。"""
    blocks = [piece for piece in pieces if piece]
    if not blocks:
        return transcript
    return "\n\n".join(blocks) + "\n\n" + transcript
