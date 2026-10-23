"""Fusion 派单、持续会话、独立检查与逐项审阅的控制服务。

Lead 派单 → 原子登记任务/写者 → Sidekick 执行 → Host 快照/检查 →
Lead 逐项审阅 → 完成。未知副作用保留写者，等待人工核查；状态由 Store 保存。
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from harness_agent.runtime.fusion.guard import FusionWriteGuard
from harness_agent.runtime.fusion.profile import (
    FrozenFusionCheckPlan,
    FrozenFusionProfile,
)
from harness_agent.runtime.fusion.snapshot import (
    capture_snapshot,
    changed_paths,
    normalize_paths,
    path_allowed,
    snapshot_from_entries,
)
from harness_agent.runtime.fusion.store import (
    FusionError,
    FusionLease,
    FusionStateStore,
    FusionTask,
    FusionWorkspaceBusy,
    encode,
    new_id,
)
from harness_agent.runtime.managed_agent_executor import (
    FinalOutputGate,
    FinalOutputGateDecision,
    ManagedFinalOutput,
)
from harness_agent.runtime.run_context import (
    RunContext,
    current_approval_mode,
    plan_constraint_active,
)


class FusionService:
    """共享图捕获稳定服务；调用时再通过 RunContext 查任务。"""

    def __init__(
        self,
        *,
        store: FusionStateStore,
        workspace: Path,
        profile_provider: Callable[[str], FrozenFusionProfile],
        worker: Callable[[RunContext, FusionTask, str], Awaitable[None]],
        guard: FusionWriteGuard,
        prepare_check: Callable[
            [RunContext, FrozenFusionCheckPlan, FusionLease],
            Awaitable[Callable[[], Awaitable[Mapping[str, object]]]],
        ],
    ) -> None:
        """注入状态、冻结配置和 Host 执行端口，每个任务内串行控制操作。"""
        self.store = store
        self.workspace = workspace
        self.profile_provider = profile_provider
        self.worker = worker
        self.guard = guard
        self.prepare_check = prepare_check
        self._locks: dict[str, asyncio.Lock] = {}
        self.resources = guard.resources

    async def _task(self, context: RunContext, role: str | None = None) -> FusionTask:
        task_id = getattr(context, "fusion_task_id", None)
        if not task_id or (role and getattr(context, "fusion_role", None) != role):
            raise FusionError("FUSION_ROLE_DENIED")
        task = await self.store.get(task_id)
        if task.thread_id != context.thread_id:
            raise FusionError("FUSION_ROLE_DENIED")
        inspection = (
            context.fusion_role == "lead" and context.fusion_state.inspection_only
        )
        if inspection and role:
            raise FusionError("FUSION_ROLE_DENIED")
        if role and not task.active:
            raise FusionError("FUSION_TASK_CONFLICT")
        scope = task.data.get("active_run")
        if not inspection and scope is not None and scope["run_id"] != context.run_id:
            raise FusionError("FUSION_TASK_CONFLICT")
        if role and (
            current_approval_mode(context, fallback=context.approval_mode) == "plan"
            or plan_constraint_active(context)
        ):
            raise FusionError("FUSION_ROLE_DENIED")
        return task

    def _emit(self, context: RunContext, task: FusionTask) -> None:
        port = getattr(context, "event_port", None)
        if port:
            port(
                "fusion.progress",
                task.to_record(),
                getattr(context, "execution_id", None),
                getattr(context, "parent_execution_id", None),
                getattr(context, "agent_id", None),
            )

    async def status(self, context: RunContext) -> dict[str, object]:
        """压缩后可读取安全状态和票据身份。"""
        task = await self._task(context)
        result = task.to_record()
        if task.data.get("revision"):
            order = await self.store.load_record(
                task.task_id, "order", str(task.data["revision"])
            )
            result["requirements"] = order["requirements"]
            result["allowed_paths"] = order["allowed_paths"]
        if task.data.get("ticket_id"):
            ticket = await self.store.load_record(
                task.task_id, "ticket", task.data["ticket_id"]
            )
            result["checks"] = ticket["checks"]
            result["changed_paths"] = ticket["changed_paths"]
        result["pending_effects"] = [
            effect
            for effect in await self.store.effects(task.task_id)
            if not effect["stopped"]
        ]
        result["workspace_blocker"] = await self.store.workspace_blocker(task.task_id)
        result["diagnostics"] = {
            "inspection_only": context.fusion_state.inspection_only,
            "command_cwd": str(self.workspace),
            "operation_owner": {"task_id": task.task_id, "thread_id": task.thread_id},
            "process_status": "unconfirmed"
            if result["pending_effects"]
            else "no_pending_effects",
            "explanation": (
                "文件权限冲突由程序自动等待，可用后继续；暂停后发送“继续等待”恢复。"
                if task.phase == "WAITING_RESOURCE"
                or task.data.get("reason") == "resource_wait_paused"
                else "停止凭据缺失表示结果尚未确认，不等于已经检测到进程占用；Host PID 不能证明子命令停止。"
                if task.phase == "OUTCOME_UNKNOWN"
                else "状态查询不会启动模型或命令；实际写入由文件范围和操作队列协调。"
            ),
        }
        return result

    async def resume(self, task_id: str) -> FusionTask:
        """用户新消息到达时恢复可审阅票据；不重放 Worker 或检查命令。"""
        task = await self.store.reconcile(task_id)
        if task.phase == "OUTCOME_UNKNOWN":
            raise FusionError("FUSION_OUTCOME_UNKNOWN")
        if task.data.get("reason") == "workspace_busy":
            return task
        if task.phase not in {"PAUSED", "WAITING_USER"}:
            return task
        ticket_id = task.data.get("ticket_id")
        if not ticket_id:
            if not task.data.get("revision"):
                return await self.store.update(
                    task.task_id,
                    task.version,
                    phase="READY",
                    data={"reason": None, "workspace_blocker": None},
                )
            return task
        ticket = await self.store.load_record(task.task_id, "ticket", ticket_id)
        order = await self.store.load_record(
            task.task_id, "order", str(task.data["revision"])
        )
        current = await asyncio.to_thread(
            capture_snapshot, self.workspace, order["allowed_paths"]
        )
        fresh = (
            ticket["revision"] == order["revision"]
            and ticket["report_id"] == task.data.get("report_id")
            and ticket["candidate"]["digest"] == current["digest"]
        )
        return await self.store.update(
            task.task_id,
            task.version,
            phase="REVIEWING" if fresh else "WAITING_USER",
            data={
                "reason": None if fresh else "candidate_changed",
                "ticket_id": ticket_id if fresh else None,
                "verification": task.data.get("verification")
                if fresh
                else "unverified",
            },
        )

    async def continue_pending(self, context: RunContext) -> None:
        """新 Run 明确继续时补完已知安全的派发/检查；状态查询不会触发执行。"""
        task = await self._task(context, "lead")
        context.fusion_state.revision = task.data.get("revision", 0)
        async with self._locks.setdefault(task.task_id, asyncio.Lock()):
            task = await self._task(context, "lead")
            pending = task.data.get("pending_round")
            if pending and task.phase in {
                "PAUSED",
                "WAITING_USER",
                "WAITING_RESOURCE",
                "READY",
            }:
                await self._round(context, task, pending["order"], pending["message"])
                return
            if (
                task.phase not in {"PAUSED", "WAITING_USER"}
                or not task.data.get("operation_id")
                or task.data.get("ticket_id")
            ):
                return
            if any(
                not effect["stopped"]
                for effect in await self.store.effects(task.task_id)
            ):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            delivery = await self.store.load_delivery(
                task.task_id, task.data["operation_id"]
            )
            order = await self.store.load_record(
                task.task_id, "order", str(task.data["revision"])
            )
            context.fusion_state.revision = order["revision"]
            if delivery["state"] == "prepared" and not task.data.get(
                "worker_execution_id"
            ):
                task, lease = await self._begin_phase(context, task, "WORKER_RUNNING")
                context.fusion_state.generation = lease.generation
                await self._dispatch(context, task, order, delivery["message"])
            elif delivery["state"] in {
                "accepted",
                "result_recorded",
                "stopped",
                "inspected",
            } and task.data.get("report_id"):
                report = await self.store.load_record(
                    task.task_id, "report", task.data["report_id"]
                )
                if report["status"] == "completed" and not report["unresolved"]:
                    await self.store.mark_delivery(
                        task.data["operation_id"], "result_recorded"
                    )
                    await self._verify(context, task, order)

    async def finish_direct(
        self, context: RunContext, *, summary: str
    ) -> dict[str, object]:
        """未派单的问答直接完成，仍标为 unverified。"""
        task = await self._task(context, "lead")
        if task.phase != "READY" or task.data.get("revision") or not summary.strip():
            raise FusionError("FUSION_TASK_CONFLICT")
        task = await self.store.complete_task(
            task.task_id, task.version, reason="direct_answer"
        )
        self._emit(context, task)
        return task.to_record()

    async def delegate(
        self,
        context: RunContext,
        *,
        goal: str,
        brief: str,
        allowed_paths: Sequence[str],
        check_plan_ids: Sequence[str],
    ) -> dict[str, object]:
        """从原始用户消息生成要求，核对路径后执行首轮。"""
        task = await self._task(context, "lead")
        async with self._locks.setdefault(task.task_id, asyncio.Lock()):
            task = await self._task(context, "lead")
            if task.phase != "READY":
                raise FusionError("FUSION_TASK_CONFLICT")
            if not goal.strip() or not brief.strip():
                raise FusionError("FUSION_INPUT_INVALID")
            source = task.data["source_message"]
            # 引用由可信输入生成，模型只负责实施方案；尾段合并，不能丢要求。
            boundaries = [0] + [
                m.start()
                for m in re.finditer(
                    r"(?m)^[ \t]*(?:[-*•][ \t]+|\d+[.)、][ \t]*)", source
                )
                if m.start() > 0
            ]
            boundaries = boundaries[:32] + [len(source)]
            quotes = [
                source[a:b].strip()
                for a, b in zip(boundaries, boundaries[1:])
                if source[a:b].strip()
            ]
            allowed = normalize_paths(self.workspace, allowed_paths)
            configured = [
                plan.plan_id for plan in self.profile_provider(task.task_id).check_plans
            ]
            selected = list(check_plan_ids) or configured
            if len(set(selected)) != len(selected) or any(
                name not in configured for name in selected
            ):
                raise FusionError("FUSION_CHECK_INVALID")
            order = {
                "revision": 1,
                "goal": goal,
                "brief": brief,
                "source_message": task.data["source_message"],
                "requirements": [
                    {"id": f"r{i + 1}", "quote": quote}
                    for i, quote in enumerate(quotes)
                ],
                "allowed_paths": list(allowed),
                "check_plan_ids": selected,
            }
            return await self._round(
                context,
                task,
                order,
                "首次任务：\n"
                + encode({k: v for k, v in order.items() if k != "baseline"}),
            )

    async def rework(
        self,
        context: RunContext,
        *,
        feedback: str,
        allowed_paths: Sequence[str],
        reason: str,
    ) -> dict[str, object]:
        """原会话追加返工；范围扩展必须附带原因。"""
        task = await self._task(context, "lead")
        async with self._locks.setdefault(task.task_id, asyncio.Lock()):
            task = await self._task(context, "lead")
            if task.data.get("reason") == "workspace_busy":
                return task.to_record()
            if not task.data.get("revision"):
                raise FusionError("FUSION_FIRST_ORDER_REQUIRED")
            if (
                task.phase not in {"REVIEWING", "WAITING_USER", "PAUSED"}
                or not feedback.strip()
            ):
                raise FusionError("FUSION_TASK_CONFLICT")
            if (
                task.data.get("round", 0)
                > self.profile_provider(task.task_id).max_rework_rounds
            ):
                task = await self.store.update(
                    task.task_id,
                    task.version,
                    phase="WAITING_USER",
                    data={"reason": "rework_limit"},
                )
                self._emit(context, task)
                return task.to_record()
            if any(
                not effect["stopped"]
                for effect in await self.store.effects(task.task_id)
            ):
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
            order = await self.store.load_record(
                task.task_id, "order", str(task.data["revision"])
            )
            if allowed_paths:
                if not reason.strip():
                    raise FusionError("FUSION_PATH_INVALID")
                order = {
                    **order,
                    "revision": order["revision"] + 1,
                    "allowed_paths": list(
                        normalize_paths(
                            self.workspace, [*order["allowed_paths"], *allowed_paths]
                        )
                    ),
                    "expansion_reason_digest": hashlib.sha256(
                        reason.encode()
                    ).hexdigest(),
                }
            return await self._round(
                context,
                task,
                order,
                "返工反馈：\n"
                + feedback
                + "\n当前任务单：\n"
                + encode({k: v for k, v in order.items() if k != "baseline"}),
            )

    async def resource_wait(
        self, context: RunContext, request_id: str, blocker: Mapping[str, Any] | None
    ) -> None:
        """向角色执行区域展示真实等待原因；不会让模型重新派单。"""
        task_id = getattr(context, "fusion_task_id", None)
        if not task_id:
            return
        task = await self.store.get(task_id)
        if not task.active:
            return
        waits = dict(task.data.get("resource_waits", {}))
        before = dict(waits)
        if blocker is None:
            waits.pop(request_id, None)
        else:
            waits[request_id] = dict(blocker)
        if waits != before:
            task = await self.store.update(
                task_id, task.version, data={"resource_waits": waits}
            )
            self._emit(context, task)

    async def _round(
        self,
        context: RunContext,
        task: FusionTask,
        order: Mapping[str, Any],
        message: str,
    ) -> dict[str, object]:
        """完整范围排队后只派发一次；等待期间不占 Host 工具写锁。"""
        normalized = list(normalize_paths(self.workspace, order["allowed_paths"]))
        if normalized != list(order["allowed_paths"]):
            order = {
                **order,
                "allowed_paths": normalized,
                "revision": max(order["revision"], task.data.get("revision", 0) + 1),
            }
        task = await self.store.update(
            task.task_id,
            task.version,
            data={"pending_round": {"order": dict(order), "message": message}},
        )
        last_version = 0

        async def waiting(current: FusionTask) -> None:
            nonlocal last_version
            if current.version != last_version:
                self._emit(context, current)
                last_version = current.version

        try:
            await self.store.wait_for_lease(
                task.task_id, "sidekick", paths=order["allowed_paths"], on_wait=waiting
            )
            task = await self.store.get(task.task_id)
            # 原范围基线保留；新申请的文件以取得许可后的真实内容为基线。
            if not task.data.get("round") or order["revision"] != task.data.get(
                "revision"
            ):
                async with self.guard.operation("snapshot", context=context, host=True):
                    current = await asyncio.to_thread(
                        capture_snapshot, self.workspace, order["allowed_paths"]
                    )
                    if task.data.get("round"):
                        previous = await self.store.load_record(
                            task.task_id, "order", str(task.data["revision"])
                        )
                        entries = {
                            name: value
                            for name, value in current["entries"].items()
                            if not path_allowed(name, previous["allowed_paths"])
                        }
                        entries.update(
                            {
                                name: value
                                for name, value in previous["baseline"][
                                    "entries"
                                ].items()
                                if path_allowed(name, previous["allowed_paths"])
                            }
                        )
                        current = snapshot_from_entries(entries)
                    order = {**order, "baseline": current}
            task = await self.store.get(task.task_id)
            task, lease = await self.store.start_round(
                task.task_id, task.version, order, new_id("dispatch"), message
            )
        except BaseException:
            await asyncio.shield(
                self.store.pause_dispatch(
                    task.task_id, task.data.get("operation_id"), context.run_id
                )
            )
            raise
        context.fusion_state.revision = order["revision"]
        context.fusion_state.generation = lease.generation
        self._emit(context, task)
        return await self._dispatch(context, task, order, message)

    async def _begin_phase(
        self, context: RunContext, task: FusionTask, phase: str
    ) -> tuple[FusionTask, FusionLease]:
        """正常交接直接完成；暂停后的范围冲突也在 Host 内自动等待。"""
        try:
            return await self.store.begin_workspace_phase(
                task.task_id, task.version, phase
            )
        except FusionWorkspaceBusy:
            order = await self.store.load_record(
                task.task_id, "order", str(task.data["revision"])
            )

            async def waiting(current: FusionTask) -> None:
                self._emit(context, current)

            await self.store.wait_for_lease(
                task.task_id,
                "host" if phase != "WORKER_RUNNING" else "sidekick",
                paths=order["allowed_paths"],
                on_wait=waiting,
                preserve_ticket=True,
            )
            current = await self.store.get(task.task_id)
            return await self.store.begin_workspace_phase(
                current.task_id, current.version, phase
            )

    async def _dispatch(
        self,
        context: RunContext,
        task: FusionTask,
        order: Mapping[str, Any],
        message: str,
    ) -> dict[str, object]:
        """派发已保存的操作；首轮和恢复共用同一条执行链。"""
        operation_id = task.data["operation_id"]
        try:
            await self.store.mark_delivery(operation_id, "dispatched")
            await self.worker(context, task, message)
            task = await self.store.get(task.task_id)
            if not task.active:
                self._emit(context, task)
                return task.to_record()
            await self.store.mark_delivery(operation_id, "accepted")
        except BaseException as exc:
            if (
                isinstance(exc, FusionError)
                and exc.code == "FUSION_WORKER_CHECKPOINT_INVALID"
            ):
                # Host 在接收子执行前验证历史。此错误明确表示没有启动本轮工具。
                await self.store.mark_delivery(operation_id, "not_started")
                current = await self.store.get(task.task_id)
                task = await self.store.update(
                    task.task_id,
                    current.version,
                    phase="WAITING_USER",
                    data={"reason": "worker_checkpoint_invalid"},
                )
                self._emit(context, task)
                return task.to_record()
            await asyncio.shield(
                self.store.pause_dispatch(task.task_id, operation_id, context.run_id)
            )
            raise
        task = await self.store.get(task.task_id)
        if task.phase == "OUTCOME_UNKNOWN":
            return task.to_record()
        if any(
            not effect["stopped"] for effect in await self.store.effects(task.task_id)
        ):
            task = await self.store.pause(task.task_id)
            self._emit(context, task)
            return task.to_record()
        report_id = task.data.get("report_id")
        if not report_id:
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={"reason": task.data.get("reason") or "worker_report_missing"},
            )
            self._emit(context, task)
            return task.to_record()
        report = await self.store.load_record(task.task_id, "report", report_id)
        await self.store.mark_delivery(operation_id, "result_recorded")
        if report["status"] != "completed" or report["unresolved"]:
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={"reason": "worker_blocked"},
            )
            self._emit(context, task)
            return task.to_record()
        return await self._verify(context, task, order)

    async def _verify(
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
        self._emit(context, task)
        return {
            **task.to_record(),
            "changed_paths": list(changes),
            "checks": checks,
            "requirements": order["requirements"],
        }

    async def submit_result(
        self,
        context: RunContext,
        *,
        status: str,
        summary: str,
        unresolved: Sequence[str],
    ) -> dict[str, object]:
        """报告只记录本轮说明，不代替 Host 验收。"""
        task = await self._task(context, "sidekick")
        if (
            task.phase != "WORKER_RUNNING"
            or task.data.get("report_id")
            or status not in {"completed", "blocked", "incomplete"}
            or not summary.strip()
        ):
            raise FusionError("FUSION_TASK_CONFLICT")
        from harness_agent.runtime.verification import redact_verification_text

        order = await self.store.load_record(
            task.task_id, "order", str(task.data["revision"])
        )
        snapshot = await asyncio.to_thread(
            capture_snapshot, self.workspace, order["allowed_paths"]
        )
        report_id = new_id("report")
        await self.store.save_record(
            task.task_id,
            "report",
            report_id,
            {
                "status": status,
                "snapshot_digest": snapshot["digest"],
                "summary": redact_verification_text(summary[:8000]),
                "unresolved": [
                    redact_verification_text(x[:2000]) for x in unresolved[:32]
                ],
            },
        )
        task = await self.store.update(
            task.task_id, task.version, data={"report_id": report_id}
        )
        self._emit(context, task)
        return {"report_id": report_id, "status": status}

    async def review(
        self,
        context: RunContext,
        *,
        ticket_id: str,
        decision: str,
        requirements: Sequence[Mapping[str, Any]],
        test_review_reason: str,
    ) -> dict[str, object]:
        """核对票据、候选快照、检查和逐项证据，再接受任务。"""
        task = await self._task(context, "lead")
        async with self._locks.setdefault(task.task_id, asyncio.Lock()):
            task = await self._task(context, "lead")
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
                    return await self._verify(context, task, order)
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
                            check["plan_id"] == evidence[6:]
                            and check.get("exit_code") == 0
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
                not effect["stopped"]
                for effect in await self.store.effects(task.task_id)
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

    def final_gate(self, context: RunContext) -> FinalOutputGate:
        """自然结束不等于任务完成，只给同一执行一次收敛机会。"""
        prompted = False

        async def gate(output: ManagedFinalOutput) -> FinalOutputGateDecision:
            nonlocal prompted
            if context.fusion_role == "lead" and context.fusion_state.inspection_only:
                return FinalOutputGateDecision("allow")
            task = await self._task(context)
            worker = getattr(context, "fusion_role", None) == "sidekick"
            allowed = (
                not task.active
                or task.phase in {"PAUSED", "WAITING_USER", "OUTCOME_UNKNOWN"}
                or bool(task.data.get("report_id"))
                if worker
                else task.phase
                in {
                    "COMPLETED",
                    "WAITING_USER",
                    "PAUSED",
                    "OUTCOME_UNKNOWN",
                    "CANCELLED",
                }
            )
            if allowed:
                return FinalOutputGateDecision("allow")
            if not prompted:
                prompted = True
                return FinalOutputGateDecision(
                    "continue",
                    continuation_prompt="请用 fusion_submit_result 提交报告。"
                    if worker
                    else "任务尚未收敛。请用 Fusion 工具完成派单、审阅或直接问答；遇到阻塞请明确说明。",
                )
            task = await self.store.update(
                task.task_id,
                task.version,
                phase="WAITING_USER",
                data={
                    "reason": "worker_report_missing"
                    if worker
                    else "lead_stopped_without_completion"
                },
            )
            self._emit(context, task)
            return FinalOutputGateDecision(
                "allow", warning="Fusion 尚未完成，需要用户继续。"
            )

        return gate
