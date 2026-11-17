/**
 * 时间线分段的纯函数：把同一 Agent 组里相邻的工具合成一组，判断一轮是否还在进行。
 *
 * 分段只改变展示结构，不改条目顺序与 id；个人展开状态仍按组首工具 id 派生的 key 记录。
 */
import type { ConversationTimelineActivity, ConversationTimelineEntry } from "./types.js"

type ToolEntry = Extract<ConversationTimelineEntry, { kind: "tool" }>

/** 渲染段：非工具条目原样通过；连续工具收成一组。 */
export type TimelineSegment =
  | { readonly kind: "entry"; readonly entry: ConversationTimelineEntry }
  | { readonly kind: "tool-group"; readonly id: string; readonly tools: readonly ToolEntry[] }

/** 同一 Agent 组内连续 ≥2 个工具合成一段；分段 id 由首个工具 id 派生，供个人状态引用。 */
export function segmentAgentEntries(entries: readonly ConversationTimelineEntry[]): TimelineSegment[] {
  const segments: TimelineSegment[] = []
  let run: ToolEntry[] = []
  const flush = () => {
    if (run.length >= 2) segments.push({ kind: "tool-group", id: `group:${run[0].id}`, tools: run })
    else for (const tool of run) segments.push({ kind: "entry", entry: tool })
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === "tool") run.push(entry)
    else {
      flush()
      segments.push({ kind: "entry", entry })
    }
  }
  flush()
  return segments
}

/** 一轮进行中的判定：有活动推理、流式回答、运行中工具，或末组仍报活动。 */
export function isTurnActive(entries: readonly ConversationTimelineEntry[], activity?: ConversationTimelineActivity | null): boolean {
  if (activity?.active) return true
  return entries.some(entry =>
    (entry.kind === "reasoning" && entry.active)
    || (entry.kind === "tool" && entry.status === "running")
    || (entry.kind === "message" && entry.role === "assistant" && Boolean(entry.streaming)),
  )
}

/** 锚点刻度项：只含提问本身的折叠文本与时间，不包含回答摘要。 */
export type MinimapItem = {
  readonly entryId: string
  readonly text: string
  readonly createdAtMs?: number
}

/** 每条用户提问产出一个锚点；空白提问没有跳转价值，直接跳过。 */
export function deriveMinimapItems(entries: readonly ConversationTimelineEntry[]): MinimapItem[] {
  return entries.flatMap(entry => {
    if (entry.kind !== "message" || entry.role !== "user") return []
    const text = entry.text.replace(/\s+/g, " ").trim()
    return text ? [{ entryId: entry.id, text, createdAtMs: entry.createdAtMs }] : []
  })
}
