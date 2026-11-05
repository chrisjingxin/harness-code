"""工具展示规则：ACP kind 映射、标题生成与位置解析。

【为什么单独测这三件事】
它们全是纯展示逻辑，出错不会让 Run 失败，只会让界面难看或误导用户：
kind 决定客户端画哪个图标，title 决定卡片副标题，locations 决定编辑器跳转。
所以这里逐条锁定规则，而不是靠端到端测试顺带覆盖。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness_agent.host.acp.tool_display import (
    ACP_KIND_BY_TOOL,
    PathLocator,
    tool_kind,
    tool_title,
)
from harness_agent.policy.tool_risk import TOOL_KIND_MAP
from harness_agent.tools.file_tool_catalog import FILE_TOOL_NAMES


def test_kind_table_covers_every_known_tool() -> None:
    """映射表必须覆盖风险分级表与文件工具全集，避免新工具悄悄落成 other。"""
    known = set(TOOL_KIND_MAP) | set(FILE_TOOL_NAMES)
    missing = known - set(ACP_KIND_BY_TOOL)
    assert not missing, sorted(missing)


def test_kind_mapping_matches_spec_table() -> None:
    """Spec §6.2 的逐项映射；`grep` 在 ACP 里是 search，不能照抄风险分级。"""
    assert tool_kind("read_file") == "read"
    assert tool_kind("ls") == "read"
    assert tool_kind("lsp") == "read"
    assert tool_kind("codebase_explore") == "read"
    assert tool_kind("grep") == "search"
    assert tool_kind("glob") == "search"
    assert tool_kind("web_search") == "search"
    assert tool_kind("tool_search") == "search"
    assert tool_kind("memory_search") == "search"
    assert tool_kind("write_file") == "edit"
    assert tool_kind("edit_file") == "edit"
    assert tool_kind("delete_file") == "delete"
    assert tool_kind("execute") == "execute"
    assert tool_kind("web_fetch") == "fetch"
    assert tool_kind("enter_plan_mode") == "switch_mode"
    assert tool_kind("exit_plan_mode") == "switch_mode"


@pytest.mark.parametrize("name", ["task", "ask_user", "write_todos", "memory_save"])
def test_interaction_tools_are_other(name: str) -> None:
    """交互类工具在 ACP 里没有专门类别，统一 other。"""
    assert tool_kind(name) == "other"


@pytest.mark.parametrize("name", ["mcp__github__create_issue", "unknown_tool", ""])
def test_unknown_and_mcp_tools_fall_back_to_other(name: str) -> None:
    """MCP 工具名与未知名字落到 other，不抛异常。"""
    assert tool_kind(name) == "other"


def test_title_uses_tool_name_before_arguments() -> None:
    """参数还没到时只有工具名，不能显示空标题。"""
    assert tool_title("edit_file", None) == "edit_file"
    assert tool_title("edit_file", {}) == "edit_file"


def test_title_shows_file_path_verbatim() -> None:
    """文件类工具的标题用模型给的虚拟路径，不做本地路径换算。"""
    assert tool_title("edit_file", {"file_path": "/src/a.py"}) == "edit_file /src/a.py"
    assert tool_title("read_file", {"file_path": "/src/b.py"}) == "read_file /src/b.py"
    assert tool_title("ls", {"path": "/src"}) == "ls /src"


@pytest.mark.parametrize(
    ("name", "args", "expected"),
    [
        ("execute", {"command": "npm test"}, "execute npm test"),
        ("web_fetch", {"url": "https://example.com"}, "web_fetch https://example.com"),
        ("web_search", {"query": "acp protocol"}, "web_search acp protocol"),
        ("grep", {"pattern": "TODO"}, "grep TODO"),
        ("glob", {"pattern": "**/*.ts"}, "glob **/*.ts"),
        ("task", {"description": "调研 ACP"}, "task 调研 ACP"),
    ],
)
def test_title_uses_tool_specific_key_argument(name: str, args: dict[str, object], expected: str) -> None:
    """非文件工具各取一个关键参数做副标题。"""
    assert tool_title(name, args) == expected


def test_title_truncates_long_text_to_120_chars() -> None:
    """超长参数截断到 120 字符并以省略号结尾，避免撑爆客户端卡片。"""
    title = tool_title("execute", {"command": "x" * 500})
    assert len(title) == 120
    assert title.endswith("…")
    assert title.startswith("execute ")


def test_title_flattens_newlines_and_strips_control_characters() -> None:
    """换行/制表符变空格，其它控制字符直接去掉，防止终端控制序列注入。"""
    title = tool_title("execute", {"command": "npm\n\ttest\x1b[31m\x07"})
    assert title == "execute npm test[31m"


def test_title_ignores_non_string_argument() -> None:
    """参数类型不对时只显示工具名，不把 dict/list 拼进标题。"""
    assert tool_title("execute", {"command": {"nested": True}}) == "execute"


class TestPathLocator:
    """位置解析只认主工作区内的直接文件工具路径。"""

    def test_virtual_path_maps_to_workspace_absolute_path(self, tmp_path: Path) -> None:
        """`/src/a.py` 换算成 `<workspace>/src/a.py`。"""
        locator = PathLocator(tmp_path)
        [location] = locator.locations("read_file", {"file_path": "/src/a.py"})
        assert location.path == str(tmp_path / "src" / "a.py")

    def test_absolute_workspace_path_is_kept(self, tmp_path: Path) -> None:
        """已经是工作区内绝对路径时结果仍是它自己。"""
        locator = PathLocator(tmp_path)
        target = tmp_path / "src" / "b.py"
        [location] = locator.locations("edit_file", {"file_path": str(target)})
        assert Path(location.path) == target

    @pytest.mark.parametrize(
        ("name", "args"),
        [
            ("read_file", {"file_path": "/.harness/x"}),
            ("read_file", {"file_path": "/src/../etc/passwd"}),
            ("read_file", {"file_path": "/etc/passwd"}),
            ("read_file", {}),
            ("read_file", {"file_path": 42}),
            ("glob", {"pattern": "**/*.py"}),
            ("grep", {"pattern": "TODO"}),
            ("execute", {"command": "ls"}),
            ("task", {"description": "调研"}),
        ],
    )
    def test_unresolvable_or_non_path_tools_return_no_locations(
        self, tmp_path: Path, name: str, args: dict[str, object]
    ) -> None:
        """越界、缺参数、非直接路径工具一律「不猜」，返回空列表。"""
        assert PathLocator(tmp_path).locations(name, args) == []

    def test_locator_never_raises_on_weird_input(self, tmp_path: Path) -> None:
        """展示逻辑绝不能抛异常打断事件流。"""
        assert PathLocator(tmp_path).locations("read_file", None) == []
