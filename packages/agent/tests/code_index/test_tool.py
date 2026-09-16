"""Harness codebase_explore 的 schema、截断、回退与分类。"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from langchain_core.tools import StructuredTool

from harness_agent.policy.tool_risk import ToolKind, get_tool_kind, is_read_only
from harness_agent.tools.codebase_explore import (
    CODEBASE_EXPLORE_NAME,
    create_codebase_explore_tool,
    codebase_explore_schema_fields,
)


@dataclass
class _Lease:
    text: str = "class UniqueMarker:\n    pass"

    async def explore(self, query: str, max_files: int) -> str:
        return self.text


def _context(lease: object | None) -> SimpleNamespace:
    return SimpleNamespace(code_index_query_lease=lease)


@pytest.mark.asyncio
async def test_schema_has_no_project_path_and_is_read_only() -> None:
    tool = create_codebase_explore_tool()
    schema = codebase_explore_schema_fields(tool)
    payload = str(schema)
    assert "projectPath" not in payload
    assert "project_path" not in payload
    assert "query" in schema.get("properties", {})
    assert get_tool_kind(CODEBASE_EXPLORE_NAME) is ToolKind.READ
    assert is_read_only(CODEBASE_EXPLORE_NAME) is True
    assert "read_file" in (tool.description or "")
    assert "CodeGraph" not in (tool.description or "")


@pytest.mark.asyncio
async def test_max_files_and_missing_lease_are_recoverable() -> None:
    tool = create_codebase_explore_tool()
    with patch("harness_agent.tools.codebase_explore.get_runtime", return_value=object()):
        with patch("harness_agent.tools.codebase_explore.require_run_context", return_value=_context(None)):
            missing = await tool.ainvoke({"query": "UniqueMarker"})
    assert "read_file" in missing
    with patch("harness_agent.tools.codebase_explore.get_runtime", return_value=object()):
        with patch("harness_agent.tools.codebase_explore.require_run_context", return_value=_context(_Lease())):
            invalid = await tool.ainvoke({"query": "UniqueMarker", "max_files": 99})
    assert "1 到 12" in invalid


@pytest.mark.asyncio
async def test_result_truncated_at_32kib_and_keeps_snapshot_hint() -> None:
    tool = create_codebase_explore_tool()
    lease = _Lease(text="x" * (32 * 1024 + 50))
    with patch("harness_agent.tools.codebase_explore.get_runtime", return_value=object()):
        with patch("harness_agent.tools.codebase_explore.require_run_context", return_value=_context(lease)):
            text = await tool.ainvoke({"query": "UniqueMarker", "max_files": 2})
    assert "32 KiB" in text
    assert "read_file" in text
    assert len(text.encode("utf-8")) <= 32 * 1024 + 200


@pytest.mark.asyncio
async def test_raw_mcp_tool_is_not_the_harness_tool() -> None:
    tool = create_codebase_explore_tool()
    assert isinstance(tool, StructuredTool)
    assert tool.name == "codebase_explore"
    assert "mcp" not in (tool.name or "")
    assert getattr(tool, "metadata", None) in (None, {})
