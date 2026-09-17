/** Ink InputBar 的 Unicode 安全纯输入缓冲。 */
import stringWidth from "string-width"

export type InputBuffer = {
  value: string
  cursor: number
  preferredColumn?: number
}

export type InputBufferAction =
  | { type: "insert"; text: string }
  | { type: "left" | "right" | "up" | "down" | "home" | "end" | "backspace" | "delete" }
  | { type: "replace"; value: string; cursor?: number }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** 创建光标一定位于 grapheme seam 的缓冲。 */
export function createInputBuffer(value = "", cursor = value.length): InputBuffer {
  const normalized = normalizeNewlines(value)
  return { value: normalized, cursor: seamAtOrBefore(normalized, Math.min(Math.max(cursor, 0), normalized.length)), preferredColumn: undefined }
}

/** 只返回新状态；paste/insert 不会产生 submit 副作用。 */
export function inputBufferReducer(state: InputBuffer, action: InputBufferAction): InputBuffer {
  const { value, cursor } = state
  switch (action.type) {
    case "replace":
      return createInputBuffer(action.value, action.cursor ?? action.value.length)
    case "insert": {
      const text = sanitizeInsertedText(action.text)
      const nextValue = value.slice(0, cursor) + text + value.slice(cursor)
      return { value: nextValue, cursor: seamAtOrAfter(nextValue, cursor + text.length), preferredColumn: undefined }
    }
    case "left":
      return { ...state, cursor: previousSeam(value, cursor), preferredColumn: undefined }
    case "right":
      return { ...state, cursor: nextSeam(value, cursor), preferredColumn: undefined }
    case "backspace": {
      const start = previousSeam(value, cursor)
      if (start === cursor) return state
      const nextValue = value.slice(0, start) + value.slice(cursor)
      return { value: nextValue, cursor: seamAtOrAfter(nextValue, start), preferredColumn: undefined }
    }
    case "delete": {
      const end = nextSeam(value, cursor)
      if (end === cursor) return state
      const nextValue = value.slice(0, cursor) + value.slice(end)
      return { value: nextValue, cursor: seamAtOrAfter(nextValue, cursor), preferredColumn: undefined }
    }
    case "home": {
      const lineStart = cursor === 0 ? 0 : value.lastIndexOf("\n", cursor - 1) + 1
      return { ...state, cursor: lineStart, preferredColumn: undefined }
    }
    case "end": {
      const newline = value.indexOf("\n", cursor)
      return { ...state, cursor: newline < 0 ? value.length : newline, preferredColumn: undefined }
    }
    case "up":
    case "down":
      return moveVertically(state, action.type === "up" ? -1 : 1)
  }
}

export type VisibleInputLines = {
  lines: string[]
  firstLine: number
  cursorLine: number
  cursorColumn: number
  cursorDisplayColumn: number
}

/** 返回包含光标的最多 maxLines 行，用于 InputBar 窗口。 */
export function visibleInputLines(state: InputBuffer, maxLines = 6): VisibleInputLines {
  const lines = state.value.split("\n")
  const before = state.value.slice(0, state.cursor)
  const cursorLineIndex = before.split("\n").length - 1
  const currentLineBeforeCursor = before.slice(before.lastIndexOf("\n") + 1)
  const cursorColumn = graphemes(currentLineBeforeCursor).length
  const firstLine = Math.min(Math.max(0, cursorLineIndex - maxLines + 1), Math.max(0, lines.length - maxLines))
  return {
    lines: lines.slice(firstLine, firstLine + maxLines),
    firstLine,
    cursorLine: cursorLineIndex - firstLine,
    cursorColumn,
    cursorDisplayColumn: stringWidth(currentLineBeforeCursor),
  }
}

function moveVertically(state: InputBuffer, delta: -1 | 1): InputBuffer {
  const lines = state.value.split("\n")
  const before = state.value.slice(0, state.cursor)
  const lineIndex = before.split("\n").length - 1
  const targetLineIndex = lineIndex + delta
  if (targetLineIndex < 0 || targetLineIndex >= lines.length) return state
  const currentLineBeforeCursor = before.slice(before.lastIndexOf("\n") + 1)
  const preferredColumn = state.preferredColumn ?? graphemes(currentLineBeforeCursor).length
  const targetSegments = graphemes(lines[targetLineIndex] ?? "")
  const targetColumn = Math.min(preferredColumn, targetSegments.length)
  const targetLineStart = lines.slice(0, targetLineIndex).reduce((length, line) => length + line.length + 1, 0)
  const targetOffset = targetSegments.slice(0, targetColumn).reduce((length, segment) => length + segment.length, 0)
  return { ...state, cursor: targetLineStart + targetOffset, preferredColumn }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n")
}

/** 粘贴是终端输入边界：保留换行/Tab，移除 ANSI、OSC 与其余 C0 控制字符。 */
function sanitizeInsertedText(value: string): string {
  return normalizeNewlines(value)
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\|$)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
}

function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), segment => segment.segment)
}

function seams(value: string): number[] {
  const result = [0]
  for (const segment of segmenter.segment(value)) result.push(segment.index + segment.segment.length)
  return result
}

function seamAtOrBefore(value: string, offset: number): number {
  let selected = 0
  for (const seam of seams(value)) {
    if (seam > offset) break
    selected = seam
  }
  return selected
}

function seamAtOrAfter(value: string, offset: number): number {
  for (const seam of seams(value)) if (seam >= offset) return seam
  return value.length
}

function previousSeam(value: string, cursor: number): number {
  const points = seams(value)
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index] ?? 0
    if (point < cursor) return point
  }
  return cursor
}

function nextSeam(value: string, cursor: number): number {
  for (const point of seams(value)) if (point > cursor) return point
  return cursor
}
