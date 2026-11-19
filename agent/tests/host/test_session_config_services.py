"""S4 Host 服务：模型目录、会话目录、会话 MCP、已有文件授权。"""

from __future__ import annotations

from pathlib import Path

import pytest

from harness_agent.extensions.mcp import McpServerConfig, build_mcp_snapshot
from harness_agent.host.connection import RpcError
from tests.support.acp_harness import InProcessAcp, make_host, make_persistent_host


class _Log:
    """记下诊断事件，确认日志里没有路径、命令和请求头。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    def info(self, event: str, fields: dict[str, object] | None = None) -> None:
        self.events.append((event, dict(fields or {})))

    def warn(self, *_args: object, **_kwargs: object) -> None:
        return None

    def error(self, *_args: object, **_kwargs: object) -> None:
        return None

    def debug(self, *_args: object, **_kwargs: object) -> None:
        return None

    def child(self, *_args: object, **_kwargs: object) -> "_Log":
        return self


async def _sender(_frame: object) -> None:
    return None


def _write_model_config(home: Path) -> None:
    config_dir = home / ".harness"
    config_dir.mkdir(parents=True)
    (config_dir / "config.toml").write_text(
        """
[config]
version = 1

[models]
default_profile = "fast"

[models.profiles.fast]
provider = "openai-compatible"
provider_label = "fast"
model = "fake-model"
base_url = "http://127.0.0.1:9/v1"
api_key = "fake-key"
context_window_tokens = 32000
""".strip()
        + "\n",
        encoding="utf-8",
    )


async def test_list_models_uses_the_explicit_connection(tmp_path: Path) -> None:
    """echo 拒绝列目录；配了模型且连接有 models.select 时返回 profile。"""
    echo = make_host(tmp_path / "echo", echo=True)
    echo_connection = echo.open_connection(
        _sender, enabled_capabilities=["models.select"], interaction_handles=["approval"]
    )
    with pytest.raises(RpcError) as caught:
        await echo.list_models(echo_connection)
    assert caught.value.message == "MODELS_UNAVAILABLE_IN_ECHO_MODE"

    _write_model_config(tmp_path / "home")
    host = make_persistent_host(tmp_path)
    bare = host.open_connection(
        _sender, enabled_capabilities=["threads.read"], interaction_handles=["approval"]
    )
    with pytest.raises(RpcError) as missing:
        await host.list_models(bare)
    assert missing.value.message == "MODELS_CAPABILITY_REQUIRED"
    connection = host.open_connection(
        _sender, enabled_capabilities=["models.select"], interaction_handles=["approval"]
    )
    listed = await host.list_models(connection)
    assert listed["profiles"][0]["id"] == "fast"
    assert listed["profiles"][0]["provider_label"] == "fast"


@pytest.mark.parametrize(
    "kind",
    ["inside", "home", "root", "missing", "file", "unc"],
)
def test_additional_directory_rejections_keep_the_submitted_path(
    tmp_path: Path, kind: str
) -> None:
    """六种不合格目录都整单拒绝，data.path 是提交值。"""
    host = make_host(tmp_path, echo=True)
    host._diagnostic_log = _Log()
    inside = host.workspace / "nested"
    inside.mkdir()
    outside_file = tmp_path / "note.txt"
    outside_file.write_text("x", encoding="utf-8")
    submitted = {
        "inside": str(inside),
        "home": str(Path.home()),
        "root": "/",
        "missing": str(tmp_path / "missing"),
        "file": str(outside_file),
        "unc": "//server/share",
    }[kind]
    with pytest.raises(RpcError) as caught:
        host.set_session_roots("thread-1", [submitted])
    assert caught.value.message == "INVALID_ADDITIONAL_DIRECTORY"
    assert caught.value.data["path"] == submitted
    assert host._session_root_ids == {}
    event, fields = host._diagnostic_log.events[-1]
    assert event == "acp.session.directories"
    assert fields == {"count": 1, "result": "rejected"}
    assert submitted not in str(fields)


def test_session_roots_replace_and_only_revoke_owned_session_scope(tmp_path: Path) -> None:
    """第二次登记替换上一次；关掉会话只撤自己的 session 根。"""
    host = make_host(tmp_path, echo=True)
    first = tmp_path / "extra-a"
    second = tmp_path / "extra-b"
    first.mkdir()
    second.mkdir()
    host.set_session_roots("thread-1", [str(first)])
    owned = host._session_root_ids["thread-1"]
    assert owned
    host.set_session_roots("thread-1", [str(second)])
    paths = {root.path for root in host._workspace_root_registry.roots()}
    assert second.resolve() in paths
    assert first.resolve() not in paths
    host.set_session_roots("thread-1", [])
    paths = {root.path for root in host._workspace_root_registry.roots()}
    assert second.resolve() not in paths


async def test_session_mcp_skips_sse_and_name_collisions(tmp_path: Path) -> None:
    """sse 与同名服务器不进入会话快照，诊断不含命令。"""
    host = make_host(tmp_path, echo=True)
    host._diagnostic_log = _Log()
    host._mcp_snapshot = build_mcp_snapshot(
        [McpServerConfig(name="taken", transport="stdio", command="true")],
        "rev",
    )
    await host.set_session_mcp(
        "thread-1",
        [
            {
                "name": "taken",
                "transport": "stdio",
                "command": "secret-cmd",
                "timeout": 0.2,
            },
            {
                "name": "extra",
                "transport": "stdio",
                "command": "false",
                "timeout": 0.2,
            },
            {
                "name": "remote",
                "transport": "sse",
                "url": "http://example.invalid",
                "timeout": 0.2,
            },
        ],
    )
    stored = host._session_mcp_servers["thread-1"]
    assert [item.name for item in stored] == ["extra"]
    merged = host._merged_session_snapshot_unlocked("thread-1")
    assert {item.name for item in merged.servers} == {"taken", "extra"}
    assert [item.name for item in host._mcp_snapshot.servers] == ["taken"]
    reasons = [
        fields["reason"]
        for event, fields in host._diagnostic_log.events
        if event == "acp.session.mcp_rejected"
    ]
    assert reasons == ["name_collision", "transport"]
    assert "secret-cmd" not in str(host._diagnostic_log.events)


def test_authorize_existing_file_stays_inside_roots(tmp_path: Path) -> None:
    """工作区内的文件返回绝对路径；根外文件返回 None。"""
    host = make_host(tmp_path, echo=True)
    inside = host.workspace / "note.py"
    inside.write_text("x = 1\n", encoding="utf-8")
    outside = tmp_path / "outside.py"
    outside.write_text("y = 2\n", encoding="utf-8")
    assert host.authorize_existing_file(str(inside)) == str(inside.resolve())
    assert host.authorize_existing_file(str(outside)) is None
    assert host.authorize_existing_file(str(host.workspace)) is None


async def test_accepted_directory_is_revoked_on_close(tmp_path: Path) -> None:
    """session/new 接受的额外目录在 session/close 后消失。"""
    extra = tmp_path / "extra"
    extra.mkdir()
    host = make_host(tmp_path, echo=True)
    async with InProcessAcp(host) as acp:
        await acp.client.request(
            1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
        )
        created = await acp.client.request(
            2,
            "session/new",
            {
                "cwd": str(host.workspace),
                "mcpServers": [],
                "additionalDirectories": [str(extra)],
            },
        )
        assert "result" in created, created
        paths = {root.path for root in host._workspace_root_registry.roots()}
        assert extra.resolve() in paths
        closed = await acp.client.request(
            3, "session/close", {"sessionId": created["result"]["sessionId"]}
        )
        assert "result" in closed, closed
    paths = {root.path for root in host._workspace_root_registry.roots()}
    assert extra.resolve() not in paths
