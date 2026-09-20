#!/usr/bin/env python3
"""简化版 wc 命令工具：统计文件的行数、词数、字符数。

支持命令行传一个或多个文件路径，若未提供文件则从标准输入读取。
"""

import argparse
import sys
from typing import NamedTuple, List, Optional


class Counts(NamedTuple):
    lines: int
    words: int
    chars: int


def count_text(text: str) -> Counts:
    """统计文本的行数、词数、字符数。

    行数按换行符 '\n' 计数（与标准 POSIX wc 一致）；
    词数按空白字符切分计数；
    字符数按 Unicode 字符数量计数。
    """
    lines = text.count("\n")
    words = len(text.split())
    chars = len(text)
    return Counts(lines=lines, words=words, chars=chars)


def count_file(file_path: str, encoding: str = "utf-8") -> Counts:
    """读取文件内容并统计指标。"""
    with open(file_path, mode="r", encoding=encoding, errors="replace") as f:
        content = f.read()
    return count_text(content)


def format_counts(
    counts: Counts,
    show_lines: bool,
    show_words: bool,
    show_chars: bool,
    width: int = 8,
) -> str:
    """将计数值格式化为右对齐的列字符串。"""
    parts: List[str] = []
    if show_lines:
        parts.append(f"{counts.lines:>{width}}")
    if show_words:
        parts.append(f"{counts.words:>{width}}")
    if show_chars:
        parts.append(f"{counts.chars:>{width}}")
    return " ".join(parts)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="简化版 wc：统计文件的行数、词数、字符数。"
    )
    parser.add_argument(
        "files",
        nargs="*",
        metavar="FILE",
        help="要统计的文件路径。若未提供文件，则从标准输入读取。",
    )
    parser.add_argument(
        "-l",
        "--lines",
        action="store_true",
        help="仅显示行数",
    )
    parser.add_argument(
        "-w",
        "--words",
        action="store_true",
        help="仅显示词数",
    )
    parser.add_argument(
        "-c",
        "-m",
        "--chars",
        action="store_true",
        help="仅显示字符数",
    )

    args = parser.parse_args(argv)

    # 如果没有指定任何特定标志，则默认展示全部三项
    show_all = not (args.lines or args.words or args.chars)
    show_lines = args.lines or show_all
    show_words = args.words or show_all
    show_chars = args.chars or show_all

    exit_code = 0
    total_lines = 0
    total_words = 0
    total_chars = 0

    if not args.files:
        # 从标准输入读取
        try:
            content = sys.stdin.read()
            counts = count_text(content)
            print(format_counts(counts, show_lines, show_words, show_chars))
        except Exception as err:
            sys.stderr.write(f"wc: 无法读取标准输入: {err}\n")
            return 1
        return 0

    results = []
    for file_path in args.files:
        try:
            counts = count_file(file_path)
            results.append((counts, file_path))
            total_lines += counts.lines
            total_words += counts.words
            total_chars += counts.chars
        except Exception as err:
            sys.stderr.write(f"wc: {file_path}: {err}\n")
            exit_code = 1

    # 动态确定对齐列宽（至少 1 位，默认 8 位）
    max_val = max(
        [total_lines, total_words, total_chars]
        + [
            val
            for c, _ in results
            for val in (c.lines, c.words, c.chars)
        ]
        + [0]
    )
    width = max(len(str(max_val)), 1)

    for counts, file_path in results:
        formatted = format_counts(counts, show_lines, show_words, show_chars, width=width)
        print(f"{formatted} {file_path}")

    # 如果有多个文件且至少有一个成功统计，输出 total
    if len(results) > 1:
        total_counts = Counts(lines=total_lines, words=total_words, chars=total_chars)
        formatted_total = format_counts(
            total_counts, show_lines, show_words, show_chars, width=width
        )
        print(f"{formatted_total} total")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
