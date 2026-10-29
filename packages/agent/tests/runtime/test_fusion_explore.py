import asyncio
from types import SimpleNamespace
import pytest
from tests.runtime.test_fusion_roles import profile
from tests.runtime.test_agent_spec import _spec
from harness_agent.runtime.fusion.roles import (
    resolve_fusion_specs,
    resolve_exploration_spec,
)


def test_exploration_has_separate_identity_and_no_mutation_capabilities(tmp_path):
    lead, worker = resolve_fusion_specs(_spec(tmp_path), profile())
    explore = resolve_exploration_spec(worker, profile())
    assert "fusion_explore" in lead.capability_view.tool_names
    assert explore.runtime_profile.profile_key != worker.runtime_profile.profile_key
    assert set(explore.capability_view.tool_names) <= {
        "ls",
        "read_file",
        "glob",
        "grep",
        "lsp",
        "codebase_explore",
        "fusion_status",
    }
    assert (
        explore.capability_view.filesystem_write is None
        and explore.capability_view.shell_commands is None
    )
    assert not explore.enable_ask_user


async def test_explore_preserves_order_phase_and_ticket_and_cancellation(tmp_path):
    from tests.runtime.test_fusion_service import setup

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)

    async def explorer(context, task, question, exploration_id):
        assert (await store.get(task.task_id)).phase == "READY"
        return "入口位于 a.py；还需 Lead 核实。"

    service.explorer = explorer
    try:
        result = await service.explore(ctx, question="找入口")
        current = await store.get(task.task_id)
        assert current.phase == "READY" and current.data.get("round", 0) == 0
        assert not current.data.get("ticket_id") and not current.data.get(
            "checkpoint_id"
        )
        assert not rounds and "入口" in result["summary"]
        assert len(await store.list_records(task.task_id, "exploration")) == 1

        async def cancelled(*args):
            raise asyncio.CancelledError()

        service.explorer = cancelled
        with pytest.raises(asyncio.CancelledError):
            await service.explore(ctx, question="再查")
        current = await store.get(task.task_id)
        assert (
            current.data["exploration"]["status"] == "cancelled"
            and current.phase == "READY"
        )
    finally:
        await p.close()


async def test_exploration_guard_denies_even_with_valid_worker_lease(tmp_path):
    from tests.runtime.test_fusion_guard import setup
    from harness_agent.runtime.fusion.guard import FusionEffectMiddleware

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    ctx.fusion_state.exploration_only = True
    called = []

    async def handler(request):
        called.append(request)
        return "should not run"

    try:
        middleware = FusionEffectMiddleware(guard, store)
        for name in [
            "execute",
            "write_file",
            "fusion_submit_result",
            "task",
            "ask_user",
            "fusion_delegate",
        ]:
            result = await middleware.awrap_tool_call(
                SimpleNamespace(
                    tool_call={
                        "id": name,
                        "name": name,
                        "args": {"command": "true", "file_path": "/src/a.py"},
                    },
                    runtime=SimpleNamespace(context=ctx),
                ),
                handler,
            )
            assert result.status == "error" and "FUSION_ROLE_DENIED" in result.content
        assert not called
    finally:
        await p.close()
