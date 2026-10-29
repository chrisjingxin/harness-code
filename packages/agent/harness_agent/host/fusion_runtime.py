"""把 Host 现有资源接到 Fusion：固定模型、执行 Sidekick、运行检查。

AgentHost -- 准备 --> Lead/Sidekick Spec -- 复用 --> AgentEnginePool
    |                                     |
    +-- FusionService <---- 执行/检查 -----+-- ManagedAgentExecutor
                                       +-- ManagedVerificationPort

本模块拥有每轮资源；任务事实由 Store 保存，权限和终态判断由 Service/Guard 负责。
"""

from __future__ import annotations

import asyncio
import shlex
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from langgraph.runtime import get_runtime

from harness_agent.config.config import ConfigError
from harness_agent.host.run_coordinator import RunPreparation, StartRun
from harness_agent.runtime.agent_spec import ResolvedAgentSpec
from harness_agent.runtime.execution_binding import (
    ResolvedExecutionBinding,
    SelectionOrigin,
    ThreadExecutionSelection,
)
from harness_agent.runtime.fusion.followup import classify_fusion_followup
from harness_agent.runtime.fusion.guard import FusionEffectMiddleware, FusionWriteGuard
from harness_agent.runtime.fusion.profile import (
    FrozenFusionCheckPlan,
    FrozenFusionProfile,
    resolve_fusion_profile,
)
from harness_agent.runtime.fusion.roles import resolve_fusion_specs
from harness_agent.runtime.fusion.service import FusionService
from harness_agent.runtime.fusion.store import (
    FusionError,
    FusionLease,
    FusionStateStore,
    FusionTask,
    new_id,
)
from harness_agent.runtime.run_context import (
    RunContext,
    current_approval_mode,
)
from harness_agent.threads.context_lifecycle import (
    ContextAuthority,
    ContextBlock,
    ContextLifecycle,
    ContextStability,
)

if TYPE_CHECKING:
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.threads.thread_persistence import ThreadPersistence


@dataclass(frozen=True, slots=True)
class FusionRunBinding:
    """固定任务、角色身份及本轮恢复方式，运行阶段不再猜测用户意图。"""

    task_id: str
    profile: FrozenFusionProfile
    lead_profile_key: str
    sidekick_profile_key: str
    owner_id: str
    inspection_only: bool = False
    resume_pending: bool = False


class FusionRuntime:
    """一个 Host 持有一个服务，任务事实仍按项目和 Thread 隔离。"""

    def __init__(self, host: AgentHost, persistence: ThreadPersistence) -> None:
        """为一个 Host 建立稳定的服务和工作区守卫。"""
        self.host = host
        self.persistence = persistence
        self.store: FusionStateStore = persistence.fusion_state_store()
        self.profiles: dict[str, FrozenFusionProfile] = {}
        self.worker_specs: dict[str, ResolvedAgentSpec] = {}
        self.owner_id = new_id("fusion-host")
        self._claimed_runs: dict[str, str] = {}

        def context_provider() -> RunContext | None:
            try:
                return get_runtime().context
            except RuntimeError:
                return None

        self.guard = FusionWriteGuard(
            persistence.database_path,
            project_fingerprint=persistence.project_fingerprint,
            workspace=host._workspace,
            context_provider=context_provider,
        )
        self.effect_middleware = FusionEffectMiddleware(self.guard, self.store)
        from harness_agent.host.fusion_worker import FusionWorkerRunner
        from harness_agent.runtime.fusion.roles import resolve_exploration_spec

        runner = FusionWorkerRunner(host, persistence, self.store)

        async def implement(parent: RunContext, task: FusionTask, message: str) -> None:
            await runner.run(
                parent,
                task,
                message,
                spec=self.worker_specs[task.task_id],
                service=self.service,
            )

        async def explore(
            parent: RunContext, task: FusionTask, message: str, exploration_id: str
        ) -> str:
            spec = resolve_exploration_spec(
                self.worker_specs[task.task_id], self.profiles[task.task_id]
            )
            from harness_agent.runtime.agent_engine import AgentEnginePoolCapacityError
            from harness_agent.runtime.managed_agent_executor import (
                ManagedAgentExecutionError,
            )

            try:
                return await runner.run(
                    parent,
                    task,
                    message,
                    spec=spec,
                    service=self.service,
                    exploration_id=exploration_id,
                )
            except AgentEnginePoolCapacityError as exc:
                raise FusionError("FUSION_EXPLORATION_BUSY") from exc
            except ManagedAgentExecutionError as exc:
                if exc.code == "RUNTIME_POOL_CAPACITY_EXHAUSTED":
                    raise FusionError("FUSION_EXPLORATION_BUSY") from exc
                raise

        self.service = FusionService(
            store=self.store,
            workspace=host._workspace,
            profile_provider=self.profiles.__getitem__,
            worker=implement,
            explorer=explore,
            guard=self.guard,
            prepare_check=self.prepare_check,
        )

    async def close(self) -> None:
        """正常关闭已经停止所有 Run，归还尚未转交或未完成收尾的本 Host 归属。"""
        for task_id, run_id in self._claimed_runs.items():
            await self.store.release_run(task_id, self.owner_id, run_id)
        self._claimed_runs.clear()

    async def prepare(self, command: StartRun) -> RunPreparation:
        """准备两角色再建立任务；拒绝 Goal、Plan 与配置漂移。"""
        host = self.host
        host._load_config()
        config = host._config
        if config is None:
            raise ConfigError(host._startup_error or "MODEL_CONFIGURATION_REQUIRED")
        if (
            command.mode != "build"
            or command.input.kind != "user"
            or command.requested_skill is not None
            or command.requested_primary_profile is not None
        ):
            raise FusionError("FUSION_INPUT_INVALID")
        if (
            command.requested_approval_mode or config.execution.approval_mode
        ) == "plan":
            raise FusionError("FUSION_INPUT_INVALID")
        if config.execution.sandbox_enabled:
            raise FusionError("FUSION_SNAPSHOT_UNAVAILABLE")
        goal = (await self.persistence.goal_store().inspect(command.thread_id)).goal
        if goal is not None and goal.status in {"active", "blocked"}:
            raise FusionError("FUSION_INPUT_INVALID")
        frozen = resolve_fusion_profile(config, command.fusion_profile_id or "")
        task = await self.store.active(command.thread_id)
        created_task = False
        inspection_only = False
        followup = classify_fusion_followup(command.input.message)
        if task:
            if task.data.get("reason") == "workspace_busy":
                task = await self.store.reconcile(task.task_id)
            inspection_only = (
                task.phase in {"OUTCOME_UNKNOWN", "WAITING_RESOURCE"}
                or task.data.get("reason") == "resource_wait_paused"
                and followup == "inspect"
                or task.data.get("reason") == "workspace_busy"
            )
            if not inspection_only and (
                task.data["profile"].get("config_fingerprint")
                != frozen.config_fingerprint
            ):
                raise FusionError("FUSION_TASK_CONFLICT")
            if not inspection_only:
                task = await self.store.claim_run(
                    task.task_id, task.version, self.owner_id, command.run_id
                )
                self._claimed_runs[task.task_id] = command.run_id
                try:
                    task = await self.service.resume(task.task_id)
                except BaseException:
                    await asyncio.shield(
                        self.store.release_run(
                            task.task_id, self.owner_id, command.run_id
                        )
                    )
                    raise
        try:
            reservation = await host._reserve_agent_engine_snapshot()
        except BaseException:
            if task is not None and not inspection_only:
                await asyncio.shield(
                    self.store.release_run(task.task_id, self.owner_id, command.run_id)
                )
            raise
        index_lease = None
        try:
            registry = await host._refresh_skill_catalog_locked()
            resolved = ResolvedExecutionBinding(
                selection=ThreadExecutionSelection(frozen.lead_profile.profile_id),
                primary_profile=frozen.lead_profile,
                safe_primary=frozen.lead,
                selection_origin=SelectionOrigin.REQUEST,
            )
            manager = host._code_index_manager
            if manager is not None:
                await manager.start()
                index_lease = await manager.acquire_query()
            base = await host._resolve_agent_engine_spec(
                command.thread_id,
                config,
                resolved,
                persistence=self.persistence,
                skill_registry=registry,
                approval_mode=command.requested_approval_mode,
                code_index_generation=index_lease.generation if index_lease else None,
                fusion=True,
            )
            lead, worker = resolve_fusion_specs(
                base, frozen, inspection_only=inspection_only
            )
            for spec in (lead, worker):
                profile = spec.runtime_profile
                await self.persistence.persist_agent_engine_profile(profile)
                host._resolved_agent_specs.setdefault(profile.profile_key, spec)
            if task is None:
                task = await self.store.create(
                    thread_id=command.thread_id,
                    profile=frozen.to_record(),
                    workspace=host._workspace,
                    source_message=command.input.message,
                )
                created_task = True
                task = await self.store.claim_run(
                    task.task_id, task.version, self.owner_id, command.run_id
                )
                self._claimed_runs[task.task_id] = command.run_id
            self.profiles[task.task_id] = frozen
            self.worker_specs[task.task_id] = worker
            snapshot = ContextLifecycle(
                host._workspace, home=host._config_home
            ).prepare(
                thread_id=command.thread_id,
                spec=lead,
                dynamic_blocks=(
                    ContextBlock(
                        "fusion-status",
                        ContextAuthority.DYNAMIC,
                        ContextStability.RUN,
                        "当前 Fusion 状态：" + str(task.to_record()),
                    ),
                ),
            )
            profile = lead.runtime_profile

            async def abandon() -> None:
                if not inspection_only:
                    await self.store.release_run(
                        task.task_id,
                        self.owner_id,
                        command.run_id,
                        abandon_new=created_task,
                    )

            return RunPreparation(
                resolved_execution_binding=resolved,
                execution_binding=resolved.bind_run(
                    thread_id=command.thread_id,
                    run_id=command.run_id,
                    runtime_profile_id=profile.profile_key[:12],
                    created_at_ms=int(time.time() * 1000),
                    context_snapshot_id=snapshot.snapshot_id,
                ),
                agent_engine_profile=profile,
                skill_snapshot_id=lead.skill_registry.snapshot_id,
                skill_registry=lead.skill_registry,
                context_snapshot=snapshot,
                approval_mode=lead.effective_policy.approval_mode
                or lead.execution.approval_mode,
                provider_retry_attempts=lead.model_settings.max_retries + 1,
                snapshot_reservation=reservation,
                on_abandon=abandon,
                code_index_lease=index_lease,
                fusion_binding=FusionRunBinding(
                    task.task_id,
                    frozen,
                    profile.profile_key,
                    worker.runtime_profile.profile_key,
                    self.owner_id,
                    inspection_only,
                    followup == "resume" and not inspection_only,
                ),
            )
        except BaseException:
            if task is not None and not inspection_only:
                await asyncio.shield(
                    self.store.release_run(
                        task.task_id,
                        self.owner_id,
                        command.run_id,
                        abandon_new=created_task,
                    )
                )
            if index_lease is not None:
                await index_lease.release()
            await reservation.release()
            raise

    async def prepare_check(
        self, context: RunContext, plan: FrozenFusionCheckPlan, lease: FusionLease
    ) -> Callable[[], Awaitable[Mapping[str, object]]]:
        """先审批固定命令，返回一次执行入口；目录许可由 Service 执行整组时取得。"""
        from harness_agent.policy.permission_rules import load_rules, merge_rules
        from harness_agent.runtime.verification import (
            ManagedVerificationPort,
            VerificationError,
            VerificationRequest,
        )

        host = self.host

        def rules():
            persisted = load_rules(project_dir=host._workspace)
            persisted["session"] = host._run_coordinator.session_rules
            return merge_rules(persisted)

        async def approve(description: str) -> bool:
            from harness_agent.runtime.interactions import InteractionRequest

            request_id = new_id("fusion-check-approval")
            result = await context.interaction_port(
                InteractionRequest(
                    request_id=request_id,
                    type="approval",
                    interrupt_id=request_id,
                    payload={
                        "interrupt_id": request_id,
                        "description": description,
                        "requests": {
                            "action_requests": [
                                {"name": "execute", "args": {"command": plan.command}}
                            ]
                        },
                        "decisions": ["approve_once", "reject"],
                    },
                )
            )
            value = getattr(result, "value", result)
            if isinstance(value, Mapping):
                decisions = value.get("decisions", [])
                return value.get("decision") in {
                    "approve_once",
                    "approve_thread",
                    "approve_project",
                } or bool(decisions and decisions[0].get("type") == "approve")
            return False

        from harness_agent.runtime.fusion.snapshot import capture_snapshot

        task = await self.store.get(context.fusion_task_id)
        order = await self.store.load_record(
            task.task_id, "order", str(task.data["revision"])
        )
        expected_digest = task.data["candidate_digest"]

        def before_execute() -> None:
            self.guard.check_command(context, host=True)
            if (
                not plan.cwd.resolve().is_relative_to(host._workspace.resolve())
                or not plan.cwd.is_dir()
            ):
                raise FusionError("FUSION_PATH_INVALID")
            if (
                capture_snapshot(host._workspace, order["allowed_paths"])["digest"]
                != expected_digest
            ):
                raise FusionError("FUSION_REPORT_STALE")

        command = plan.command
        if plan.cwd != host._workspace.resolve():
            command = "cd " + shlex.quote(str(plan.cwd)) + " && " + command
        port = ManagedVerificationPort(
            pool=host._ensure_workspace_execution_resources(),
            settings=self.worker_specs[context.fusion_task_id].execution,
            workspace=host._workspace,
            rules_provider=rules,
            rwlock=host._tool_concurrency_lock,
            now_ms=lambda: int(time.time() * 1000),
            write_guard=lambda: self.guard.check_command(None),
        )
        prepared = None
        preparation_error = None
        try:
            prepared = await port.prepare(
                VerificationRequest(
                    command=command,
                    label=plan.plan_id,
                    resource_key="fusion-check:" + context.fusion_task_id,
                    timeout_seconds=plan.timeout_seconds,
                    approve=approve,
                    before_execute=before_execute,
                    approval_mode_provider=lambda: current_approval_mode(
                        context, fallback=context.approval_mode
                    ),
                )
            )
        except (FusionError, VerificationError) as exc:
            preparation_error = exc.code

        async def execute_check() -> Mapping[str, object]:
            if preparation_error is not None:
                return {
                    "plan_id": plan.plan_id,
                    "exit_code": None,
                    "summary": preparation_error,
                    "stopped": True,
                }
            try:
                evidence = await prepared()
                return {
                    "plan_id": plan.plan_id,
                    "exit_code": evidence.exit_code,
                    "summary": evidence.output_summary,
                    "output_digest": evidence.output_digest,
                    "started_at_ms": evidence.started_at_ms,
                    "finished_at_ms": evidence.finished_at_ms,
                    "working_dir": evidence.working_dir,
                    "stopped": evidence.exit_code != 124,
                }
            except FusionError as exc:
                return {
                    "plan_id": plan.plan_id,
                    "exit_code": None,
                    "summary": exc.code,
                    "stopped": True,
                }
            except VerificationError as exc:
                return {
                    "plan_id": plan.plan_id,
                    "exit_code": None,
                    "summary": exc.code,
                    "stopped": exc.code
                    not in {"VERIFICATION_TIMEOUT", "BACKEND_FAILED"},
                }

        return execute_check
