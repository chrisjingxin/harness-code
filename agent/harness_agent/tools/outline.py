"""多语言纯标准库代码大纲提取与字符预算拼接模块。

用于在读取全文之前快速返回一组文件的类、函数、类型与标题行号范围，
配合 ``read_file(offset, limit)`` 实现“先地图、后切片”的并发按需读取。
本模块仅使用 Python 标准库，不引入第三方语法树依赖，也不签发编辑快照。
"""

from __future__ import annotations

import ast
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

DEFAULT_OUTLINE_MAX_CHARS = 16_000
"""单次 ``outline_files`` 默认最大返回字符数。"""

MAX_OUTLINE_MAX_CHARS = 24_000
"""单次 ``outline_files`` 允许请求的最大字符上限。"""

MAX_OUTLINE_FILES = 20
"""单次 ``outline_files`` 最多接受的文件路径数。"""

INLINE_OUTLINE_MIN_LINES = 250
"""``read_file`` 读大文件首页时自动附带精简大纲的总行数阈值。"""

INLINE_OUTLINE_MAX_CHARS = 1_500
"""``read_file`` 首页自动附带精简大纲的字符预算上限。"""

_PY_EXTENSIONS = frozenset({".py", ".pyi"})
_TS_JS_EXTENSIONS = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"})
_GO_EXTENSIONS = frozenset({".go"})
_RUST_EXTENSIONS = frozenset({".rs"})
_JAVA_C_EXTENSIONS = frozenset({".java", ".kt", ".kts", ".c", ".h", ".cc", ".cpp", ".hpp"})
_MD_EXTENSIONS = frozenset({".md", ".mdx"})
_YAML_EXTENSIONS = frozenset({".yaml", ".yml"})

_TS_KEYWORDS = frozenset(
    {"if", "for", "while", "switch", "catch", "else", "return", "throw", "new", "try", "do"}
)
_PY_FALLBACK_RE = re.compile(r"^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)")
_TS_DECL_RE = re.compile(
    r"^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?"
    r"(class|interface|type|enum|function\*?)\s+([A-Za-z_$][A-Za-z0-9_$]*)"
)
_TS_ARROW_RE = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*"
    r"(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>"
)
_TS_METHOD_RE = re.compile(
    r"^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*"
    r"([A-Za-z_$#][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\("
)
_GO_DECL_RE = re.compile(
    r"^\s*(?:(func)\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)|"
    r"(type)\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)?)"
)
_RUST_DECL_RE = re.compile(
    r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?"
    r"(struct|enum|trait|impl|fn|mod)\s+([^\s{(<]+)"
)
_JAVA_C_DECL_RE = re.compile(
    r"^\s*(?:(?:public|private|protected|static|final|abstract|sealed|virtual|override|inline)\s+)*"
    r"(class|interface|enum|struct|record|fun|namespace)\s+([A-Za-z_][A-Za-z0-9_]*)"
)
_MD_HEADING_RE = re.compile(r"^(#{1,4})\s+(.+?)\s*$")
_MD_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_JSON_KEY_RE = re.compile(r'^\s*"((?:\\.|[^"\\])+)"\s*:')
_YAML_KEY_RE = re.compile(r"^([A-Za-z0-9_.-]+)\s*:(?:\s|$)")
_TOML_SECTION_RE = re.compile(r"^\s*(\[\[?[^\]]+\]?\]?)\s*(?:#.*)?$")
_TOML_KEY_RE = re.compile(r"^([A-Za-z0-9_.-]+)\s*=")


@dataclass(frozen=True, slots=True)
class OutlineItem:
    """代码大纲中的单个符号条目（1-based 闭区间）。"""

    start_line: int
    end_line: int
    kind: str
    name: str
    indent: int = 0
    signature: str = ""

    def render(self) -> str:
        """格式化为 ``Lstart-Lend [kind] name[signature]``。"""
        prefix = "  " * self.indent
        return f"{prefix}L{self.start_line}-L{self.end_line} [{self.kind}] {self.name}{self.signature}"


def _clip_signature(text: str, *, max_len: int = 80) -> str:
    """把多行或超长签名折叠成单行并按预算截断。"""
    collapsed = " ".join(text.split())
    if not collapsed:
        return ""
    if len(collapsed) <= max_len:
        return collapsed
    return collapsed[: max_len - 1] + "…"


def _extract_inline_signature(lines: Sequence[str], start_idx: int, name: str) -> str:
    """从声明行起提取平衡括号参数签名及简短返回类型，括号不完整时返回空串。"""
    snippet = " ".join(lines[start_idx : min(len(lines), start_idx + 2)])
    pos = snippet.find(name)
    if pos < 0:
        return ""
    tail = snippet[pos + len(name) :]
    # 在参数左括号前只允许空白、泛型 <...> 或箭头赋值 "= async"，避免误匹配正文括号。
    brace_stop = tail.find("{")
    semi_stop = tail.find(";")
    candidates = [idx for idx in (brace_stop, semi_stop) if idx >= 0]
    limit = min(candidates) if candidates else len(tail)
    open_idx = tail.find("(", 0, limit)
    if open_idx < 0:
        return ""

    depth = 0
    quote: str | None = None
    close_idx = -1
    i = open_idx
    while i < len(tail):
        ch = tail[i]
        if quote is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in {"'", '"', "`"}:
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                close_idx = i
                break
        i += 1
    if close_idx < 0:
        return ""

    after = tail[close_idx + 1 :]
    end_markers = [after.find(marker) for marker in ("{", ";", "=>", " where ") if after.find(marker) >= 0]
    ret_raw = after[: min(end_markers)] if end_markers else after
    ret_clean = " ".join(ret_raw.split())
    if ret_clean.startswith(":"):
        ret_clean = ": " + ret_clean[1:].lstrip()
    elif ret_clean:
        ret_clean = " " + ret_clean
    return _clip_signature(f"{tail[open_idx : close_idx + 1]}{ret_clean}", max_len=80)


def _brace_balance_for_line(
    line: str,
    *,
    in_block_comment: bool,
) -> tuple[int, int, int, bool]:
    """统计单行在非字符串/非注释区域内的 ``{`` 与 ``}`` 数量及净变化。"""
    opens = 0
    closes = 0
    i = 0
    n = len(line)
    quote: str | None = None
    while i < n:
        ch = line[i]
        nxt = line[i + 1] if i + 1 < n else ""
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if quote is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch == "/" and nxt == "/":
            break
        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue
        if ch in {"'", '"', "`"}:
            quote = ch
            i += 1
            continue
        if ch == "{":
            opens += 1
        elif ch == "}":
            closes += 1
        i += 1
    return opens, closes, opens - closes, in_block_comment


def _find_brace_block_end(lines: Sequence[str], start_idx: int) -> int:
    """从声明起始行向下查找与之配对的大括号结束行索引（0-based）。"""
    depth = 0
    seen_open = False
    in_comment = False
    for idx in range(start_idx, len(lines)):
        opens, closes, _delta, in_comment = _brace_balance_for_line(
            lines[idx], in_block_comment=in_comment
        )
        if opens > 0:
            seen_open = True
        depth += opens - closes
        if seen_open and depth <= 0:
            return idx
        if not seen_open and ";" in lines[idx] and idx > start_idx:
            return idx
        if not seen_open and idx == start_idx and lines[idx].rstrip().endswith(";"):
            return idx
    return start_idx


def _extract_python_ast(content: str) -> list[OutlineItem]:
    """用标准库 ``ast.parse`` 提取 Python 类、方法与函数大纲及精简签名。"""
    tree = ast.parse(content)
    items: list[OutlineItem] = []

    def visit(body: Sequence[ast.stmt], *, indent: int, in_class: bool) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                end = getattr(node, "end_lineno", node.lineno) or node.lineno
                sig = ""
                if node.bases:
                    try:
                        bases_text = ", ".join(ast.unparse(base) for base in node.bases)
                        sig = _clip_signature(f"({bases_text})", max_len=60)
                    except Exception:
                        sig = ""
                items.append(OutlineItem(node.lineno, end, "class", node.name, indent, sig))
                visit(node.body, indent=indent + 1, in_class=True)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                end = getattr(node, "end_lineno", node.lineno) or node.lineno
                is_async = isinstance(node, ast.AsyncFunctionDef)
                if in_class:
                    kind = "async method" if is_async else "method"
                else:
                    kind = "async function" if is_async else "function"
                sig = ""
                try:
                    args_text = ast.unparse(node.args)
                    ret_text = f" -> {ast.unparse(node.returns)}" if node.returns is not None else ""
                    sig = _clip_signature(f"({args_text}){ret_text}", max_len=80)
                except Exception:
                    sig = ""
                items.append(OutlineItem(node.lineno, end, kind, node.name, indent, sig))

    visit(tree.body, indent=0, in_class=False)
    return items


def _extract_python_fallback(lines: Sequence[str]) -> list[OutlineItem]:
    """当 Python 文件存在语法错误时按缩进正则降级提取大纲。"""
    items: list[OutlineItem] = []
    n = len(lines)
    for idx, line in enumerate(lines):
        m = _PY_FALLBACK_RE.match(line)
        if not m:
            continue
        ws, kw, name = m.groups()
        indent_len = len(ws.expandtabs(4))
        end_idx = idx
        for j in range(idx + 1, n):
            stripped = lines[j].strip()
            if not stripped or stripped.startswith("#"):
                continue
            cur_indent = len(lines[j][: len(lines[j]) - len(lines[j].lstrip())].expandtabs(4))
            if cur_indent <= indent_len:
                break
            end_idx = j
        kind = "class" if kw == "class" else ("async function" if kw.startswith("async") else "function")
        items.append(OutlineItem(idx + 1, end_idx + 1, kind, name, 1 if indent_len > 0 else 0))
    return items


def _extract_ts_js(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 TS/JS/JSX/TSX 顶层声明及类方法。"""
    items: list[OutlineItem] = []
    depth = 0
    in_comment = False
    class_end_stack: list[tuple[int, int]] = []  # (class_body_depth, end_idx)
    idx = 0
    while idx < len(lines):
        while class_end_stack and idx > class_end_stack[-1][1]:
            class_end_stack.pop()
        line = lines[idx]
        if depth == 0:
            decl = _TS_DECL_RE.match(line)
            if decl:
                raw_kind, name = decl.groups()
                kind = "function" if raw_kind.startswith("function") else raw_kind
                end_idx = _find_brace_block_end(lines, idx)
                sig = _extract_inline_signature(lines, idx, name) if kind == "function" else ""
                items.append(OutlineItem(idx + 1, end_idx + 1, kind, name, 0, sig))
                if kind == "class" and end_idx > idx:
                    class_end_stack.append((1, end_idx))
            else:
                arrow = _TS_ARROW_RE.match(line)
                if arrow:
                    name = arrow.group(1)
                    end_idx = _find_brace_block_end(lines, idx)
                    sig = _extract_inline_signature(lines, idx, name)
                    items.append(OutlineItem(idx + 1, end_idx + 1, "function", name, 0, sig))
        elif class_end_stack and depth == class_end_stack[-1][0]:
            method = _TS_METHOD_RE.match(line)
            if method and method.group(1) not in _TS_KEYWORDS:
                name = method.group(1)
                end_idx = _find_brace_block_end(lines, idx)
                sig = _extract_inline_signature(lines, idx, name)
                items.append(OutlineItem(idx + 1, end_idx + 1, "method", name, 1, sig))
        opens, closes, delta, in_comment = _brace_balance_for_line(line, in_block_comment=in_comment)
        depth = max(0, depth + delta)
        idx += 1
    return items


def _extract_go(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 Go 顶层 ``func`` 与 ``type`` 声明。"""
    items: list[OutlineItem] = []
    depth = 0
    in_comment = False
    for idx, line in enumerate(lines):
        if depth == 0:
            m = _GO_DECL_RE.match(line)
            if m:
                func_kw, func_name, type_kw, type_name, type_kind = m.groups()
                if func_kw and func_name:
                    end_idx = _find_brace_block_end(lines, idx)
                    sig = _extract_inline_signature(lines, idx, func_name)
                    items.append(OutlineItem(idx + 1, end_idx + 1, "func", func_name, 0, sig))
                elif type_kw and type_name:
                    end_idx = _find_brace_block_end(lines, idx)
                    kind = type_kind or "type"
                    items.append(OutlineItem(idx + 1, end_idx + 1, kind, type_name, 0))
        _, _, delta, in_comment = _brace_balance_for_line(line, in_block_comment=in_comment)
        depth = max(0, depth + delta)
    return items


def _extract_rust(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 Rust ``struct``/``enum``/``trait``/``impl``/``fn`` 及其方法。"""
    items: list[OutlineItem] = []
    depth = 0
    in_comment = False
    impl_end_stack: list[tuple[int, int]] = []
    for idx, line in enumerate(lines):
        while impl_end_stack and idx > impl_end_stack[-1][1]:
            impl_end_stack.pop()
        m = _RUST_DECL_RE.match(line)
        if m and (depth == 0 or (impl_end_stack and depth == impl_end_stack[-1][0])):
            kind, name = m.groups()
            indent = 1 if depth > 0 else 0
            end_idx = _find_brace_block_end(lines, idx)
            sig = _extract_inline_signature(lines, idx, name) if kind == "fn" else ""
            items.append(OutlineItem(idx + 1, end_idx + 1, kind, name, indent, sig))
            if kind in {"impl", "trait", "mod"} and depth == 0 and end_idx > idx:
                impl_end_stack.append((1, end_idx))
        _, _, delta, in_comment = _brace_balance_for_line(line, in_block_comment=in_comment)
        depth = max(0, depth + delta)
    return items


def _extract_java_c(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 Java/Kotlin/C/C++ 类型与函数/方法声明。"""
    items: list[OutlineItem] = []
    depth = 0
    in_comment = False
    for idx, line in enumerate(lines):
        if depth <= 1:
            m = _JAVA_C_DECL_RE.match(line)
            if m:
                kind, name = m.groups()
                end_idx = _find_brace_block_end(lines, idx)
                items.append(OutlineItem(idx + 1, end_idx + 1, kind, name, 1 if depth == 1 else 0))
        _, _, delta, in_comment = _brace_balance_for_line(line, in_block_comment=in_comment)
        depth = max(0, depth + delta)
    return items


def _extract_markdown(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 Markdown 1~4 级标题，跳过 fenced 代码块内部井号注释。"""
    headings: list[tuple[int, int, str]] = []
    in_fence = False
    for idx, line in enumerate(lines):
        if _MD_FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _MD_HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            headings.append((idx + 1, level, m.group(2).strip()))
    total_lines = len(lines)
    items: list[OutlineItem] = []
    for pos, (start, level, title) in enumerate(headings):
        end = total_lines
        for next_start, next_level, _ in headings[pos + 1 :]:
            if next_level <= level:
                end = next_start - 1
                break
        items.append(OutlineItem(start, max(start, end), f"h{level}", title, max(0, level - 1)))
    return items


def _extract_json(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 JSON 顶层键名与行号区间。"""
    items: list[OutlineItem] = []
    depth = 0
    for idx, line in enumerate(lines):
        if depth == 1:
            m = _JSON_KEY_RE.match(line)
            if m:
                end_idx = _find_brace_block_end(lines, idx) if "{" in line or "[" in line else idx
                items.append(OutlineItem(idx + 1, end_idx + 1, "key", m.group(1), 0))
        _, _, delta, _ = _brace_balance_for_line(line, in_block_comment=False)
        depth = max(0, depth + delta)
    return items


def _extract_yaml(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 YAML 顶层键与对应块行范围。"""
    keys: list[tuple[int, str]] = []
    for idx, line in enumerate(lines):
        m = _YAML_KEY_RE.match(line)
        if m:
            keys.append((idx + 1, m.group(1)))
    total_lines = len(lines)
    return [
        OutlineItem(
            start,
            max(start, keys[pos + 1][0] - 1 if pos + 1 < len(keys) else total_lines),
            "key",
            name,
            0,
        )
        for pos, (start, name) in enumerate(keys)
    ]


def _extract_toml(lines: Sequence[str]) -> list[OutlineItem]:
    """提取 TOML ``[section]`` 区间与键名（节内键缩进展示）。"""
    sections: list[tuple[int, str]] = []
    keys: list[tuple[int, str]] = []
    for idx, line in enumerate(lines):
        sec = _TOML_SECTION_RE.match(line)
        if sec:
            sections.append((idx + 1, sec.group(1)))
            continue
        key = _TOML_KEY_RE.match(line)
        if key:
            keys.append((idx + 1, key.group(1)))
    total_lines = len(lines)
    items: list[OutlineItem] = []
    first_sec = sections[0][0] if sections else total_lines + 1
    for start, name in keys:
        if start < first_sec:
            items.append(OutlineItem(start, start, "key", name, 0))
    for pos, (sec_start, sec_name) in enumerate(sections):
        sec_end = sections[pos + 1][0] - 1 if pos + 1 < len(sections) else total_lines
        items.append(OutlineItem(sec_start, max(sec_start, sec_end), "section", sec_name, 0))
        for key_start, key_name in keys:
            if sec_start < key_start <= sec_end:
                items.append(OutlineItem(key_start, key_start, "key", key_name, 1))
    return items


def _extract_outline_items(path: str, content: str) -> tuple[int, list[OutlineItem]]:
    """按文件扩展名提取总行数与结构化大纲条目列表。"""
    lines = content.splitlines()
    line_count = len(lines)
    ext = Path(path).suffix.lower()
    items: list[OutlineItem] = []

    if ext in _PY_EXTENSIONS:
        try:
            items = _extract_python_ast(content)
        except SyntaxError:
            items = _extract_python_fallback(lines)
    elif ext in _TS_JS_EXTENSIONS:
        items = _extract_ts_js(lines)
    elif ext in _GO_EXTENSIONS:
        items = _extract_go(lines)
    elif ext in _RUST_EXTENSIONS:
        items = _extract_rust(lines)
    elif ext in _JAVA_C_EXTENSIONS:
        items = _extract_java_c(lines)
    elif ext in _MD_EXTENSIONS:
        items = _extract_markdown(lines)
    elif ext == ".json":
        items = _extract_json(lines)
    elif ext in _YAML_EXTENSIONS:
        items = _extract_yaml(lines)
    elif ext == ".toml":
        items = _extract_toml(lines)
    return line_count, items


def extract_file_outline(path: str, content: str) -> str:
    """提取单个文件的结构化大纲文本（不含编辑快照）。"""
    line_count, items = _extract_outline_items(path, content)
    header = f"## Outline: {path} ({line_count} lines)"
    if not items:
        return f"{header}\n(无结构符号；请直接用 read_file 读取)"
    return "\n".join([header, *(item.render() for item in items)])


def extract_inline_outline(
    path: str,
    content: str,
    *,
    max_chars: int = INLINE_OUTLINE_MAX_CHARS,
) -> str | None:
    """为 ``read_file`` 大文件首页生成精简大纲；无结构符号时返回 ``None``。"""
    _line_count, items = _extract_outline_items(path, content)
    if not items:
        return None
    suffix = "\n... [大纲已截断；需要完整目录可调用 outline_files]"
    budget = max(120, max_chars - len(suffix))
    kept: list[str] = []
    used = 0
    truncated = False
    for item in items:
        line = item.render()
        add = len(line) + (1 if kept else 0)
        if used + add <= budget:
            kept.append(line)
            used += add
            continue
        if not kept:
            kept.append(line[:budget])
        truncated = True
        break
    rendered = "\n".join(kept)
    return f"{rendered}{suffix}" if truncated else rendered


def format_batch_outlines(
    entries: Sequence[tuple[str, str]],
    *,
    max_chars: int = DEFAULT_OUTLINE_MAX_CHARS,
) -> tuple[str, list[str]]:
    """按文件边界预算拼接多文件大纲；超限截断并返回省略路径列表。"""
    if not entries:
        return "", []
    rendered_blocks: list[str] = []
    omitted_paths: list[str] = []
    total_len = 0

    for idx, (path, block) in enumerate(entries):
        separator_len = 2 if rendered_blocks else 0
        next_len = total_len + separator_len + len(block)
        if next_len <= max_chars:
            rendered_blocks.append(block)
            total_len = next_len
            continue
        # 首个文件就超限时对其按行截断，确保至少返回首文件头部大纲。
        if not rendered_blocks:
            budget = max(200, max_chars - 64)
            clipped_lines: list[str] = []
            used = 0
            for line in block.splitlines():
                add = len(line) + (1 if clipped_lines else 0)
                if used + add > budget:
                    break
                clipped_lines.append(line)
                used += add
            if not clipped_lines:
                clipped_lines.append(block[:budget])
            clipped_lines.append("... [大纲过长已截断]")
            rendered_blocks.append("\n".join(clipped_lines))
            omitted_paths.extend(p for p, _ in entries[idx + 1 :])
            break
        omitted_paths.extend(p for p, _ in entries[idx:])
        break

    result = "\n\n".join(rendered_blocks)
    if omitted_paths:
        preview = ", ".join(omitted_paths)
        result = f"{result}\n\n[已达字符上限，省略其余 {len(omitted_paths)} 个文件：{preview}]"
    return result, omitted_paths


__all__ = [
    "DEFAULT_OUTLINE_MAX_CHARS",
    "INLINE_OUTLINE_MAX_CHARS",
    "INLINE_OUTLINE_MIN_LINES",
    "MAX_OUTLINE_FILES",
    "MAX_OUTLINE_MAX_CHARS",
    "OutlineItem",
    "extract_file_outline",
    "extract_inline_outline",
    "format_batch_outlines",
]
