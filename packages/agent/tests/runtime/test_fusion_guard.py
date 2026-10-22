from types import SimpleNamespace

import pytest

from harness_agent.runtime.run_context import FusionRunState
from harness_agent.threads.thread_persistence import ThreadPersistence


async def setup(tmp_path):
    from harness_agent.runtime.fusion.guard import FusionWriteGuard

    root = tmp_path / "project"
    root.mkdir()
    p = await ThreadPersistence.open(project=root, home=tmp_path / "home")
    store = p.fusion_state_store()
    task = await store.create(
        thread_id="t",
        profile={"profile_id": "duo"},
        workspace=root,
        source_message="修改",
    )
    await store.save_record(task.task_id, "order", "1", {"allowed_paths": ["src/"]})
    task = await store.update(
        task.task_id, task.version, phase="WORKER_RUNNING", data={"revision": 1}
    )
    lease = await store.acquire_lease(task.task_id, "sidekick")
    ctx = SimpleNamespace(
        fusion_task_id=task.task_id,
        fusion_role="sidekick",
        fusion_state=FusionRunState(1, lease.generation),
        thread_id="t",
        execution_id="exec",
        approval_mode="auto-edit",
        approval_state=None,
        approval_mode_provider=None,
        plan_constraint=None,
    )
    guard = FusionWriteGuard(
        store.database_path,
        project_fingerprint=store.project,
        workspace=root,
        context_provider=lambda: ctx,
    )
    return p, store, task, lease, ctx, guard


async def test_prepare_scope_and_commit_recheck_after_approval(tmp_path):
    from harness_agent.tools.file_mutation import MutationMetadata

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    try:
        metadata = MutationMetadata("write", "/src/a.py", "t", "call")
        authorized = guard.prepare(metadata)
        with pytest.raises(ValueError, match="FUSION_PATH_INVALID"):
            guard.prepare(MutationMetadata("write", "/other.py", "t", "call2"))
        ctx.approval_mode = "plan"
        with pytest.raises(ValueError, match="FUSION_ROLE_DENIED"):
            with guard.commit(authorized):
                pass
        ctx.approval_mode = "auto-edit"
        with guard.commit(authorized):
            pass
        assert (await store.effects(task.task_id))[0]["stopped"] == 1
    finally:
        await p.close()


async def test_stale_generation_and_ordinary_write_are_rejected(tmp_path):
    from harness_agent.tools.file_mutation import MutationMetadata

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    try:
        authorized = guard.prepare(MutationMetadata("write", "/src/a.py", "t", "call"))
        await store.acquire_lease(task.task_id, "host")
        with pytest.raises(ValueError, match="FUSION_LEASE_BUSY"):
            with guard.commit(authorized):
                pass
        ctx.fusion_task_id = None
        with pytest.raises(ValueError, match="FUSION_LEASE_BUSY"):
            guard.prepare(MutationMetadata("write", "/src/a.py", "t", "other"))
    finally:
        await p.close()


@pytest.mark.parametrize("tool_name", ["fusion_external_write", "fusion_delegate"])
async def test_ordinary_tool_cannot_bypass_writer_by_fusion_name(tmp_path, tool_name):
    from langchain_core.messages import ToolMessage

    from harness_agent.runtime.fusion.guard import FusionEffectMiddleware

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    try:
        ctx.fusion_task_id = None
        called = []

        async def handler(request):
            called.append(request)
            return ToolMessage(content="unexpected write", tool_call_id="tool")

        result = await FusionEffectMiddleware(guard, store).awrap_tool_call(
            SimpleNamespace(
                tool_call={"name": tool_name, "id": "tool", "args": {}},
                runtime=SimpleNamespace(context=ctx),
            ),
            handler,
        )
        assert result.status == "error" and result.content == "FUSION_LEASE_BUSY"
        assert not called
    finally:
        await p.close()


@pytest.mark.parametrize(
    "command",
    [
        "git add a.py",
        "git reset --hard",
        "git -C . commit -m changed",
        "git checkout HEAD -- a.py",
        "git config alias.x checkout",
    ],
)
async def test_worker_rejects_git_state_mutation(tmp_path, command):
    from harness_agent.runtime.fusion.guard import FusionEffectMiddleware

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    try:
        called = []

        async def handler(request):
            called.append(request)

        middleware = FusionEffectMiddleware(guard, store)
        result = await middleware.awrap_tool_call(
            SimpleNamespace(
                tool_call={
                    "name": "execute",
                    "id": "tool",
                    "args": {"command": command},
                },
                runtime=SimpleNamespace(context=ctx),
            ),
            handler,
        )
        assert result.status == "error" and result.content.startswith(
            "FUSION_COMMAND_INVALID"
        )
        assert not called
    finally:
        await p.close()


@pytest.mark.parametrize(
    "exit_code, expected_state", [(0, "succeeded"), (1, "failed"), (124, "unknown")]
)
async def test_execute_effect_uses_backend_exit_code_and_timeout_is_unknown(
    tmp_path, exit_code, expected_state
):
    from langchain_core.messages import ToolMessage

    from harness_agent.runtime.fusion.guard import FusionEffectMiddleware

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    try:

        async def handler(request):
            return ToolMessage(
                content=f"[Command failed with exit code {exit_code}]",
                tool_call_id="tool",
                name="execute",
            )

        await FusionEffectMiddleware(guard, store).awrap_tool_call(
            SimpleNamespace(
                tool_call={
                    "name": "execute",
                    "id": "tool",
                    "args": {"command": "python3 -V"},
                },
                runtime=SimpleNamespace(context=ctx),
            ),
            handler,
        )
        effect = (await store.effects(task.task_id))[0]
        assert effect["state"] == expected_state
        assert bool(effect["stopped"]) is (exit_code != 124)
        if exit_code == 124:
            assert (await store.get(task.task_id)).phase == "OUTCOME_UNKNOWN"
            assert (await store.get(task.task_id)).to_record()["pending_operations"]
    finally:
        await p.close()


async def test_snapshot_contract_commits_real_file_under_fusion_guard(tmp_path):
    import json

    from harness_agent.threads.snapshots import ThreadSnapshotStore
    from harness_agent.threads.text_backend import LocalTextMutationBackend
    from harness_agent.tools.snapshot_file_contract import (
        create_snapshot_file_tool_contract,
    )

    p, store, task, lease, ctx, guard = await setup(tmp_path)
    try:
        root = guard.workspace
        (root / "src").mkdir()
        contract = create_snapshot_file_tool_contract(
            object(),
            snapshot_store=ThreadSnapshotStore(),
            text_backend=LocalTextMutationBackend(root),
            mutation_guard=guard,
        )

        def request(path):
            return SimpleNamespace(
                tool_call={
                    "name": "write_file",
                    "id": "write",
                    "args": {"file_path": path, "content": "hello"},
                },
                runtime=SimpleNamespace(context=ctx),
            )

        result = json.loads(contract.dispatch(request("/src/new.py")).content)
        assert result["ok"] is True and (root / "src/new.py").read_text() == "hello"
        denied = json.loads(contract.dispatch(request("/outside.py")).content)
        assert denied["ok"] is False
        assert not (root / "outside.py").exists()
        assert (await store.effects(task.task_id))[0]["state"] == "succeeded"
    finally:
        await p.close()


@pytest.mark.parametrize(
    "command",
    [
        "cd / && python3 -m unittest discover",
        "find / -name calculator.py",
        "find -L / -name a.py",
        "sh -c 'find / -name a.py'",
    ],
)
def test_virtual_file_root_is_not_a_shell_working_directory(command):
    from harness_agent.runtime.fusion.guard import _invalid_command

    assert _invalid_command(command)


@pytest.mark.parametrize(
    "command",
    [
        "find . -name a.py",
        "cd tests && python3 -m unittest",
        "python3 -c \"s = 'find /'; print(s)\"",
    ],
)
def test_project_commands_and_quoted_root_search_text_remain_valid(command):
    from harness_agent.runtime.fusion.guard import _invalid_command

    assert not _invalid_command(command)


@pytest.mark.parametrize(
    "error",
    [
        {"code": "BACKEND_READ_FAILED", "message": "目录读取失败"},
        {"code": {"invalid": "object"}},
        {"code": ["invalid"]},
        ["FUSION_PATH_INVALID"],
        [],
        None,
        1,
    ],
)
@pytest.mark.parametrize("inspection", [False, True])
def test_rejection_counter_never_hashes_non_string_error_values(error, inspection):
    import json

    from langchain_core.messages import ToolMessage

    from harness_agent.runtime.fusion.guard import _repeated_rejection

    messages = [
        ToolMessage(
            content=json.dumps({"ok": False, "error": error}),
            name="ls",
            tool_call_id=f"ls-{index}",
            status="error",
        )
        for index in range(3)
    ]
    assert _repeated_rejection({"messages": messages}, include_unknown=inspection) == (
        ("ls", "TOOL_REJECTED") if inspection else None
    )


@pytest.mark.parametrize(
    "payload",
    [
        "FUSION_PATH_INVALID：路径需要调整",
        '{"error":"FUSION_PATH_INVALID"}',
        '{"ok":false,"error":{"code":"FUSION_PATH_INVALID","message":"范围外"}}',
    ],
)
def test_rejection_counter_still_limits_actual_fusion_errors(payload):
    from langchain_core.messages import ToolMessage

    from harness_agent.runtime.fusion.guard import _repeated_rejection

    messages = [
        ToolMessage(
            content=payload,
            name="fusion_rework",
            tool_call_id=str(index),
            status="error",
        )
        for index in range(3)
    ]
    assert _repeated_rejection({"messages": messages}) == (
        "fusion_rework",
        "FUSION_PATH_INVALID",
    )
    assert _repeated_rejection({"messages": messages[:2]}) is None
