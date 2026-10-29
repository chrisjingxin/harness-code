"""Fusion 的独立检查与逐项审阅，不负责发起模型任务。

候选快照 → 可信命令和停止回执 → 审阅票据 → Lead 逐项证据 → 完成。
由 FusionService 持有控制锁后调用，写权限和实际操作仍受 Guard 约束。
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from harness_agent.runtime.fusion.guard import FusionWriteGuard
from harness_agent.runtime.fusion.profile import (
    FrozenFusionProfile,
)
from harness_agent.runtime.fusion.snapshot import (
    capture_snapshot,
    changed_paths,
    normalize_paths,
    path_allowed,
)
from harness_agent.runtime.fusion.store import (
    FusionError,
    FusionStateStore,
    FusionTask,
    new_id,
)
from harness_agent.runtime.run_context import (
    RunContext,
)


class FusionAcceptance:
    """集中维护快照、检查回执和逐项证据；控制服务持有任务锁后调用。"""

    def __init__(
        self,
        *,
        store: FusionStateStore,
        workspace: Path,
        profile_provider: Callable[[str], FrozenFusionProfile],
        guard: FusionWriteGuard,
        prepare_check: Callable,
        begin_phase: Callable,
        emit: Callable,
    ) -> None:
        """模型和用户决策留在服务层，检查阶段依次核对候选、命令与票据。"""
        self.store, self.workspace, self.profile_provider = (
            store,
            workspace,
            profile_provider,
        )
        self.guard, self.prepare_check = guard, prepare_check
        self._begin_phase, self._emit = begin_phase, emit
        self.resources = guard.resources

    async def verify(
        self,
        context: RunContext,
        task: FusionTask,
        order: Mapping[str, Any],
    ) -> dict[str, object]:
        """核对当前候选，复用已保存的检查记录后运行剩余计划。"""
        report_id = task.data["report_id"]
        report = await self.store.load_record(task.task_id, "report", report_id)
        task, lease = await self._begin_phase(context, task, "CHECKING")
        context.fusion_state.generation = lease.generation
        candidate = await asyncio.to_thread(
            capture_snapshot, self.workspace, order["allowed_paths"]
        )
        if report["snapshot_digest"] != candidate["digest"] or (
            task.data.get("candidate_digest")
            and task.data["candidate_digest"] != candidate["digest"]
        ):
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={
                    "reason": "candidate_changed",
                    "ticket_id": None,
                    "verification": "unverified",
                },
            )
            self._emit(context, task)
            return task.to_record()
        changes = changed_paths(order["baseline"], candidate)
        outside = [
            name for name in changes if not path_allowed(name, order["allowed_paths"])
        ]
        if outside:
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={"reason": "out_of_scope", "changed_paths": list(changes)},
            )
            self._emit(context, task)
            return {
                **task.to_record(),
                "changed_paths": list(changes),
                "outside_paths": outside,
            }
        task = await self.store.update(
            task.task_id,
            task.version,
            phase="CHECKING",
            data={"candidate_digest": candidate["digest"]},
        )
        self._emit(context, task)
        cycle = task.data.get("verification_cycle")
        saved_checks = {
            item["plan_id"]: item
            for item in await self.store.list_records(task.task_id, "check")
            if item["operation_id"] == task.data["operation_id"]
            and item.get("verification_cycle") == cycle
        }
        started_plans = list(task.data.get("check_started_plan_ids", []))
        if any(name not in saved_checks for name in started_plans):
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={"reason": "check_receipt_missing"},
            )
            self._emit(context, task)
            return task.to_record()
        plans = [
            plan
            for plan in self.profile_provider(task.task_id).check_plans
            if plan.plan_id in order["check_plan_ids"]
        ]
        # 审批在任何目录许可之外完成；消费准备结果前仍会重查策略和候选文件。
        executors = {
            plan.plan_id: await self.prepare_check(context, plan, lease)
            for plan in plans
        }
        task = await self.store.get(task.task_id)
        checks = []
        workspace_digest = None
        async with self.guard.operation(
            "command" if plans else "snapshot", context=context, host=True
        ) as permit:
            source_paths = [
                "./",
                *await self.store.claimed_paths(task.workspace_key),
                *order["allowed_paths"],
            ]
            source = await asyncio.to_thread(
                capture_snapshot, self.workspace, source_paths
            )
            workspace_digest = source["digest"]
            current = await asyncio.to_thread(
                capture_snapshot, self.workspace, order["allowed_paths"]
            )
            if current["digest"] != candidate["digest"]:
                task = await self.store.get(task.task_id)
                task = await self.store.update(
                    task.task_id,
                    task.version,
                    phase="WAITING_USER",
                    data={
                        "reason": "candidate_changed",
                        "ticket_id": None,
                        "verification": "unverified",
                    },
                )
                self._emit(context, task)
                return task.to_record()
            if saved_checks and any(
                check.get("workspace_digest") != workspace_digest
                for check in saved_checks.values()
            ):
                # 旧检查有完整停止回执，但其他源码更新过，整组重新检查，不拼接过期证据。
                saved_checks = {}
                started_plans = []
                cycle = new_id("verification")
                task = await self.store.get(task.task_id)
                task = await self.store.update(
                    task.task_id,
                    task.version,
                    data={"verification_cycle": cycle, "check_started_plan_ids": []},
                )
            for plan in plans:
                if plan.plan_id in saved_checks:
                    saved = saved_checks[plan.plan_id]
                    if (
                        saved["revision"] != order["revision"]
                        or saved["command_digest"] != plan.command_digest
                    ):
                        raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
                    checks.append(saved)
                    continue
                task = await self.store.get(task.task_id)
                started_plans.append(plan.plan_id)
                task = await self.store.update(
                    task.task_id,
                    task.version,
                    data={"check_started_plan_ids": started_plans},
                )
                effect_id = await self.store.begin_effect(
                    task.task_id,
                    lease.generation,
                    context.execution_id,
                    "check",
                    plan.command_digest,
                )
                context.fusion_state.check_effect_id = effect_id
                await asyncio.to_thread(self.resources.bind_effect, permit, effect_id)
                before = await asyncio.to_thread(
                    capture_snapshot, self.workspace, source_paths
                )
                permit.stopped = False
                try:
                    check = dict(await executors[plan.plan_id]())
                    permit.stopped = check.get("stopped") is True
                except BaseException:
                    await asyncio.shield(
                        self.store.finish_effect(
                            effect_id, succeeded=False, stopped=permit.stopped
                        )
                    )
                    await asyncio.shield(self.store.pause(task.task_id))
                    raise
                await self.store.finish_effect(
                    effect_id,
                    succeeded=check.get("exit_code") == 0,
                    stopped=permit.stopped,
                )
                if not permit.stopped:
                    task = await self.store.pause(task.task_id)
                    self._emit(context, task)
                    return task.to_record()
                after = await asyncio.to_thread(
                    capture_snapshot, self.workspace, source_paths
                )
                check = {
                    **check,
                    "revision": order["revision"],
                    "operation_id": task.data["operation_id"],
                    "verification_cycle": cycle,
                    "command_digest": plan.command_digest,
                    "before_digest": before["digest"],
                    "after_digest": after["digest"],
                    "workspace_digest": workspace_digest,
                    "source_changed": before["digest"] != after["digest"],
                }
                checks.append(check)
                await self.store.save_record(
                    task.task_id, "check", new_id("check"), check
                )
                if check["source_changed"]:
                    break
        ticket_id = new_id("ticket")
        success = all(
            check.get("exit_code") == 0 and not check.get("source_changed")
            for check in checks
        ) and len(checks) == len(order["check_plan_ids"])
        verification = (
            "verified"
            if checks and success
            else "review_only"
            if not order["check_plan_ids"]
            else "unverified"
        )
        await self.store.save_record(
            task.task_id,
            "ticket",
            ticket_id,
            {
                "ticket_id": ticket_id,
                "revision": order["revision"],
                "report_id": report_id,
                "candidate": candidate,
                "changed_paths": list(changes),
                "checks": checks,
                "verification": verification,
                "success": success,
                "workspace_digest": workspace_digest,
                "source_paths": source_paths,
            },
        )
        task = await self.store.get(task.task_id)
        task = await self.store.update(
            task.task_id,
            task.version,
            phase="REVIEWING",
            data={"ticket_id": ticket_id, "verification": verification},
        )
        from harness_agent.runtime.fusion.guidance import record_round_outcome

        task = await record_round_outcome(self.store, task, report, checks)
        self._emit(context, task)
        return {
            **task.to_record(),
            "changed_paths": list(changes),
            "checks": checks,
            "requirements": order["requirements"],
        }

    async def review(
        self,
        context: RunContext,
        task: FusionTask,
        *,
        ticket_id: str,
        decision: str,
        requirements: Sequence[Mapping[str, Any]],
        test_review_reason: str,
    ) -> dict[str, object]:
        """核对票据、候选快照、检查和逐项证据，再接受任务。"""
        if task.phase != "REVIEWING" or task.data.get("ticket_id") != ticket_id:
            raise FusionError("FUSION_REPORT_STALE")
        if decision == "reject":
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={"reason": "review_rejected"},
            )
            self._emit(context, task)
            return task.to_record()
        if decision != "accept":
            raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
        task, lease = await self._begin_phase(context, task, "REVIEWING")
        context.fusion_state.generation = lease.generation
        ticket = await self.store.load_record(task.task_id, "ticket", ticket_id)
        order = await self.store.load_record(
            task.task_id, "order", str(task.data["revision"])
        )
        if ticket["revision"] != order["revision"] or ticket[
            "report_id"
        ] != task.data.get("report_id"):
            raise FusionError("FUSION_REPORT_STALE")
        current = await asyncio.to_thread(
            capture_snapshot, self.workspace, order["allowed_paths"]
        )
        if current["digest"] != ticket["candidate"]["digest"]:
            raise FusionError("FUSION_REPORT_STALE")
        if order["check_plan_ids"]:
            async with self.guard.operation("snapshot", context=context, host=True):
                source = await asyncio.to_thread(
                    capture_snapshot, self.workspace, ticket["source_paths"]
                )
            if source["digest"] != ticket["workspace_digest"]:
                task = await self.store.get(task.task_id)
                task = await self.store.update(
                    task.task_id,
                    task.version,
                    data={
                        "verification_cycle": new_id("verification"),
                        "check_started_plan_ids": [],
                        "ticket_id": None,
                        "verification": "unverified",
                        "reason": "workspace_changed",
                    },
                )
                return await self.verify(context, task, order)
        if not ticket["success"] or ticket["verification"] == "unverified":
            raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
        expected = {requirement["id"] for requirement in order["requirements"]}
        if (
            len(requirements) != len(expected)
            or {item.get("id") for item in requirements} != expected
        ):
            raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
        for item in requirements:
            if item.get("satisfied") is not True or not item.get("evidence"):
                raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
            for evidence in item["evidence"]:
                if evidence.startswith("file:"):
                    path = evidence[5:]
                    normalize_paths(self.workspace, [path])
                    if path not in current["entries"]:
                        raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
                elif evidence.startswith("check:"):
                    if not any(
                        check["plan_id"] == evidence[6:] and check.get("exit_code") == 0
                        for check in ticket["checks"]
                    ):
                        raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
                else:
                    raise FusionError("FUSION_EVIDENCE_INCOMPLETE")
        if (
            any(
                "tests" in Path(path).parts
                or Path(path).name.startswith("test_")
                or ".test." in path
                for path in ticket["changed_paths"]
            )
            and not test_review_reason.strip()
        ):
            raise FusionError("FUSION_TEST_REVIEW_REQUIRED")
        if any(
            not effect["stopped"] for effect in await self.store.effects(task.task_id)
        ):
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        async with self.guard.operation("snapshot", context=context, host=True):
            final = await asyncio.to_thread(
                capture_snapshot, self.workspace, order["allowed_paths"]
            )
            if final["digest"] != ticket["candidate"]["digest"]:
                raise FusionError("FUSION_REPORT_STALE")
            if (
                order["check_plan_ids"]
                and (
                    await asyncio.to_thread(
                        capture_snapshot, self.workspace, ticket["source_paths"]
                    )
                )["digest"]
                != ticket["workspace_digest"]
            ):
                raise FusionError("FUSION_REPORT_STALE")
            task = await self.store.get(task.task_id)
            await self.store.save_record(
                task.task_id,
                "review",
                new_id("review"),
                {
                    "ticket_id": ticket_id,
                    "requirements": list(requirements),
                    "test_review_digest": hashlib.sha256(
                        test_review_reason.encode()
                    ).hexdigest(),
                },
            )
            task = await self.store.complete_task(task.task_id, task.version)
        self._emit(context, task)
        return task.to_record()
