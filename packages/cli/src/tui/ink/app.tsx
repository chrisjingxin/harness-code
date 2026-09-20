/** Ink 6.8 全屏 TUI：应用自持有时间线视口与固定底部交互区。 */
/** @jsxImportSource react */
import { Box, Text, render, useInput, useStdout, type Key } from "ink"
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"

import type { TimelineItem } from "../../interactive/state"
import type { InteractiveController } from "../../interactive/types"
import type { AgentGateway } from "../../interactive/ports"
import type { WorkspaceExplorer } from "../../workspace/types"
import type { PresentationCoordinator } from "../../presentation-coordinator"
import { detectGitChangedFiles } from "../../infrastructure/git-workspace"
import { createTuiAdapter, type TuiAdapter, type TuiAdapterSnapshot } from "../application/adapter"
import { resolveShortcut, type ShortcutAction, type ShortcutContext, type TemporaryViewKind } from "../application/shortcuts"
import { createInputBuffer, inputBufferReducer, type InputBufferAction } from "./input-buffer"
import { isInkBackspace, isInkMouseReport, stripMouseReports } from "./input-key"
import { InteractionBottomArea } from "./bottom-area"
import { activePickerKind, InlineMenus } from "./menus"
import { TemporaryView } from "./temporary-view"
import { bottomAreaKind } from "../../presentation-shared/interaction-policy"
import { createTerminalSession, parseMouseWheelInput } from "./terminal-session"
import {
  applyViewportAction,
  createViewportState,
  layoutViewport,
  updateViewport,
  type TimelineViewportAction,
  type TimelineViewportRow,
} from "./timeline-viewport"
import {
  FullscreenFooter,
  FullscreenHeader,
  FullscreenInputBar,
  FullscreenWelcome,
  TOAST_VIEWPORT_ROWS,
  ToastViewport,
  fullscreenInputRows,
} from "./fullscreen-shell"
import { modeAccent, tuiTheme } from "../presentation/theme"
import {
  projectFullscreenTimeline,
  type FullscreenEntry,
  type FullscreenTone,
  type ToolEntry,
} from "./fullscreen-projection"
import { highlightCodeLine, wrapText } from "./terminal-markdown"
import { useActivitySpinner } from "./activity-spinner"
import { ICON } from "./symbols"

const STABLE_SPINNER_GLYPH = ICON.SPINNER

function formatActiveReasoning(text: string, glyph: string, statusLabel: string, columns = 80): string {
  const header = `${glyph} \u001b[38;5;176;3m${statusLabel}…\u001b[0m`
  const trimmed = text.trim()
  if (!trimmed) return header

  const contentWidth = Math.max(20, columns - 6)
  const rawLines = trimmed.split("\n").map(l => l.trim()).filter(Boolean)
  if (rawLines.length === 0) return header

  const wrappedLines: string[] = []
  for (const line of rawLines) {
    wrappedLines.push(...wrapText(line, contentWidth))
  }

  const MAX_LIVE_THINKING_LINES = 4
  const visibleLines = wrappedLines.slice(-MAX_LIVE_THINKING_LINES)

  const body = visibleLines
    .map(line => `  \u001b[90m│\u001b[0m \u001b[3;90m${line}\u001b[0m`)
    .join("\n")

  return `${header}\n${body}`
}

/** 把一个语义条目收敛为 viewport 可测量文本；活动 glyph 固定宽度且不参与新内容计数。 */
function fullscreenEntryText(entry: FullscreenEntry, columns = 80): string {
  const glyph = entry.spinnerGlyph ? STABLE_SPINNER_GLYPH : entry.glyph
  const details = entry.details.length > 0 ? `\n${entry.details.join("\n")}` : ""
  switch (entry.kind) {
    case "user": {
      const accent = entry.tone === "compose" ? "\u001b[38;5;141m" : "\u001b[38;5;214m"
      return `${accent}▎\u001b[0m \u001b[38;5;221m${ICON.SPARKLE}\u001b[0m \u001b[1m${entry.text}\u001b[0m`
    }
    case "assistant": return entry.streaming
      ? `${glyph} \u001b[38;5;75m${entry.statusLabel}…\u001b[0m${entry.text ? `\n${entry.text}` : ""}`
      : entry.text
    case "reasoning": {
      if (entry.active) {
        return formatActiveReasoning(entry.text, glyph, entry.statusLabel, columns)
      }
      const countSuffix = entry.lineCount && entry.lineCount > 1 ? ` (共 ${entry.lineCount} 行)` : ""
      return `\u001b[38;5;176m◆\u001b[0m \u001b[90m思考完成 · ${entry.text}${countSuffix}\u001b[0m`
    }
    case "activity": return `${glyph} \u001b[38;5;75m${entry.statusLabel}\u001b[0m`
    case "tool": return renderFullscreenToolEntry(entry, glyph)
    case "tool-group": return `${glyph} \u001b[38;5;75m${entry.text}\u001b[0m · \u001b[90m${entry.count} 项 · ${entry.statusLabel}\u001b[0m${details}`
    case "interaction-result": return `${glyph} \u001b[1m${entry.text}\u001b[0m · \u001b[90m${entry.statusLabel}\u001b[0m${details}`
    case "compose-summary": return `${glyph} \u001b[38;5;141m${entry.text}\u001b[0m · \u001b[90m${entry.statusLabel}\u001b[0m${details}`
    case "goal-evaluation": return `${glyph} \u001b[1m${entry.text}\u001b[0m · \u001b[90m${entry.statusLabel}\u001b[0m${details}`
  }
}

function renderFullscreenToolEntry(entry: ToolEntry, glyph: string): string {
  const toneColors = toolToneColor(entry.tone)
  const isFailed = entry.status === "failed"
  const isRunning = entry.status === "running"

  const coloredGlyph = isFailed
    ? `\u001b[38;5;203m×\u001b[0m`
    : `${toneColors.glyphColor}${glyph}\u001b[0m`

  const labelText = entry.label || entry.toolName || entry.text
  const coloredLabel = `${toneColors.labelColor}${labelText}\u001b[0m`

  const coloredArg = entry.primaryArgument
    ? ` \u001b[90m·\u001b[0m ${entry.tone === "execute" ? `\u001b[38;5;223m${entry.primaryArgument}\u001b[0m` : `\u001b[1;37m${entry.primaryArgument}\u001b[0m`}`
    : ""

  const coloredChip = formatColoredChip(entry.chip)

  const coloredStatus = isFailed
    ? `\u001b[38;5;203m${entry.statusLabel}\u001b[0m`
    : isRunning
      ? `\u001b[38;5;75m${entry.statusLabel}…\u001b[0m`
      : `\u001b[90m${entry.statusLabel}\u001b[0m`

  const header = `${coloredGlyph} ${coloredLabel}${coloredArg}${coloredChip} · ${coloredStatus}`

  if (entry.details.length === 0) return header

  const ext = extractExtension(entry.primaryArgument)
  const formattedDetails = entry.details.map(line => formatDetailLine(line, ext)).join("\n")

  return `${header}\n${formattedDetails}`
}

function formatColoredChip(chip: string | null | undefined): string {
  if (!chip) return ""
  const diffMatch = chip.match(/^\+(\d+)\s+-(\d+)$/)
  if (diffMatch) {
    return ` [\u001b[38;5;114m+${diffMatch[1]}\u001b[0m \u001b[38;5;203m-${diffMatch[2]}\u001b[0m]`
  }
  if (chip.startsWith("+")) {
    return ` [\u001b[38;5;114m${chip}\u001b[0m]`
  }
  if (chip === "已删除") {
    return ` [\u001b[38;5;203m已删除\u001b[0m]`
  }
  return ` [\u001b[38;5;75m${chip}\u001b[0m]`
}

function toolToneColor(tone: FullscreenTone): { glyphColor: string; labelColor: string } {
  switch (tone) {
    case "execute":
      return { glyphColor: "\u001b[38;5;214m", labelColor: "\u001b[38;5;214;1m" } // 琥珀/金黄
    case "write":
      return { glyphColor: "\u001b[38;5;114m", labelColor: "\u001b[38;5;114;1m" } // 翡翠/翠绿
    case "delete":
      return { glyphColor: "\u001b[38;5;203m", labelColor: "\u001b[38;5;203;1m" } // 玫瑰/警示红
    case "read":
      return { glyphColor: "\u001b[38;5;75m", labelColor: "\u001b[38;5;75;1m" }   // 青空/天蓝
    default:
      return { glyphColor: "\u001b[38;5;141m", labelColor: "\u001b[38;5;141;1m" } // 淡紫
  }
}

function extractExtension(filePath: string | null | undefined): string {
  if (!filePath) return "code"
  const dot = filePath.lastIndexOf(".")
  if (dot >= 0 && dot < filePath.length - 1) {
    return filePath.slice(dot + 1).toLowerCase()
  }
  return "code"
}

function formatDetailLine(line: string, ext: string): string {
  if (line.startsWith("│ - ")) {
    return `  \u001b[90m│\u001b[0m \u001b[38;5;203m- ${line.slice(4)}\u001b[0m`
  }
  if (line.startsWith("│ + ")) {
    const code = line.slice(4)
    const highlighted = highlightCodeLine(code, ext)
    return `  \u001b[90m│\u001b[0m \u001b[38;5;114m+ \u001b[0m${highlighted}`
  }
  const lineNumMatch = line.match(/^│\s*(\d+)\s*│\s*(.*)$/)
  if (lineNumMatch) {
    const num = lineNumMatch[1]!
    const code = lineNumMatch[2]!
    const highlighted = highlightCodeLine(code, ext)
    return `  \u001b[90m│\u001b[0m \u001b[90m${num.padStart(4)} │ \u001b[0m${highlighted}`
  }
  if (line.startsWith("│ …")) {
    return `  \u001b[90m│\u001b[0m \u001b[90m${line.slice(2).trim()}\u001b[0m`
  }
  if (line.startsWith("│ 错误")) {
    return `  \u001b[90m│\u001b[0m \u001b[38;5;203m${line.slice(2).trim()}\u001b[0m`
  }
  if (line.startsWith("│ 文件已删除")) {
    return `  \u001b[90m│\u001b[0m \u001b[38;5;203m- 文件已删除\u001b[0m`
  }
  return `  \u001b[90m│\u001b[0m ${line.startsWith("│ ") ? line.slice(2) : line}`
}

function formatViewportEntryText(entry: FullscreenEntry, index: number, total: number, columns = 80): string {
  const raw = fullscreenEntryText(entry, columns).replace(/\n+$/, "")
  return index < total - 1 ? `${raw}\n` : raw
}

function fullscreenToneColor(tone: FullscreenTone): string | undefined {
  switch (tone) {
    case "build":
    case "compose": return modeAccent(tone)
    case "success": return tuiTheme.success
    case "warning":
    case "execute": return tuiTheme.warning
    case "danger":
    case "delete": return tuiTheme.danger
    case "write": return tuiTheme.success
    case "read": return tuiTheme.muted
    case "neutral": return undefined
  }
}

function ActiveSpinnerGlyph() {
  return <Text>{useActivitySpinner(true)}</Text>
}

export type TuiOptions = {
  controller: InteractiveController
  gateway?: AgentGateway
  workspaceExplorer?: WorkspaceExplorer
  resume?: boolean
  promptHistoryFile?: string
  openWeb?: (threadId: string | null) => Promise<void>
  webHandoff?: PresentationCoordinator
}

export type InkInputResolution =
  | { type: "buffer"; action: InputBufferAction }
  | { type: "submit" }
  | { type: "history"; direction: "previous" | "next" }
  | { type: "viewport"; action: "page-up" | "page-down" | "top" | "bottom" }
  | { type: "shortcut"; action: ShortcutAction }
  | { type: "ignore" }

function toKeyLike(input: string, key: Key): { name: string; ctrl: boolean; shift?: boolean } {
  let name = input.toLowerCase()
  if (key.return) name = "return"
  else if (key.escape) name = "escape"
  else if (key.tab) name = "tab"
  else if (key.upArrow) name = "up"
  else if (key.downArrow) name = "down"
  else if (key.leftArrow) name = "left"
  else if (key.rightArrow) name = "right"
  else if (key.pageUp) name = "pageup"
  else if (key.pageDown) name = "pagedown"
  else if (key.home) name = "home"
  else if (key.end) name = "end"
  else if (isInkBackspace(key)) name = "backspace"
  return { name, ctrl: Boolean(key.ctrl), shift: Boolean(key.shift) }
}

/** 将 Ink 键事件收敛为 InputBuffer 或现有 Adapter intent。 */
export function resolveInkInput(
  input: string,
  key: Key,
  context: ShortcutContext & { multiline?: boolean },
): InkInputResolution {
  if (key.eventType === "release") return { type: "ignore" }
  if (isInkMouseReport(input)) return { type: "ignore" }
  const cleanInput = stripMouseReports(input)
  if (!cleanInput && input) return { type: "ignore" }
  const shortcut = resolveShortcut(toKeyLike(cleanInput || input, key), context)
  if (shortcut !== "none") return { type: "shortcut", action: shortcut }
  if (key.pageUp) return { type: "viewport", action: "page-up" }
  if (key.pageDown) return { type: "viewport", action: "page-down" }
  if (key.ctrl && key.home) return { type: "viewport", action: "top" }
  if (key.ctrl && key.end) return { type: "viewport", action: "bottom" }
  if (key.return) {
    if (key.shift || key.meta || key.ctrl) return { type: "buffer", action: { type: "insert", text: "\n" } }
    return { type: "submit" }
  }
  if (key.ctrl && (cleanInput || input).toLowerCase() === "j") return { type: "buffer", action: { type: "insert", text: "\n" } }
  if (key.leftArrow) return { type: "buffer", action: { type: "left" } }
  if (key.rightArrow) return { type: "buffer", action: { type: "right" } }
  if (key.upArrow) return context.multiline ? { type: "buffer", action: { type: "up" } } : { type: "history", direction: "previous" }
  if (key.downArrow) return context.multiline ? { type: "buffer", action: { type: "down" } } : { type: "history", direction: "next" }
  if (key.home) return { type: "buffer", action: { type: "home" } }
  if (key.end) return { type: "buffer", action: { type: "end" } }
  if (isInkBackspace(key)) return { type: "buffer", action: { type: "backspace" } }
  if (cleanInput && !key.ctrl && !key.super) return { type: "buffer", action: { type: "insert", text: cleanInput } }
  return { type: "ignore" }
}

/** 全屏 Ink 四槽骨架；滚动状态由调用方通过 viewport rows 注入。 */
export function FullscreenConversationView(props: {
  committed: readonly TimelineItem[]
  live: readonly TimelineItem[]
  draft: string
  draftCursor?: number
  notice?: string
  terminalWidth: number
  terminalHeight: number
  hideInput?: boolean
  footer?: React.ReactNode
  status?: React.ReactNode
  viewportRows?: readonly TimelineViewportRow[]
  unseenCount?: number
  header?: React.ReactNode
  emptyState?: React.ReactNode
  toast?: React.ReactNode
  workMode?: "build" | "compose"
  entries?: readonly FullscreenEntry[]
  overlay?: React.ReactNode
}) {
  if (props.terminalWidth < 40 || props.terminalHeight < 12) {
    return (
      <Box width={Math.max(1, props.terminalWidth)} height={Math.max(1, props.terminalHeight)} alignItems="center" justifyContent="center">
        <Text>终端过小 · 至少需要 40 列 × 12 行</Text>
      </Box>
    )
  }

  const draftLines = props.hideInput ? 0 : fullscreenInputRows(props.draft, props.draftCursor)
  const reservedRows = 1 + draftLines + (props.status ? 1 : 0) + (props.unseenCount ? 1 : 0) + (props.toast ? TOAST_VIEWPORT_ROWS : 0)
  const timelineRows = Math.max(1, props.terminalHeight - reservedRows)
  const timeline = [...props.committed, ...props.live]
  const entries = props.entries ?? projectFullscreenTimeline(timeline, {
    columns: props.terminalWidth,
    fallbackWorkMode: props.workMode ?? "build",
  })
  const entryById = new Map(entries.map(entry => [entry.id, entry]))
  const visibleRows = props.viewportRows ?? layoutViewport(
    entries.map((entry, index) => ({
      id: entry.id,
      text: formatViewportEntryText(entry, index, entries.length, props.terminalWidth),
      aliases: entry.kind === "tool-group" ? entry.sourceEntryIds : undefined,
    })),
    createViewportState(),
    { columns: props.terminalWidth, rows: timelineRows },
  ).visibleRows

  return (
    <Box flexDirection="column" width={props.terminalWidth} height={props.terminalHeight} overflow="hidden">
      {props.header ?? <Box height={1} flexShrink={0} overflow="hidden"><Text color={tuiTheme.brand} bold wrap="truncate">Harness Code</Text></Box>}
      {props.toast}
      <Box flexDirection="column" flexGrow={1} minHeight={1} overflow="hidden">
        {props.overlay ? (
          props.overlay
        ) : visibleRows.length === 0 && props.emptyState ? (
          props.emptyState
        ) : (
          visibleRows.map(row => {
            const entry = entryById.get(row.entryId)
            const active = row.row === 0 && entry?.spinnerGlyph && row.text.startsWith(STABLE_SPINNER_GLYPH)
            return (
              <Text
                key={`${row.entryId}:${row.row}`}
                color={entry && entry.kind !== "tool" && entry.kind !== "user" && entry.kind !== "reasoning" ? fullscreenToneColor(entry.tone) : undefined}
                dimColor={entry?.kind === "tool-group"}
                wrap="truncate"
              >
                {active ? <><ActiveSpinnerGlyph />{row.text.slice(STABLE_SPINNER_GLYPH.length)}</> : row.text || " "}
              </Text>
            )
          })
        )}
        {props.notice ? <Text color={tuiTheme.warning}>{props.notice}</Text> : null}
      </Box>
      {props.unseenCount ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={tuiTheme.warning}>{`↓ ${props.unseenCount} 条新内容 · Ctrl+End 回到底部`}</Text>
        </Box>
      ) : null}
      {props.footer ? <Box flexDirection="column" flexShrink={0}>{props.footer}</Box> : null}
      {props.hideInput ? null : (
        <FullscreenInputBar
          draft={props.draft}
          draftCursor={props.draftCursor}
          width={props.terminalWidth}
          workMode={props.workMode ?? "build"}
        />
      )}
      {props.status ? <Box height={1} flexShrink={0} overflow="hidden">{props.status}</Box> : null}
    </Box>
  )
}

export function InkConversationRoot(props: { adapter: TuiAdapter; webHandoff?: PresentationCoordinator }) {
  const subscribe = useCallback((listener: (snapshot: TuiAdapterSnapshot) => void) => props.adapter.subscribe(listener), [props.adapter])
  const getSnapshot = useCallback(() => props.adapter.getSnapshot(), [props.adapter])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const subscribeWeb = useCallback((listener: () => void) => props.webHandoff?.subscribe(listener) ?? (() => {}), [props.webHandoff])
  const getWebSnapshot = useCallback(() => props.webHandoff?.getSnapshot(), [props.webHandoff])
  const webSnapshot = useSyncExternalStore(subscribeWeb, getWebSnapshot, getWebSnapshot)
  const isWebActive = webSnapshot?.phase === "web-active"

  const [buffer, setBuffer] = useState(() => createInputBuffer(snapshot.draft))
  const [displayTimeline, setDisplayTimeline] = useState(snapshot.interactive.timeline)
  const { stdout } = useStdout()
  const [terminalSize, setTerminalSize] = useState({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })

  useEffect(() => {
    if (snapshot.draft !== buffer.value) setBuffer(createInputBuffer(snapshot.draft, snapshot.draftCursor === "start" ? 0 : snapshot.draft.length))
  }, [buffer.value, snapshot.draft, snapshot.draftCursor])

  useEffect(() => {
    if (!isWebActive) setDisplayTimeline(snapshot.interactive.timeline)
  }, [isWebActive, snapshot.interactive.timeline])

  useEffect(() => {
    const resize = () => setTerminalSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on("resize", resize)
    return () => {
      stdout.off("resize", resize)
    }
  }, [stdout])

  const interactionKind = bottomAreaKind(snapshot.interactive.interaction)
  const viewportIdentity = `${snapshot.interactive.currentThreadId ?? "home"}:${snapshot.interactive.childTimelineExecutionId ?? "root"}`
  const projectedEntries = useMemo(() => projectFullscreenTimeline(displayTimeline, {
    columns: terminalSize.columns,
    fallbackWorkMode: snapshot.interactive.workMode,
    pendingInteractionId: snapshot.interactive.interaction?.requestId,
    spinnerGlyph: STABLE_SPINNER_GLYPH,
    active: snapshot.interactive.activity.kind === "running" || snapshot.interactive.activity.kind === "starting",
    activityKind: snapshot.interactive.activity.kind,
  }), [displayTimeline, snapshot.interactive.activity.kind, snapshot.interactive.interaction?.requestId, snapshot.interactive.workMode, terminalSize.columns])
  const viewportEntries = useMemo(() => projectedEntries.map((entry, index) => ({
    id: entry.id,
    text: formatViewportEntryText(entry, index, projectedEntries.length, terminalSize.columns),
    aliases: entry.kind === "tool-group" ? entry.sourceEntryIds : undefined,
  })), [projectedEntries, terminalSize.columns])
  const inputRows = interactionKind === "input" && snapshot.temporaryView.kind === "none"
    ? fullscreenInputRows(buffer.value, buffer.cursor)
    : 0
  const viewportSize = {
    columns: terminalSize.columns,
    rows: Math.max(1, terminalSize.rows - 1 - TOAST_VIEWPORT_ROWS - inputRows - 1),
  }
  const [viewportState, setViewportState] = useState(() => createViewportState(viewportIdentity))
  const menuMaxRows = Math.max(1, terminalSize.rows - inputRows - 4)
  const menuMaxItems = Math.max(1, Math.min(8, menuMaxRows - 4))
  const effectiveViewportState = viewportState.threadId === viewportIdentity
    ? viewportState
    : createViewportState(viewportIdentity)
  const viewportLayout = useMemo(
    () => layoutViewport(viewportEntries, effectiveViewportState, viewportSize),
    [effectiveViewportState, viewportEntries, viewportSize.columns, viewportSize.rows],
  )
  const viewportBlocked = interactionKind !== "input"
    || snapshot.temporaryView.kind !== "none"
    || Boolean(snapshot.commandDialog || snapshot.modelBindingDialog || snapshot.undoDialog?.visible)
    || Boolean(activePickerKind(snapshot) || snapshot.commandMenu.visible || snapshot.mentionMenu.visible)

  useEffect(() => {
    if (isWebActive) return
    setViewportState(current => updateViewport(current, viewportEntries, viewportSize, viewportIdentity).state)
  }, [isWebActive, viewportEntries, viewportIdentity, viewportSize.columns, viewportSize.rows])

  const moveViewport = (action: TimelineViewportAction) => {
    setViewportState(current => applyViewportAction(current, action, viewportEntries, viewportSize).state)
  }

  useInput((input, key) => {
    if (key.eventType === "release") return
    if (isWebActive) {
      if ((key.ctrl && input.toLowerCase() === "c") || key.escape) {
        props.webHandoff?.requestReturn()
      }
      return
    }
    const wheel = parseMouseWheelInput(input)
    if (wheel) {
      if (!viewportBlocked && wheel.steps > 0) {
        moveViewport({ type: wheel.direction === "up" ? "scroll-up" : "scroll-down", steps: wheel.steps })
      }
      return
    }
    if (isInkMouseReport(input)) return
    const resolution = resolveInkInput(input, key, {
      hasDraft: buffer.value.length > 0,
      activeRun: Boolean(snapshot.interactive.activeRun),
      multiline: buffer.value.includes("\n"),
      commandMenuVisible: snapshot.commandMenu.visible,
      commandOptionCount: snapshot.commandOptions.length,
      mentionMenuVisible: snapshot.mentionMenu.visible,
      mentionOptionCount: snapshot.mentionSearch.items.length,
      interactionActive: interactionKind !== "input",
      temporaryViewKind: snapshot.temporaryView.kind === "none" ? undefined : snapshot.temporaryView.kind as TemporaryViewKind,
      commandDialogVisible: Boolean(snapshot.commandDialog || snapshot.modelBindingDialog),
      skillPickerVisible: snapshot.skills.visible,
      skillOptionCount: snapshot.skills.items.length,
      threadPickerVisible: snapshot.threads.visible,
      threadOptionCount: snapshot.threads.items.length,
      modelPickerVisible: snapshot.models.visible,
      modelOptionCount: snapshot.models.items.length,
      agentPickerVisible: snapshot.agents.visible,
      agentOptionCount: snapshot.agents.items.length,
      undoPickerVisible: snapshot.undo.visible,
      undoOptionCount: snapshot.undo.items.length,
      undoDialogVisible: Boolean(snapshot.undoDialog?.visible),
      inputMode: snapshot.inputMode,
      childTimelineActive: Boolean(snapshot.interactive.childTimelineExecutionId),
    })
    if (interactionKind !== "input" || snapshot.temporaryView.kind !== "none") {
      if (resolution.type === "shortcut") void props.adapter.dispatch({ type: "shortcut", action: resolution.action })
      return
    }
    if (resolution.type === "viewport") {
      if (!viewportBlocked) moveViewport(resolution.action)
      return
    }
    const picker = activePickerKind(snapshot)
    if (picker && resolution.type === "buffer") {
      if (resolution.action.type === "insert") {
        const current = picker === "skills" ? snapshot.skills.query
          : picker === "threads" ? snapshot.threads.query
            : picker === "models" ? snapshot.models.query
              : picker === "agents" ? snapshot.agents.query
                : snapshot.undo.query
        void props.adapter.dispatch({ type: "picker-search", picker, query: `${current}${resolution.action.text}` })
        return
      }
      if (resolution.action.type === "backspace") {
        const current = picker === "skills" ? snapshot.skills.query
          : picker === "threads" ? snapshot.threads.query
            : picker === "models" ? snapshot.models.query
              : picker === "agents" ? snapshot.agents.query
                : snapshot.undo.query
        void props.adapter.dispatch({ type: "picker-search", picker, query: current.slice(0, -1) })
        return
      }
    }
    if (resolution.type === "ignore") return
    if (resolution.type === "submit") {
      moveViewport("bottom")
      void props.adapter.dispatch({ type: "submit", value: buffer.value })
      return
    }
    if (resolution.type === "history") {
      void props.adapter.dispatch(resolution)
      return
    }
    if (resolution.type === "shortcut") {
      void props.adapter.dispatch({ type: "shortcut", action: resolution.action })
      return
    }
    const next = inputBufferReducer(buffer, resolution.action)
    setBuffer(next)
    void props.adapter.dispatch({ type: "draft-input", value: next.value, cursorOffset: next.cursor })
  })

  return (
    <FullscreenConversationView
      committed={[]}
      live={displayTimeline}
      draft={buffer.value}
      draftCursor={buffer.cursor}
      notice={snapshot.transientNotice?.message}
      terminalWidth={terminalSize.columns}
      terminalHeight={terminalSize.rows}
      hideInput={isWebActive || interactionKind !== "input" || snapshot.temporaryView.kind !== "none"}
      viewportRows={viewportLayout.visibleRows}
      entries={projectedEntries}
      unseenCount={viewportLayout.unseenCount}
      workMode={snapshot.interactive.workMode}
      header={(
        <FullscreenHeader
          width={terminalSize.columns}
          threadId={snapshot.interactive.currentThreadId}
          workMode={snapshot.interactive.workMode}
          model={snapshot.interactive.runtime.modelName ?? "未配置模型"}
          workspace={snapshot.interactive.runtime.workspace}
          specialStatus={isWebActive ? "Web 接管" : snapshot.interactive.childTimelineExecutionId ? "子任务" : undefined}
        />
      )}
      emptyState={(
        <FullscreenWelcome
          version={snapshot.interactive.runtime.cliVersion}
          workspace={snapshot.interactive.runtime.workspace}
          model={snapshot.interactive.runtime.modelName ?? "未配置模型"}
          workMode={snapshot.interactive.workMode}
          width={terminalSize.columns}
        />
      )}
      toast={<ToastViewport toasts={snapshot.toasts} width={terminalSize.columns} />}
      overlay={
        isWebActive ? (
          <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.brand} paddingX={1} flexGrow={1}>
            <Text color={tuiTheme.brand} bold>已移交 Web 工作台</Text>
            <Text dimColor>当前会话已由浏览器接管。完成操作后点击页面中的“返回 TUI”，或直接关闭浏览器窗口。</Text>
            <Text dimColor>在终端按 Ctrl+C 或 Esc 可请求返回 TUI。</Text>
          </Box>
        ) : snapshot.temporaryView.kind !== "none" ? (
          <TemporaryView snapshot={snapshot} adapter={props.adapter} />
        ) : undefined
      }
      footer={
        isWebActive || snapshot.temporaryView.kind !== "none" ? null : (
          <>
            {interactionKind !== "input" ? (
              <InteractionBottomArea
                snapshot={snapshot.interactive}
                adapter={props.adapter}
                maxRows={Math.max(1, terminalSize.rows - 4)}
              />
            ) : (
              <InlineMenus snapshot={snapshot} maxItems={menuMaxItems} maxRows={menuMaxRows} />
            )}
          </>
        )
      }
      status={(
        <FullscreenFooter
          width={terminalSize.columns}
          activity={isWebActive ? "Web 接管中" : interactionKind !== "input" ? "等待操作" : snapshot.interactive.activeRun ? "运行中" : "等待输入"}
          approvalMode={snapshot.interactive.runtime.approvalMode}
          inputMode={snapshot.inputMode}
          connection={snapshot.interactive.connection.status}
        />
      )}
    />
  )
}

/** 创建唯一 Ink root 与唯一幂等 shutdown 路径。 */
export async function runTui(options: TuiOptions): Promise<void> {
  const gitWorkspace = options.controller.getSnapshot().runtime.gitWorkspace
  const gitRoot = gitWorkspace?.kind === "branch" || gitWorkspace?.kind === "detached" ? gitWorkspace.root : undefined
  let instance: ReturnType<typeof render> | undefined
  let closed = false
  let unregisterExit: (() => void) | undefined
  const terminalSession = createTerminalSession({ stdin: process.stdin, stdout: process.stdout })
  const onSigint = () => { process.exitCode = 130; close() }
  const onSigterm = () => { process.exitCode = 143; close() }
  const adapter = createTuiAdapter({
    controller: options.controller,
    gateway: options.gateway,
    workspaceExplorer: options.workspaceExplorer,
    promptHistoryFile: options.promptHistoryFile,
    resume: options.resume,
    onRequestExit: () => close(),
    openWeb: options.openWeb,
    workspaceChangeProbe: gitRoot ? () => detectGitChangedFiles(gitRoot) : undefined,
    dispatchGate: options.webHandoff ? intent => options.webHandoff!.tuiDispatch(intent) : undefined,
  })
  const close = () => {
    if (closed) return
    closed = true
    unregisterExit?.()
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
    try {
      instance?.unmount()
    } finally {
      terminalSession.close()
    }
  }
  try {
    terminalSession.enter()
    process.once("SIGINT", onSigint)
    process.once("SIGTERM", onSigterm)
    unregisterExit = options.webHandoff?.registerExitHandler(close)
    instance = render(<InkConversationRoot adapter={adapter} webHandoff={options.webHandoff} />, {
      exitOnCtrlC: false,
      incrementalRendering: false,
      maxFps: 30,
      kittyKeyboard: { mode: "auto" },
    })
    await instance.waitUntilExit()
  } finally {
    close()
    await adapter.close()
  }
}
