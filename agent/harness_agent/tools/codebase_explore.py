"""Harness 自有只读代码探索工具；只依赖查询租约，不 import MCP。"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import StructuredTool
from langgraph.runtime import get_runtime
from pydantic import BaseModel, Field

from harness_agent.runtime.run_context import require_run_context

CODEBASE_EXPLORE_NAME = "codebase_explore"
CODEBASE_EXPLORE_SCHEMA_SHAPE = {
    "name": CODEBASE_EXPLORE_NAME,
    "parameters": {"query": "string", "max_files": "integer"},
}
_MAX_RESULT_BYTES = 32 * 1024
_SNAPSHOT_HINT = "返回源码仅供理解，编辑前必须使用 read_file 取得当前 Snapshot。"
_TOOL_DESCRIPTION = (
    "定位当前工作区的符号、文件与调用关系。"
    "未命中、语言未覆盖或查询失败时继续使用 glob、grep 或 read_file。"
    f" {_SNAPSHOT_HINT}"
)


class CodebaseExploreInput(BaseModel):
    """codebase_explore 的结构化参数；工作区由 Host 固定。"""

    query: str = Field(description="要定位的符号、文件或问题。")
    max_files: int = Field(default=8, description="最多返回的相关文件数，范围 1 到 12。")


def create_codebase_explore_tool() -> StructuredTool:
    """从当前 RunContext 租约查询；没有租约时返回可恢复说明。"""

    async def codebase_explore(query: str, max_files: int = 8) -> str:
        if not isinstance(max_files, int) or max_files < 1 or max_files > 12:
            return "max_files 必须是 1 到 12 的整数。请缩小范围后重试，或改用 glob/grep/read_file。"
        context = require_run_context(get_runtime())
        lease = getattr(context, "code_index_query_lease", None)
        if lease is None:
            return "代码索引当前不可用。请改用 glob、grep 或 read_file。"
        try:
            text = await lease.explore(query, max_files)
        except BaseException:
            return "代码索引查询失败。请改用 glob、grep 或 read_file。"
        if not isinstance(text, str) or not text.strip():
            return "代码索引未命中相关结果。请改用 glob、grep 或 read_file。"
        encoded = text.encode("utf-8")
        if len(encoded) > _MAX_RESULT_BYTES:
            truncated = encoded[:_MAX_RESULT_BYTES].decode("utf-8", errors="ignore")
            return f"{truncated}\n…结果已截断到 32 KiB，请缩小 query。{_SNAPSHOT_HINT}"
        if _SNAPSHOT_HINT not in text:
            return f"{text}\n{_SNAPSHOT_HINT}"
        return text

    return StructuredTool.from_function(
        coroutine=codebase_explore,
        name=CODEBASE_EXPLORE_NAME,
        description=_TOOL_DESCRIPTION,
        args_schema=CodebaseExploreInput,
    )


def codebase_explore_schema_fields(tool: Any) -> dict[str, object]:
    """测试用：返回模型可见 schema，确认不含 projectPath。"""
    schema = getattr(tool, "args_schema", None)
    if schema is None:
        return {}
    payload = schema.model_json_schema() if hasattr(schema, "model_json_schema") else {}
    return payload if isinstance(payload, dict) else {}
