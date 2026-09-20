/** Ink 全屏外壳组件：响应式上下文、欢迎页、输入区、Footer 与稳定 Toast 槽位。 */
/** @jsxImportSource react */
import { Box, Text } from "ink"
import React from "react"
import stringWidth from "string-width"

import { tuiTheme, modeAccent } from "../presentation/theme"
import { createInputBuffer, visibleInputLines } from "./input-buffer"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

type WorkMode = "build" | "compose"

/** 单行 Header 按终端宽度依次展示 Thread、模型和工作区。 */
export function FullscreenHeader(props: {
  width: number
  threadId: string | null
  workMode: WorkMode
  model: string
  workspace: string
  specialStatus?: string
}) {
  const details: string[] = []
  if (props.width >= 60) details.push(props.threadId ? props.threadId.slice(0, 9) : "新会话", props.model)
  if (props.width >= 100) details.push(props.workspace)
  if (props.specialStatus) details.push(props.specialStatus)
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text color={tuiTheme.brand} bold>Harness</Text>
      <Text dimColor>{` · `}</Text>
      <Text color={modeAccent(props.workMode)} bold>{props.workMode.toUpperCase()}</Text>
      {details.map((segment, index) => (
        <Text key={`${index}-${segment}`} wrap="truncate">{` · ${segment}`}</Text>
      ))}
    </Box>
  )
}

import { HarnessCodeLogo } from "./harness-logo"

/** 空 Thread 的欢迎页：展示品牌 ASCII Logo、运行模式/模型上下文与快捷键指引。 */
export function FullscreenWelcome(props: {
  version: string
  workspace: string
  model: string
  workMode: WorkMode
  width?: number
}) {
  const width = props.width ?? 80
  const modeColor = modeAccent(props.workMode)
  const isCompact = width < 60
  const showLogo = props.width !== undefined && props.width >= 60
  const cardWidth = Math.min(width - 2, 76)

  if (isCompact) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column" marginY={1}>
          <Text color={tuiTheme.brand} bold>{`Harness Code ${props.version}`}</Text>
          <Text dimColor wrap="truncate">{`工作区: ${props.workspace} · 模型: ${props.model} · 模式: ${props.workMode.toUpperCase()}`}</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>{"  · 直接输入问题或任务开始"}</Text>
          <Text dimColor>{"  · 输入 / 唤起本地命令菜单"}</Text>
          <Text dimColor>{"  · 输入 @ 引用工作区文件或代码片段"}</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {showLogo && <HarnessCodeLogo width={width} />}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={tuiTheme.cardBorder}
        paddingX={2}
        paddingY={0}
        marginY={1}
        width={cardWidth}
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={tuiTheme.brand} bold>{`Harness Code ${props.version}`}</Text>
          <Text color={modeColor} bold>{`[${props.workMode.toUpperCase()}]`}</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor wrap="truncate">{`工作区: ${props.workspace}`}</Text>
          <Text dimColor wrap="truncate">{`模型:   ${props.model}`}</Text>
        </Box>
        <Box height={1} />
        <Box flexDirection="column">
          <Text color={tuiTheme.textMuted} bold>快捷操作:</Text>
          <Text dimColor>{"  · 直接输入问题或任务开始"}</Text>
          <Text dimColor>{"  · 输入 / 唤起本地命令菜单"}</Text>
          <Text dimColor>{"  · 输入 @ 引用工作区文件或代码片段"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={tuiTheme.textMuted}>{"💡 提示: 输入 ! 可直接在终端执行本地 Shell 命令"}</Text>
        </Box>
      </Box>
    </Box>
  )
}

/** Footer 在窄屏只保留活动状态，宽屏再补输入与连接上下文。 */
export function FullscreenFooter(props: {
  width: number
  activity: string
  approvalMode: string
  inputMode: "chat" | "shell"
  connection: string
}) {
  const secondary = props.width >= 72
    ? ` · ${props.inputMode} · ${props.approvalMode}${props.width >= 100 ? ` · ${props.connection}` : ""}`
    : ""
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text dimColor wrap="truncate">{`${props.activity}${secondary}`}</Text>
    </Box>
  )
}

/** 最多六行的输入区：一行上下文、最多四行正文、一行帮助。 */
export function FullscreenInputBar(props: {
  draft: string
  draftCursor?: number
  width: number
  workMode: WorkMode
}) {
  const buffer = createInputBuffer(props.draft, props.draftCursor ?? props.draft.length)
  const visible = visibleInputLines(buffer, 4)
  const accent = modeAccent(props.workMode)
  return (
    <Box flexDirection="column" flexShrink={0} width={props.width} overflow="hidden">
      <InputFrameBorder
        edge="top"
        width={props.width}
        color={accent}
      />
      {visible.lines.map((line, index) => {
        const prefix = index === 0 ? "❯ " : "  "
        let content: React.ReactNode
        if (!props.draft && index === 0) {
          content = <Text wrap="truncate">{prefix}<Text inverse> </Text><Text dimColor>输入消息…</Text></Text>
        } else if (index !== visible.cursorLine) {
          content = <Text wrap="truncate">{prefix}{line || " "}</Text>
        } else {
          const { before, current, after } = cursorWindow(line, visible.cursorColumn, props.width - 2 - stringWidth(prefix))
          content = <Text wrap="truncate">{prefix}{before}<Text inverse>{current}</Text>{after}</Text>
        }
        return (
          <Box key={index} height={1} flexShrink={0} overflow="hidden">
            <Text color={accent}>│</Text>
            <Box width={Math.max(1, props.width - 2)} overflow="hidden">{content}</Box>
            <Text color={accent}>│</Text>
          </Box>
        )
      })}
      <InputFrameBorder
        edge="bottom"
        label={props.width < 60 ? "Enter 发送 · Ctrl+C 取消/退出" : "Enter 发送 · Shift/Alt+Enter 换行 · Ctrl+C 取消/退出"}
        width={props.width}
        color={accent}
      />
    </Box>
  )
}

function InputFrameBorder(props: { edge: "top" | "bottom"; label?: string; width: number; color: string }) {
  if (!props.label) {
    return <Text color={props.color}>{`╭${"─".repeat(Math.max(1, props.width - 2))}╮`}</Text>
  }
  const left = "╰─ "
  const right = props.edge === "top" ? "╮" : "╯"
  const labelWidth = Math.max(0, props.width - stringWidth(left) - stringWidth(right) - 1)
  const label = truncateCells(props.label, labelWidth)
  const fill = "─".repeat(Math.max(1, props.width - stringWidth(left) - stringWidth(label) - stringWidth(right)))
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text color={props.color}>{left}</Text>
      <Text dimColor>{label}</Text>
      <Text color={props.color}>{fill}{right}</Text>
    </Box>
  )
}

function truncateCells(value: string, width: number): string {
  let result = ""
  let used = 0
  for (const segment of graphemeSegmenter.segment(value)) {
    const segmentWidth = stringWidth(segment.segment)
    if (used + segmentWidth > width) break
    result += segment.segment
    used += segmentWidth
  }
  return result
}

/** 按终端 cell 宽度截取光标附近窗口，长行始终优先保留光标而不是行首。 */
function cursorWindow(line: string, cursorColumn: number, width: number): { before: string; current: string; after: string } {
  const units = Array.from(graphemeSegmenter.segment(line), segment => segment.segment)
  const column = Math.min(cursorColumn, units.length)
  const current = units[column] ?? " "
  const budget = Math.max(1, width)
  let used = Math.max(1, stringWidth(current))
  let start = column
  while (start > 0) {
    const candidateWidth = stringWidth(units[start - 1] ?? "")
    if (used + candidateWidth > budget) break
    start -= 1
    used += candidateWidth
  }
  let end = column + (units[column] ? 1 : 0)
  while (end < units.length) {
    const candidateWidth = stringWidth(units[end] ?? "")
    if (used + candidateWidth > budget) break
    used += candidateWidth
    end += 1
  }
  return {
    before: units.slice(start, column).join(""),
    current,
    after: units.slice(column + (units[column] ? 1 : 0), end).join(""),
  }
}

/** InputBar 的实际行预算，供 Timeline viewport 预留稳定空间。 */
export function fullscreenInputRows(draft: string, cursor?: number): number {
  return visibleInputLines(createInputBuffer(draft, cursor ?? draft.length), 4).lines.length + 2
}

type ToastViewItem = {
  readonly id: string
  readonly message: string
  readonly variant: "info" | "success" | "warning" | "error"
}

export const TOAST_VIEWPORT_ROWS = 1

const toastPresentation = {
  info: { glyph: "i", color: tuiTheme.brand },
  success: { glyph: "✓", color: tuiTheme.success },
  warning: { glyph: "!", color: tuiTheme.warning },
  error: { glyph: "×", color: tuiTheme.danger },
} as const

/** Toast 使用固定一行槽位；出现或消失都不改变 Timeline 与 BottomArea 高度。 */
export function ToastViewport(props: { toasts: readonly ToastViewItem[]; width: number }) {
  const toast = props.toasts.at(-1)
  const presentation = toast ? toastPresentation[toast.variant] : null
  return (
    <Box height={TOAST_VIEWPORT_ROWS} width={props.width} flexShrink={0} overflow="hidden">
      {toast && presentation
        ? <Text color={presentation.color} wrap="truncate">{`${presentation.glyph} ${toast.message}`}</Text>
        : <Text>{"\u00a0"}</Text>}
    </Box>
  )
}
