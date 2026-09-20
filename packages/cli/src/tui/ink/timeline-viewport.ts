/** Ink 全屏时间线的纯视口状态：负责 cell wrap、锚点、滚动和尾随。 */
import stringWidth from "string-width"

/** 由 FullscreenProjection 提供、可测量的纯文本条目。 */
export type TimelineViewportEntry = {
  readonly id: string
  readonly text: string
  /** 条目合并后仍指向该条目的旧身份，用于保留阅读锚点。 */
  readonly aliases?: readonly string[]
}

/** TimelineViewport 使用的终端尺寸；输入会被规范化为非负整数。 */
export type TimelineViewportSize = {
  readonly columns: number
  readonly rows: number
}

/** 只影响时间线视觉状态的导航动作。 */
export type TimelineViewportAction =
  | "page-up"
  | "page-down"
  | "scroll-up"
  | "scroll-down"
  | "top"
  | "bottom"
  | "follow-tail"
  | { readonly type: "scroll-up"; readonly steps?: number }
  | { readonly type: "scroll-down"; readonly steps?: number }

/** 可在 resize 后重新定位的 entry 内锚点。 */
export type TimelineViewportAnchor = {
  readonly entryId: string
  /** 该 entry 内的视觉行号。 */
  readonly row: number
  /** 该视觉行起点在 entry 内的终端 cell 偏移。 */
  readonly cellOffset: number
}

/** 一行按终端 cell width 包装后的视觉片段。 */
export type TimelineViewportRow = {
  readonly entryId: string
  /** 该 entry 内的视觉行号。 */
  readonly row: number
  readonly text: string
  readonly width: number
  /** 该行起点在 entry 内的终端 cell 偏移。 */
  readonly cellOffset: number
}

type KnownEntry = TimelineViewportEntry

/** TimelineViewport 的本地表现状态，不进入 TuiAdapter snapshot。 */
export type TimelineViewportState = {
  readonly threadId: string | null
  readonly anchor: TimelineViewportAnchor | null
  readonly followTail: boolean
  readonly unseenCount: number
  /** 上一次已知内容只用于检测新条目或流式文本变化，不属于业务 snapshot。 */
  readonly knownEntries: readonly KnownEntry[]
}

/** 给 Ink 渲染层消费的当前可见窗口。 */
export type TimelineViewportLayout = {
  readonly visibleRows: readonly TimelineViewportRow[]
  readonly totalRows: number
  readonly offset: number
  readonly anchor: TimelineViewportAnchor | null
  readonly followTail: boolean
  readonly unseenCount: number
  readonly tooSmall: boolean
  readonly size: TimelineViewportSize
}

/** 时间线更新或导航动作的不可变结果。 */
export type TimelineViewportUpdate = {
  readonly state: TimelineViewportState
  readonly layout: TimelineViewportLayout
}

const MIN_COLUMNS = 40
const MIN_ROWS = 12
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** 创建默认跟随尾部的视口状态。 */
export function createViewportState(threadId: string | null = null): TimelineViewportState {
  return {
    threadId,
    anchor: null,
    followTail: true,
    unseenCount: 0,
    knownEntries: [],
  }
}

/** 判断当前尺寸是否只能显示“终端过小”提示。 */
export function isViewportTooSmall(size: TimelineViewportSize): boolean {
  const normalized = normalizeSize(size)
  return normalized.columns < MIN_COLUMNS || normalized.rows < MIN_ROWS
}

/** 按 terminal cell width 把展示条目布局成可滚动视觉行。 */
export function layoutViewport(
  entries: readonly TimelineViewportEntry[],
  state: TimelineViewportState,
  size: TimelineViewportSize,
): TimelineViewportLayout {
  const normalizedSize = normalizeSize(size)
  const rows = wrapEntries(entries, Math.max(1, normalizedSize.columns))
  const visibleHeight = normalizedSize.rows
  const offset = resolveOffset(rows, state, visibleHeight, entries)
  const anchor = anchorAt(rows, offset)

  return {
    visibleRows: rows.slice(offset, offset + visibleHeight),
    totalRows: rows.length,
    offset,
    anchor,
    followTail: state.followTail,
    unseenCount: state.unseenCount,
    tooSmall: isViewportTooSmall(normalizedSize),
    size: normalizedSize,
  }
}

/**
 * 用新的时间线和尺寸计算视口；用户已滚离尾部时保留稳定 entry 锚点，并累计新内容提示。
 * threadId 变化会清空旧锚点，重新从新 Thread 尾部开始跟随。
 */
export function updateViewport(
  state: TimelineViewportState,
  entries: readonly TimelineViewportEntry[],
  size: TimelineViewportSize,
  threadId: string | null = state.threadId,
): TimelineViewportUpdate {
  const threadChanged = state.threadId !== threadId
  const base = threadChanged ? createViewportState(threadId) : state
  const changedCount = threadChanged ? 0 : changedEntryCount(base.knownEntries, entries)
  const nextState: TimelineViewportState = {
    ...base,
    unseenCount: base.followTail ? 0 : base.unseenCount + changedCount,
    knownEntries: entries.map(({ id, text, aliases }) => ({ id, text, aliases })),
  }
  const layout = layoutViewport(entries, nextState, size)
  return {
    state: { ...nextState, anchor: layout.anchor },
    layout,
  }
}

/** 应用一项纯视口导航动作；普通方向键和输入编辑不在此模块处理。 */
export function applyViewportAction(
  state: TimelineViewportState,
  action: TimelineViewportAction,
  entries: readonly TimelineViewportEntry[],
  size: TimelineViewportSize,
): TimelineViewportUpdate {
  const normalizedSize = normalizeSize(size)
  const rows = wrapEntries(entries, Math.max(1, normalizedSize.columns))
  const visibleHeight = normalizedSize.rows
  const currentOffset = resolveOffset(rows, state, visibleHeight, entries)
  const maxOffset = Math.max(0, rows.length - visibleHeight)
  const pageStep = Math.max(1, visibleHeight - 1)

  const actionType = typeof action === "string" ? action : action.type
  const steps = typeof action === "object" ? Math.max(1, Math.min(10, action.steps ?? 1)) : 1

  switch (actionType) {
    case "page-up":
      return finishAction(state, rows, Math.max(0, currentOffset - pageStep), false, entries, normalizedSize)
    case "page-down": {
      const nextOffset = Math.min(maxOffset, currentOffset + pageStep)
      const atBottom = nextOffset >= maxOffset
      return finishAction(state, rows, nextOffset, atBottom, entries, normalizedSize)
    }
    case "scroll-up":
      return finishAction(state, rows, Math.max(0, currentOffset - 3 * steps), false, entries, normalizedSize)
    case "scroll-down": {
      const nextOffset = Math.min(maxOffset, currentOffset + 3 * steps)
      return finishAction(state, rows, nextOffset, nextOffset >= maxOffset, entries, normalizedSize)
    }
    case "top":
      return finishAction(state, rows, 0, false, entries, normalizedSize)
    case "bottom":
    case "follow-tail":
      return finishAction(state, rows, maxOffset, true, entries, normalizedSize)
  }
}

function finishAction(
  state: TimelineViewportState,
  rows: readonly TimelineViewportRow[],
  offset: number,
  followTail: boolean,
  entries: readonly TimelineViewportEntry[],
  normalizedSize: TimelineViewportSize,
): TimelineViewportUpdate {
  const visibleHeight = normalizedSize.rows
  const anchor = anchorAt(rows, offset)
  const nextState: TimelineViewportState = {
    ...state,
    anchor,
    followTail,
    unseenCount: followTail ? 0 : state.unseenCount,
    knownEntries: entries.map(({ id, text, aliases }) => ({ id, text, aliases })),
  }
  return {
    state: nextState,
    layout: {
      visibleRows: rows.slice(offset, offset + visibleHeight),
      totalRows: rows.length,
      offset,
      anchor,
      followTail,
      unseenCount: nextState.unseenCount,
      tooSmall: isViewportTooSmall(normalizedSize),
      size: normalizedSize,
    },
  }
}

function resolveOffset(
  rows: readonly TimelineViewportRow[],
  state: TimelineViewportState,
  visibleHeight: number,
  entries: readonly TimelineViewportEntry[],
): number {
  if (visibleHeight <= 0) return 0
  const maxOffset = Math.max(0, rows.length - visibleHeight)
  if (state.followTail) return maxOffset
  if (!state.anchor) return 0

  const anchoredEntryId = entries.find(entry => (
    entry.id === state.anchor?.entryId || entry.aliases?.includes(state.anchor?.entryId ?? "")
  ))?.id ?? state.anchor.entryId
  const entryRows = rows.filter(row => row.entryId === anchoredEntryId)
  if (entryRows.length === 0) return 0
  // resize 会改变物理 row；以 entry 内 cell offset 找到仍包含原阅读位置的新行。
  const nearest = entryRows.reduce((selected, row) => (
    row.cellOffset <= state.anchor!.cellOffset && row.cellOffset >= selected.cellOffset ? row : selected
  ), entryRows[0]!)
  return rows.indexOf(nearest)
}

function anchorAt(rows: readonly TimelineViewportRow[], offset: number): TimelineViewportAnchor | null {
  const row = rows[Math.min(Math.max(offset, 0), Math.max(0, rows.length - 1))]
  return row ? { entryId: row.entryId, row: row.row, cellOffset: row.cellOffset } : null
}

function changedEntryCount(previous: readonly KnownEntry[], next: readonly TimelineViewportEntry[]): number {
  const previousById = new Map(previous.map(item => [item.id, item.text]))
  let changed = 0
  for (const item of next) {
    if (previousById.get(item.id) !== item.text) changed += 1
  }
  return changed
}

function wrapEntries(entries: readonly TimelineViewportEntry[], columns: number): TimelineViewportRow[] {
  const rows: TimelineViewportRow[] = []
  for (const entry of entries) {
    const wrapped = wrapText(entry.text, columns)
    wrapped.forEach((line, row) => {
      rows.push({ entryId: entry.id, row, text: line.text, width: line.width, cellOffset: line.cellOffset })
    })
  }
  return rows
}

const ANSI_SEQUENCE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2A-Z])|\u009B[0-?]*[ -/]*[@-~]/g
const ASCII_PRINTABLE = /^[\x20-\x7E]*$/

type AnsiWrapToken =
  | { type: "ansi"; sequence: string }
  | { type: "char"; grapheme: string; width: number }

function tokenizeTextSegment(text: string): AnsiWrapToken[] {
  if (ASCII_PRINTABLE.test(text)) {
    const tokens: AnsiWrapToken[] = []
    for (let i = 0; i < text.length; i++) {
      tokens.push({ type: "char", grapheme: text[i]!, width: 1 })
    }
    return tokens
  }
  const tokens: AnsiWrapToken[] = []
  for (const seg of graphemeSegmenter.segment(text)) {
    tokens.push({ type: "char", grapheme: seg.segment, width: stringWidth(seg.segment) })
  }
  return tokens
}

function tokenizeAnsiLine(line: string): AnsiWrapToken[] {
  const tokens: AnsiWrapToken[] = []
  ANSI_SEQUENCE.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = ANSI_SEQUENCE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(...tokenizeTextSegment(line.slice(lastIndex, match.index)))
    }
    tokens.push({ type: "ansi", sequence: match[0] })
    lastIndex = ANSI_SEQUENCE.lastIndex
  }

  if (lastIndex < line.length) {
    tokens.push(...tokenizeTextSegment(line.slice(lastIndex)))
  }

  return tokens
}

const wrapTextCache = new Map<string, Array<{ text: string; width: number; cellOffset: number }>>()
const WRAP_CACHE_MAX_ENTRIES = 500

function wrapText(text: string, columns: number): Array<{ text: string; width: number; cellOffset: number }> {
  const cacheKey = `${columns}:${text}`
  const cached = wrapTextCache.get(cacheKey)
  if (cached) return cached

  const normalized = text.replace(/\r\n?/g, "\n")
  const logicalLines = normalized.split("\n")
  const result: Array<{ text: string; width: number; cellOffset: number }> = []
  let cellOffset = 0

  for (const [logicalIndex, logicalLine] of logicalLines.entries()) {
    const tokens = tokenizeAnsiLine(logicalLine)
    if (tokens.length === 0) {
      result.push({ text: "", width: 0, cellOffset })
      if (logicalIndex < logicalLines.length - 1) cellOffset += 1
      continue
    }

    let current = ""
    let width = 0
    let lineOffset = cellOffset
    let activeStyles = ""

    for (const token of tokens) {
      if (token.type === "ansi") {
        current += token.sequence
        if (token.sequence === "\u001b[0m" || token.sequence === "\u001b[m") {
          activeStyles = ""
        } else {
          activeStyles += token.sequence
        }
        continue
      }

      const charWidth = token.width
      if (width > 0 && width + charWidth > columns) {
        result.push({ text: current + (activeStyles ? "\u001b[0m" : ""), width, cellOffset: lineOffset })
        cellOffset += width
        current = activeStyles + token.grapheme
        width = charWidth
        lineOffset = cellOffset
      } else {
        current += token.grapheme
        width += charWidth
      }
    }
    if (activeStyles && !current.endsWith("\u001b[0m")) {
      current += "\u001b[0m"
    }
    result.push({ text: current, width, cellOffset: lineOffset })
    cellOffset += width
    if (logicalIndex < logicalLines.length - 1) cellOffset += 1
  }

  if (wrapTextCache.size >= WRAP_CACHE_MAX_ENTRIES) {
    const iterator = wrapTextCache.keys()
    for (let i = 0; i < 100; i++) {
      const next = iterator.next()
      if (next.done) break
      wrapTextCache.delete(next.value)
    }
  }
  wrapTextCache.set(cacheKey, result)
  return result
}

function normalizeSize(size: TimelineViewportSize): TimelineViewportSize {
  return {
    columns: normalizeDimension(size.columns),
    rows: normalizeDimension(size.rows),
  }
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}
