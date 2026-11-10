"""工具在 ACP 界面上的展示规则：类别、标题与文件位置。

【这是做什么的？】
把 Harness 的工具词汇翻译成 ACP 客户端能画的卡片元数据：
- `kind`：决定客户端用哪个图标（读、写、搜索、执行……）；
- `title`：卡片的副标题，参数到齐后变成「动作 + 关键参数」；
- `locations`：把模型写的虚拟路径（`/src/a.ts`）换算成本机绝对路径，供编辑器跳转。

【上下游】
- 上游：`translate.py` 生成 `tool_call` / `tool_call_update` 时调用。
- 下游：`policy/tool_risk.py` 的风险分级表与 `tools/file_tool_catalog.py` 的路径参数表，
  以及 `policy/workspace_boundary.py` 的路径校验（这里只用来换算绝对路径）。

【两条硬约束】
1. 这里是纯展示逻辑，任何失败（参数缺失、路径越界、类型不对）都只能降级成
   「不显示」，绝不能抛异常打断事件流。
2. 标题文本来自模型，会进终端与编辑器：换行、制表符、控制字符必须先净化，
   否则一条精心构造的工具参数就能在用户终端里执行控制序列。
"""

from __future__ import annotations

import unicodedata
from collections.abc import Callable, Mapping
from pathlib import Path

from acp.schema import ToolCallLocation, ToolKind

from harness_agent.policy.tool_risk import TOOL_KIND_MAP
from harness_agent.tools.file_tool_catalog import (
    DIRECT_FILE_TOOL_PATH_ARGUMENTS,
    FILE_TOOL_PATH_ARGUMENTS,
)

TITLE_LIMIT = 120
"""标题的最大字符数；超过就截断加省略号，避免撑爆客户端卡片。"""

BLOCK_LIMIT = 24_000
"""多行安全文本（审批描述与 diff）的上限。"""

_TITLE_ARGUMENT_BY_TOOL: dict[str, str] = {
    "execute": "command",
    "web_fetch": "url",
    "web_search": "query",
    "grep": "pattern",
    "glob": "pattern",
    "task": "description",
}
"""非文件工具各自用来做标题的那个关键参数。"""

ACP_KIND_BY_TOOL: Mapping[str, ToolKind] = {
    # 读
    "read_file": "read",
    "ls": "read",
    "lsp": "read",
    "codebase_explore": "read",
    # 搜索（注意：`grep` 在风险分级里是 READ，在 ACP 里是 search）
    "grep": "search",
    "glob": "search",
    "web_search": "search",
    "tool_search": "search",
    "memory_search": "search",
    # 写与删
    "write_file": "edit",
    "edit_file": "edit",
    "delete_file": "delete",
    # 执行与抓取
    "execute": "execute",
    "web_fetch": "fetch",
    # 模式切换
    "enter_plan_mode": "switch_mode",
    "exit_plan_mode": "switch_mode",
    # 交互类与子 agent（ACP 没有对应类别）
    "task": "other",
    "ask_user": "other",
    "write_todos": "other",
    "memory_save": "other",
}
"""显式的工具→ACP 类别表。不复用 `ToolKind` 枚举：两边的词汇并不一一对应。"""


def tool_kind(name: str) -> ToolKind:
    """返回 ACP 工具类别；未知名字（含 MCP 工具）落到 `other`，绝不抛异常。"""
    return ACP_KIND_BY_TOOL.get(name, "other")


def tool_title(name: str, args: Mapping[str, object] | None) -> str:
    """生成工具卡标题：`edit_file /src/a.py`、`execute npm test`。

    参数未到、参数类型不对或关键参数缺失时退化成工具名本身——标题永远非空。
    """
    raw: object | None = None
    if args:
        # 专用参数表优先：`grep`/`glob` 在文件工具表里也有 `path`，但标题要用 `pattern`。
        argument_name = _TITLE_ARGUMENT_BY_TOOL.get(name) or FILE_TOOL_PATH_ARGUMENTS.get(name)
        if argument_name is not None:
            raw = args.get(argument_name)
    if not isinstance(raw, str) or not raw:
        return sanitize_line(name)
    return sanitize_line(f"{name} {raw}")


def sanitize_line(text: str) -> str:
    """把标题压成单行安全文本：空白折叠成一个空格，去掉控制字符，超长截断。"""
    chars: list[str] = []
    for char in text:
        if char in " \t\r\n":
            chars.append(" ")
        elif unicodedata.category(char) in {"Cc", "Cf"}:
            # Cc=控制字符、Cf=格式字符（含零宽、双向覆盖），在终端里都可能改变观感。
            continue
        else:
            chars.append(char)
    collapsed = " ".join("".join(chars).split())
    if len(collapsed) > TITLE_LIMIT:
        return collapsed[: TITLE_LIMIT - 1] + "…"
    return collapsed


def sanitize_block(text: str, *, limit: int = BLOCK_LIMIT) -> str:
    """把多行文本压成安全版本：保留换行与制表，去掉其它控制与格式字符。

    审批兜底文本与 diff 内容来自模型和文件，会进终端或编辑器，必须净化；
    与标题不同，这里不能把换行折成空格，否则 diff 不可读。
    """
    chars: list[str] = []
    for char in text:
        if char in "\n\t":
            chars.append(char)
        elif unicodedata.category(char) in {"Cc", "Cf"}:
            continue
        else:
            chars.append(char)
    cleaned = "".join(chars)
    if len(cleaned) > limit:
        return cleaned[: limit - 1] + "…"
    return cleaned


class PathLocator:
    """把工具参数里的虚拟路径换算成工作区内的绝对路径。

    只处理 `DIRECT_FILE_TOOL_PATH_ARGUMENTS` 里的工具：`glob`/`grep` 的 `path` 是可选的
    搜索根，缺省时会搜整个工作区，把它当作「被访问的文件」会误导客户端。
    """

    def __init__(self, resolve: Callable[[object, str], str | None]) -> None:
        """绑定一个把工具路径参数解析为绝对宿主路径的函数（HostServicePort.resolve_display_path）。

        分层上 acp/ 不能 import policy.*：位置解析的「哪些根可信」的事实源在
        Host 侧，这里只拿结果——主工作区与全部已授权外部根都会产出位置。
        """
        self._resolve = resolve

    def locations(self, name: str, args: Mapping[str, object] | None) -> list[ToolCallLocation]:
        """返回文件位置列表；无法确定时返回空列表，绝不抛异常。"""
        argument_name = DIRECT_FILE_TOOL_PATH_ARGUMENTS.get(name)
        if argument_name is None or not args:
            return []
        raw = args.get(argument_name)
        resolved = self._resolve(raw, tool_name=name)
        # 解析失败（越界/未信任/非字符串）由 Host 一侧返回 None：只少一个副标题，
        # 绝不能因为一张卡片的副标题打断整个 Run 的事件流。
        if not resolved:
            return []
        return [ToolCallLocation(path=resolved)]


__all__ = [
    "ACP_KIND_BY_TOOL",
    "BLOCK_LIMIT",
    "PathLocator",
    "TITLE_LIMIT",
    "sanitize_block",
    "sanitize_line",
    "tool_kind",
    "tool_risk_kind_names",
    "tool_title",
]


def tool_risk_kind_names() -> set[str]:
    """返回风险分级表里的工具名，供漂移测试比对映射表覆盖面。"""
    return set(TOOL_KIND_MAP)
