"""复用 Host 资源执行 Sidekick，分别管理探索和实施的历史。

Host 固定角色 → Pool / Managed 执行 → 同页过程与真实审批 → 取消/资源收尾。
探索用临时 checkpoint，实施在同任务内持续；任务阶段和验收由服务决定。
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Mapping
from typing import TYPE_CHECKING, Literal


from harness_agent.host.run_coordinator import RunRef
from harness_agent.runtime.agent_spec import ResolvedAgentSpec
from harness_agent.runtime.execution_binding import (
    MANAGED_EXECUTION_CHECKPOINT_PREFIX,
    AgentExecutionBinding,
    ExecutionMode,
    ExecutionRef,
    ExecutionStatus,
)
from harness_agent.runtime.execution_stream import (
    CONTENT_DELTA,
    ExecutionSignal,
    StreamInteractionRequest,
)
from harness_agent.runtime.fusion.service import FusionService
from harness_agent.runtime.fusion.store import (
    FusionError,
    FusionStateStore,
    FusionTask,
    new_id,
)
from harness_agent.runtime.interactions import InteractionRequest
from harness_agent.runtime.managed_agent_executor import (
    ManagedAgentExecutionError,
    ManagedAgentExecutor,
    ManagedAgentRequest,
    ManagedAgentResult,
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
    ContextLifecycle,
)

if TYPE_CHECKING:
    from harness_agent.host.agent_host import AgentHost
    from harness_agent.threads.thread_persistence import ThreadPersistence


class FusionWorkerObserver(ManagedChildObserver):
    """实时转发 Sidekick 过程和真实审批；不写父 Transcript，不主动提问。"""

    def __init__(
        self,
        host: AgentHost,
        parent: RunContext,
        ref: ExecutionRef,
        namespace: str,
        *,
        task: FusionTask,
        model: str,
        kind: str = "implementation",
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
        self._execution_payload = {
            "task_id": task.task_id,
            "role": "sidekick",
            "round": task.data["round"],
            "model": model,
            **({"kind": "exploration"} if kind == "exploration" else {}),
        }

    def emit(self, signal: ExecutionSignal) -> None:
        """正文与主 Agent 一样实时转发；身份始终使用本轮冻结值。"""
        if signal.type == CONTENT_DELTA:
            self._emit(signal.type, signal.payload)
        else:
            super().emit(signal)

    async def on_execution_complete(self, result: ManagedAgentResult) -> None:
        """正文已经实时显示，结束时不再重复追加最终内容。"""
        return None

    def emit_status(
        self, status: Literal["running", "completed", "cancelled", "failed"]
    ) -> None:
        """一轮开始前及释放前公布起止事实，不把执行结束当作任务验收。"""
        self._emit("fusion.execution", {**self._execution_payload, "status": status})

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


class FusionWorkerRunner:
    """统一 Sidekick 的模型资源和取消收尾，探索与实施使用不同 checkpoint。"""

    def __init__(
        self, host: AgentHost, persistence: ThreadPersistence, store: FusionStateStore
    ) -> None:
        """运行事实由 Host 注入；本类不决定任务阶段、权限或验收。"""
        self.host, self.persistence, self.store = host, persistence, store

    async def run(
        self,
        parent: RunContext,
        task: FusionTask,
        message: str,
        *,
        spec: ResolvedAgentSpec,
        service: FusionService,
        exploration_id: str | None = None,
    ) -> str:
        """每轮新执行 ID，同一任务保持 checkpoint；共享审批、取消和用量。"""
        host = self.host
        exploration = exploration_id is not None
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
                f"{self.persistence.project_fingerprint}:{parent.thread_id}:{task.task_id}:{exploration_id or task.worker_session_id}".encode()
            ).hexdigest()
        )
        restore_checkpoint_id = None
        if not exploration and (
            task.data.get("checkpoint_id") or task.data.get("round", 0) > 1
        ):
            saved = await self.persistence.checkpointer.aget_tuple(
                self.persistence.graph_config(stable_id)
            )
            completed_id = task.data.get("completed_checkpoint_id")
            interrupted = task.data.get("worker_checkpoint_interrupted") is True
            if task.data.get("checkpoint_id") != stable_id and not (
                interrupted
                and task.data.get("checkpoint_id") is None
                and completed_id is None
            ):
                raise FusionError("FUSION_WORKER_CHECKPOINT_INVALID")
            if interrupted:
                # 只从上一完整记录续接；半轮工具不重放，已改文件留在工作区供重新读取。
                if completed_id:
                    config = self.persistence.graph_config(stable_id)
                    config["configurable"]["checkpoint_id"] = completed_id
                    completed = await self.persistence.checkpointer.aget_tuple(config)
                    if completed is None:
                        raise FusionError("FUSION_WORKER_CHECKPOINT_INVALID")
                    restore_checkpoint_id = completed_id
                else:
                    await self.persistence.delete_execution_checkpoint(stable_id)
            elif (
                saved is None
                or not completed_id
                or saved.checkpoint["id"] != completed_id
            ):
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
        if not exploration:
            task = await self.store.update(
                task.task_id,
                task.version,
                data={
                    "worker_execution_id": ref.execution_id,
                    "checkpoint_id": stable_id,
                },
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
            interaction_port=lambda interaction: (
                host._run_coordinator.request_child_interaction(
                    RunRef(ref.thread_id, ref.run_id), interaction
                )
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
                parent.fusion_state.revision,
                parent.fusion_state.generation,
                exploration_only=exploration,
            ),
            fusion_service=service,
        )

        def release() -> None:
            host._snapshot_store.close_thread(stable_id)

        def graph_config(_: str) -> Mapping[str, object]:
            nonlocal restore_checkpoint_id
            config = self.persistence.graph_config(stable_id)
            if restore_checkpoint_id is not None:
                config["configurable"]["checkpoint_id"] = restore_checkpoint_id
                restore_checkpoint_id = None
            return config

        async def acquire() -> ManagedAgentRuntime:
            # 空闲图淘汰也会删除规格缓存；每次借用前从本轮冻结 Spec 恢复登记。
            host._resolved_agent_specs.setdefault(profile.profile_key, spec)
            return await acquire_pooled_agent_runtime(
                pool=host._ensure_agent_engine_pool(host._config),
                profile=profile,
                run_context=context,
                graph_config=graph_config,
                on_release=release,
            )

        async def start(_: str) -> None:
            await registry.start(ref)

        request = ManagedAgentRequest(
            execution_ref=ref.execution_id,
            parent_execution_ref=ref.parent_execution_id,
            run_id=ref.run_id,
            input=message,
            checkpoint_namespace=exploration_id or task.worker_session_id,
            output_policy="passthrough",
            runtime_provider=acquire,
            is_cancelled=lambda: parent.cancellation_token.cancelled,
            idempotency_key=exploration_id or task.data["operation_id"],
            execution_starter=start,
            agent_spec=spec,
            final_output_gate=None if exploration else service.final_gate(context),
            provider_retry=BoundedProviderRetry(
                max_attempts=spec.model_settings.max_retries + 1
            ),
            diagnostic_log=log,
            model_profile_id=spec.model_profile_id,
            usage_ledger=parent.usage_ledger,
            on_model_usage=lambda event_id, calls: service.record_usage(
                context, event_id, calls
            ),
            on_resume_consumed=lambda: host._run_coordinator.child_resume_consumed(
                RunRef(parent.thread_id, parent.run_id)
            ),
        )
        observer = FusionWorkerObserver(
            host,
            parent,
            ref,
            stable_id,
            task=task,
            model=spec.model_view.model,
            kind="exploration" if exploration else "implementation",
        )
        observer.emit_status("running")
        checkpoint_finished = False
        try:
            result = await ManagedAgentExecutor().execute(request, observer)
            saved = await self.persistence.checkpointer.aget_tuple(
                self.persistence.graph_config(stable_id)
            )
            if saved is not None and not exploration:
                current = await self.store.get(task.task_id)
                await self.store.update(
                    task.task_id,
                    current.version,
                    data={"completed_checkpoint_id": saved.checkpoint["id"]},
                )
            checkpoint_finished = True
            await registry.finalize(ref, status=ExecutionStatus.COMPLETED)
            observer.emit_status("completed")
            return result.final_content
        except BaseException as exc:
            cancelled = parent.cancellation_token.cancelled or isinstance(
                exc, asyncio.CancelledError
            )
            await registry.finalize(
                ref,
                status=ExecutionStatus.CANCELLED
                if cancelled
                else ExecutionStatus.FAILED,
            )
            observer.emit_status("cancelled" if cancelled else "failed")
            if (
                isinstance(exc, ManagedAgentExecutionError)
                and exc.code == "RUN_CANCELLED"
            ):
                raise asyncio.CancelledError from exc
            raise
        finally:
            release()
            try:
                if index_lease is not None:
                    await index_lease.release()
            finally:
                if exploration:
                    await asyncio.shield(
                        self.persistence.delete_execution_checkpoint(stable_id)
                    )
                else:
                    # Managed 已退出只确认派单收尾，不替子命令推断 stopped。
                    await asyncio.shield(
                        self.store.record_worker_stopped(
                            task.task_id,
                            task.data["operation_id"],
                            ref.execution_id,
                            interrupted=not checkpoint_finished,
                        )
                    )
