"""用真实本机 MCP 验证会话构图与连接租约，不访问用户配置或模型服务。"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from harness_agent.config.config import ModelSettings, ToolsSettings
from harness_agent.extensions.mcp import McpConnectionManager, build_mcp_snapshot
from harness_agent.host.agent_host import AgentHost
from harness_agent.runtime.agent_spec import skill_catalog_fingerprint


async def test_session_mcp_engine_keeps_filtered_tools_and_live_lease(
    tmp_path: Path, monkeypatch: Any
) -> None:
    """会话 MCP 可构图；子视图不越权，最后一名会话退出也不打断已有图。"""
    import harness_agent.extensions.providers.harness_gateway as gateway_module
    import harness_agent.runtime.agent as agent_module
    import harness_agent.threads.context_window as context_window_module

    mcp_script = tmp_path / "controlled_mcp.py"
    mcp_script.write_text(
        'from mcp.server.fastmcp import FastMCP\n'
        'server = FastMCP("controlled-context")\n'
        '@server.tool()\n'
        'def read() -> str:\n'
        '    """返回受控内容。"""\n'
        '    return "controlled context"\n'
        '@server.tool()\n'
        'def secret() -> str:\n'
        '    """子视图无权读取。"""\n'
        '    return "hidden context"\n'
        'server.run(transport="stdio")\n',
        encoding="utf-8",
    )
    captured_tools: list[list[Any]] = []
    model_builds: list[object] = []
    monkeypatch.setattr(
        agent_module,
        "create_harness_agent",
        lambda *_args, **kwargs: captured_tools.append(kwargs["tools"]) or object(),
    )
    monkeypatch.setattr(
        context_window_module, "ContextWindowMiddleware", lambda *_args, **_kwargs: object()
    )
    monkeypatch.setattr(
        gateway_module,
        "create_openai_compatible_model",
        lambda *_args, **_kwargs: model_builds.append(object()) or object(),
    )

    class Lease:
        def __init__(self) -> None:
            self.value = SimpleNamespace(backend=object())
            self.released = False

        async def release(self) -> None:
            self.released = True

    class Pool:
        def __init__(self) -> None:
            self.leases: list[Lease] = []

        async def acquire(self, *_args: object) -> Lease:
            lease = Lease()
            self.leases.append(lease)
            return lease

        async def aclose(self) -> None:
            return None

    provider_pool = Pool()
    workspace_pool = Pool()
    host = AgentHost(
        allow_echo=True, workspace=tmp_path, config_home=tmp_path / "isolated-home"
    )
    host._config = SimpleNamespace(tools=ToolsSettings(defer="off"), model_catalog=None)
    global_snapshot = build_mcp_snapshot([], revision="isolated")
    manager = McpConnectionManager(global_snapshot)
    host._mcp_snapshot = global_snapshot
    host._mcp_manager = manager
    host._provider_client_pool = provider_pool  # type: ignore[assignment]
    host._ensure_workspace_execution_resources = lambda: workspace_pool  # type: ignore[method-assign]

    async def persistence() -> object:
        return SimpleNamespace(checkpointer=object())

    host._ensure_thread_persistence = persistence  # type: ignore[method-assign]
    session_server = {
        "name": "workbench-context",
        "transport": "stdio",
        "command": sys.executable,
        "args": ["-I", str(mcp_script)],
        "timeout": 10,
    }
    engines = []
    try:
        await host.set_session_mcp("session-a", [session_server])
        await host.set_session_mcp("session-b", [session_server])
        snapshot = host._merged_session_snapshot_unlocked("session-a")
        tools = host._tools_for_snapshot_unlocked(snapshot)
        assert {tool.name for tool in tools} == {
            "workbench-context_read", "workbench-context_secret"
        }
        assert manager.snapshot is global_snapshot
        assert manager.get_tools() == []
        probe = await manager.acquire(snapshot)
        runtime = probe.value
        await probe.release()
        registry = SimpleNamespace(snapshot_id="isolated-skills")

        for name, allowed in (
            ("parent", tools),
            ("child", tuple(tool for tool in tools if tool.name.endswith("_read"))),
        ):
            profile = SimpleNamespace(
                profile_key=name,
                mcp_config_fingerprint=snapshot.digest,
                sandbox_config_fingerprint="isolated-sandbox",
                skill_catalog_fingerprint=skill_catalog_fingerprint(
                    registry, view_fingerprint=name
                ),
            )
            spec = SimpleNamespace(
                runtime_profile=profile,
                mcp_snapshot=snapshot,
                execution=SimpleNamespace(approval_mode="yolo"),
                workspace=tmp_path,
                model_settings=ModelSettings("offline-model", "http://127.0.0.1:9/v1"),
                model_view=None,
                tools=allowed,
                interactive=False,
                enable_ask_user=False,
                enable_memory=False,
                enable_skills=False,
                effective_policy=SimpleNamespace(approval_mode=None),
                capability_view=SimpleNamespace(
                    mcp_tool_names=tuple(tool.name for tool in allowed)
                ),
                skill_registry=registry,
                skill_view_fingerprint=name,
                pinned=False,
            )
            host._resolved_agent_specs[name] = spec
            engines.append(await host._build_default_agent_engine(profile))
            assert captured_tools[-1] == list(allowed)

        # 同名服务器的配置变化不能借用现存快照；声明但未加载的工具也不能放行。
        missing_snapshot = build_mcp_snapshot(
            [replace(snapshot.servers[0], args=("-I", str(tmp_path / "other.py")))],
            revision="unregistered",
        )
        for name, candidate_snapshot, candidate_tools, error in (
            (
                "missing-snapshot", missing_snapshot, spec.tools,
                "MCP_RESOURCE_SNAPSHOT_UNAVAILABLE",
            ),
            (
                "missing-tool", snapshot, (SimpleNamespace(name="absent"),),
                "RUNTIME_MCP_TOOL_VIEW_UNAVAILABLE",
            ),
        ):
            rejected_profile = SimpleNamespace(
                **(vars(profile) | {
                    "profile_key": name,
                    "mcp_config_fingerprint": candidate_snapshot.digest,
                })
            )
            rejected_spec = SimpleNamespace(
                **(vars(spec) | {
                    "runtime_profile": rejected_profile,
                    "mcp_snapshot": candidate_snapshot,
                    "tools": candidate_tools,
                    "capability_view": SimpleNamespace(
                        mcp_tool_names=tuple(tool.name for tool in candidate_tools)
                    ),
                })
            )
            host._resolved_agent_specs[name] = rejected_spec
            with pytest.raises(RuntimeError, match=error):
                await host._build_default_agent_engine(rejected_profile)

        assert len(model_builds) == 2
        await host.set_session_mcp("session-a", [])
        still_shared = await manager.acquire(snapshot)
        await still_shared.release()
        await host.set_session_mcp("session-b", [])
        with pytest.raises(RuntimeError, match="MCP_RESOURCE_SNAPSHOT_UNAVAILABLE"):
            await manager.acquire(snapshot)
        with pytest.raises(RuntimeError, match="MCP_RESOURCE_SNAPSHOT_UNAVAILABLE"):
            await manager.acquire_covering(snapshot)
        await manager.reap()
        assert runtime.connected
        assert runtime.tools == list(tools)
        # 已借用的工具在会话解绑后仍能发起真实 MCP 调用。
        result = await captured_tools[-1][0].ainvoke({})
        assert "controlled context" in str(result)
        assert not (await engines[0].aclose()).failures
        await manager.reap()
        assert runtime.connected
        assert not (await engines[1].aclose()).failures
        await manager.reap()
        assert not runtime.connected
        assert runtime.tools == []
        assert all(lease.released for lease in provider_pool.leases)
        assert all(lease.released for lease in workspace_pool.leases)
    finally:
        for engine in engines:
            await engine.aclose()
        await host.close()
