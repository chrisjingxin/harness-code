/**
 * Fusion 过程投影：开始事件建立角色身份，实时内容沿用普通 Timeline。
 *
 * run.started / fusion.execution → 角色记录 → 原有内容和工具 → 结束时收敛指示
 * 记录只属于展示状态，不进入父模型上下文，也不改变任务权限和验收结果。
 */
import { EventType, type EventEnvelope } from "@za38/protocol"
import type { ConversationMessage, TimelineItem } from "./state"
import { itemScopeFields, timelineExecutionKey } from "./timeline-identity"
import { fusionSummary } from "./fusion-summary"

export type FusionExecution = {
  taskId: string
  role: "lead" | "sidekick"
  round: number
  model: string
  status: "running" | "completed" | "cancelled" | "failed"
}

const PROCESS_EVENTS = new Set<string>([
  EventType.CONTENT_DELTA, EventType.REASONING_DELTA, EventType.TOOL_STARTED,
  EventType.TOOL_DELTA, EventType.TOOL_COMPLETED,
])

/** 仅开始记录授予该执行在主界面中的展示身份，不能从 agent 名称猜测。 */
export function fusionExecutionIndex(timeline: readonly TimelineItem[]): ReadonlyMap<string, FusionExecution> {
  const result = new Map<string, FusionExecution>()
  for (const item of timeline) {
    if (item.type !== "message" || !item.message.fusionExecution) continue
    result.set(timelineExecutionKey(item.message.runId, item.message.executionId), item.message.fusionExecution)
  }
  return result
}

/** 普通系统说明与用户消息保持独立；过程标记及实际执行记录可归组。 */
export function itemFusionExecution(item: TimelineItem, index: ReadonlyMap<string, FusionExecution>): FusionExecution | undefined {
  if (item.type === "message" && item.message.role !== "assistant" && !item.message.fusionExecution) return undefined
  const identity = itemScopeFields(item)
  return index.get(timelineExecutionKey(identity.runId, identity.executionId))
}

/** 从已校验事件更新角色记录；失败和取消只结束执行，不标记任务验收成功。 */
export function applyFusionExecutionEvent(timeline: TimelineItem[], event: EventEnvelope): TimelineItem[] | null {
  if (PROCESS_EVENTS.has(event.type)) {
    const previous = fusionExecutionIndex(timeline).get(timelineExecutionKey(event.run_id, event.execution_id))
    if (previous && previous.status !== "running") return null
  }
  if (event.type === EventType.RUN_STARTED && event.payload.fusion) {
    const task = event.payload.fusion
    const lead = task.profile.lead as Record<string, unknown> | undefined
    return registerExecution(timeline, event, {
      taskId: task.task_id, role: "lead", round: task.round,
      model: typeof lead?.model === "string" ? lead.model : "未知", status: "running",
    })
  }
  if (event.type === EventType.FUSION_EXECUTION) {
    const payload = event.payload
    const lead = timeline.find(item => item.type === "message"
      && item.message.runId === event.run_id && item.message.executionId === event.parent_execution_id
      && item.message.fusionExecution?.role === "lead" && item.message.fusionExecution.taskId === payload.task_id)
    if (!lead || !event.execution_id || event.execution_id === event.parent_execution_id
      || event.agent_id !== "fusion-sidekick") return timeline
    return registerExecution(timeline, event, {
      taskId: payload.task_id, role: "sidekick", round: payload.round, model: payload.model, status: payload.status,
    })
  }
  if (event.type === EventType.FUSION_PROGRESS) {
    const task = event.payload
    const message: ConversationMessage = {
      id: `fusion-status-${task.task_id}`, role: "system", content: fusionSummary(task), runId: event.run_id,
    }
    const index = timeline.findIndex(item => item.type === "message" && item.message.id === message.id)
    return index < 0 ? [...timeline, { type: "message", message }]
      : timeline.map((item, position) => position === index ? { type: "message", message } : item)
  }
  const status = event.type === EventType.RUN_COMPLETED ? "completed"
    : event.type === EventType.RUN_CANCELLED ? "cancelled"
      : event.type === EventType.RUN_FAILED ? "failed" : undefined
  if (!status) return timeline
  return settleFusionRun(timeline, event.run_id, status)
}

/** Wire 终态与本地连接失败共用收尾；缺少远端结束帧也不能一直显示执行中。 */
export function settleFusionRun(timeline: TimelineItem[], runId: string, status: Exclude<FusionExecution["status"], "running">): TimelineItem[] {
  let next = timeline
  for (const item of timeline) {
    if (item.type !== "message" || item.message.runId !== runId || item.message.fusionExecution?.status !== "running") continue
    next = finishExecution(next, runId, item.message.executionId ?? "root", status)
  }
  return next
}

function registerExecution(timeline: TimelineItem[], event: EventEnvelope, execution: FusionExecution): TimelineItem[] {
  const executionId = event.execution_id ?? "root"
  const id = `fusion-execution-${timelineExecutionKey(event.run_id, executionId)}`
  const existing = timeline.find(item => item.type === "message" && item.message.id === id)
  // 一轮身份冻结；终态之后到达的重复开始或不同结果不能复活执行。
  if (existing?.type === "message") {
    const previous = existing.message.fusionExecution!
    if (previous.status !== "running" || previous.taskId !== execution.taskId
      || previous.role !== execution.role || previous.round !== execution.round || previous.model !== execution.model) return timeline
    return execution.status === "running" ? timeline
      : finishExecution(timeline, event.run_id, executionId, execution.status)
  }
  // 未见开始时不凭结束事件生成一段虚构过程。
  if (execution.status !== "running") return timeline
  return [...timeline, { type: "message", message: {
    id, role: "system", content: "", runId: event.run_id, executionId,
    agentId: event.agent_id, fusionExecution: execution,
  } }]
}

function finishExecution(timeline: TimelineItem[], runId: string, executionId: string, status: FusionExecution["status"]): TimelineItem[] {
  return timeline.map(item => {
    const identity = itemScopeFields(item)
    if (identity.runId !== runId || (identity.executionId ?? "root") !== executionId) return item
    if (item.type === "message") return { ...item, message: {
      ...item.message, streaming: false,
      ...(item.message.fusionExecution ? { fusionExecution: { ...item.message.fusionExecution, status } } : {}),
    } }
    if (item.type === "reasoning") return { ...item, reasoning: { ...item.reasoning, active: false } }
    if (item.type === "tool" && item.tool.status === "running") return { ...item, tool: {
      ...item.tool, status: "failed", output: item.tool.output || (status === "cancelled" ? "执行已取消" : "工具未返回结束状态"),
    } }
    return item
  })
}
