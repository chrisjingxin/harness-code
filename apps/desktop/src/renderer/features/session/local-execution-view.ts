/**
 * 本机执行结果到中央对话的投影。装配方按会话持有状态，将已排序、去重的文本更新
 * 交给本模块。这里只归并显示条目，不消费 ACP 帧或云端同步历史。
 */
import type { LocalExecutionPermission, LocalExecutionTool } from "../../../local-execution-host.js"
import type { ConversationTimelineEntry, ConversationToolBlock, ConversationToolDetailView, ConversationViewProps } from "@workbench/ui"

type Message = Extract<ConversationTimelineEntry, { kind: "message" }>
type Tool = Extract<ConversationTimelineEntry, { kind: "tool" }>
type Reasoning = Extract<ConversationTimelineEntry, { kind: "reasoning" }>
type InteractionHistory = Extract<ConversationTimelineEntry, { kind: "interaction-history" }>
type LocalEntry = Message | Tool | Reasoning | InteractionHistory

/** 单个差异块最多展开的行数，超出保留截断提示而不是拖慢渲染。 */
const DIFF_ROW_LIMIT = 400
/** 行级差异上下保留的未改上下文行数，避免只改几行却倾倒整份文件。 */
const DIFF_CONTEXT_LINES = 3
/** 行级 LCS 表规模上限，避免极大文本生成过大二维表。 */
const DIFF_LCS_CELL_LIMIT = 65_536

export type SyncedTurnRange = {
  readonly firstSequence: number
  readonly syncedSequence: number
}

/** 同一账号、项目、设备和会话的本机增量视图。 */
export type LocalExecutionView = {
  readonly activeTurnId: string | null
  readonly activeTurnAssistantMessageId?: string
  readonly entries: readonly LocalEntry[]
  readonly revision: number
  readonly permissionRetryRevision?: number
  readonly permission?: LocalExecutionPermission | null
  readonly failure: string | null
  readonly referenceFailure?: { readonly id: string; readonly message: string }
  readonly uploadFailures?: ReadonlyMap<string, string>
  /** 已确认上传到云端的轮次及其服务端序号区间，用于在增量历史回补时原地去重。 */
  readonly syncedTurnRanges?: Readonly<Record<string, SyncedTurnRange>>
  /** 保留单条工具调用的累计元数据，防止后续仅更新 status/output 时丢失先前 diff 或位置。 */
  readonly toolSnapshots?: Readonly<Record<string, LocalExecutionTool>>
  /** 记录 permission:null 清屏时的条目下标，待 answerPermission 返回确认后在原时间点回插审批历史。 */
  readonly settledPermissionAnchors?: Readonly<Record<string, { readonly turnId: string; readonly entryIndex: number }>>
}

export const emptyLocalExecutionView: LocalExecutionView = {
  activeTurnId: null,
  entries: [],
  revision: 0,
  failure: null,
}

/** 仅供桌面装配使用的显示更新。已明确受理后才追加用户消息。 */
export type LocalExecutionViewUpdate =
  | { readonly kind: "accepted"; readonly turnId: string; readonly text: string; readonly author: Message["author"]; readonly referenceIds?: readonly string[] }
  | { readonly kind: "tool"; readonly turnId: string; readonly tool: LocalExecutionTool }
  | { readonly kind: "assistant-text"; readonly turnId: string; readonly text: string; readonly messageId?: string }
  | { readonly kind: "thought"; readonly turnId: string; readonly text: string }
  | { readonly kind: "permission"; readonly turnId: string; readonly request: LocalExecutionPermission | null }
  | { readonly kind: "permission-decision"; readonly turnId: string; readonly requestId: string; readonly title: string; readonly optionLabel: string; readonly description?: string }
  | { readonly kind: "finished"; readonly turnId: string; readonly failure?: string }
  | { readonly kind: "upload"; readonly turnId: string; readonly failure?: string; readonly firstSequence?: number; readonly syncedSequence?: number }

function finishActiveReasoning(entries: readonly LocalEntry[], entryPrefix: string): readonly LocalEntry[] {
  const reasoningPrefix = `${entryPrefix}:reasoning:`
  let changed = false
  const next = entries.map(entry => {
    if (entry.kind === "reasoning" && entry.id.startsWith(reasoningPrefix) && entry.active) {
      changed = true
      return { ...entry, active: false }
    }
    return entry
  })
  return changed ? next : entries
}

function finishStreamingAssistant(entries: readonly LocalEntry[], entryPrefix: string): readonly LocalEntry[] {
  const assistantPrefix = `${entryPrefix}:assistant`
  let changed = false
  const next = entries.map(entry => {
    if (entry.kind === "message" && entry.role === "assistant" && entry.id.startsWith(assistantPrefix) && entry.streaming) {
      changed = true
      return { ...entry, streaming: false }
    }
    return entry
  })
  return changed ? next : entries
}

function formatLocationSummary(loc: NonNullable<LocalExecutionTool["locations"]>[number] | undefined): string | undefined {
  if (!loc?.path) return undefined
  return loc.line !== undefined ? `${loc.path}:${loc.line}` : loc.path
}

function splitToolTitle(
  rawTitle: string | undefined,
  locations: LocalExecutionTool["locations"],
  diffs: LocalExecutionTool["diffs"],
): { readonly label: string; readonly summary?: string; readonly originalName?: string } {
  const trimmed = rawTitle?.trim()
  if (trimmed) {
    const match = /^([a-z][a-z0-9_:-]*)\s+(.+)$/i.exec(trimmed)
    if (match) {
      return {
        label: match[1]!,
        summary: match[2]!.trim(),
        originalName: trimmed,
      }
    }
    const derivedSummary = formatLocationSummary(locations?.[0]) ?? diffs?.[0]?.path
    return {
      label: trimmed,
      ...(derivedSummary ? { summary: derivedSummary } : {}),
    }
  }
  const fallbackSummary = formatLocationSummary(locations?.[0]) ?? diffs?.[0]?.path
  return {
    label: "Agent 工具",
    ...(fallbackSummary ? { summary: fallbackSummary } : {}),
  }
}

export function applyLocalExecutionUpdate(state: LocalExecutionView, update: LocalExecutionViewUpdate): LocalExecutionView {
  if (update.kind === "upload") {
    const prevFailure = state.uploadFailures?.get(update.turnId)
    const prevRange = state.syncedTurnRanges?.[update.turnId]
    const nextRange = !update.failure && update.firstSequence !== undefined && update.syncedSequence !== undefined
      ? { firstSequence: update.firstSequence, syncedSequence: update.syncedSequence }
      : undefined
    const sameRange = nextRange
      ? prevRange?.firstSequence === nextRange.firstSequence && prevRange?.syncedSequence === nextRange.syncedSequence
      : true
    if (prevFailure === update.failure && sameRange) return state
    const uploadFailures = new Map(state.uploadFailures)
    if (update.failure) uploadFailures.set(update.turnId, update.failure)
    else uploadFailures.delete(update.turnId)
    const syncedTurnRanges = nextRange
      ? { ...state.syncedTurnRanges, [update.turnId]: nextRange }
      : state.syncedTurnRanges
    return { ...state, uploadFailures, ...(syncedTurnRanges ? { syncedTurnRanges } : {}) }
  }
  const entryPrefix = `local-execution:${update.turnId}`
  if (update.kind === "accepted") {
    const id = `${entryPrefix}:user`
    if (state.activeTurnId !== null || state.entries.some(entry => entry.id === id)) return state
    return {
      ...state,
      activeTurnId: update.turnId,
      activeTurnAssistantMessageId: undefined,
      settledPermissionAnchors: undefined,
      entries: [...state.entries, {
        kind: "message", id, role: "user", text: update.text, author: update.author, referenceIds: update.referenceIds, createdAtMs: Date.now(),
      }],
      revision: state.revision + 1,
      failure: null,
      referenceFailure: undefined,
    }
  }

  // permission-decision 可能在 permission:null 清屏甚至 finished 结束本轮之后才从 IPC 调用返回。
  if (update.kind === "permission-decision") {
    const userId = `${entryPrefix}:user`
    if (state.activeTurnId !== update.turnId && !state.entries.some(entry => entry.id === userId)) return state
    const historyId = `${entryPrefix}:interaction:${update.requestId}`
    const nextEntry: InteractionHistory = {
      kind: "interaction-history",
      id: historyId,
      title: update.title,
      statusLabel: update.optionLabel,
      ...(update.description ? { description: update.description } : {}),
    }
    const existing = state.entries.find(entry => entry.id === historyId)
    if (existing?.kind === "interaction-history"
      && existing.statusLabel === nextEntry.statusLabel
      && existing.title === nextEntry.title
      && existing.description === nextEntry.description
      && state.permission?.id !== update.requestId) {
      return state
    }
    const anchor = state.settledPermissionAnchors?.[update.requestId]
    const nextAnchors = anchor
      ? Object.fromEntries(Object.entries(state.settledPermissionAnchors ?? {}).filter(([key]) => key !== update.requestId))
      : state.settledPermissionAnchors
    let entries: readonly LocalEntry[]
    if (existing) {
      entries = state.entries.map(entry => entry.id === historyId ? nextEntry : entry)
    } else if (anchor && anchor.turnId === update.turnId) {
      const insertAt = Math.max(0, Math.min(state.entries.length, anchor.entryIndex))
      entries = [...state.entries.slice(0, insertAt), nextEntry, ...state.entries.slice(insertAt)]
    } else {
      entries = [...state.entries, nextEntry]
    }
    return {
      ...state,
      entries,
      permission: state.permission?.id === update.requestId ? null : state.permission,
      settledPermissionAnchors: nextAnchors && Object.keys(nextAnchors).length > 0 ? nextAnchors : undefined,
      revision: state.revision + 1,
    }
  }

  // 结束后迟到的分段不能重开这轮对话，也不能写进后来开始的另一轮。
  if (state.activeTurnId !== update.turnId) return state

  if (update.kind === "permission") {
    // 审批出现时停止先前的思考扫光与正文光标，避免界面同时在"思考中"和"等审批"。
    const baseEntries = update.request
      ? finishStreamingAssistant(finishActiveReasoning(state.entries, entryPrefix), entryPrefix)
      : state.entries
    const settledPermissionAnchors = update.request === null && state.permission
      ? {
          ...state.settledPermissionAnchors,
          [state.permission.id]: { turnId: update.turnId, entryIndex: baseEntries.length },
        }
      : state.settledPermissionAnchors
    return {
      ...state,
      entries: baseEntries,
      permission: update.request,
      ...(settledPermissionAnchors ? { settledPermissionAnchors } : {}),
      revision: state.revision + Number(baseEntries !== state.entries),
    }
  }

  if (update.kind === "tool") {
    const id = `${entryPrefix}:tool:${update.tool.id}`
    const existing = state.entries.find((item): item is Tool => item.id === id && item.kind === "tool")
    const prevSnapshot = state.toolSnapshots?.[id]
    const mergedTool: LocalExecutionTool = {
      id: update.tool.id,
      title: update.tool.title ?? prevSnapshot?.title,
      status: update.tool.status ?? prevSnapshot?.status,
      kind: update.tool.kind ?? prevSnapshot?.kind,
      input: update.tool.input ?? prevSnapshot?.input,
      output: update.tool.output ?? prevSnapshot?.output,
      diffs: update.tool.diffs ?? prevSnapshot?.diffs,
      locations: update.tool.locations ?? prevSnapshot?.locations,
    }
    const status = update.tool.status
    const detail = mergeToolDetail(existing?.detail, mergedTool)
    const header = splitToolTitle(mergedTool.title, mergedTool.locations, mergedTool.diffs)
    const item: Tool = {
      kind: "tool", id,
      label: header.label,
      ...(header.originalName ? { originalName: header.originalName } : {}),
      ...(header.summary ? { summary: header.summary } : {}),
      tone: toneForKind(mergedTool.kind) ?? existing?.tone ?? "neutral",
      status: status === "completed" || status === "failed" ? status : status ? "running" : existing?.status ?? "running",
      ...(detail ? { detail } : {}),
    }
    // 工具开始即表明本段思考与先发正文暂告一段落，停掉思考扫光与尾部流式光标。
    const settled = finishStreamingAssistant(finishActiveReasoning(state.entries, entryPrefix), entryPrefix)
    const entries = existing ? settled.map(entry => entry.id === id ? item : entry) : [...settled, item]
    return {
      ...state,
      entries,
      toolSnapshots: { ...state.toolSnapshots, [id]: mergedTool },
      revision: state.revision + 1,
    }
  }

  if (update.kind === "thought") {
    if (!update.text) return state
    const settled = finishStreamingAssistant(state.entries, entryPrefix)
    const reasoningPrefix = `${entryPrefix}:reasoning:`
    const last = settled.at(-1)
    const entries = last?.kind === "reasoning" && last.id.startsWith(reasoningPrefix)
      ? settled.map(entry => entry === last ? { ...last, text: last.text + update.text } : entry)
      : [...settled, {
          kind: "reasoning", active: true,
          id: `${reasoningPrefix}${settled.filter(entry => entry.id.startsWith(reasoningPrefix)).length}`,
          text: update.text,
        } satisfies Reasoning]
    return { ...state, entries, revision: state.revision + 1 }
  }

  const assistantPrefix = `${entryPrefix}:assistant`
  if (update.kind === "assistant-text") {
    if (!update.text) return state
    // 模型开始吐出正文后，立即把先前活跃中的思考收束为已完成状态。
    const settled = finishActiveReasoning(state.entries, entryPrefix)
    const last = settled.at(-1)
    const messageIdChanged = update.messageId !== undefined
      && state.activeTurnAssistantMessageId !== undefined
      && update.messageId !== state.activeTurnAssistantMessageId
    const canAppendToTail = last?.kind === "message"
      && last.role === "assistant"
      && last.id.startsWith(assistantPrefix)
      && !messageIdChanged
    let entries: readonly LocalEntry[]
    if (canAppendToTail && last?.kind === "message") {
      entries = settled.map(entry => entry === last ? { ...last, text: last.text + update.text, streaming: true } : entry)
    } else {
      const paused = finishStreamingAssistant(settled, entryPrefix)
      const count = paused.filter(entry => entry.kind === "message" && entry.id.startsWith(assistantPrefix)).length
      const segmentId = count === 0 ? assistantPrefix : `${assistantPrefix}:${count}`
      entries = [...paused, { kind: "message", id: segmentId, role: "assistant", text: update.text, streaming: true } satisfies Message]
    }
    return {
      ...state,
      activeTurnAssistantMessageId: update.messageId ?? state.activeTurnAssistantMessageId,
      entries,
      revision: state.revision + 1,
    }
  }

  if (update.kind !== "finished") return state

  let entries: LocalEntry[] = state.entries.map(entry => {
    if (entry.kind === "message" && entry.id.startsWith(assistantPrefix) && entry.streaming) return { ...entry, streaming: false }
    if (entry.kind === "tool" && entry.id.startsWith(`${entryPrefix}:tool:`) && entry.status === "running") {
      return { ...entry, status: "failed" as const }
    }
    if (entry.kind === "reasoning" && entry.id.startsWith(`${entryPrefix}:reasoning:`) && entry.active) {
      return { ...entry, active: false }
    }
    return entry
  })
  // 轮次结束或被用户取消时，若还有未作答的审批请求，补一条终态历史记录防止悬空。
  if (state.permission) {
    const historyId = `${entryPrefix}:interaction:${state.permission.id}`
    if (!entries.some(entry => entry.id === historyId)) {
      const pendingDesc = describePermissionRequest(state.permission).description
      entries = [...entries, {
        kind: "interaction-history",
        id: historyId,
        title: state.permission.title,
        statusLabel: update.failure === "本轮已停止。" ? "已取消" : "已结束",
        ...(pendingDesc ? { description: pendingDesc } : {}),
      }]
    }
  }
  return {
    ...state,
    activeTurnId: null,
    activeTurnAssistantMessageId: undefined,
    permission: null,
    entries,
    revision: state.revision + Number(entries.length !== state.entries.length || entries.some((entry, idx) => entry !== state.entries[idx])),
    failure: update.failure ?? null,
  }
}

/** kind 到色调：读类灰蓝、写类强调、其余中性；未提供时保留原有色调。 */
function toneForKind(kind: LocalExecutionTool["kind"]): Tool["tone"] | undefined {
  if (kind === "read" || kind === "search" || kind === "fetch") return "read"
  if (kind === "edit" || kind === "delete" || kind === "move") return "write"
  return undefined
}

type DiffOp = { readonly kind: "add" | "remove" | "context"; readonly text: string }

function buildLineDiffOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  let prefix = 0
  const maxPrefix = Math.min(oldLines.length, newLines.length)
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix += 1

  let suffix = 0
  const remainingOld = oldLines.length - prefix
  const remainingNew = newLines.length - prefix
  const maxSuffix = Math.min(remainingOld, remainingNew)
  while (
    suffix < maxSuffix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)
  const middleOps: DiffOp[] = []

  if (oldMid.length === 0 && newMid.length === 0) {
    return oldLines.map(text => ({ kind: "context", text }))
  }
  if (oldMid.length * newMid.length > DIFF_LCS_CELL_LIMIT) {
    for (const text of oldMid) middleOps.push({ kind: "remove", text })
    for (const text of newMid) middleOps.push({ kind: "add", text })
  } else {
    const rows = oldMid.length
    const cols = newMid.length
    const dp = new Uint32Array((rows + 1) * (cols + 1))
    const stride = cols + 1
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        dp[i * stride + j] = oldMid[i] === newMid[j]
          ? dp[(i + 1) * stride + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + (j + 1)]!)
      }
    }
    let i = 0
    let j = 0
    while (i < rows && j < cols) {
      if (oldMid[i] === newMid[j]) {
        middleOps.push({ kind: "context", text: oldMid[i]! })
        i += 1
        j += 1
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
        middleOps.push({ kind: "remove", text: oldMid[i]! })
        i += 1
      } else {
        middleOps.push({ kind: "add", text: newMid[j]! })
        j += 1
      }
    }
    while (i < rows) {
      middleOps.push({ kind: "remove", text: oldMid[i]! })
      i += 1
    }
    while (j < cols) {
      middleOps.push({ kind: "add", text: newMid[j]! })
      j += 1
    }
  }

  return [
    ...oldLines.slice(0, prefix).map(text => ({ kind: "context" as const, text })),
    ...middleOps,
    ...oldLines.slice(oldLines.length - suffix).map(text => ({ kind: "context" as const, text })),
  ]
}

/**
 * 行级上下文差异：用 LCS 对齐未改行，仅保留每处变更上下 3 行上下文，
 * 超出部分折叠为单行 `⋯` 提示，避免大文件局部编辑时整份文件红绿刷屏。
 */
function diffToBlock(diff: NonNullable<LocalExecutionTool["diffs"]>[number]): ConversationToolBlock {
  const hasOld = Boolean(diff.oldText)
  const hasNew = Boolean(diff.newText)
  if (!hasOld || !hasNew) {
    const rows: DiffOp[] = []
    for (const [kind, text] of [["remove", diff.oldText], ["add", diff.newText]] as const) {
      if (!text) continue
      for (const line of text.split("\n")) {
        if (rows.length >= DIFF_ROW_LIMIT) return { kind: "diff", path: diff.path, rows }
        rows.push({ kind, text: line })
      }
    }
    return { kind: "diff", path: diff.path, rows }
  }

  const ops = buildLineDiffOps(diff.oldText!.split("\n"), diff.newText.split("\n"))
  const keep = new Array<boolean>(ops.length).fill(false)
  let hasChange = false
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind === "context") continue
    hasChange = true
    const start = Math.max(0, i - DIFF_CONTEXT_LINES)
    const end = Math.min(ops.length - 1, i + DIFF_CONTEXT_LINES)
    for (let k = start; k <= end; k += 1) keep[k] = true
  }
  if (!hasChange) return { kind: "diff", path: diff.path, rows: [] }

  const rows: DiffOp[] = []
  let skipping = false
  for (let i = 0; i < ops.length; i += 1) {
    if (keep[i]) {
      if (rows.length >= DIFF_ROW_LIMIT) break
      rows.push(ops[i]!)
      skipping = false
    } else if (!skipping) {
      if (rows.length >= DIFF_ROW_LIMIT) break
      rows.push({ kind: "context", text: "⋯" })
      skipping = true
    }
  }
  return { kind: "diff", path: diff.path, rows }
}

function formatDiffCopyText(diffs: readonly NonNullable<LocalExecutionTool["diffs"]>[number][]): string | undefined {
  if (diffs.length === 0) return undefined
  return diffs.map(diff => {
    const block = diffToBlock(diff)
    const header = `--- a/${diff.path}\n+++ b/${diff.path}`
    if (block.kind !== "diff" || block.rows.length === 0) return header
    const lines = block.rows.map(row =>
      row.kind === "add" ? `+${row.text}` : row.kind === "remove" ? `-${row.text}` : row.text === "⋯" ? "@@ ... @@" : ` ${row.text}`,
    )
    return [header, ...lines].join("\n")
  }).join("\n\n")
}

/** 增量更新按字段合并进已有细节；同时保留 diff 块与文本输出，缺失纯文本输出时提供 diff 复制文本。 */
function mergeToolDetail(existing: ConversationToolDetailView | undefined, tool: LocalExecutionTool): ConversationToolDetailView | undefined {
  const argumentsText = tool.input ?? existing?.argumentsText
  const outputText = tool.output ?? existing?.outputText
  const diffBlocks = tool.diffs?.length ? tool.diffs.map(diffToBlock) : undefined
  const blocks: readonly ConversationToolBlock[] | undefined = diffBlocks
    ? (outputText !== undefined && outputText.length > 0 ? [...diffBlocks, { kind: "text", text: outputText }] : diffBlocks)
    : existing?.blocks
  const copyText = outputText ?? (tool.diffs?.length ? formatDiffCopyText(tool.diffs) : undefined) ?? existing?.copyText
  const extension = existing?.extension
  if (argumentsText === undefined && outputText === undefined && copyText === undefined && blocks === undefined && extension === undefined) {
    return undefined
  }
  return {
    ...(argumentsText !== undefined ? { argumentsText } : {}),
    ...(outputText !== undefined ? { outputText } : {}),
    ...(copyText !== undefined ? { copyText } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    ...(extension !== undefined ? { extension } : {}),
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))
}

/** 从权限请求携带的工具详情投影审批说明与差异/参数预览块，避免弹窗只有干瘪标题。 */
export function describePermissionRequest(permission: LocalExecutionPermission): {
  readonly description?: string
  readonly blocks: readonly ConversationToolBlock[]
} {
  const tool = permission.tool
  if (!tool) return { blocks: [] }
  const descParts: string[] = []
  const primaryLocation = formatLocationSummary(tool.locations?.[0]) ?? tool.diffs?.[0]?.path
  if (primaryLocation) {
    const extraCount = (tool.locations?.length ?? 0) > 1 ? ` 等 ${tool.locations!.length} 处` : ""
    descParts.push(`涉及路径：${primaryLocation}${extraCount}`)
  }
  if (tool.kind) descParts.push(`操作类型：${tool.kind}`)
  const blocks: ConversationToolBlock[] = []
  if (tool.diffs?.length) {
    for (const diff of tool.diffs) blocks.push(diffToBlock(diff))
  }
  if (tool.input) {
    blocks.push({ kind: looksLikeJson(tool.input) ? "json" : "text", text: tool.input })
  }
  if (tool.output) {
    blocks.push({ kind: "text", text: tool.output })
  }
  return {
    ...(descParts.length ? { description: descParts.join(" · ") } : {}),
    blocks,
  }
}

type ConversationExecutionProps = Pick<ConversationViewProps, "entries" | "contentRevision" | "composer" | "activity">

function extractTurnId(entryId: string): string | null {
  const match = /^local-execution:([^:]+):/.exec(entryId)
  return match?.[1] ?? null
}

function extractHistorySequence(entryId: string): number | null {
  const match = /^seq-(\d+)(?:$|:)/.exec(entryId)
  return match ? Number(match[1]) : null
}

/**
 * 在已有历史之后展示会话本机增量。装配方保证两组条目没有重复，并保留
 * 宿主给出的发送可用性。已确认上传落盘的轮次在历史切片到达后原地替换 seq 条目，
 * 既消除双份消息又保留本机的思考/工具/审批详情及时间顺序。
 */
export function projectLocalExecution(
  base: Omit<ConversationExecutionProps, "activity">,
  execution: LocalExecutionView,
): ConversationExecutionProps {
  const running = execution.activeTurnId !== null
  const canCancel = base.composer.cancel.enabled
    && (base.composer.primaryActions === "cancel" || base.composer.primaryActions === "both")

  let entries: readonly ConversationTimelineEntry[]
  const ranges = execution.syncedTurnRanges ? Object.entries(execution.syncedTurnRanges) : []
  if (!execution.entries.length) {
    entries = base.entries
  } else if (!ranges.length || !base.entries.length) {
    entries = [...base.entries, ...execution.entries]
  } else {
    const byTurn = new Map<string, LocalEntry[]>()
    for (const entry of execution.entries) {
      const turnId = extractTurnId(entry.id)
      if (!turnId) continue
      const list = byTurn.get(turnId) ?? []
      list.push(entry)
      byTurn.set(turnId, list)
    }
    const emittedTurns = new Set<string>()
    const merged: ConversationTimelineEntry[] = []
    for (const entry of base.entries) {
      const seq = extractHistorySequence(entry.id)
      const matched = seq !== null
        ? ranges.find(([, range]) => seq >= range.firstSequence && seq <= range.syncedSequence)?.[0]
        : undefined
      if (matched && byTurn.has(matched)) {
        if (!emittedTurns.has(matched)) {
          merged.push(...byTurn.get(matched)!)
          emittedTurns.add(matched)
        }
        continue
      }
      merged.push(entry)
    }
    const appendedTurns = new Set<string>()
    for (const entry of execution.entries) {
      const turnId = extractTurnId(entry.id)
      if (!turnId || (!emittedTurns.has(turnId) && !appendedTurns.has(turnId))) {
        if (turnId) {
          merged.push(...(byTurn.get(turnId) ?? []))
          appendedTurns.add(turnId)
        } else {
          merged.push(entry)
        }
      }
    }
    entries = merged
  }

  return {
    entries,
    contentRevision: base.contentRevision + execution.revision,
    activity: running ? { active: true, label: "Agent 正在回复" } : null,
    composer: {
      ...base.composer,
      send: running ? { enabled: false, reason: "等待当前回复完成" } : base.composer.send,
      primaryActions: running && canCancel ? "cancel" : base.composer.primaryActions,
      statusText: execution.failure ?? execution.uploadFailures?.values().next().value ?? base.composer.statusText,
    },
  }
}
