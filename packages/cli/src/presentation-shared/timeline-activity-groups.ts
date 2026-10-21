/** Compose/Fusion 活动分组：保持时间顺序，TUI/Web 共用，不持有 reducer 状态。 */

import type {
  ComposeStageId,
  ComposeSummaryCard,
  TimelineItem,
} from "../interactive/state"
import { itemScopeFields } from "../interactive/timeline-identity"
import { fusionExecutionIndex, itemFusionExecution, type FusionExecution } from "../interactive/fusion-execution"

export const COMPOSE_STAGE_LABELS: Record<string, string> = {
  grill: "需求",
  task: "需求",
  spec: "规格",
  plan: "计划",
  implement: "实现",
  verify: "验证",
  requirement: "需求",
  understand: "理解",
  build: "构建",
  review: "检视",
}

/** 一段连续 timeline：要么是无 scope 的扁平项，要么是同一 activity 的分组。 */
export type TimelineSegment =
  | { kind: "flat"; item: TimelineItem }
  | { kind: "group"; group: TimelineActivityGroup }

export type TimelineActivityGroup = {
  /** runId:activityId 稳定键。 */
  key: string
  runId: string
  activityId: string
  executionId?: string
  agentId?: string
  stage?: ComposeStageId
  attempt?: number
  taskId?: string
  taskTitle?: string
  items: TimelineItem[]
  /** 组内 Runtime 摘要（若有）。 */
  summary?: ComposeSummaryCard
  /** 有终态摘要时默认折叠。 */
  terminal: boolean
  /** Fusion 执行事实，角色与轮次来自 Host 的开始记录。 */
  fusion?: FusionExecution
  waitingForSidekick?: boolean
}

/** 无 Compose activity 时返回 null，表示按扁平项渲染（Build 路径）。 */
export function itemActivityKey(item: TimelineItem): string | null {
  const fields = itemScopeFields(item)
  if (!fields.activityId || fields.activityId === "root") return null
  const runId = fields.runId ?? "run"
  return `${runId}:${fields.activityId}`
}

/** 同一轮已有 result 时不再展示 checking，避免完成后还转圈。 */
export function withoutSupersededGoalChecking(timeline: readonly TimelineItem[]): TimelineItem[] {
  const completed = new Set<string>()
  for (const item of timeline) {
    if (item.type === "goal-evaluation" && item.evaluation.phase === "result") {
      completed.add(`${item.evaluation.runId}:${item.evaluation.iteration}`)
    }
  }
  if (completed.size === 0) return [...timeline]
  return timeline.filter(item => {
    if (item.type !== "goal-evaluation" || item.evaluation.phase !== "checking") return true
    return !completed.has(`${item.evaluation.runId}:${item.evaluation.iteration}`)
  })
}

/**
 * 按 Host sequence 顺序把 timeline 切成 flat/group 段。
 * 同一 activity 的连续条目合成一组；中间插入的 root 项打断分组。
 */
export function segmentTimeline(timeline: readonly TimelineItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = []
  const fusion = fusionExecutionIndex(timeline)
  const activeWorkers = new Set(timeline.flatMap(item => item.type === "message"
    && item.message.fusionExecution?.role === "sidekick" && item.message.fusionExecution.status === "running"
    ? [item.message.runId] : []))
  let current: TimelineActivityGroup | null = null

  const flush = () => {
    if (current) {
      segments.push({ kind: "group", group: finalizeGroup(current) })
      current = null
    }
  }

  for (const item of withoutSupersededGoalChecking(timeline)) {
    const execution = itemFusionExecution(item, fusion)
    const fields = itemScopeFields(item)
    const key = execution ? JSON.stringify([fields.runId, "fusion", fields.executionId ?? "root"]) : itemActivityKey(item)
    if (key === null) {
      flush()
      segments.push({ kind: "flat", item })
      continue
    }
    if (!current || current.key !== key) {
      flush()
      current = startGroup(item, key)
      if (execution) {
        current.fusion = execution
        current.waitingForSidekick = execution.role === "lead" && activeWorkers.has(current.runId)
      }
    } else {
      appendToGroup(current, item)
    }
  }
  flush()
  return segments
}

/** Compose 终态默认折叠；Fusion 保留过程可见，用户可手动折叠。 */
export function isGroupExpandedByDefault(group: TimelineActivityGroup): boolean {
  // 同一次会话中不在结束瞬间隐藏用户正在看的过程；用户仍可主动折叠。
  if (group.fusion) return true
  return !group.terminal
}

/** 分组标题文案：阶段 · Task · Agent · attempt。 */
export function activityGroupTitle(group: TimelineActivityGroup): string {
  if (group.fusion) {
    return fusionTitle(group.fusion)
  }
  const stageLabel = group.stage ? (COMPOSE_STAGE_LABELS[group.stage] ?? group.stage) : "活动"
  const parts = [stageLabel]
  if (group.taskTitle) parts.push(group.taskTitle)
  else if (group.taskId) parts.push(group.taskId)
  if (group.agentId) parts.push(group.agentId)
  if (group.attempt && group.attempt > 0) parts.push(`#${group.attempt}`)
  return parts.join(" · ")
}

function fusionTitle(execution: FusionExecution): string {
  const title = `${execution.role === "lead" ? "Lead" : "Sidekick"} · ${execution.model}`
  return execution.role === "sidekick" ? `${title} · 第 ${execution.round} 轮` : title
}

/** 状态行说明当前正在执行的角色；耗时明确属于本次 Run。 */
export function fusionLiveStatusLine(timeline: readonly TimelineItem[], runId: string | undefined, elapsedLabel: string): string | null {
  const live = timeline.flatMap(item => item.type === "message" && item.message.runId === runId
    && item.message.fusionExecution?.status === "running" ? [item.message.fusionExecution] : [])
  const execution = live.findLast(item => item.role === "sidekick") ?? live.findLast(item => item.role === "lead")
  return execution ? `${fusionTitle(execution)} · 执行中 · 本次已运行 ${elapsedLabel}` : null
}

/** 折叠头副标题：摘要或状态。 */
export function activityGroupSubtitle(group: TimelineActivityGroup): string {
  if (group.fusion) {
    const execution = group.fusion
    if (execution.status === "cancelled") return "已取消"
    if (execution.status === "failed") return "执行失败"
    if (execution.status === "completed") return execution.role === "sidekick" ? "本轮执行结束" : "本次运行结束"
    return group.waitingForSidekick ? "等待 Sidekick" : "执行中"
  }
  if (group.summary?.text) return group.summary.text
  if (group.summary?.status) return group.summary.status
  if (group.terminal) return "已结束"
  return "进行中"
}

function startGroup(item: TimelineItem, key: string): TimelineActivityGroup {
  const fields = itemScopeFields(item)
  const scope = fields.composeScope
  const group: TimelineActivityGroup = {
    key,
    runId: fields.runId ?? "run",
    activityId: fields.activityId ?? key,
    executionId: fields.executionId,
    agentId: fields.agentId ?? scope?.stage,
    stage: scope?.stage,
    attempt: scope?.attempt,
    taskId: scope?.taskId,
    taskTitle: scope?.taskTitle,
    items: [item],
    terminal: false,
  }
  if (item.type === "compose-summary") {
    applySummary(group, item.summary)
  }
  return group
}

function appendToGroup(group: TimelineActivityGroup, item: TimelineItem): void {
  group.items.push(item)
  const fields = itemScopeFields(item)
  if (!group.executionId && fields.executionId) group.executionId = fields.executionId
  if (!group.agentId && fields.agentId) group.agentId = fields.agentId
  const scope = fields.composeScope
  if (scope) {
    group.stage = group.stage ?? scope.stage
    group.attempt = group.attempt ?? scope.attempt
    group.taskId = group.taskId ?? scope.taskId
    group.taskTitle = group.taskTitle ?? scope.taskTitle
  }
  if (item.type === "compose-summary") applySummary(group, item.summary)
}

function applySummary(group: TimelineActivityGroup, summary: ComposeSummaryCard): void {
  group.summary = summary
  if (summary.composeScope) {
    group.stage = group.stage ?? summary.composeScope.stage
    group.attempt = group.attempt ?? summary.composeScope.attempt
    group.taskId = group.taskId ?? summary.composeScope.taskId
    group.taskTitle = group.taskTitle ?? summary.composeScope.taskTitle
  }
  group.agentId = group.agentId ?? summary.agentId
  group.executionId = group.executionId ?? summary.executionId
}

function finalizeGroup(group: TimelineActivityGroup): TimelineActivityGroup {
  if (group.fusion) {
    const first = group.items[0]
    const firstId = first?.type === "message" ? first.message.id
      : first?.type === "tool" ? first.tool.id
        : first?.type === "reasoning" ? first.reasoning.id
          : first?.type === "interaction" ? first.interaction.id : "start"
    return {
      ...group,
      // Lead 可能在 Sidekick 之后继续输出。各段保留原位置，且不能共用 React key。
      key: JSON.stringify([group.key, firstId]),
      items: group.items.filter(item => item.type !== "message" || !item.message.fusionExecution),
      terminal: group.fusion.status !== "running",
    }
  }
  const hasTerminalSummary = Boolean(
    group.summary
    && (group.summary.status === "passed"
      || group.summary.status === "failed"
      || group.summary.status === "blocked"
      || group.summary.status === "cancelled"
      || group.summary.status === "truncated"),
  )
  const hasLiveWork = group.items.some(item => {
    if (item.type === "tool" && item.tool.status === "running") return true
    if (item.type === "reasoning" && item.reasoning.active) return true
    if (item.type === "interaction" && item.interaction.status === "pending") return true
    if (item.type === "message" && item.message.streaming) return true
    return false
  })
  return {
    ...group,
    terminal: hasTerminalSummary && !hasLiveWork,
  }
}

/** Compose 活动行文案：Compose · 阶段 · task · agent · 相位 · 耗时。 */
export function composeLiveStatusLine(input: {
  stage?: ComposeStageId | string | null
  taskTitle?: string | null
  agentId?: string | null
  phaseLabel: string
  elapsedLabel: string
}): string {
  const parts = ["Compose"]
  if (input.stage) {
    const stage = String(input.stage)
    parts.push(COMPOSE_STAGE_LABELS[stage as ComposeStageId] ?? stage)
  }
  if (input.taskTitle) parts.push(input.taskTitle)
  if (input.agentId) parts.push(input.agentId)
  parts.push(input.phaseLabel)
  parts.push(`已运行 ${input.elapsedLabel}`)
  return parts.join(" · ")
}
