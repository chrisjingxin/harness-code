from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from tests.runtime.test_fusion_roles import profile

from harness_agent.runtime.fusion.profile import FrozenFusionCheckPlan
from harness_agent.runtime.run_context import FusionRunState
from harness_agent.threads.thread_persistence import ThreadPersistence


def prepared_check(check):
    async def prepare(context, plan, lease):
        async def execute():
            return await check(context, plan, lease)

        return execute

    return prepare


async def setup(tmp_path, *, checks=False, submitted=True):
    from harness_agent.runtime.fusion.service import FusionService

    root = tmp_path / "workspace"
    root.mkdir()
    (root / "a.py").write_text("one")
    p = await ThreadPersistence.open(project=root, home=tmp_path / "home")
    store = p.fusion_state_store()
    frozen = profile()
    if checks:
        frozen = replace(
            frozen,
            check_plans=(FrozenFusionCheckPlan("unit", "true", root, 5, "cmd-digest"),),
        )
    task = await store.create(
        thread_id="t",
        profile=frozen.to_record(),
        workspace=root,
        source_message="保持兼容，修改实现。",
    )
    ctx = SimpleNamespace(
        fusion_task_id=task.task_id,
        fusion_role="lead",
        fusion_state=FusionRunState(),
        thread_id="t",
        run_id="r",
        execution_id="root",
        approval_mode="auto-edit",
        approval_state=None,
        approval_mode_provider=None,
        plan_constraint=None,
        event_port=None,
    )
    rounds = []

    async def worker(context, task, message):
        rounds.append((task.worker_session_id, message))
        (root / "a.py").write_text(str(len(rounds)))
        if submitted:
            await service.submit_result(
                SimpleNamespace(**{**vars(ctx), "fusion_role": "sidekick"}),
                status="completed",
                summary="已修改",
                unresolved=[],
            )

    async def check(context, plan, lease):
        return {
            "plan_id": plan.plan_id,
            "exit_code": 0,
            "stopped": True,
            "summary": "ok",
        }

    service = FusionService(
        store=store,
        workspace=root,
        profile_provider=lambda task_id: frozen,
        worker=worker,
        prepare_check=prepared_check(check),
        guard=__import__(
            "harness_agent.runtime.fusion.guard", fromlist=["FusionWriteGuard"]
        ).FusionWriteGuard(
            store.database_path,
            project_fingerprint=store.project,
            workspace=root,
            context_provider=lambda: ctx,
        ),
    )
    return p, store, task, ctx, service, rounds, root


async def test_delegate_rework_same_session_and_review_only(tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        result = await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持接口",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        assert (
            result["phase"] == "REVIEWING" and result["verification"] == "review_only"
        )
        old_ticket = result["ticket_id"]
        result = await service.rework(
            ctx, feedback="修正实现", allowed_paths=[], reason=""
        )
        assert len(rounds) == 2 and rounds[0][0] == rounds[1][0]
        assert result["ticket_id"] != old_ticket
        with pytest.raises(ValueError, match="FUSION_REPORT_STALE"):
            await service.review(
                ctx,
                ticket_id=old_ticket,
                decision="accept",
                requirements=[
                    {"id": "r1", "satisfied": True, "evidence": ["file:a.py"]}
                ],
                test_review_reason="",
            )
        accepted = await service.review(
            ctx,
            ticket_id=result["ticket_id"],
            decision="accept",
            requirements=[{"id": "r1", "satisfied": True, "evidence": ["file:a.py"]}],
            test_review_reason="",
        )
        assert (
            accepted["phase"] == "COMPLETED"
            and accepted["verification"] == "review_only"
        )
    finally:
        await p.close()


@pytest.mark.parametrize(
    "initial,requested,reason",
    [
        (["a.py"], [], ""),
        (["a.py"], ["a.py"], ""),
        (["a.py"], ["a.py", "a.py"], ""),
        (["a.py"], ["a.py"], "重复说明不是扩权"),
        (["./"], ["a.py", "new/sub.py"], ""),
        (["src/", "a.py"], ["src/new.py", "src/", "a.py"], ""),
    ],
)
async def test_rework_covered_paths_keep_order_and_refresh_permission(
    tmp_path, initial, requested, reason
):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持接口",
            allowed_paths=initial,
            check_plan_ids=[],
        )
        before = await store.load_record(task.task_id, "order", "1")
        generation = ctx.fusion_state.generation
        result = await service.rework(
            ctx, feedback="修正实现", allowed_paths=requested, reason=reason
        )
        assert result["phase"] == "REVIEWING" and result["round"] == 2
        assert result["revision"] == 1
        assert await store.load_record(task.task_id, "order", "1") == before
        with pytest.raises(ValueError, match="FUSION_EVIDENCE_INCOMPLETE"):
            await store.load_record(task.task_id, "order", "2")
        assert ctx.fusion_state.generation > generation
        assert len(rounds) == 2 and rounds[0][0] == rounds[1][0]
    finally:
        await p.close()


@pytest.mark.parametrize("requested", [["b.py"], ["a.py", "b.py"], ["./"]])
async def test_rework_actual_expansion_requires_reason(tmp_path, requested):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持接口",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        with pytest.raises(ValueError, match="FUSION_PATH_INVALID"):
            await service.rework(
                ctx, feedback="修正实现", allowed_paths=requested, reason=" "
            )
        assert len(rounds) == 1
        result = await service.rework(
            ctx, feedback="补充相关文件", allowed_paths=requested, reason="补充配套实现"
        )
        assert result["revision"] == 2 and result["round"] == 2
    finally:
        await p.close()


async def test_rework_expansion_error_explains_scope_and_reason(tmp_path, monkeypatch):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    ctx.fusion_service = service
    try:
        await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持接口",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        before = await store.get(task.task_id)
        response = await _lead_tool(monkeypatch, ctx, "fusion_rework").ainvoke(
            {"feedback": "补充实现", "allowed_paths": ["b.py"], "reason": ""}
        )
        error = json.loads(response)
        assert error["error"] == "FUSION_PATH_INVALID"
        assert error["field"] == "allowed_paths/reason"
        assert "reason" in error["message"] and "原范围" in error["message"]
        assert await store.get(task.task_id) == before and len(rounds) == 1
    finally:
        await p.close()


@pytest.mark.parametrize(
    "requested", [["../escape.py"], ["/a.py"], [".git/config"], ["link.py"]]
)
async def test_rework_validates_paths_even_when_whole_workspace_allowed(
    tmp_path, requested
):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持接口",
            allowed_paths=["./"],
            check_plan_ids=[],
        )
        (root / "link.py").symlink_to(root / "a.py")
        with pytest.raises(ValueError, match="FUSION_PATH_INVALID"):
            await service.rework(
                ctx, feedback="修正实现", allowed_paths=requested, reason="补充"
            )
        assert len(rounds) == 1
    finally:
        await p.close()


async def test_workspace_busy_waits_with_owner_then_resumes_first_order(tmp_path):
    """正常冲突由 Host 排队，旧任务结束后同一次工具调用自动继续。"""
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    pending = None
    try:
        owner = await store.create(
            thread_id="older",
            profile=task.data["profile"],
            workspace=root,
            source_message="旧任务",
        )
        await store.acquire_lease(owner.task_id, "sidekick", paths=["a.py"])
        owner = await store.update(owner.task_id, owner.version, phase="WORKER_RUNNING")
        pending = asyncio.create_task(
            service.delegate(
                ctx,
                goal="修改",
                brief="保持接口",
                allowed_paths=["a.py"],
                check_plan_ids=[],
            )
        )
        async with asyncio.timeout(2):
            while (await store.get(task.task_id)).phase != "WAITING_RESOURCE":
                await asyncio.sleep(0.01)
        await asyncio.sleep(0.04)
        current = await store.get(task.task_id)
        assert current.data["round"] == current.data["revision"] == 0
        assert current.data["workspace_blocker"]["task_id"] == owner.task_id
        assert not rounds
        with pytest.raises(ValueError, match="FUSION_EVIDENCE_INCOMPLETE"):
            await store.load_record(task.task_id, "order", "1")
        await store.cancel(owner.task_id, owner.version)
        result = await asyncio.wait_for(pending, 3)
        assert result["phase"] == "REVIEWING" and len(rounds) == 1
    finally:
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await p.close()


async def test_rework_before_first_order_explains_delegate(tmp_path):
    from harness_agent.runtime.fusion.store import FusionError

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    ctx.fusion_service = service
    try:
        with pytest.raises(FusionError, match="FUSION_FIRST_ORDER_REQUIRED"):
            await service.rework(ctx, feedback="开始", allowed_paths=[], reason="")
        assert not rounds and (await store.get(task.task_id)).data["round"] == 0
    finally:
        await p.close()


@pytest.mark.parametrize(
    "failure",
    [
        "source",
        "drift",
        "requirements",
        "check_failure",
        "missing_report",
    ],
)
async def test_rejects_invalid_evidence(tmp_path, failure):
    from harness_agent.runtime.fusion.store import FusionError

    p, store, task, ctx, service, rounds, root = await setup(
        tmp_path,
        checks=failure == "check_failure",
        submitted=failure != "missing_report",
    )
    try:
        if failure == "check_failure":

            async def failed(context, plan, lease):
                return {
                    "plan_id": plan.plan_id,
                    "exit_code": 1,
                    "stopped": True,
                    "summary": "failed",
                }

            service.acceptance.prepare_check = prepared_check(failed)
        if failure == "source":
            with pytest.raises(FusionError, match="FUSION_INPUT_INVALID"):
                await service.delegate(
                    ctx,
                    goal=" ",
                    brief="b",
                    allowed_paths=["a.py"],
                    check_plan_ids=[],
                )
            return
        result = await service.delegate(
            ctx,
            goal="g",
            brief="b",
            allowed_paths=["a.py"],
            check_plan_ids=["unit"] if failure == "check_failure" else [],
        )
        if failure == "missing_report":
            assert (
                result["phase"] == "WAITING_USER"
                and result["verification"] == "unverified"
            )
            return
        if failure == "drift":
            (root / "a.py").write_text("external")
        evidence = (
            []
            if failure == "requirements"
            else [{"id": "r1", "satisfied": True, "evidence": ["file:a.py"]}]
        )
        with pytest.raises(FusionError):
            await service.review(
                ctx,
                ticket_id=result["ticket_id"],
                decision="accept",
                requirements=evidence,
                test_review_reason="",
            )
        assert (await store.get(task.task_id)).phase != "COMPLETED"
    finally:
        await p.close()


async def test_unknown_check_does_not_start_next_round(tmp_path):
    from harness_agent.runtime.fusion.store import FusionError

    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    try:

        async def unknown(context, plan, lease):
            return {
                "plan_id": plan.plan_id,
                "exit_code": None,
                "stopped": False,
                "summary": "unknown",
            }

        service.acceptance.prepare_check = prepared_check(unknown)
        result = await service.delegate(
            ctx,
            goal="g",
            brief="b",
            allowed_paths=["a.py"],
            check_plan_ids=["unit"],
        )
        assert result["phase"] == "OUTCOME_UNKNOWN"
        with pytest.raises(FusionError):
            await service.rework(ctx, feedback="again", allowed_paths=[], reason="")
        assert len(rounds) == 1
    finally:
        await p.close()


async def test_role_forgery_and_final_gate(tmp_path):
    from harness_agent.runtime.fusion.store import FusionError
    from harness_agent.runtime.managed_agent_executor import ManagedFinalOutput

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        ctx.fusion_role = "sidekick"
        with pytest.raises(FusionError, match="FUSION_ROLE_DENIED"):
            await service.finish_direct(ctx, summary="done")
        ctx.fusion_role = "lead"
        gate = service.final_gate(ctx)
        output = ManagedFinalOutput("root", None, "r", "premature")
        assert (await gate(output)).action == "continue"
        assert (await gate(output)).action == "allow"
        assert (await store.get(task.task_id)).phase == "WAITING_USER"
    finally:
        await p.close()


@pytest.mark.parametrize("drift", [False, True])
async def test_explicit_continue_restores_review_without_replaying_worker(
    tmp_path, drift
):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    try:
        result = await service.delegate(
            ctx,
            goal="修改",
            brief="保持接口",
            allowed_paths=["a.py"],
            check_plan_ids=["unit"],
        )
        task = await store.pause(task.task_id)
        if drift:
            (root / "a.py").write_text("external")
        task = await service.resume(task.task_id)
        assert len(rounds) == 1
        status = await service.status(ctx)
        assert status["requirements"] == [{"id": "r1", "quote": "保持兼容，修改实现。"}]
        if drift:
            assert task.phase == "WAITING_USER" and task.data["ticket_id"] is None
        else:
            assert (
                task.phase == "REVIEWING"
                and task.data["ticket_id"] == result["ticket_id"]
            )
            accepted = await service.review(
                ctx,
                ticket_id=result["ticket_id"],
                decision="accept",
                requirements=[
                    {"id": "r1", "satisfied": True, "evidence": ["check:unit"]}
                ],
                test_review_reason="",
            )
            assert accepted["verification"] == "verified"
    finally:
        await p.close()


async def test_busy_workspace_does_not_partially_register_order(tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    pending = None
    try:
        other = await store.create(
            thread_id="other",
            profile=task.data["profile"],
            workspace=root,
            source_message="other",
        )
        await store.acquire_lease(other.task_id, "sidekick", paths=["a.py"])
        pending = asyncio.create_task(
            service.delegate(
                ctx,
                goal="修改",
                brief="保持接口",
                allowed_paths=["a.py"],
                check_plan_ids=[],
            )
        )
        async with asyncio.timeout(2):
            while (await store.get(task.task_id)).phase != "WAITING_RESOURCE":
                await asyncio.sleep(0.01)
        assert not rounds
        with pytest.raises(ValueError, match="FUSION_EVIDENCE_INCOMPLETE"):
            await store.load_record(task.task_id, "order", "1")
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        assert (await store.get(task.task_id)).phase == "PAUSED"
        async with store.lock:
            cursor = await store.connection.execute(
                "SELECT COUNT(*) FROM fusion_access WHERE task_id=?", (task.task_id,)
            )
            assert (await cursor.fetchone())[0] == 0
    finally:
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await p.close()


async def test_round_waits_for_ordinary_writer_before_baseline(tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    pending = None
    try:
        async with service.guard.operation("command"):
            pending = asyncio.create_task(
                service.delegate(
                    ctx,
                    goal="修改",
                    brief="保持接口",
                    allowed_paths=["a.py"],
                    check_plan_ids=[],
                )
            )
            await asyncio.sleep(0.1)
            assert not rounds
            (root / "other.py").write_text("existing ordinary writer")
        result = await asyncio.wait_for(pending, 3)
        assert result["phase"] == "REVIEWING" and result["changed_paths"] == ["a.py"]
    finally:
        if pending is not None:
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
        await p.close()


async def seed_prepared_order(store, task, root):
    from harness_agent.runtime.fusion.snapshot import capture_snapshot

    order = {
        "revision": 1,
        "goal": "修改",
        "brief": "保持兼容",
        "source_message": task.data["source_message"],
        "requirements": [{"id": "r1", "quote": "保持兼容，修改实现。"}],
        "allowed_paths": ["a.py"],
        "check_plan_ids": ["unit"],
        "baseline": capture_snapshot(root, ["a.py"]),
    }
    task, lease = await store.start_round(
        task.task_id, task.version, order, "saved-dispatch", "已保存的派单"
    )
    return task, lease


async def test_explicit_continue_dispatches_only_proven_prepared_message(tmp_path):
    """还没有交给 Worker 的消息沿用原操作、轮次及会话身份。"""
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    try:
        task, _ = await seed_prepared_order(store, task, root)
        task = await store.pause(task.task_id)
        await service.continue_pending(ctx)
        current = await store.get(task.task_id)
        assert current.phase == "REVIEWING" and current.data["round"] == 1
        assert current.data["operation_id"] == "saved-dispatch"
        assert rounds == [(task.worker_session_id, "已保存的派单")]
        await service.continue_pending(ctx)
        assert len(rounds) == 1
    finally:
        await p.close()


@pytest.mark.parametrize("drift", [False, True])
async def test_explicit_continue_checks_saved_report_without_worker_replay(
    tmp_path, drift
):
    """报告完成、派发结束且没有开始检查时，只执行冻结的检查。"""
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    try:
        task, lease = await seed_prepared_order(store, task, root)
        ctx.fusion_state.revision = 1
        ctx.fusion_state.generation = lease.generation
        (root / "a.py").write_text("saved output")
        await service.submit_result(
            SimpleNamespace(**{**vars(ctx), "fusion_role": "sidekick"}),
            status="completed",
            summary="已完成",
            unresolved=[],
        )
        await store.mark_delivery("saved-dispatch", "accepted")
        await store.pause(task.task_id)
        check_calls = []
        original = service.acceptance.prepare_check

        async def check(context, plan, lease):
            check_calls.append(plan.plan_id)
            execute = await original(context, plan, lease)
            return await execute()

        service.acceptance.prepare_check = prepared_check(check)
        if drift:
            (root / "a.py").write_text("external edit")
        await service.continue_pending(ctx)
        current = await store.get(task.task_id)
        assert not rounds
        if drift:
            assert current.phase == "WAITING_USER" and not check_calls
            assert current.data["reason"] == "candidate_changed"
        else:
            assert current.phase == "REVIEWING" and check_calls == ["unit"]
            ticket_id = current.data["ticket_id"]
            await service.continue_pending(ctx)
            assert check_calls == ["unit"]
            assert (await store.get(task.task_id)).data["ticket_id"] == ticket_id
    finally:
        await p.close()


async def test_resume_reuses_saved_check_receipt_and_runs_only_remaining_plan(tmp_path):
    """检查回执落库后崩溃，恢复复用第一项、只执行第二项。"""
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    frozen = service.profile_provider(task.task_id)
    frozen = replace(
        frozen,
        check_plans=(
            *frozen.check_plans,
            FrozenFusionCheckPlan("lint", "true", root, 5, "lint-digest"),
        ),
    )
    service.profile_provider = lambda task_id: frozen
    service.acceptance.profile_provider = service.profile_provider
    calls = []
    original_check = service.acceptance.prepare_check
    original_save = store.save_record

    async def check(context, plan, lease):
        calls.append(plan.plan_id)
        execute = await original_check(context, plan, lease)
        return await execute()

    async def crash_after_check(task_id, kind, record_id, data):
        await original_save(task_id, kind, record_id, data)
        if kind == "check":
            raise RuntimeError("模拟回执保存后进程退出")

    service.acceptance.prepare_check = prepared_check(check)
    store.save_record = crash_after_check
    try:
        with pytest.raises(RuntimeError, match="模拟回执保存"):
            await service.delegate(
                ctx,
                goal="修改",
                brief="保持兼容",
                allowed_paths=["a.py"],
                check_plan_ids=["unit", "lint"],
            )
        assert calls == ["unit"]
        await store.pause(task.task_id)
        store.save_record = original_save
        await service.continue_pending(ctx)
        current = await store.get(task.task_id)
        assert (
            current.phase == "REVIEWING" and current.data["verification"] == "verified"
        )
        assert calls == ["unit", "lint"] and len(rounds) == 1
    finally:
        await p.close()


async def test_review_finishes_task_and_releases_writer_in_one_transaction(tmp_path):
    """任务变成完成时必须同时交还工作区，不能留下不可恢复的终态占用。"""
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        result = await service.delegate(
            ctx,
            goal="修改",
            brief="保持兼容",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )

        async def separate_release(*args, **kwargs):
            raise RuntimeError("完成和释放不能分开提交")

        store.release_lease = separate_release
        accepted = await service.review(
            ctx,
            ticket_id=result["ticket_id"],
            decision="accept",
            requirements=[{"id": "r1", "satisfied": True, "evidence": ["file:a.py"]}],
            test_review_reason="",
        )
        assert accepted["phase"] == "COMPLETED"
        other = await store.create(
            thread_id="next",
            profile=task.data["profile"],
            workspace=root,
            source_message="下一个任务",
        )
        assert (
            await store.acquire_lease(other.task_id, "sidekick")
        ).task_id == other.task_id
    finally:
        await p.close()


def _lead_tool(monkeypatch, context, name):
    from harness_agent.runtime.fusion import tools

    monkeypatch.setattr(tools, "get_runtime", lambda: object())
    monkeypatch.setattr(tools, "require_run_context", lambda runtime: context)
    return next(tool for tool in tools.create_fusion_tools("lead") if tool.name == name)


@pytest.mark.parametrize("control", ["fusion_delegate", "fusion_rework"])
async def test_control_explains_relative_path_error_without_starting_worker(
    tmp_path, monkeypatch, control
):
    """参数错误要指出坐标规则，不能误导 Lead 要求用户先创建文件。"""
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    ctx.fusion_service = service
    try:
        arguments = {
            "goal": "修改实现",
            "brief": "保持兼容",
            "allowed_paths": ["/calc.py"],
            "check_plan_ids": [],
        }
        if control == "fusion_rework":
            await service.delegate(ctx, **{**arguments, "allowed_paths": ["a.py"]})
            arguments = {
                "feedback": "新建文件",
                "allowed_paths": ["/calc.py"],
                "reason": "需要新增实现",
            }
        before = await store.get(task.task_id)
        count = len(rounds)
        response = await _lead_tool(monkeypatch, ctx, control).ainvoke(arguments)
        assert response.startswith("{"), response
        error = json.loads(response)
        assert error["error"] == "FUSION_PATH_INVALID"
        assert error["field"] == "allowed_paths"
        assert "相对路径" in error["message"] and "不存在" in error["message"]
        assert (await store.get(task.task_id)).to_record() == before.to_record()
        assert len(rounds) == count and not (root / "calc.py").exists()
    finally:
        await p.close()


@pytest.mark.parametrize("schema_name", ["DelegateInput", "ReworkInput"])
def test_control_path_schema_explains_new_paths(schema_name):
    from harness_agent.runtime.fusion import tools

    description = (
        getattr(tools, schema_name)
        .model_json_schema()["properties"]["allowed_paths"]
        .get("description", "")
    )
    assert "相对路径" in description
    assert "不存在" in description
    assert "calc.py" in description and "tests/" in description


def test_delegation_schema_distinguishes_read_paths_from_delegation_paths():
    from harness_agent.runtime.fusion.tools import PATH_SCOPE_DESCRIPTION

    assert "相对路径" in PATH_SCOPE_DESCRIPTION and "不存在" in PATH_SCOPE_DESCRIPTION
    assert "/calc.py" in PATH_SCOPE_DESCRIPTION and "calc.py" in PATH_SCOPE_DESCRIPTION


async def test_unknown_value_error_is_not_exposed_to_model(monkeypatch):
    async def fail(context, **arguments):
        raise ValueError("private-token-and-internal-path")

    ctx = SimpleNamespace(fusion_service=SimpleNamespace(delegate=fail))
    response = await _lead_tool(monkeypatch, ctx, "fusion_delegate").ainvoke(
        {
            "goal": "修改",
            "brief": "修改",
            "allowed_paths": ["calc.py"],
            "check_plan_ids": [],
        }
    )
    assert json.loads(response)["error"] == "FUSION_INPUT_INVALID"


@pytest.mark.parametrize(
    ("allowed", "created"),
    [
        (["calc.py", "test_calc.py"], ["calc.py", "test_calc.py"]),
        (
            ["new/calc.py", "new/test_calc.py"],
            ["new/calc.py", "new/test_calc.py"],
        ),
        (["new/"], ["new/calc.py", "new/test_calc.py"]),
    ],
)
async def test_new_files_complete_real_guarded_write_and_review(
    tmp_path, allowed, created
):
    """通过真实文件工具创建新文件和父目录，并走完报告与审阅闭环。"""
    from harness_agent.runtime.fusion.guard import FusionWriteGuard
    from harness_agent.threads.snapshots import ThreadSnapshotStore
    from harness_agent.threads.text_backend import LocalTextMutationBackend
    from harness_agent.tools.snapshot_file_contract import (
        create_snapshot_file_tool_contract,
    )

    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:

        async def create_files(context, task, message):
            worker_ctx = SimpleNamespace(
                **{**vars(ctx), "fusion_role": "sidekick", "execution_id": "worker"}
            )
            guard = FusionWriteGuard(
                store.database_path,
                project_fingerprint=store.project,
                workspace=root,
                context_provider=lambda: worker_ctx,
            )
            contract = create_snapshot_file_tool_contract(
                object(),
                snapshot_store=ThreadSnapshotStore(),
                text_backend=LocalTextMutationBackend(root),
                mutation_guard=guard,
            )
            for path in created:
                request = SimpleNamespace(
                    tool_call={
                        "name": "write_file",
                        "id": "write-" + path,
                        "args": {"file_path": "/" + path, "content": "created"},
                    },
                    runtime=SimpleNamespace(context=worker_ctx),
                )
                response = json.loads(contract.dispatch(request).content)
                assert response["ok"] is True, response
            await service.submit_result(
                worker_ctx, status="completed", summary="已创建", unresolved=[]
            )

        service.worker = create_files
        assert all(not (root / path).exists() for path in allowed)
        result = await service.delegate(
            ctx,
            goal="修改实现",
            brief="保持兼容",
            allowed_paths=allowed,
            check_plan_ids=[],
        )
        assert result["phase"] == "REVIEWING"
        assert result["changed_paths"] == sorted(created)
        assert all((root / path).read_text() == "created" for path in created)
        accepted = await service.review(
            ctx,
            ticket_id=result["ticket_id"],
            decision="accept",
            requirements=[
                {"id": "r1", "satisfied": True, "evidence": ["file:" + created[0]]}
            ],
            test_review_reason="已审阅新增测试文件，未删除或跳过原有测试。",
        )
        assert accepted["phase"] == "COMPLETED"
        assert accepted["verification"] == "review_only"
        assert all(
            effect["state"] == "succeeded"
            for effect in await store.effects(task.task_id)
        )
    finally:
        await p.close()


async def test_first_order_tool_gives_actionable_error(monkeypatch, tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    ctx.fusion_service = service
    try:
        response = await _lead_tool(monkeypatch, ctx, "fusion_rework").ainvoke(
            {
                "feedback": "继续",
                "allowed_paths": [],
                "reason": "",
            }
        )
        detail = json.loads(response)
        assert detail["error"] == "FUSION_FIRST_ORDER_REQUIRED"
        assert "fusion_delegate" in detail["message"]
        assert not rounds
    finally:
        await p.close()


async def test_rework_with_order_does_not_require_first_ticket(tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, submitted=False)
    try:
        result = await service.delegate(
            ctx,
            goal="g",
            brief="b",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        assert result["phase"] == "WAITING_USER" and not result["ticket_id"]
        result = await service.rework(
            ctx, feedback="补交报告", allowed_paths=[], reason=""
        )
        assert result["round"] == 2 and len(rounds) == 2
    finally:
        await p.close()


async def test_other_source_change_rechecks_and_issues_new_ticket_without_worker_replay(
    tmp_path,
):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    try:
        result = await service.delegate(
            ctx,
            goal="修改",
            brief="保持兼容",
            allowed_paths=["a.py"],
            check_plan_ids=["unit"],
        )
        old_ticket = result["ticket_id"]
        (root / "other.py").write_text("other task changed")
        kwargs = {
            "decision": "accept",
            "requirements": [
                {"id": "r1", "satisfied": True, "evidence": ["file:a.py", "check:unit"]}
            ],
            "test_review_reason": "",
        }
        rechecked = await service.review(ctx, ticket_id=old_ticket, **kwargs)
        assert (
            rechecked["phase"] == "REVIEWING" and rechecked["ticket_id"] != old_ticket
        )
        assert len(rounds) == 1 and rechecked["round"] == 1
        accepted = await service.review(ctx, ticket_id=rechecked["ticket_id"], **kwargs)
        assert accepted["phase"] == "COMPLETED"
        assert len(await store.list_records(task.task_id, "check")) == 2
    finally:
        await p.close()


async def test_expansion_uses_current_new_files_as_baseline(tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    try:
        (root / "b.py").write_text("preexisting unrelated file")
        await service.delegate(
            ctx,
            goal="修改",
            brief="保持兼容",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
        result = await service.rework(
            ctx,
            feedback="需要读取 b 并继续修正 a",
            allowed_paths=["b.py"],
            reason="扩展文件范围",
        )
        assert result["changed_paths"] == ["a.py"]
    finally:
        await p.close()


async def test_approval_preparation_does_not_hold_directory_permission(tmp_path):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path, checks=True)
    started = asyncio.Event()
    approved = asyncio.Event()
    prepare = service.acceptance.prepare_check

    async def approval(context, plan, lease):
        started.set()
        await approved.wait()
        return await prepare(context, plan, lease)

    service.acceptance.prepare_check = approval
    pending = asyncio.create_task(
        service.delegate(
            ctx,
            goal="修改",
            brief="保持兼容",
            allowed_paths=["a.py"],
            check_plan_ids=["unit"],
        )
    )
    try:
        await asyncio.wait_for(started.wait(), 2)
        async with asyncio.timeout(2):
            async with service.guard.operation("file", paths=["b.py"]):
                (root / "b.py").write_text("other task")
        approved.set()
        assert (await asyncio.wait_for(pending, 3))["verification"] == "verified"
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await p.close()


async def test_cancel_before_worker_execution_keeps_prepared_order_without_unknown_outcome(
    tmp_path,
):
    p, store, task, ctx, service, rounds, root = await setup(tmp_path)
    entered = asyncio.Event()

    async def not_started(context, current, message):
        entered.set()
        await asyncio.Event().wait()

    service.worker = not_started
    pending = asyncio.create_task(
        service.delegate(
            ctx,
            goal="修改",
            brief="保持接口",
            allowed_paths=["a.py"],
            check_plan_ids=[],
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 2)
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        current = await store.get(task.task_id)
        assert current.phase == "PAUSED"
        assert current.data["reason"] == "resource_wait_paused"
        assert not await store.effects(task.task_id)
        assert (await store.load_delivery(task.task_id, current.data["operation_id"]))[
            "state"
        ] == "prepared"
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await p.close()
