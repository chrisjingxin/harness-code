"""派单、闲置让出目录及停止核查的真实 Store/Service 回归。"""

import json
from types import SimpleNamespace

import pytest
from harness_agent.runtime.fusion.guard import FusionEffectMiddleware
from harness_agent.runtime.fusion.store import FusionError
from harness_agent.runtime.fusion.tools import DelegateInput, create_fusion_tools


@pytest.mark.parametrize("role", ["lead", "sidekick"])
@pytest.mark.parametrize("ended", ["cancelled", "superseded"])
async def test_ended_or_superseded_execution_cannot_request_another_model(
    tmp_path, role, ended
):
    p, store, task, ctx, _, _, _ = await setup(tmp_path)
    try:
        ctx.fusion_role = role
        if ended == "cancelled":
            await store.cancel(task.task_id, task.version)
        else:
            await store.claim_run(task.task_id, task.version, "new-host", "new-run")
        middleware = FusionEffectMiddleware(SimpleNamespace(), store)
        assert await middleware.abefore_model(
            {"messages": []}, SimpleNamespace(context=ctx)
        ) == {"jump_to": "end"}
    finally:
        await p.close()


async def test_terminal_task_cannot_be_revived_by_late_phase_update(tmp_path):
    p, store, task, _, _, _, _ = await setup(tmp_path)
    try:
        task = await store.cancel(task.task_id, task.version)
        with pytest.raises(FusionError, match="FUSION_TASK_CONFLICT"):
            await store.update(task.task_id, task.version, phase="WAITING_USER")
        assert (await store.get(task.task_id)).phase == "CANCELLED"
    finally:
        await p.close()


async def test_cancelled_worker_does_not_request_a_missing_report(tmp_path):
    p, store, task, ctx, service, _, _ = await setup(tmp_path)
    try:
        ctx.fusion_role = "sidekick"
        await store.cancel(task.task_id, task.version)
        assert (await service.final_gate(ctx)(None)).action == "allow"
    finally:
        await p.close()


async def test_late_worker_return_preserves_cancellation(tmp_path):
    p, store, task, ctx, service, _, _ = await setup(tmp_path)
    try:

        async def stopped_then_cancelled(context, task, message):
            await store.mark_delivery(task.data["operation_id"], "accepted")
            current = await store.get(task.task_id)
            await store.cancel(task.task_id, current.version)

        service.worker = stopped_then_cancelled
        result = await delegate(service, ctx)
        assert result["phase"] == "CANCELLED" and result["active"] is False
        current = await store.get(task.task_id)
        assert (await store.load_delivery(task.task_id, current.data["operation_id"]))[
            "state"
        ] == "accepted"
    finally:
        await p.close()


@pytest.mark.parametrize("role", ["lead", "sidekick"])
async def test_unknown_effect_ends_model_loop_without_changing_unknown_state(
    tmp_path, role
):
    p, store, task, ctx, service, _, _ = await setup(tmp_path)
    try:
        task, lease = await pending(store, task)
        effect = await store.begin_effect(
            task.task_id, lease.generation, "worker", "execute", "digest"
        )
        await store.finish_effect(effect, succeeded=False, stopped=False)
        task = await store.pause(task.task_id)
        ctx.fusion_role = role
        assert task.phase == "OUTCOME_UNKNOWN"
        middleware = FusionEffectMiddleware(SimpleNamespace(), store)
        assert await middleware.abefore_model(
            {"messages": []}, SimpleNamespace(context=ctx)
        ) == {"jump_to": "end"}
        assert (await service.final_gate(ctx)(None)).action == "allow"
        assert (await store.get(task.task_id)).phase == "OUTCOME_UNKNOWN"
    finally:
        await p.close()


async def test_run_exit_refreshes_unknown_operations_after_worker_stopped(tmp_path):
    p, store, task, ctx, _, _, _ = await setup(tmp_path)
    try:
        task = await store.claim_run(task.task_id, task.version, "host", ctx.run_id)
        task, lease = await pending(store, task)
        effect = await store.begin_effect(
            task.task_id, lease.generation, "worker", "execute", "digest"
        )
        await store.finish_effect(effect, succeeded=False, stopped=False)
        task = await store.pause(task.task_id)
        assert len(task.data["pending_operations"]) == 2
        await store.record_worker_stopped(
            task.task_id, "pending", "worker", interrupted=True
        )
        await store.release_run(task.task_id, "host", ctx.run_id)
        task = await store.get(task.task_id)
        assert task.phase == "OUTCOME_UNKNOWN" and task.data["active_run"] is None
        assert [item["operation_id"] for item in task.data["pending_operations"]] == [
            effect
        ]
    finally:
        await p.close()


from langchain_core.messages import ToolMessage
from pydantic import ValidationError
from tests.runtime.test_fusion_service import setup


async def delegate(service, ctx):
    return await service.delegate(
        ctx,
        goal="实现工具",
        brief="读取后修改并验证",
        allowed_paths=["a.py"],
        check_plan_ids=[],
    )


async def pending(store, task):
    task, lease = await store.start_round(
        task.task_id, task.version, {"revision": 1}, "pending", "message"
    )
    task = await store.update(
        task.task_id, task.version, data={"worker_execution_id": "worker"}
    )
    await store.mark_delivery("pending", "dispatched")
    return task, lease


async def test_short_request_is_frozen_by_host_without_model_quotes(tmp_path):
    p, store, task, ctx, service, _, _ = await setup(tmp_path)
    try:
        task = await store.update(
            task.task_id,
            task.version,
            data={"source_message": "实现一个字符串大小写转换工具类"},
        )
        result = await delegate(service, ctx)
        order = await store.load_record(task.task_id, "order", "1")
        assert result["phase"] == "REVIEWING"
        assert order["requirements"] == [
            {"id": "r1", "quote": "实现一个字符串大小写转换工具类"}
        ]
        assert "读取后修改" not in str(order["requirements"])
    finally:
        await p.close()


async def test_every_snapshot_is_protected_by_the_tasks_workspace_lease(
    tmp_path, monkeypatch
):
    import sqlite3

    import harness_agent.runtime.fusion.service as module

    p, store, task, ctx, service, _, _ = await setup(tmp_path)
    original = module.capture_snapshot

    def capture(*args):
        connection = sqlite3.connect(store.database_path)
        try:
            row = connection.execute(
                "SELECT task_id FROM fusion_leases WHERE workspace_key=?",
                (task.workspace_key,),
            ).fetchone()
            assert row and row[0] == task.task_id
        finally:
            connection.close()
        return original(*args)

    monkeypatch.setattr(module, "capture_snapshot", capture)
    try:
        await delegate(service, ctx)
    finally:
        await p.close()


async def test_repeated_cancel_never_reactivates_terminal_task(tmp_path):
    p, store, task, _, _, _, root = await setup(tmp_path)
    try:
        cancelled = await store.cancel(task.task_id, task.version)
        other = await store.create(
            thread_id=task.thread_id,
            profile=task.data["profile"],
            workspace=root,
            source_message="新任务",
        )
        again = await store.cancel(
            cancelled.task_id, cancelled.version, stopped_inspection_note="已核查停止"
        )
        assert again == cancelled
        assert (await store.active(task.thread_id)).task_id == other.task_id
    finally:
        await p.close()


async def test_run_owner_and_late_cleanup_cannot_disrupt_another_run(tmp_path):
    p, store, task, _, _, _, _ = await setup(tmp_path)
    try:
        task = await store.claim_run(task.task_id, task.version, "host-a", "run-a")
        with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
            await store.claim_run(task.task_id, task.version, "host-b", "run-b")
        await store.release_run(task.task_id, "host-a", "run-a")
        task = await store.get(task.task_id)
        assert task.phase == "PAUSED" and task.data["active_run"] is None
        task = await store.claim_run(task.task_id, task.version, "host-b", "run-b")
        before = task.version
        await store.release_run(task.task_id, "host-a", "run-a")
        task = await store.get(task.task_id)
        assert task.version == before and task.data["active_run"] == {
            "owner": "host-b",
            "run_id": "run-b",
        }
    finally:
        await p.close()


async def test_explicit_list_quotes_cover_every_original_requirement(tmp_path):
    p, store, task, ctx, service, _, _ = await setup(tmp_path)
    try:
        source = "实现转换工具：\n" + "\n".join(
            f"{i}. 保留需求 {i}" for i in range(1, 41)
        )
        await store.update(task.task_id, task.version, data={"source_message": source})
        await delegate(service, ctx)
        order = await store.load_record(task.task_id, "order", "1")
        requirements = order["requirements"]
        assert len(requirements) <= 32
        assert all(item["quote"] in source for item in requirements)
        assert all(
            f"保留需求 {i}" in "\n".join(item["quote"] for item in requirements)
            for i in range(1, 41)
        )
    finally:
        await p.close()


def test_model_cannot_supply_or_forge_user_requirements():
    with pytest.raises(ValidationError):
        DelegateInput.model_validate(
            {
                "goal": "g",
                "brief": "b",
                "allowed_paths": ["a.py"],
                "user_requirements": ["伪造要求"],
            }
        )
    tool = next(t for t in create_fusion_tools("lead") if t.name == "fusion_delegate")
    assert "user_requirements" not in tool.args


async def test_invalid_tool_fields_return_failed_message_without_input_secrets():
    tool = next(t for t in create_fusion_tools("lead") if t.name == "fusion_delegate")
    result = await tool.ainvoke(
        {
            "name": tool.name,
            "id": "bad",
            "type": "tool_call",
            "args": {"goal": "g", "secret": "sk-never-echo-this"},
        }
    )
    assert result.status == "error"
    data = json.loads(result.content)
    assert data["error"] == "FUSION_INPUT_INVALID"
    assert "allowed_paths" in str(data)
    assert "sk-never-echo-this" not in result.content


async def test_idle_owner_yields_directory_and_keeps_its_task(tmp_path):
    p, store, task, _, _, _, root = await setup(tmp_path)
    try:
        owner = await store.create(
            thread_id="old",
            profile=task.data["profile"],
            workspace=root,
            source_message="旧任务",
        )
        lease = await store.acquire_lease(owner.task_id, "sidekick")
        owner = await store.update(
            owner.task_id,
            owner.version,
            phase="WAITING_USER",
            data={"reason": "rework_limit"},
        )
        newer = await store.acquire_lease(task.task_id, "sidekick")
        assert newer.generation > lease.generation
        assert (await store.get(owner.task_id)).active
        with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
            await store.release_lease(owner.task_id, lease.generation)
    finally:
        await p.close()


async def test_unknown_queries_are_idempotent_and_keep_writer(tmp_path):
    p, store, task, _, _, _, root = await setup(tmp_path)
    try:
        task, _ = await pending(store, task)
        first = await store.reconcile(task.task_id)
        assert first.phase == "OUTCOME_UNKNOWN"
        for _ in range(3):
            assert (await store.reconcile(task.task_id)).version == first.version
        other = await store.create(
            thread_id="new",
            profile=task.data["profile"],
            workspace=root,
            source_message="新任务",
        )
        with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
            await store.acquire_lease(other.task_id, "sidekick")
    finally:
        await p.close()


async def test_cancel_inspects_and_releases_in_one_transaction(tmp_path):
    p, store, task, _, _, _, root = await setup(tmp_path)
    try:
        task, lease = await pending(store, task)
        effect = await store.begin_effect(
            task.task_id, lease.generation, "worker", "execute", "digest"
        )
        task = await store.pause(task.task_id)
        result = await store.cancel(
            task.task_id,
            task.version,
            stopped_inspection_note="已检查文件和进程，执行已停止",
        )
        assert result.phase == "CANCELLED" and not result.active
        assert result.data["inspection_digest"]
        assert (await store.load_delivery(task.task_id, "pending"))[
            "state"
        ] == "inspected"
        assert (
            next(
                e
                for e in await store.effects(task.task_id)
                if e["operation_id"] == effect
            )["stopped"]
            == 1
        )
        assert (root / "a.py").read_text() == "one"
        other = await store.create(
            thread_id="new",
            profile=task.data["profile"],
            workspace=root,
            source_message="新任务",
        )
        await store.acquire_lease(other.task_id, "sidekick")
    finally:
        await p.close()


@pytest.mark.parametrize("note", [None, "", "   "])
async def test_unknown_cancel_needs_nonempty_stop_confirmation(tmp_path, note):
    p, store, task, _, _, _, _ = await setup(tmp_path)
    try:
        task, _ = await pending(store, task)
        task = await store.pause(task.task_id)
        with pytest.raises(FusionError, match="FUSION_OUTCOME_UNKNOWN"):
            await store.cancel(task.task_id, task.version, stopped_inspection_note=note)
        assert (await store.load_delivery(task.task_id, "pending"))[
            "state"
        ] == "dispatched"
    finally:
        await p.close()


async def test_stale_inspection_cannot_partially_change_stop_records(tmp_path):
    p, store, task, _, _, _, _ = await setup(tmp_path)
    try:
        task, lease = await pending(store, task)
        await store.begin_effect(
            task.task_id, lease.generation, "worker", "execute", "digest"
        )
        task = await store.pause(task.task_id)
        old_version = task.version
        await store.update(task.task_id, task.version, data={"changed": True})
        with pytest.raises(FusionError, match="FUSION_TASK_CONFLICT"):
            await store.cancel(
                task.task_id, old_version, stopped_inspection_note="已核查停止"
            )
        assert any(not e["stopped"] for e in await store.effects(task.task_id))
        assert (await store.load_delivery(task.task_id, "pending"))[
            "state"
        ] == "dispatched"
    finally:
        await p.close()


@pytest.mark.parametrize("unknown_effect", [False, True])
async def test_worker_exit_settles_dispatch_but_does_not_invent_command_stop(
    tmp_path, unknown_effect
):
    p, store, task, _, _, _, root = await setup(tmp_path)
    try:
        task, lease = await pending(store, task)
        if unknown_effect:
            await store.begin_effect(
                task.task_id, lease.generation, "worker", "execute", "digest"
            )
        await store.record_worker_stopped(
            task.task_id, "pending", "worker", interrupted=True
        )
        task = await store.pause(task.task_id)
        assert task.data["worker_checkpoint_interrupted"] is True
        assert task.phase == ("OUTCOME_UNKNOWN" if unknown_effect else "PAUSED")
        other = await store.create(
            thread_id="new",
            profile=task.data["profile"],
            workspace=root,
            source_message="新任务",
        )
        if unknown_effect:
            with pytest.raises(FusionError, match="FUSION_LEASE_BUSY"):
                await store.acquire_lease(other.task_id, "sidekick")
        else:
            await store.acquire_lease(other.task_id, "sidekick")
    finally:
        await p.close()


async def test_old_ack_cannot_overwrite_new_round_or_revoke_new_writer(tmp_path):
    p, store, task, _, _, _, _ = await setup(tmp_path)
    try:
        task, _ = await pending(store, task)
        await store.record_worker_stopped(
            task.task_id, "pending", "worker", interrupted=True
        )
        task = await store.pause(task.task_id)
        task, _ = await store.start_round(
            task.task_id, task.version, {"revision": 1}, "new-op", "new message"
        )
        task = await store.update(
            task.task_id, task.version, data={"worker_execution_id": "new-worker"}
        )
        before = task.version
        await store.record_worker_stopped(
            task.task_id, "pending", "worker", interrupted=False
        )
        current = await store.get(task.task_id)
        assert current.version == before and current.data["operation_id"] == "new-op"
        assert current.data["worker_checkpoint_interrupted"] is True
    finally:
        await p.close()


async def test_resume_reacquires_directory_before_reusing_review_ticket(tmp_path):
    p, store, task, ctx, service, _, root = await setup(tmp_path)
    try:
        result = await delegate(service, ctx)
        task = await store.pause(task.task_id)
        other = await store.create(
            thread_id="other",
            profile=task.data["profile"],
            workspace=root,
            source_message="另一任务",
        )
        other, _ = await pending(store, other)
        waiting = await service.resume(task.task_id)
        assert waiting.data["reason"] == "workspace_busy"
        assert waiting.data["workspace_blocker"]["task_id"] == other.task_id
        await store.mark_delivery("pending", "not_started")
        await store.pause(other.task_id)
        restored = await service.resume(task.task_id)
        assert (
            restored.phase == "REVIEWING"
            and restored.data["ticket_id"] == result["ticket_id"]
        )
        assert (await store.acquire_lease(task.task_id, "host")).owner == "host"
    finally:
        await p.close()


async def test_control_errors_are_failed_messages_and_stop_repeated_lead_guesses(
    tmp_path,
):
    p, store, task, ctx, _, _, _ = await setup(tmp_path)
    middleware = FusionEffectMiddleware(SimpleNamespace(), store)
    try:
        messages = []
        for i in range(3):
            request = SimpleNamespace(
                tool_call={"name": "fusion_delegate", "id": str(i)},
                runtime=SimpleNamespace(context=ctx),
            )

            async def handler(request):
                return ToolMessage(
                    content=json.dumps(
                        {"error": "FUSION_CHECK_INVALID", "field": "check_plan_ids"}
                    ),
                    tool_call_id=request.tool_call["id"],
                    name="fusion_delegate",
                )

            result = await middleware.awrap_tool_call(request, handler)
            assert result.status == "error"
            messages.append(result)
        result = await middleware.abefore_model(
            {"messages": messages}, SimpleNamespace(context=ctx)
        )
        assert result["jump_to"] == "end"
        task = await store.get(task.task_id)
        assert (
            task.phase == "WAITING_USER"
            and task.data["reason"] == "lead_control_rejected"
        )
    finally:
        await p.close()
