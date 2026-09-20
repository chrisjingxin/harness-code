/** HC-183 全屏时间线纯投影：把 Interactive Core 条目收敛为可绘制的语义行。 */

import type {
  ComposeSummaryCard,
  ConversationMessage,
  GoalEvaluationCard,
  InteractionCard,
  ReasoningCard,
  TimelineItem,
  ToolCard,
  WorkMode,
} from "../../interactive/state"
import { goalEvaluationTitle, interactionStatusLabel, toolStatusLabel } from "../../presentation-shared/timeline-presenter"
import { COMPOSE_STAGE_LABELS } from "../../presentation-shared/timeline-activity-groups"
import { toolDisplay, toolPrimaryArgument, type ToolDisplayTone } from "../../presentation-shared/tool-display-policy"
import { collapseToolOutput } from "../../presentation-shared/tool-output-policy"
import { boundVisibleText, thinkingVisibleBody } from "../../presentation-shared/paint-budget"
import { formatTerminalMarkdown, sanitizeTerminalText } from "./terminal-markdown"
import { ICON } from "./symbols"

/** 投影的语义色调；渲染端再把 tone 映射到终端颜色。 */
export type FullscreenTone = WorkMode | ToolDisplayTone | "success" | "warning" | "danger"

/** 纯投影上下文；不携带 React、终端控制码或业务回调。 */
export type FullscreenProjectionContext = {
  columns: number
  fallbackWorkMode: WorkMode
  pendingInteractionId?: string
  /** 活动条目的固定宽 spinner；由外层负责定时重绘。 */
  spinnerGlyph?: string
  /** 当前是否有活跃运行；在等待首包时挂起状态条目。 */
  active?: boolean
  activityKind?: string
}

type FullscreenEntryBase<K extends FullscreenEntry["kind"]> = {
  id: string
  kind: K
  /** 主文案已去掉内部英文前缀；Markdown 在投影阶段降级为终端文本。 */
  text: string
  statusLabel: string
  glyph: string
  tone: FullscreenTone
  details: readonly string[]
  runId?: string
  executionId?: string
  activityId?: string
  agentId?: string
  /** 仅 active/running/streaming 条目存在；静态历史不得携带 spinner。 */
  spinnerGlyph?: string
}

export type UserEntry = FullscreenEntryBase<"user"> & {
  workMode: WorkMode
  status: "completed"
}

export type AssistantEntry = FullscreenEntryBase<"assistant"> & {
  status: "streaming" | "completed"
  streaming: boolean
}

export type ReasoningEntry = FullscreenEntryBase<"reasoning"> & {
  status: "active" | "completed"
  active: boolean
  collapsed: boolean
  lineCount?: number
}

export type ToolEntry = FullscreenEntryBase<"tool"> & {
  status: ToolCard["status"]
  toolId: string
  toolName: string
  label: string
  primaryArgument: string | null
  chip?: string | null
  childExecutionId?: string
}

export type ToolGroupEntry = FullscreenEntryBase<"tool-group"> & {
  status: "completed"
  sourceToolIds: readonly string[]
  sourceEntryIds: readonly string[]
  /** sourceToolIds 的别名，方便详情面板按 Tool 身份索引。 */
  toolIds: readonly string[]
  count: number
  failedCount: 0
  label: string
  representativeArgument: string | null
}

export type InteractionResultEntry = FullscreenEntryBase<"interaction-result"> & {
  status: InteractionCard["status"]
  interactionId: string
  interactionType: InteractionCard["type"]
}

export type ComposeSummaryEntry = FullscreenEntryBase<"compose-summary"> & {
  status: ComposeSummaryCard["status"]
  stage?: string
  attempt?: number
  taskId?: string
  taskTitle?: string
}

export type GoalEvaluationEntry = FullscreenEntryBase<"goal-evaluation"> & {
  status: GoalEvaluationCard["phase"]
  iteration: number
  result?: GoalEvaluationCard["result"]
}

export type TimelineActivityEntry = FullscreenEntryBase<"activity"> & {
  status: "running"
}

/** FullscreenProjection 的稳定语义联合；每一项都能独立测量和绘制。 */
export type FullscreenEntry =
  | UserEntry
  | AssistantEntry
  | ReasoningEntry
  | ToolEntry
  | ToolGroupEntry
  | InteractionResultEntry
  | ComposeSummaryEntry
  | GoalEvaluationEntry
  | TimelineActivityEntry

const DEFAULT_SPINNER = "⠋"
const READ_GROUP_TOOLS = new Set(["read_file", "grep", "glob", "ls"])
export const TOOL_DIFF_MAX_LINES = 12
export const TOOL_WRITE_MAX_LINES = 10
export const TOOL_READ_MAX_LINES = 10
export const TOOL_EXEC_MAX_LINES = 8
export const TOOL_LIST_MAX_LINES = 8
const TOOL_OUTPUT_LINES = 8

/**
 * 将 Timeline 投影为稳定的全屏条目。
 *
 * 输入只读；同一输入和上下文每次都会产生相同 id、顺序和正文。
 */
export function projectFullscreenTimeline(
  timeline: readonly TimelineItem[],
  context: FullscreenProjectionContext,
): FullscreenEntry[] {
  const columns = normalizeColumns(context.columns)
  const spinnerGlyph = context.spinnerGlyph ?? DEFAULT_SPINNER
  const entries: FullscreenEntry[] = []

  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]
    if (!item) continue

    if (isCurrentPendingInteraction(item, context.pendingInteractionId)) continue

    if (item.type === "tool" && canGroupTool(item.tool)) {
      const group = collectToolGroup(timeline, index, context.pendingInteractionId)
      if (group.length >= 2) {
        entries.push(projectToolGroup(group, columns))
        index += group.length - 1
        continue
      }
    }

    const entry = projectItem(item, { columns, fallbackWorkMode: context.fallbackWorkMode, spinnerGlyph })
    if (entry) entries.push(entry)
  }

  // 当运行处于 starting/running 态且末尾没有任何活跃的条目（例如等待模型首包中），
  // 追加动态活动条目（⠋ 正在等待响应… · Esc 取消），平滑让位给真实的思考或正文流。
  const isActive = context.active ?? (context.activityKind === "running" || context.activityKind === "starting")
  if (isActive) {
    const hasActiveTail = entries.some(e =>
      (e.kind === "assistant" && e.streaming) ||
      (e.kind === "reasoning" && e.active) ||
      (e.kind === "tool" && e.status === "running")
    )
    if (!hasActiveTail) {
      entries.push({
        id: "activity:active-run",
        kind: "activity",
        text: "",
        status: "running",
        statusLabel: "正在等待响应… · Esc 取消",
        glyph: spinnerGlyph,
        spinnerGlyph,
        tone: context.fallbackWorkMode,
        details: [],
      })
    }
  }

  return entries
}

type ProjectionParts = {
  columns: number
  fallbackWorkMode: WorkMode
  spinnerGlyph: string
}

function projectItem(item: TimelineItem, context: ProjectionParts): FullscreenEntry | null {
  switch (item.type) {
    case "message":
      return item.message.role === "user"
        ? projectUser(item.message, context)
        : projectAssistant(item.message, context)
    case "reasoning":
      return projectReasoning(item.reasoning, context)
    case "tool":
      return projectTool(item.tool, context)
    case "interaction":
      return projectInteraction(item.interaction, context)
    case "compose-summary":
      return projectComposeSummary(item.summary, context)
    case "goal-evaluation":
      return projectGoalEvaluation(item.evaluation, context)
  }
}

function projectUser(message: ConversationMessage, context: ProjectionParts): UserEntry {
  const workMode = message.workMode ?? context.fallbackWorkMode
  return {
    id: `message:${message.id}`,
    kind: "user",
    text: normalizeText(message.content),
    status: "completed",
    statusLabel: "已发送",
    glyph: "›",
    tone: workMode,
    workMode,
    details: [],
    runId: message.runId,
    executionId: message.executionId,
    activityId: message.activityId,
    agentId: message.agentId,
  }
}

function projectAssistant(message: ConversationMessage, context: ProjectionParts): AssistantEntry | null {
  if (!message.streaming && !message.content.trim()) return null
  const streaming = message.streaming === true
  const text = formatTerminalMarkdown(message.content, context.columns)
  return {
    id: `message:${message.id}`,
    kind: "assistant",
    text: text || (streaming ? "" : "已完成"),
    status: streaming ? "streaming" : "completed",
    streaming,
    statusLabel: streaming ? "正在生成" : "已完成",
    glyph: streaming ? context.spinnerGlyph : "·",
    tone: "neutral",
    details: [],
    runId: message.runId,
    executionId: message.executionId,
    activityId: message.activityId,
    agentId: message.agentId,
    ...(streaming ? { spinnerGlyph: context.spinnerGlyph } : {}),
  }
}

function projectReasoning(reasoning: ReasoningCard, context: ProjectionParts): ReasoningEntry {
  const sanitized = sanitizeTerminalText(reasoning.text)
  const allLines = sanitized.split("\n").map(l => l.trim()).filter(Boolean)
  const lineCount = allLines.length

  if (reasoning.active) {
    return {
      id: `reasoning:${reasoning.id}`,
      kind: "reasoning",
      text: sanitized,
      status: "active",
      active: true,
      collapsed: false,
      statusLabel: "正在思考",
      glyph: context.spinnerGlyph,
      spinnerGlyph: context.spinnerGlyph,
      tone: "neutral",
      details: allLines,
      lineCount,
      runId: reasoning.runId,
      executionId: reasoning.executionId,
      activityId: reasoning.activityId,
      agentId: reasoning.agentId,
    }
  }

  const summary = allLines[0] ? (allLines[0].length > 40 ? allLines[0].slice(0, 40) + "…" : allLines[0]) : "思考完毕"
  return {
    id: `reasoning:${reasoning.id}`,
    kind: "reasoning",
    text: summary,
    status: "completed",
    active: false,
    collapsed: true,
    statusLabel: "已完成",
    glyph: "·",
    tone: "neutral",
    details: allLines,
    lineCount,
    runId: reasoning.runId,
    executionId: reasoning.executionId,
    activityId: reasoning.activityId,
    agentId: reasoning.agentId,
  }
}

function tryParseJsonObject(text: string | undefined): Record<string, any> | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object") return parsed
  } catch {}
  return null
}

function computeToolChip(name: string, output: string, argsText?: string): string | null {
  if (!output) return null
  const trimmed = output.trim()
  if (!trimmed) return null

  const parsed = tryParseJsonObject(trimmed)
  if (parsed && typeof parsed === "object") {
    if (parsed.ok === false) {
      return null
    }

    if (name.includes("edit") || name.includes("patch")) {
      const cr = parsed.changed_range
      if (cr && (typeof cr.added_lines === "number" || typeof cr.removed_lines === "number")) {
        const adds = cr.added_lines ?? 0
        const dels = cr.removed_lines ?? 0
        if (adds > 0 || dels > 0) return `+${adds} -${dels}`
      }
      const lines = parsed.line_count ?? parsed.total_lines
      if (typeof lines === "number" && lines > 0) return `${lines} 行`
    }

    if (name.includes("write") || name.includes("create")) {
      const lines = parsed.total_lines ?? parsed.line_count ?? parsed.changed_range?.added_lines
      if (typeof lines === "number" && lines > 0) return `+${lines} 行`
    }

    if (name.includes("read") || name.includes("view")) {
      if (parsed.shown_lines && typeof parsed.shown_lines.start_line === "number" && typeof parsed.shown_lines.end_line === "number") {
        const lines = parsed.shown_lines.end_line - parsed.shown_lines.start_line + 1
        return `${lines} 行`
      }
      const lines = parsed.line_count ?? parsed.total_lines
      if (typeof lines === "number" && lines > 0) return `${lines} 行`
    }

    if (name.includes("delete")) {
      return "已删除"
    }

    if (name.includes("grep") || name.includes("search")) {
      if (Array.isArray(parsed.matches)) return `${parsed.matches.length} 处`
      if (Array.isArray(parsed.items)) return `${parsed.items.length} 处`
    }

    if (name.includes("glob") || name.includes("find") || name.includes("list") || name.includes("ls")) {
      if (Array.isArray(parsed.entries)) return `${parsed.entries.length} 项`
      if (Array.isArray(parsed.items)) return `${parsed.items.length} 项`
    }
  }

  // 非 JSON 或回退文本匹配
  if (name.includes("edit") || name.includes("patch")) {
    const adds = (trimmed.match(/^\+[^+]/gm) || []).length
    const dels = (trimmed.match(/^-[^-]/gm) || []).length
    if (adds > 0 || dels > 0) return `+${adds} -${dels}`
    const lines = trimmed.split("\n").length
    return `${lines} 行`
  }
  if (name.includes("write") || name.includes("create")) {
    const lines = trimmed.split("\n").length
    return `+${lines} 行`
  }
  if (name.includes("read") || name.includes("view")) {
    const lines = trimmed.split("\n").length
    return `${lines} 行`
  }
  if (name.includes("grep") || name.includes("search")) {
    const matches = trimmed.split("\n").filter(Boolean).length
    return matches > 0 ? `${matches} 处` : null
  }
  if (name.includes("glob") || name.includes("find") || name.includes("list") || name.includes("ls")) {
    const items = trimmed.split("\n").filter(Boolean).length
    return `${items} 项`
  }
  return null
}

function formatToolDetails(tool: ToolCard, columns: number): string[] {
  const sanitizedOutput = sanitizeTerminalText(tool.output ?? "")
  const parsed = tryParseJsonObject(sanitizedOutput)

  if (tool.status === "failed") {
    if (parsed && parsed.ok === false) {
      const err = parsed.error
      const code = err?.code ? `[${err.code}] ` : ""
      const msg = err?.message || err?.next_action || "操作失败"
      return [`│ 错误 ${code}${msg}`]
    }
    const collapsed = collapseToolOutput(sanitizedOutput, TOOL_EXEC_MAX_LINES, Math.max(80, columns * TOOL_EXEC_MAX_LINES))
    return toolDetails(collapsed.output, collapsed.overflow)
  }

  if (parsed && typeof parsed === "object") {
    // 1. edit_file: 提取 +/- diff
    if (tool.name.includes("edit") || tool.name.includes("patch")) {
      const args = tryParseJsonObject(tool.arguments)
      if (args && (args.old_string !== undefined || args.new_string !== undefined)) {
        const oldStr = sanitizeTerminalText(String(args.old_string ?? ""))
        const newStr = sanitizeTerminalText(String(args.new_string ?? ""))
        const oldLines = oldStr ? oldStr.split("\n") : []
        const newLines = newStr ? newStr.split("\n") : []

        let prefixLen = 0
        while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
          prefixLen++
        }
        let suffixLen = 0
        while (
          suffixLen < (oldLines.length - prefixLen) &&
          suffixLen < (newLines.length - prefixLen) &&
          oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
        ) {
          suffixLen++
        }

        const removed = oldLines.slice(prefixLen, oldLines.length - suffixLen)
        const added = newLines.slice(prefixLen, newLines.length - suffixLen)
        const diffLines: string[] = []

        for (const line of removed) diffLines.push(`- ${line}`)
        for (const line of added) diffLines.push(`+ ${line}`)

        if (diffLines.length === 0 && (oldLines.length > 0 || newLines.length > 0)) {
          for (const line of oldLines.slice(0, 1)) diffLines.push(`- ${line}`)
          for (const line of newLines.slice(0, 1)) diffLines.push(`+ ${line}`)
        }

        const visible = diffLines.slice(0, TOOL_DIFF_MAX_LINES)
        const result = visible.map(line => `│ ${line}`)
        if (diffLines.length > TOOL_DIFF_MAX_LINES) {
          result.push(`│ … (共 ${diffLines.length} 行变更)`)
        }
        return result
      }

      // 如果未携带 old_string/new_string，提取 content
      if (typeof parsed.content === "string") {
        return formatContentLines(parsed.content, TOOL_DIFF_MAX_LINES, parsed.total_lines)
      }
      return []
    }

    // 2. write_file: 提取写入的新增内容
    if (tool.name.includes("write") || tool.name.includes("create")) {
      const args = tryParseJsonObject(tool.arguments)
      const rawContent = typeof args?.content === "string" ? args.content : (typeof parsed.content === "string" ? parsed.content : null)
      if (rawContent) {
        const cleanContent = sanitizeTerminalText(rawContent)
        const lines = cleanContent.split("\n").filter((l: string, i: number, arr: string[]) => !(i === arr.length - 1 && l === ""))
        const visible = lines.slice(0, TOOL_WRITE_MAX_LINES)
        const result = visible.map(line => `│ + ${line}`)
        const total = parsed.total_lines ?? parsed.line_count ?? lines.length
        if (total > TOOL_WRITE_MAX_LINES) {
          result.push(`│ … (共 ${total} 行)`)
        }
        return result
      }
      return []
    }

    // 3. read_file: 提取带行号的代码
    if (tool.name.includes("read") || tool.name.includes("view")) {
      if (typeof parsed.content === "string") {
        return formatContentLines(parsed.content, TOOL_READ_MAX_LINES, parsed.shown_lines ? (parsed.shown_lines.end_line - parsed.shown_lines.start_line + 1) : parsed.total_lines)
      }
      return []
    }

    // 4. delete_file
    if (tool.name.includes("delete")) {
      return ["│ 文件已删除"]
    }

    // 5. 其他带 entries/items/content 的 JSON
    if (Array.isArray(parsed.entries)) {
      const visible = parsed.entries.slice(0, TOOL_LIST_MAX_LINES)
      const result = visible.map((e: any) => `│ ${sanitizeTerminalText(typeof e === "string" ? e : (e.path || e.name || JSON.stringify(e)))}`)
      if (parsed.entries.length > TOOL_LIST_MAX_LINES) {
        result.push(`│ … (共 ${parsed.entries.length} 项)`)
      }
      return result
    }

    if (typeof parsed.content === "string") {
      return formatContentLines(parsed.content, TOOL_READ_MAX_LINES)
    }

    // 严禁打印裸 JSON
    return []
  }

  // 原始文本输出（如命令执行 stdout/stderr）
  const collapsed = collapseToolOutput(sanitizedOutput, TOOL_EXEC_MAX_LINES, Math.max(80, columns * TOOL_EXEC_MAX_LINES))
  return toolDetails(collapsed.output, collapsed.overflow)
}

function formatContentLines(content: string, maxLines: number, totalCount?: number): string[] {
  const clean = sanitizeTerminalText(content)
  const lines = clean.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""))
  const visible = lines.slice(0, maxLines)
  const result = visible.map(line => {
    const tabIdx = line.indexOf("\t")
    if (tabIdx > 0 && !isNaN(Number(line.slice(0, tabIdx)))) {
      const lineNum = line.slice(0, tabIdx)
      const code = line.slice(tabIdx + 1)
      return `│ ${lineNum.padStart(4)} │ ${code}`
    }
    return `│ ${line}`
  })
  const total = totalCount ?? lines.length
  if (total > maxLines) {
    result.push(`│ … (共 ${total} 行)`)
  }
  return result
}

function projectTool(tool: ToolCard, context: ProjectionParts): ToolEntry {
  const display = toolDisplay(tool.name)
  const rawPrimaryArgument = toolPrimaryArgument(tool.name, tool.arguments, Math.min(72, Math.max(16, context.columns - 18)))
  const primaryArgument = rawPrimaryArgument ? sanitizeTerminalText(rawPrimaryArgument) : null
  const status = tool.status
  const active = status === "running"
  const label = sanitizeTerminalText(display.label)
  const chip = computeToolChip(tool.name, tool.output, tool.arguments)
  const chipSuffix = chip ? ` [${chip}]` : ""
  return {
    id: toolEntryId(tool),
    kind: "tool",
    text: primaryArgument ? `${label} · ${primaryArgument}${chipSuffix}` : `${label}${chipSuffix}`,
    status,
    statusLabel: toolStatusLabel(status),
    glyph: toolGlyph(status, context.spinnerGlyph),
    tone: display.tone,
    details: formatToolDetails(tool, context.columns),
    runId: tool.runId,
    executionId: tool.executionId,
    activityId: tool.activityId,
    agentId: tool.agentId,
    toolId: tool.id,
    toolName: sanitizeTerminalText(tool.name),
    label,
    primaryArgument,
    chip,
    childExecutionId: tool.childExecutionId,
    ...(active ? { spinnerGlyph: context.spinnerGlyph } : {}),
  }
}

function projectToolGroup(tools: readonly ToolCard[], columns: number): ToolGroupEntry {
  const first = tools[0] as ToolCard
  const displayLabels = new Set(tools.map(tool => toolDisplay(tool.name).label))
  const label = displayLabels.size === 1 ? [...displayLabels][0] as string : "读取活动"
  const rawRepresentativeArgument = toolPrimaryArgument(
    first.name,
    first.arguments,
    Math.min(72, Math.max(16, columns - 18)),
  )
  const representativeArgument = rawRepresentativeArgument ? sanitizeTerminalText(rawRepresentativeArgument) : null
  const sourceToolIds = tools.map(tool => tool.id)
  const sourceEntryIds = tools.map(tool => toolEntryId(tool))
  return {
    id: toolEntryId(first),
    kind: "tool-group",
    text: representativeArgument ? `${label} · ${representativeArgument}` : label,
    status: "completed",
    statusLabel: "已完成",
    glyph: ICON.CHECK,
    tone: "read",
    details: tools.slice(0, TOOL_LIST_MAX_LINES).map((tool, idx) => {
      const isLast = idx === Math.min(tools.length, TOOL_LIST_MAX_LINES) - 1 && tools.length <= TOOL_LIST_MAX_LINES
      const prefix = isLast ? "└─" : "├─"
      const rawArgument = toolPrimaryArgument(tool.name, tool.arguments, Math.min(72, Math.max(16, columns - 18)))
      const argument = rawArgument ? sanitizeTerminalText(rawArgument) : null
      return `  ${prefix} ${toolDisplay(tool.name).label}${argument ? ` · ${argument}` : ""}`
    }),
    runId: first.runId,
    executionId: first.executionId,
    activityId: first.activityId,
    agentId: first.agentId,
    sourceToolIds,
    sourceEntryIds,
    toolIds: sourceToolIds,
    count: tools.length,
    failedCount: 0,
    label,
    representativeArgument,
  }
}

function projectInteraction(interaction: InteractionCard, context: ProjectionParts): InteractionResultEntry {
  const statusLabel = interactionStatusLabel(interaction.status)
  const title = interactionTypeLabel(interaction.type)
  const description = interaction.description ?? interaction.question ?? ""
  const tone = interactionTone(interaction.status)
  return {
    id: `interaction:${interaction.runId}:${interaction.id}`,
    kind: "interaction-result",
    text: description ? `${title} · ${normalizeText(description)}` : title,
    status: interaction.status,
    statusLabel,
    glyph: interactionGlyph(interaction.status),
    tone,
    details: [],
    runId: interaction.runId,
    executionId: interaction.executionId,
    activityId: interaction.activityId,
    agentId: interaction.agentId,
    interactionId: interaction.id,
    interactionType: interaction.type,
    ...(interaction.status === "pending" ? { spinnerGlyph: context.spinnerGlyph } : {}),
  }
}

function projectComposeSummary(summary: ComposeSummaryCard, context: ProjectionParts): ComposeSummaryEntry {
  const scope = summary.composeScope
  const stage = scope ? sanitizeTerminalText(COMPOSE_STAGE_LABELS[scope.stage] ?? scope.stage) : undefined
  const statusLabel = composeStatusLabel(summary.status)
  const summaryText = formatTerminalMarkdown(summary.text, context.columns)
  const title = stage ? `Compose · ${stage}` : "Compose"
  return {
    id: `compose-summary:${summary.id}`,
    kind: "compose-summary",
    text: summaryText ? `${title} · ${summaryText}` : title,
    status: summary.status,
    statusLabel,
    glyph: composeGlyph(summary.status),
    tone: composeTone(summary.status),
    details: [],
    runId: summary.runId,
    executionId: summary.executionId,
    activityId: summary.activityId,
    agentId: summary.agentId,
    stage,
    attempt: scope?.attempt,
    taskId: scope?.taskId,
    taskTitle: scope?.taskTitle,
  }
}

function projectGoalEvaluation(evaluation: GoalEvaluationCard, context: ProjectionParts): GoalEvaluationEntry {
  const title = goalEvaluationTitle(evaluation.phase, evaluation.iteration, evaluation.result)
  const explanation = evaluation.explanation ? normalizeText(evaluation.explanation) : ""
  const criteria = evaluation.criteria?.map(criterion => {
    const mark = criterion.passed ? "✓" : "×"
    const text = normalizeText(criterion.text ?? criterion.criterion_id)
    return `${mark} ${text}${criterion.gap ? ` · ${normalizeText(criterion.gap)}` : ""}`
  }) ?? []
  const boundedDetails = boundVisibleText(
    [explanation, ...criteria].filter(Boolean).join("\n"),
    { maxLines: 6, maxChars: Math.max(80, context.columns * 6), keep: "head" },
  )
  const isChecking = evaluation.phase === "checking"
  return {
    id: `goal-evaluation:${evaluation.id}`,
    kind: "goal-evaluation",
    text: title,
    status: evaluation.phase,
    result: evaluation.result,
    iteration: evaluation.iteration,
    statusLabel: isChecking ? "验收中" : goalResultLabel(evaluation.result),
    glyph: isChecking ? context.spinnerGlyph : goalGlyph(evaluation.result),
    tone: isChecking ? "warning" : goalTone(evaluation.result),
    details: boundedDetails.text ? boundedDetails.text.split("\n") : [],
    runId: evaluation.runId,
    ...(isChecking ? { spinnerGlyph: context.spinnerGlyph } : {}),
  }
}

function collectToolGroup(
  timeline: readonly TimelineItem[],
  start: number,
  pendingInteractionId: string | undefined,
): ToolCard[] {
  const first = timeline[start]
  if (!first || first.type !== "tool" || !canGroupTool(first.tool)) return []
  const tools = [first.tool]
  for (let index = start + 1; index < timeline.length; index += 1) {
    const next = timeline[index]
    if (!next || isCurrentPendingInteraction(next, pendingInteractionId)) break
    if (next.type !== "tool" || !canGroupTool(next.tool) || !sameToolScope(first.tool, next.tool)) break
    tools.push(next.tool)
  }
  return tools
}

function canGroupTool(tool: ToolCard): boolean {
  return tool.status === "completed"
    && toolDisplay(tool.name).known
    && toolDisplay(tool.name).tone === "read"
    && READ_GROUP_TOOLS.has(tool.name)
}

function sameToolScope(left: ToolCard, right: ToolCard): boolean {
  return left.runId === right.runId
    && (left.executionId ?? "root") === (right.executionId ?? "root")
    && (left.activityId ?? "root") === (right.activityId ?? "root")
}

function isCurrentPendingInteraction(item: TimelineItem, pendingInteractionId: string | undefined): boolean {
  return item.type === "interaction"
    && item.interaction.status === "pending"
    && item.interaction.id === pendingInteractionId
}

function toolEntryId(tool: ToolCard): string {
  return `tool:${toolEntryIdParts(tool).join(":")}`
}

function toolEntryIdParts(tool: ToolCard): string[] {
  return [tool.runId, tool.executionId ?? "root", tool.activityId ?? "root", tool.id]
}

function toolGlyph(status: ToolCard["status"], spinnerGlyph: string): string {
  if (status === "running") return spinnerGlyph
  return status === "failed" ? "×" : "✓"
}

function toolDetails(output: string, overflow: boolean): string[] {
  if (!output) return overflow ? ["│ 输出已折叠"] : []
  const lines = output.split("\n").map(line => `│ ${line}`)
  if (overflow && !lines.some(line => line === "│ …")) lines.push("│ …")
  return lines
}

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1
}

function normalizeText(text: string): string {
  return sanitizeTerminalText(text)
}

function interactionTypeLabel(type: InteractionCard["type"]): string {
  switch (type) {
    case "approval": return "审批"
    case "question": return "问题"
    case "directory_trust": return "目录信任"
    case "plan": return "计划确认"
    case "goal": return "目标确认"
  }
}

function interactionTone(status: InteractionCard["status"]): FullscreenTone {
  if (status === "rejected" || status === "cancelled") return "danger"
  if (status === "pending") return "warning"
  return "success"
}

function interactionGlyph(status: InteractionCard["status"]): string {
  if (status === "pending") return "?"
  return status === "rejected" || status === "cancelled" ? "×" : "✓"
}

function composeStatusLabel(status: ComposeSummaryCard["status"]): string {
  switch (status) {
    case "passed": return "已通过"
    case "failed": return "失败"
    case "blocked": return "已阻塞"
    case "cancelled": return "已取消"
    case "truncated": return "已截断"
  }
}

function composeGlyph(status: ComposeSummaryCard["status"]): string {
  return status === "passed" ? "✓" : status === "failed" || status === "cancelled" ? "×" : "!"
}

function composeTone(status: ComposeSummaryCard["status"]): FullscreenTone {
  return status === "passed" ? "success" : status === "failed" || status === "cancelled" ? "danger" : "warning"
}

function goalResultLabel(result: GoalEvaluationCard["result"]): string {
  switch (result) {
    case "satisfied": return "验收通过"
    case "needs_revision": return "验收未通过"
    case "max_iterations_reached": return "已达次数上限"
    case "grader_error": return "验收失败"
    case "failed": return "验收失败"
    default: return "已完成"
  }
}

function goalGlyph(result: GoalEvaluationCard["result"]): string {
  return result === "satisfied" ? "✓" : result === "needs_revision" || result === "failed" || result === "grader_error" ? "×" : "!"
}

function goalTone(result: GoalEvaluationCard["result"]): FullscreenTone {
  return result === "satisfied" ? "success" : result === "needs_revision" || result === "failed" || result === "grader_error" ? "danger" : "warning"
}
