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
}

export type ToolEntry = FullscreenEntryBase<"tool"> & {
  status: ToolCard["status"]
  toolId: string
  toolName: string
  label: string
  primaryArgument: string | null
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

const DEFAULT_SPINNER = "⠋"
const READ_GROUP_TOOLS = new Set(["read_file", "grep", "glob", "ls"])
const TOOL_OUTPUT_LINES = 3

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
  const bounded = thinkingVisibleBody(sanitized, reasoning.active ? "live" : "collapsed")

  if (reasoning.active) {
    return {
      id: `reasoning:${reasoning.id}`,
      kind: "reasoning",
      text: bounded.text,
      status: "active",
      active: true,
      collapsed: false,
      statusLabel: "正在思考",
      glyph: context.spinnerGlyph,
      spinnerGlyph: context.spinnerGlyph,
      tone: "neutral",
      details: bounded.overflow ? ["思考内容较长，已保留有界预览"] : [],
      runId: reasoning.runId,
      executionId: reasoning.executionId,
      activityId: reasoning.activityId,
      agentId: reasoning.agentId,
    }
  }

  const lines = sanitized.split("\n").map(l => l.trim()).filter(Boolean)
  const firstLine = lines[0] ?? ""
  return {
    id: `reasoning:${reasoning.id}`,
    kind: "reasoning",
    text: firstLine,
    status: "completed",
    active: false,
    collapsed: true,
    statusLabel: "已完成",
    glyph: "·",
    tone: "neutral",
    details: lines.slice(1),
    runId: reasoning.runId,
    executionId: reasoning.executionId,
    activityId: reasoning.activityId,
    agentId: reasoning.agentId,
  }
}

function computeToolChip(name: string, output: string): string | null {
  if (!output) return null
  const trimmed = output.trim()
  if (!trimmed) return null
  if (name.includes("edit") || name.includes("patch")) {
    const adds = (trimmed.match(/^\+[^+]/gm) || []).length
    const dels = (trimmed.match(/^-[^-]/gm) || []).length
    if (adds > 0 || dels > 0) return `+${adds} -${dels}`
    const lines = trimmed.split("\n").length
    return `${lines} 行`
  }
  if (name.includes("write") || name.includes("create")) {
    const lines = trimmed.split("\n").length
    return `${lines} 行`
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

function projectTool(tool: ToolCard, context: ProjectionParts): ToolEntry {
  const display = toolDisplay(tool.name)
  const rawPrimaryArgument = toolPrimaryArgument(tool.name, tool.arguments, Math.min(72, Math.max(16, context.columns - 18)))
  const primaryArgument = rawPrimaryArgument ? sanitizeTerminalText(rawPrimaryArgument) : null
  const status = tool.status
  const active = status === "running"
  const collapsed = collapseToolOutput(sanitizeTerminalText(tool.output), TOOL_OUTPUT_LINES, Math.max(80, context.columns * TOOL_OUTPUT_LINES))
  const label = sanitizeTerminalText(display.label)
  const chip = computeToolChip(tool.name, tool.output)
  const chipSuffix = chip ? ` [${chip}]` : ""
  return {
    id: toolEntryId(tool),
    kind: "tool",
    text: primaryArgument ? `${label} · ${primaryArgument}${chipSuffix}` : `${label}${chipSuffix}`,
    status,
    statusLabel: toolStatusLabel(status),
    glyph: toolGlyph(status, context.spinnerGlyph),
    tone: display.tone,
    details: toolDetails(collapsed.output, collapsed.overflow),
    runId: tool.runId,
    executionId: tool.executionId,
    activityId: tool.activityId,
    agentId: tool.agentId,
    toolId: tool.id,
    toolName: sanitizeTerminalText(tool.name),
    label,
    primaryArgument,
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
    details: tools.slice(0, TOOL_OUTPUT_LINES).map((tool, idx) => {
      const isLast = idx === Math.min(tools.length, TOOL_OUTPUT_LINES) - 1 && tools.length <= TOOL_OUTPUT_LINES
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
