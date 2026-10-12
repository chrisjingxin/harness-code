"""把 Host 现有资源接到 Fusion：固定模型、执行 Sidekick、运行检查。

AgentHost -- 准备 --> Lead/Sidekick Spec -- 复用 --> AgentEnginePool
    |                                     |
    +-- FusionService <---- 执行/检查 -----+-- ManagedAgentExecutor
                                       +-- ManagedVerificationPort

本模块拥有每轮资源；任务事实由 Store 保存，权限和终态判断由 Service/Guard 负责。
"""

from __future__ import annotations

import asyncio
import hashlib
import shlex
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from langgraph.runtime import get_runtime

from harness_agent.config.config import ConfigError
from harness_agent.host.run_coordinator import RunPreparation, RunRef, StartRun
from harness_agent.runtime.agent_spec import ResolvedAgentSpec
from harness_agent.runtime.execution_binding import (
    MANAGED_EXECUTION_CHECKPOINT_PREFIX,
    AgentExecutionBinding,
    ExecutionMode,
    ExecutionRef,
    ExecutionStatus,
    ResolvedExecutionBinding,
    SelectionOrigin,
    ThreadExecutionSelection,
)
from harness_agent.runtime.execution_stream import StreamInteractionRequest
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
from harness_agent.runtime.interactions import InteractionRequest
from harness_agent.runtime.managed_agent_executor import (
    ManagedAgentExecutionError,
    ManagedAgentExecutor,
    ManagedAgentRequest,
    ManagedAgentRuntime,
    ManagedChildObserver,
    acquire_pooled_agent_runtime,
)
from harness_agent.runtime.provider_retry import BoundedProviderRetry
from harness_agent.runtime.run_context import (
    FusionRunState,
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
    """只携带任务和冻结角色身份，运行阶段不再决定模型。"""

    task_id: str
    profile: FrozenFusionProfile
    lead_profile_key: str
    sidekick_profile_key: str


class FusionWorkerObserver(ManagedChildObserver):
    """转发子图事件和真实审批；禁止 Sidekick 主动向用户提问。"""

    def __init__(
        self, host: AgentHost, parent: RunContext, ref: ExecutionRef, namespace: str
    ) -> None:
        """固定本轮执行来源及持续 checkpoint，审批由父 Run 接收。"""
        super().__init__(
            event_port=parent.event_port,
            execution_ref=ref.execution_id,
            parent_execution_ref=ref.parent_execution_id,
            agent_id="fusion-sidekick",
        )
        self.host = host
        self.parent = parent
        self.ref = ref
        self.namespace = namespace

    async def interact(self, request: StreamInteractionRequest) -> object:
        """通过父 Run 的串行审批生成 LangGraph 恢复值，不自动批准。"""
        if request.type != "approval":
            raise FusionError("FUSION_ROLE_DENIED")
        interaction = InteractionRequest(
            request_id=request.request_id,
            type=request.type,
            payload=request.payload,
            interrupt_id=request.interrupt_id,
            questions=request.questions,
            action_count=request.action_count,
            serial_context={
                **(request.serial_context or {}),
                "checkpoint_namespace": self.namespace,
            },
            execution_id=self.ref.execution_id,
            parent_execution_id=self.ref.parent_execution_id,
            agent_id="fusion-sidekick",
        )
        return await self.host._run_coordinator.collect_child_approvals(
            RunRef(self.parent.thread_id, self.parent.run_id), interaction
        )


class FusionRuntime:
    """一个 Host 持有一个服务，任务事实仍按项目和 Thread 隔离。"""

    def __init__(self, host: AgentHost, persistence: ThreadPersistence) -> None:
        """为一个 Host 建立稳定的服务和工作区守卫。"""
        self.host = host
        self.persistence = persistence
        self.store: FusionStateStore = persistence.fusion_state_store()
        self.profiles: dict[str, FrozenFusionProfile] = {}
        self.worker_specs: dict[str, ResolvedAgentSpec] = {}

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
        self.service = FusionService(
            store=self.store,
            workspace=host._workspace,
            profile_provider=self.profiles.__getitem__,
            worker=self.run_worker,
            check=self.run_check,
            rwlock=host._tool_concurrency_lock,
        )

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
        if task:
            if (
                task.data["profile"].get("config_fingerprint")
                != frozen.config_fingerprint
            ):
                raise FusionError("FUSION_TASK_CONFLICT")
            task = await self.service.resume(task.task_id)
            if task.phase == "OUTCOME_UNKNOWN":
                raise FusionError("FUSION_OUTCOME_UNKNOWN")
        reservation = await host._reserve_agent_engine_snapshot()
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
            lead, worker = resolve_fusion_specs(base, frozen)
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
                code_index_lease=index_lease,
                fusion_binding=FusionRunBinding(
                    task.task_id,
                    frozen,
                    profile.profile_key,
                    worker.runtime_profile.profile_key,
                ),
            )
        except BaseException:
            if index_lease is not None:
                await index_lease.release()
            await reservation.release()
            raise

    async def run_worker(
        self, parent: RunContext, task: FusionTask, message: str
    ) -> None:
        """每轮新执行 ID，同一任务保持 checkpoint；共享审批、取消和用量。"""
        host = self.host
        spec = self.worker_specs[task.task_id]
        profile = spec.runtime_profile
        registry = host._run_coordinator.execution_registry
        ref = ExecutionRef(
            parent.thread_id,
            parent.run_id,
            new_id("fusion-worker"),
            parent.execution_id,
        )
        stable_id = (
            MANAGED_EXECUTION_CHECKPOINT_PREFIX
            + hashlib.sha256(
                f"{self.persistence.project_fingerprint}:{parent.thread_id}:{task.task_id}:{task.worker_session_id}".encode()
            ).hexdigest()
        )
        if task.data.get("checkpoint_id") or task.data.get("round", 0) > 1:
            saved = await self.persistence.checkpointer.aget_tuple(
                self.persistence.graph_config(stable_id)
            )
            if (
                task.data.get("checkpoint_id") != stable_id
                or saved is None
                or not task.data.get("completed_checkpoint_id")
                or saved.checkpoint["id"] != task.data["completed_checkpoint_id"]
            ):
                # 丢失、被覆盖或上一轮未完整结束的历史都不能当成空会话重开。
                raise FusionError("FUSION_WORKER_CHECKPOINT_INVALID")
        await registry.accept(
            AgentExecutionBinding(
                ref=ref,
                agent_id="fusion-sidekick",
                mode=ExecutionMode.MANAGED,
                depth=1,
                model=spec.model_view,
                policy_fingerprint=spec.effective_policy.fingerprint,
                engine_profile_key=profile.profile_key,
                definition_fingerprint=spec.definition_fingerprint,
            )
        )
        task = await self.store.update(
            task.task_id,
            task.version,
            data={"worker_execution_id": ref.execution_id, "checkpoint_id": stable_id},
        )
        from harness_agent.diagnostic_log.runtime import bind_execution_log
        from harness_agent.threads.deferred_store import ThreadDeferredToolStore

        log = bind_execution_log(
            parent.diagnostic_log,
            thread_id=ref.thread_id,
            run_id=ref.run_id,
            execution_id=ref.execution_id,
            parent_execution_id=ref.parent_execution_id,
            agent_id="fusion-sidekick",
        )
        index_lease = None
        if host._code_index_manager is not None:
            index_lease = await host._code_index_manager.acquire_query()
        snapshot = ContextLifecycle(host._workspace, home=host._config_home).prepare(
            thread_id=parent.thread_id, spec=spec
        )
        context = RunContext(
            thread_id=parent.thread_id,
            run_id=parent.run_id,
            context_snapshot=snapshot,
            skill_registry=spec.skill_registry,
            approval_mode=parent.approval_mode,
            approval_state=parent.approval_state,
            approval_mode_provider=lambda: current_approval_mode(
                parent, fallback=parent.approval_mode
            ),
            interaction_port=lambda interaction: host._run_coordinator.request_child_interaction(
                RunRef(ref.thread_id, ref.run_id), interaction
            ),
            event_port=parent.event_port,
            record_approval=parent.record_approval,
            profile_key=profile.profile_key,
            checkpoint_thread_id=stable_id,
            execution_id=ref.execution_id,
            parent_execution_id=ref.parent_execution_id,
            agent_id="fusion-sidekick",
            cancellation_token=parent.cancellation_token,
            plan_constraint=parent.plan_constraint,
            delegation_policy=spec.effective_policy.delegation,
            workspace_root_registry=host._workspace_root_registry.readonly_view()
            if host._workspace_root_registry
            else None,
            snapshot_store=host._snapshot_store,
            deferred_tool_store=ThreadDeferredToolStore(),
            diagnostic_log=log,
            usage_ledger=parent.usage_ledger,
            code_index_query_lease=index_lease,
            fusion_task_id=task.task_id,
            fusion_role="sidekick",
            fusion_state=FusionRunState(
                parent.fusion_state.revision, parent.fusion_state.generation
            ),
            fusion_service=self.service,
        )

        def release() -> None:
            host._snapshot_store.close_thread(stable_id)

        async def acquire() -> ManagedAgentRuntime:
            return await acquire_pooled_agent_runtime(
                pool=host._ensure_agent_engine_pool(host._config),
                profile=profile,
                run_context=context,
                graph_config=lambda _: self.persistence.graph_config(stable_id),
                on_release=release,
            )

        async def start(_: str) -> None:
            await registry.start(ref)

        request = ManagedAgentRequest(
            execution_ref=ref.execution_id,
            parent_execution_ref=ref.parent_execution_id,
            run_id=ref.run_id,
            input=message,
            checkpoint_namespace=task.worker_session_id,
            output_policy="capture_only",
            runtime_provider=acquire,
            is_cancelled=lambda: parent.cancellation_token.cancelled,
            idempotency_key=task.data["operation_id"],
            execution_starter=start,
            agent_spec=spec,
            final_output_gate=self.service.final_gate(context),
            provider_retry=BoundedProviderRetry(
                max_attempts=spec.model_settings.max_retries + 1
            ),
            diagnostic_log=log,
            model_profile_id=spec.model_profile_id,
            usage_ledger=parent.usage_ledger,
            on_resume_consumed=lambda: host._run_coordinator.child_resume_consumed(
                RunRef(parent.thread_id, parent.run_id)
            ),
        )
        try:
            await ManagedAgentExecutor().execute(
                request, FusionWorkerObserver(host, parent, ref, stable_id)
            )
            saved = await self.persistence.checkpointer.aget_tuple(
                self.persistence.graph_config(stable_id)
            )
            if saved is not None:
                current = await self.store.get(task.task_id)
                await self.store.update(
                    task.task_id,
                    current.version,
                    data={"completed_checkpoint_id": saved.checkpoint["id"]},
                )
            await registry.finalize(ref, status=ExecutionStatus.COMPLETED)
        except BaseException as exc:
            await registry.finalize(
                ref,
                status=ExecutionStatus.CANCELLED
                if parent.cancellation_token.cancelled
                else ExecutionStatus.FAILED,
            )
            if (
                isinstance(exc, ManagedAgentExecutionError)
                and exc.code == "RUN_CANCELLED"
            ):
                raise asyncio.CancelledError from exc
            raise
        finally:
            release()
            if index_lease is not None:
                await index_lease.release()

    async def run_check(
        self, context: RunContext, plan: FrozenFusionCheckPlan, lease: FusionLease
    ) -> Mapping[str, object]:
        """检查固定配置命令；审批后重查权限、目录、候选和写者。"""
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
        try:
            evidence = await port.run(
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
            if exc.code in {"VERIFICATION_TIMEOUT", "BACKEND_FAILED"}:
                return {
                    "plan_id": plan.plan_id,
                    "exit_code": None,
                    "summary": exc.code,
                    "stopped": False,
                }
            return {
                "plan_id": plan.plan_id,
                "exit_code": None,
                "summary": exc.code,
                "stopped": True,
            }
