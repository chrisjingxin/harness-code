/** Fusion 双角色过程的固定事件；所有模型名和任务 ID 都是测试数据。 */
import { EventType, type EventEnvelope } from "@za38/protocol"
import { applyAgentEvent, createInitialState, startRun, type InteractiveState } from "../../src/interactive/state"

export const fusionTask = {
  task_id: "fusion-test", thread_id: "t", version: 1, phase: "READY", active: true,
  profile: { profile_id: "duo", lead: { id: "pro", model: "strong-model" }, sidekick: { id: "fast", model: "fast-model" } },
  worker_session_id: "stable-session", revision: 0, round: 0, verification: "unverified",
}

export function fusionEvent(type: string, payload: Record<string, unknown>, sequence: number,
  executionId = "root-r", parentExecutionId?: string): EventEnvelope {
  return {
    event_id: `event-${sequence}`, type, thread_id: "t", run_id: "r", sequence, timestamp_ms: sequence,
    execution_id: executionId, ...(parentExecutionId ? { parent_execution_id: parentExecutionId } : {}),
    agent_id: parentExecutionId ? "fusion-sidekick" : "fusion-lead", payload,
  } as EventEnvelope
}

export function workerEvent(status: string, sequence: number, executionId = "worker-1", round = 1): EventEnvelope {
  return fusionEvent("fusion.execution", { task_id: "fusion-test", role: "sidekick", round, model: "fast-model", status },
    sequence, executionId, "root-r")
}

export function startFusion(): InteractiveState {
  return applyAgentEvent(startRun(createInitialState("t"), { threadId: "t", runId: "r" }, "修改代码"),
    fusionEvent(EventType.RUN_STARTED, { mode: "build", resumed: false, fusion: fusionTask }, 1))
}

export function liveFusionTimeline(): InteractiveState {
  let state = startFusion()
  for (const event of [
    fusionEvent(EventType.CONTENT_DELTA, { text: "Lead 正在检查代码" }, 2),
    workerEvent("running", 3),
    fusionEvent(EventType.CONTENT_DELTA, { text: "Sidekick 正在修改文件" }, 4, "worker-1", "root-r"),
    fusionEvent(EventType.TOOL_STARTED, { tool_call_id: "write-1", name: "write_file" }, 5, "worker-1", "root-r"),
    fusionEvent(EventType.TOOL_DELTA, { tool_call_id: "write-1", arguments_delta: '{"file_path":"/answer.py"}' }, 6, "worker-1", "root-r"),
  ]) state = applyAgentEvent(state, event)
  return state
}
