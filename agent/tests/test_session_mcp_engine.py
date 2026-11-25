"""会话级 MCP 侧路运行时借用与 AgentHost Engine 覆盖测试。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harness_agent.extensions.mcp import (
    McpConfigSnapshot,
    McpConnectionManager,
    McpServerConfig,
    build_mcp_snapshot,
)
from harness_agent.host.agent_host import AgentHost


def _http_server(name: str, port: int) -> McpServerConfig:
    return McpServerConfig(
        name=name,
        transport="http",
        url=f"http://127.0.0.1:{port}/mcp",
        headers={"Authorization": "Bearer test-token"},
        source="session",
    )


def test_acquire_covering_uses_side_runtime_and_rejects_mismatch() -> None:
    """会话级侧路快照可被精确及子集视图借用，不匹配时 fail-closed 抛异常。"""

    async def run() -> None:
        base_server = _http_server("global-srv", 19001)
        side_server = _http_server("workbench-context", 19002)
        global_snapshot = build_mcp_snapshot((base_server,), revision="global")
        side_snapshot = build_mcp_snapshot(
            (base_server, side_server),
            revision="session-side",
        )
        subset_snapshot = build_mcp_snapshot((side_server,), revision="subset")
        drifted_snapshot = build_mcp_snapshot(
            (_http_server("workbench-context", 19003),),
            revision="drifted",
        )

        manager = McpConnectionManager(global_snapshot)
        with patch.object(manager, "_connect_runtime", AsyncMock(return_value=None)):
            await manager._connect_runtime(manager._current_resource.value)
            await manager.ensure_side_runtime(side_snapshot)

        # 精确命中会话侧路快照
        lease_exact = await manager.acquire_covering(side_snapshot)
        assert lease_exact.value.snapshot.digest == side_snapshot.digest
        await lease_exact.release()

        # 子集快照可从覆盖它的 READY 侧路快照借用
        lease_subset = await manager.acquire_covering(subset_snapshot)
        assert {s.name for s in lease_subset.value.snapshot.servers} >= {
            "workbench-context"
        }
        await lease_subset.release()

        # 配置漂移或不存在的快照必须拒绝
        with pytest.raises(RuntimeError, match="MCP_RESOURCE_SNAPSHOT_UNAVAILABLE"):
            await manager.acquire_covering(drifted_snapshot)

        await manager.close_all()

    asyncio.run(run())


def test_agent_host_build_engine_acquires_session_mcp_side_runtime(
    tmp_path: Path,
) -> None:
    """挂载会话级 MCP 后，AgentHost 构建 Engine 应通过 acquire_covering 借用侧路工具。"""

    async def run() -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        config_home = tmp_path / "home"
        (config_home / ".harness").mkdir(parents=True)
        (config_home / ".harness" / "config.toml").write_text(
            "\n".join(
                [
                    "[config]",
                    "version = 1",
                    "",
                    "[models]",
                    'default_profile = "mock"',
                    "",
                    "[models.profiles.mock]",
                    'provider = "openai-compatible"',
                    'model = "mock-model"',
                    'base_url = "http://127.0.0.1:18789/v1"',
                    'api_key_env = "E2E_MOCK_API_KEY"',
                    "",
                ]
            ),
            encoding="utf-8",
        )

        host = AgentHost(workspace=workspace, config_home=config_home, allow_echo=False)
        server = _http_server("workbench-context", 19123)
        side_snapshot = build_mcp_snapshot((server,), revision="global")

        fake_tool = MagicMock()
        fake_tool.name = "workbench-context_list_team_knowledge"

        manager = McpConnectionManager(build_mcp_snapshot((), revision="empty"))
        with patch.object(manager, "_connect_runtime", AsyncMock(return_value=None)):
            await manager.ensure_side_runtime(side_snapshot)
            side_resource = manager._resources[side_snapshot.digest][-1]
            side_resource.value.tools = [fake_tool]
            side_resource.value.connected = True

        host._mcp_manager = manager
        host._mcp_snapshot = manager.snapshot

        spec = MagicMock()
        spec.mcp_snapshot = side_snapshot
        spec.tools = (fake_tool,)
        spec.capability_view.mcp_tool_names = ("workbench-context_list_team_knowledge",)
        spec.effective_policy = MagicMock()
        spec.effective_policy.approval_mode = "default"
        spec.goal_backed = False
        spec.code_index_generation = None
        spec.execution.approval_classifier = None
        spec.model_settings = MagicMock()
        spec.model_settings.context_window_tokens = 128_000
        spec.model_settings.max_retries = 0
        spec.execution = MagicMock()
        spec.workspace = workspace
        spec.runtime_profile = MagicMock()
        spec.runtime_profile.profile_key = "test-profile"
        spec.runtime_profile.mcp_config_fingerprint = side_snapshot.digest
        spec.runtime_profile.sandbox_config_fingerprint = "sbx"
        spec.runtime_profile.skill_catalog_fingerprint = None
        spec.skill_registry = MagicMock()
        spec.skill_view_fingerprint = "sk"

        host._resolved_agent_specs["test-profile"] = spec

        fake_lease = AsyncMock()
        fake_lease.value = MagicMock()
        with (
            patch.object(host, "_ensure_plugin_runtime_started", AsyncMock()),
            patch.object(host, "_ensure_thread_persistence", AsyncMock(return_value=MagicMock(checkpointer=MagicMock()))),
            patch.object(host._provider_client_pool, "acquire", AsyncMock(return_value=fake_lease)),
            patch.object(host, "_ensure_workspace_execution_resources", return_value=MagicMock(acquire=AsyncMock(return_value=fake_lease))),
            patch("harness_agent.host.agent_host.skill_catalog_fingerprint", return_value="sk"),
            patch("harness_agent.extensions.providers.harness_gateway.create_openai_compatible_model", return_value=MagicMock()),
            patch("harness_agent.runtime.agent.create_harness_agent", return_value=MagicMock()),
            patch.object(host, "_plugin_delegation_targets", AsyncMock(return_value=())),
            patch.object(host, "_bound_builtin_delegation_targets", AsyncMock(return_value=())),
        ):
            engine = await host._build_default_agent_engine(spec.runtime_profile)
            assert engine is not None
            await engine.aclose()

        await manager.close_all()

    asyncio.run(run())
