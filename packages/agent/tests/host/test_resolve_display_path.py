"""Todo 2.7：`AgentHost.resolve_display_path` 与 PathLocator 外部根位置（S0 §7.5）。"""

from __future__ import annotations

from pathlib import Path

from tests.support.acp_harness import make_persistent_host


async def test_resolve_display_path_workspace_inputs(tmp_path: Path) -> None:
    """主工作区内的相对/虚拟/绝对路径解析为绝对路径；坏输入一律 None。"""
    host = make_persistent_host(tmp_path)
    ws = str(host.workspace)
    # 相对路径不是合法输入：resolve 要求 / 开头虚拟路径或已授权绝对路径。
    assert host.resolve_display_path("a/b.txt", tool_name="read_file") is None
    assert host.resolve_display_path("/a/b.txt", tool_name="read_file") == f"{ws}/a/b.txt"
    assert host.resolve_display_path(f"{ws}/a.txt", tool_name="read_file") == f"{ws}/a.txt"
    assert host.resolve_display_path("../escape", tool_name="read_file") is None
    assert host.resolve_display_path("/etc/passwd", tool_name="read_file") is None
    assert host.resolve_display_path("", tool_name="read_file") is None
    assert host.resolve_display_path(123, tool_name="read_file") is None
    await host.close()


async def test_resolve_display_path_external_trusted_root(tmp_path: Path) -> None:
    """已授权外部目录给出绝对路径；未授权外部路径 None。"""
    host = make_persistent_host(tmp_path)
    outside = tmp_path / "shared"
    outside.mkdir(parents=True, exist_ok=True)
    assert host.resolve_display_path(str(outside / "a.txt"), tool_name="read_file") is None
    host._workspace_root_registry.trust(str(outside), "session")
    resolved = host.resolve_display_path(str(outside / "a.txt"), tool_name="read_file")
    assert resolved == str(outside / "a.txt")
    await host.close()
