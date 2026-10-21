/** 时间线条目的执行归属；reducer 与两种界面使用同一提取规则。 */
import type { ComposeScopeMeta, TimelineItem } from "./state"

export type TimelineIdentityFields = {
  runId?: string
  executionId?: string
  activityId?: string
  agentId?: string
  composeScope?: ComposeScopeMeta
}

/** 提取已有的身份字段，不根据工具名称或模型输出推测归属。 */
export function itemScopeFields(item: TimelineItem): TimelineIdentityFields {
  if (item.type === "tool") return item.tool
  if (item.type === "reasoning") return item.reasoning
  if (item.type === "message") return item.message
  if (item.type === "interaction") return item.interaction
  if (item.type === "goal-evaluation") return { runId: item.evaluation.runId }
  return item.summary
}

/** 使用元组编码，避免 ID 中含冒号时发生跨 Run/执行碰撞。 */
export function timelineExecutionKey(runId: string | undefined, executionId: string | undefined): string {
  return JSON.stringify([runId ?? "", executionId ?? "root"])
}
