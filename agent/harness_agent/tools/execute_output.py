"""``execute`` 工具超长输出头尾折叠与安全落盘中间件。

当 Shell 命令（如全量测试、构建日志）产生超长输出时：
1. 保留开头前若干行（包含首条报错根因）与末尾若干行（包含测试汇总、退出码与堆栈尾部）；
2. 将完整原始输出写入 ``/.harness/tool-outputs/<id>.txt``（由虚拟后端落盘到用户 home
   私有目录，绝不污染工作区 Git）；
3. 在返回消息中明确告知完整日志路径与 ``read_file`` 分页用法，引导模型按需读取而不要
   重复重跑同一长耗时命令。
"""

from __future__ import annotations

import inspect
import re
import sys
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from deepagents.backends import CompositeBackend
from langchain.agents.middleware.types import (
    AgentMiddleware,
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.types import Command

DEFAULT_MAX_INLINE_CHARS = 12_000
DEFAULT_HEAD_LINES = 30
DEFAULT_TAIL_LINES = 60
DEFAULT_HEAD_CHAR_BUDGET = 3_000
DEFAULT_TAIL_CHAR_BUDGET = 6_000
DEFAULT_MAX_LINE_CHARS = 500

_SAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9._-]")
_VIRTUAL_TOOL_OUTPUT_PREFIX = "/.harness/tool-outputs"


def _runtime_shell_label(platform: str | None = None) -> str:
    """返回当前宿主平台与默认 Shell 标识，供模型避免跨平台命令试错。"""
    host = (platform if platform is not None else sys.platform).lower()
    if host == "darwin":
        return "macOS（/bin/sh）"
    if host.startswith("linux"):
        return "Linux（/bin/sh）"
    if host == "win32":
        return "Windows（cmd）"
    return f"{host}（/bin/sh）"


def build_execute_description_hint(platform: str | None = None) -> str:
    """构造进程内恒定的 ``execute`` 工具提示，包含 OS/Shell 与防截断约束。"""
    env_label = _runtime_shell_label(platform)
    return (
        f"\n注意：命令运行在 {env_label}，默认已在当前工作区根目录执行，不要写 cd <workspace>；"
        "超长输出会自动头尾折叠并保存完整日志到 /.harness/tool-outputs/...，"
        "请信任自动折叠直接运行命令本身，避免使用 | head、| tail、| grep 或重定向截断后反复重跑。"
    )


_EXECUTE_DESCRIPTION_HINT = build_execute_description_hint()


def _extract_text(content: object) -> str:
    """提取 ToolMessage 中的文本正文；非文本结构返回空串跳过折叠。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _safe_output_filename(tool_call_id: object) -> str:
    """由 tool_call_id 生成无路径穿越风险的纯文件名。"""
    raw = str(tool_call_id or "").strip()
    cleaned = _SAFE_ID_CHARS.sub("_", raw).strip("._")
    if not cleaned or cleaned in {".", ".."}:
        cleaned = uuid.uuid4().hex[:12]
    else:
        cleaned = cleaned[:100]
    return f"{cleaned}.txt"


def _supports_virtual_tool_outputs(backend: object) -> bool:
    """确认 backend 已挂载 ``/.harness/`` 路由，避免把落盘文件写进工作区仓库。"""
    if backend is None:
        return False
    if getattr(backend, "artifacts_root", None) == "/.harness":
        return True
    if isinstance(backend, CompositeBackend):
        return any(
            str(prefix).rstrip("/") == "/.harness"
            for prefix in (getattr(backend, "routes", {}) or {})
        )
    return False


def _bound_line(line: str, max_line_chars: int) -> str:
    if len(line) <= max_line_chars:
        return line
    return f"{line[:max_line_chars]} ...[单行过长已截断]"


def format_head_tail_output(
    content: str,
    *,
    virtual_path: str | None = None,
    head_lines: int = DEFAULT_HEAD_LINES,
    tail_lines: int = DEFAULT_TAIL_LINES,
    head_char_budget: int = DEFAULT_HEAD_CHAR_BUDGET,
    tail_char_budget: int = DEFAULT_TAIL_CHAR_BUDGET,
    max_line_chars: int = DEFAULT_MAX_LINE_CHARS,
) -> str:
    """将超长输出折叠为头尾摘要，并附带只读分页提示。"""
    lines = content.splitlines()
    total_lines = len(lines)
    total_chars = len(content)

    # 极少行但单行极长的极端输出（如单行 50 KB JSON），直接按字符切头尾。
    if total_lines <= 2:
        head_raw = content[:head_char_budget]
        tail_raw = content[-tail_char_budget:] if total_chars > head_char_budget else ""
        omitted_chars = max(0, total_chars - len(head_raw) - len(tail_raw))
        notice = (
            f"\n\n... [已省略中间 {omitted_chars} 字符；完整输出共 {total_lines} 行 / {total_chars} 字符] ...\n\n"
        )
        folded = f"{head_raw}{notice}{tail_raw}" if tail_raw else head_raw
    else:
        selected_head: list[str] = []
        used_head = 0
        for raw in lines[:head_lines]:
            bounded = _bound_line(raw, max_line_chars)
            addition = len(bounded) + (1 if selected_head else 0)
            if selected_head and used_head + addition > head_char_budget:
                break
            selected_head.append(bounded)
            used_head += addition

        selected_tail_rev: list[str] = []
        used_tail = 0
        # 避免头尾索引重叠；优先从末尾倒序保留测试汇总与 Exit code。
        tail_pool = lines[len(selected_head) :]
        for raw in tail_pool[-tail_lines:][::-1]:
            bounded = _bound_line(raw, max_line_chars)
            addition = len(bounded) + (1 if selected_tail_rev else 0)
            if selected_tail_rev and used_tail + addition > tail_char_budget:
                break
            selected_tail_rev.append(bounded)
            used_tail += addition
        selected_tail = list(reversed(selected_tail_rev))

        omitted_lines = max(0, total_lines - len(selected_head) - len(selected_tail))
        head_text = "\n".join(selected_head)
        tail_text = "\n".join(selected_tail)
        omitted_chars = max(0, total_chars - len(head_text) - len(tail_text))

        if omitted_lines == 0 and omitted_chars == 0:
            folded = f"{head_text}\n{tail_text}" if tail_text else head_text
        else:
            notice = (
                f"\n\n... [已省略中间 {omitted_lines} 行 / {omitted_chars} 字符；"
                f"完整输出共 {total_lines} 行 / {total_chars} 字符] ...\n\n"
            )
            folded = f"{head_text}{notice}{tail_text}" if tail_text else f"{head_text}{notice}".rstrip()

    if virtual_path is not None:
        return (
            f"{folded}\n\n"
            f"完整输出已保存至 {virtual_path}。"
            f'如需查看中间细节，请使用 read_file(file_path="{virtual_path}", offset=..., limit=...) 分页读取，'
            "不要重复执行同一长耗时命令。"
        )
    return folded


class ExecuteOutputMiddleware(AgentMiddleware):
    """在模型看到 ``execute`` 输出前完成头尾折叠与安全落盘。"""

    def __init__(
        self,
        *,
        backend: Any | None = None,
        max_inline_chars: int = DEFAULT_MAX_INLINE_CHARS,
        head_lines: int = DEFAULT_HEAD_LINES,
        tail_lines: int = DEFAULT_TAIL_LINES,
        head_char_budget: int = DEFAULT_HEAD_CHAR_BUDGET,
        tail_char_budget: int = DEFAULT_TAIL_CHAR_BUDGET,
        platform: str | None = None,
    ) -> None:
        super().__init__()
        self._backend = backend
        self._max_inline_chars = max_inline_chars
        self._head_lines = head_lines
        self._tail_lines = tail_lines
        self._head_char_budget = head_char_budget
        self._tail_char_budget = tail_char_budget
        self._description_hint = (
            build_execute_description_hint(platform)
            if platform is not None
            else _EXECUTE_DESCRIPTION_HINT
        )

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse | ExtendedModelResponse],
    ) -> ModelResponse | ExtendedModelResponse:
        """同步注入 ``execute`` 工具说明。"""
        return handler(self._with_execute_hint(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse | ExtendedModelResponse]],
    ) -> ModelResponse | ExtendedModelResponse:
        """异步注入 ``execute`` 工具说明。"""
        return await handler(self._with_execute_hint(request))

    def _with_execute_hint(self, request: ModelRequest) -> ModelRequest:
        """在发给模型前为 ``execute`` 工具声明追加工作目录与输出折叠说明。"""
        tools = getattr(request, "tools", None)
        if not tools:
            return request
        hint_marker = self._description_hint.strip()
        updated_tools: list[Any] = []
        changed = False
        for tool in tools:
            if isinstance(tool, BaseTool) and tool.name == "execute":
                desc = tool.description or ""
                if hint_marker not in desc:
                    updated_tools.append(
                        tool.model_copy(update={"description": f"{desc}{self._description_hint}"})
                    )
                    changed = True
                    continue
            elif isinstance(tool, dict) and tool.get("name") == "execute":
                desc = str(tool.get("description") or "")
                if hint_marker not in desc:
                    updated_tools.append({**tool, "description": f"{desc}{self._description_hint}"})
                    changed = True
                    continue
            updated_tools.append(tool)
        if not changed:
            return request
        return request.override(tools=updated_tools)

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Any],
    ) -> Any:
        """同步拦截 ``execute`` 的超长返回。"""
        result = handler(request)
        if not self._is_execute(request):
            return result
        return self._process_sync(request, result)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[Any]],
    ) -> Any:
        """异步拦截 ``execute`` 的超长返回。"""
        result = await handler(request)
        if not self._is_execute(request):
            return result
        return await self._process_async(request, result)

    @staticmethod
    def _is_execute(request: ToolCallRequest) -> bool:
        tool_call = getattr(request, "tool_call", None)
        return isinstance(tool_call, dict) and tool_call.get("name") == "execute"

    def _process_sync(self, request: ToolCallRequest, result: Any) -> Any:
        if isinstance(result, ToolMessage):
            return self._fold_message_sync(request, result)
        if isinstance(result, Command) and isinstance(result.update, dict):
            messages = result.update.get("messages")
            if isinstance(messages, list):
                new_messages = [
                    self._fold_message_sync(request, msg) if isinstance(msg, ToolMessage) else msg
                    for msg in messages
                ]
                return Command(
                    graph=result.graph,
                    update={**result.update, "messages": new_messages},
                    resume=result.resume,
                    goto=result.goto,
                )
        return result

    async def _process_async(self, request: ToolCallRequest, result: Any) -> Any:
        if isinstance(result, ToolMessage):
            return await self._fold_message_async(request, result)
        if isinstance(result, Command) and isinstance(result.update, dict):
            messages = result.update.get("messages")
            if isinstance(messages, list):
                new_messages = [
                    await self._fold_message_async(request, msg)
                    if isinstance(msg, ToolMessage)
                    else msg
                    for msg in messages
                ]
                return Command(
                    graph=result.graph,
                    update={**result.update, "messages": new_messages},
                    resume=result.resume,
                    goto=result.goto,
                )
        return result

    def _fold_message_sync(self, request: ToolCallRequest, message: ToolMessage) -> ToolMessage:
        text = _extract_text(message.content)
        if len(text) <= self._max_inline_chars:
            return message
        virtual_path = self._try_write_sync(message.tool_call_id or _call_id(request), text)
        return self._replace_content(message, text, virtual_path)

    async def _fold_message_async(
        self, request: ToolCallRequest, message: ToolMessage
    ) -> ToolMessage:
        text = _extract_text(message.content)
        if len(text) <= self._max_inline_chars:
            return message
        virtual_path = await self._try_write_async(message.tool_call_id or _call_id(request), text)
        return self._replace_content(message, text, virtual_path)

    def _try_write_sync(self, tool_call_id: object, content: str) -> str | None:
        if not _supports_virtual_tool_outputs(self._backend):
            return None
        virtual_path = f"{_VIRTUAL_TOOL_OUTPUT_PREFIX}/{_safe_output_filename(tool_call_id)}"
        try:
            res = self._backend.write(virtual_path, content)
        except Exception:
            return None
        if res is None or getattr(res, "error", None):
            return None
        return virtual_path

    async def _try_write_async(self, tool_call_id: object, content: str) -> str | None:
        if not _supports_virtual_tool_outputs(self._backend):
            return None
        virtual_path = f"{_VIRTUAL_TOOL_OUTPUT_PREFIX}/{_safe_output_filename(tool_call_id)}"
        try:
            awrite = getattr(self._backend, "awrite", None)
            if callable(awrite):
                res = awrite(virtual_path, content)
                if inspect.isawaitable(res):
                    res = await res
            else:
                res = self._backend.write(virtual_path, content)
        except Exception:
            return None
        if res is None or getattr(res, "error", None):
            return None
        return virtual_path

    def _replace_content(
        self,
        message: ToolMessage,
        raw_text: str,
        virtual_path: str | None,
    ) -> ToolMessage:
        folded = format_head_tail_output(
            raw_text,
            virtual_path=virtual_path,
            head_lines=self._head_lines,
            tail_lines=self._tail_lines,
            head_char_budget=self._head_char_budget,
            tail_char_budget=self._tail_char_budget,
        )
        return ToolMessage(
            content=folded,
            tool_call_id=message.tool_call_id,
            name=message.name,
            status=getattr(message, "status", "success"),
            additional_kwargs=dict(getattr(message, "additional_kwargs", {}) or {}),
        )


def _call_id(request: ToolCallRequest) -> object:
    tool_call = getattr(request, "tool_call", None)
    return tool_call.get("id") if isinstance(tool_call, dict) else None


__all__ = [
    "DEFAULT_HEAD_CHAR_BUDGET",
    "DEFAULT_HEAD_LINES",
    "DEFAULT_MAX_INLINE_CHARS",
    "DEFAULT_TAIL_CHAR_BUDGET",
    "DEFAULT_TAIL_LINES",
    "ExecuteOutputMiddleware",
    "format_head_tail_output",
]
