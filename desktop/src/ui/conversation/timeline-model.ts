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
  const parents = new Set(entries.flatMap(entry => entry.kind === "tool" && !entry.parentToolId ? [entry.id] : []))
  const children = new Map<string, ToolEntry[]>()
  for (const entry of entries) {
    if (entry.kind !== "tool" || !entry.parentToolId || !parents.has(entry.parentToolId)) continue
    const siblings = children.get(entry.parentToolId) ?? []
    siblings.push(entry)
    children.set(entry.parentToolId, siblings)
  }
  for (const entry of entries) {
    if (entry.kind === "tool") {
      if (entry.parentToolId && parents.has(entry.parentToolId)) continue
      run.push(entry, ...(children.get(entry.id) ?? []))
    } else {
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

/** 一轮正文前的过程摘要，完成后可带真实耗时与完成时间。 */
export type ProcessSummary = {
  readonly id: string
  readonly label: string
  readonly failedCount: number
  readonly hasThought: boolean
  readonly running: boolean
  readonly completedAtMs?: number
  readonly durationMs?: number
  readonly agentName?: string
}

export type TurnProcessSplit = {
  readonly processSummary: ProcessSummary | null
  readonly processSegments: readonly TimelineSegment[]
  readonly finalEntry?: Extract<ConversationTimelineEntry, { kind: "message" | "extension" }>
}

/** 过程有多段或已有完成信息时收成一行，最终正文留在折叠组外。 */
export function splitTurnProcess(
  entries: readonly ConversationTimelineEntry[],
  activity?: ConversationTimelineActivity | null,
  startedAtMs?: number,
): TurnProcessSplit {
  // 若末尾只跟着追尾思考（reasoning），回溯跳过它们：只要紧邻一条助手回复或扩展交互卡片且其后无工具/审批，
  // 仍把它当作 finalEntry 留在折叠区外，避免最终回答或选择题卡片被吞进“思考过程”。
  let finalIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === "reasoning") continue
    if ((entry.kind === "message" && entry.role === "assistant") || entry.kind === "extension") {
      finalIndex = index
    }
    break
  }
  const finalEntry = finalIndex >= 0
    ? (entries[finalIndex] as Extract<ConversationTimelineEntry, { kind: "message" | "extension" }>)
    : undefined
  const processEntries = finalIndex >= 0
    ? [...entries.slice(0, finalIndex), ...entries.slice(finalIndex + 1)]
    : entries
  const processSegments = segmentAgentEntries(processEntries)
  const turnActive = isTurnActive(entries, activity)
  const completedReply = !turnActive && finalEntry?.kind === "message" ? finalEntry : undefined
  const recordedAtMs = completedReply?.createdAtMs
  const completedAtMs = recordedAtMs !== undefined && Number.isFinite(new Date(recordedAtMs).getTime()) ? recordedAtMs : undefined
  // 历史回复已经记录完成时间，能和紧邻的提问配对时补算耗时。
  const elapsedMs = completedAtMs !== undefined && startedAtMs !== undefined && startedAtMs >= 0 && completedAtMs >= startedAtMs
    ? completedAtMs - startedAtMs : undefined
  const durationMs = completedReply?.runSummary?.durationMs ?? elapsedMs
  if (processSegments.length === 0 || (processSegments.length < 2 && completedAtMs === undefined && durationMs === undefined)) {
    return { processSummary: null, processSegments, finalEntry }
  }
  let thoughtCount = 0
  let toolCount = 0
  let failedCount = 0
  let interactionCount = 0
  let stepRunning = false
  for (const entry of processEntries) {
    if (entry.kind === "reasoning") {
      thoughtCount += 1
      if (entry.active) stepRunning = true
    } else if (entry.kind === "tool") {
      toolCount += 1
      if (entry.status === "failed") failedCount += 1
      if (entry.status === "running") stepRunning = true
    } else if (entry.kind === "interaction-history") {
      interactionCount += 1
    } else if (entry.kind === "message" && entry.role === "assistant" && entry.streaming) {
      stepRunning = true
    }
  }
  const parts: string[] = []
  if (thoughtCount > 0) parts.push(thoughtCount === 1 ? "思考过程" : `思考 ${thoughtCount} 次`)
  if (toolCount > 0) parts.push(`${toolCount} 个操作`)
  if (interactionCount > 0) parts.push(`${interactionCount} 次审批`)
  return {
    processSummary: {
      id: `process:${processEntries[0]!.id}`,
      label: parts.join(" · ") || "执行过程",
      failedCount,
      hasThought: thoughtCount > 0,
      running: turnActive && (!finalEntry || stepRunning),
      completedAtMs,
      durationMs,
      agentName: completedReply?.runSummary?.agentName,
    },
    processSegments,
    finalEntry,
  }
}

/** 锚点刻度项：只含提问本身的折叠文本与时间，不包含回答摘要。 */
export type MinimapItem = {
  readonly entryId: string
  readonly text: string
  readonly createdAtMs?: number
}

/** 每条用户提问产出一个锚点；空白提问没有跳转价值，直接跳过（仅附件时取附件名摘要）。 */
export function deriveMinimapItems(entries: readonly ConversationTimelineEntry[]): MinimapItem[] {
  return entries.flatMap(entry => {
    if (entry.kind !== "message" || entry.role !== "user") return []
    const text = entry.text.replace(/\s+/g, " ").trim()
      || (entry.attachments?.length ? entry.attachments.map(item => item.label).join(" · ") : "")
    return text ? [{ entryId: entry.id, text, createdAtMs: entry.createdAtMs }] : []
  })
}
