/** 终端 Markdown 富文本与代码语法高亮投影引擎（参考 Claude Code / Qwen Code）。 */
import { lexer, type Token, type Tokens } from "marked"
import stringWidth from "string-width"

const DEFAULT_COLUMNS = 80
const ANSI_SEQUENCE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2A-Z])|\u009B[0-?]*[ -/]*[@-~]/g
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** 移除字符串中的 ANSI 转义序列。 */
export function stripAnsi(value: string): string {
  return String(value ?? "").replace(ANSI_SEQUENCE, "")
}

/** 清理不可信终端输入中的有害控制序列，但保留格式化换行。 */
export function sanitizeTerminalText(value: string): string {
  return String(value ?? "")
    .replace(ANSI_SEQUENCE, "")
    .replace(/\u001B/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL_CHARACTERS, "")
}

/** 将 Markdown 解析为适合终端全屏视口的高质量富文本（带语法高亮与有界框体）。 */
export function formatTerminalMarkdown(source: string, columns: number): string {
  const width = normalizeColumns(columns)
  const cleanSource = sanitizeTerminalText(source)

  try {
    const tokens = lexer(cleanSource, { gfm: true })
    return renderBlocks(tokens, width).join("\n")
  } catch {
    return wrapText(cleanSource, width).join("\n")
  }
}

function normalizeColumns(columns: number): number {
  return Number.isFinite(columns) && columns > 0 ? Math.max(1, Math.floor(columns)) : DEFAULT_COLUMNS
}

function renderBlocks(tokens: readonly Token[], width: number): string[] {
  const lines: string[] = []
  for (const token of tokens) {
    if (token.type === "space") continue
    const block = renderBlock(token, width)
    if (block.length === 0) continue
    if (lines.length > 0) lines.push("")
    lines.push(...block)
  }
  return lines
}

function renderBlock(token: Token, width: number): string[] {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading
      const text = renderInline(heading.tokens, heading.text)
      if (heading.depth === 1) {
        return wrapWithPrefix(text, "\u001b[1;4;38;5;39m▌ ", width).map(l => l + "\u001b[0m")
      }
      if (heading.depth === 2) {
        return wrapWithPrefix(text, "\u001b[1;38;5;75m▌ ", width).map(l => l + "\u001b[0m")
      }
      return wrapWithPrefix(text, "\u001b[1;37m▌ ", width).map(l => l + "\u001b[0m")
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph
      return wrapText(renderInline(paragraph.tokens, paragraph.text), width)
    }
    case "text": {
      const text = token as Tokens.Text
      return wrapText(renderInline(text.tokens, text.text), width)
    }
    case "code":
      return renderCode(token as Tokens.Code, width)
    case "list":
      return renderList(token as Tokens.List, width)
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, width)
    case "table":
      return renderTable(token as Tokens.Table, width)
    case "hr":
      return [`\u001b[90m${"─".repeat(width)}\u001b[0m`]
    case "html": {
      const html = token as Tokens.HTML
      return wrapText(html.text, width)
    }
    case "def":
      return []
    default:
      return wrapText(safeTokenText(token), width)
  }
}

/** 针对常见编程语言进行终端代码行语法着色。 */
export function highlightCodeLine(line: string, lang: string): string {
  if (!line || /[│├└┌┐┘┬┴┼]/.test(line)) {
    return line
  }

  const l = (lang || "").toLowerCase()

  if (l === "diff" || l === "patch") {
    if (line.startsWith("+")) return `\u001b[32m${line}\u001b[0m`
    if (line.startsWith("-")) return `\u001b[31m${line}\u001b[0m`
    if (line.startsWith("@")) return `\u001b[36m${line}\u001b[0m`
    return line
  }

  const trimmed = line.trim()
  if (
    trimmed.startsWith("//") ||
    (l.startsWith("py") && trimmed.startsWith("#")) ||
    (l.startsWith("sh") && trimmed.startsWith("#")) ||
    (l === "bash" && trimmed.startsWith("#")) ||
    (l === "zsh" && trimmed.startsWith("#"))
  ) {
    return `\u001b[90;3m${line}\u001b[0m`
  }

  // 单趟词法匹配：优先匹配字符串和注释，避免内部关键字或数字被二次染色
  const TOKEN_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*$|#.*$)|(\b(?:const|let|var|function|class|interface|type|enum|return|if|else|for|while|do|switch|case|break|continue|import|export|from|default|extends|implements|new|this|async|await|try|catch|finally|throw|def|elif|lambda|yield|pass|match|with|as|in|is|not|fn|pub|struct|impl|trait|mut|package)\b)|(\b(?:string|number|boolean|any|void|never|unknown|object|Promise|Array|Record|Map|Set|int|float|str|bool|list|dict|tuple|None|True|False|true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())/g

  let result = ""
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      result += line.slice(lastIndex, match.index)
    }
    const [raw, str, comment, keyword, typeName, num, fn] = match
    if (str) {
      result += `\u001b[38;5;114m${str}\u001b[0m`
    } else if (comment) {
      result += `\u001b[90;3m${comment}\u001b[0m`
    } else if (keyword) {
      result += `\u001b[38;5;176m${keyword}\u001b[0m`
    } else if (typeName) {
      result += `\u001b[38;5;73m${typeName}\u001b[0m`
    } else if (num) {
      result += `\u001b[38;5;180m${num}\u001b[0m`
    } else if (fn) {
      result += `\u001b[38;5;75m${fn}\u001b[0m`
    } else {
      result += raw
    }
    lastIndex = TOKEN_RE.lastIndex
  }

  if (lastIndex < line.length) {
    result += line.slice(lastIndex)
  }

  return result
}

function renderCode(token: Tokens.Code, width: number): string[] {
  const language = token.lang?.trim() || "code"
  const lines: string[] = []

  let safeLang = language
  let topLabel = `╭─ \u001b[38;5;75;1m${safeLang}\u001b[0m `
  let topLabelWidth = stringWidth(`╭─ ${safeLang} `)
  if (topLabelWidth + 2 > width) {
    const maxLangLen = Math.max(1, width - 6)
    safeLang = safeLang.slice(0, maxLangLen)
    topLabel = `╭─ \u001b[38;5;75;1m${safeLang}\u001b[0m `
    topLabelWidth = stringWidth(`╭─ ${safeLang} `)
  }
  const topFill = Math.max(1, width - topLabelWidth - 1)
  lines.push(`${topLabel}\u001b[90m${"─".repeat(topFill)}╮\u001b[0m`)

  const sourceLines = token.text.split("\n")
  const codePrefix = "\u001b[90m│\u001b[0m "
  for (const sourceLine of sourceLines) {
    const highlighted = highlightCodeLine(sourceLine || " ", safeLang)
    lines.push(...wrapWithPrefix(highlighted, codePrefix, width, codePrefix))
  }

  lines.push(`\u001b[90m╰${"─".repeat(Math.max(1, width - 2))}╯\u001b[0m`)
  return lines
}

function renderList(token: Tokens.List, width: number): string[] {
  const lines: string[] = []
  token.items.forEach((item, index) => {
    const number = typeof token.start === "number" ? token.start + index : index + 1
    const marker = token.ordered
      ? `\u001b[90m${number}.\u001b[0m `
      : item.task
        ? item.checked ? "\u001b[32m☑\u001b[0m " : "\u001b[90m☐\u001b[0m "
        : "\u001b[38;5;75m•\u001b[0m "
    const itemLines = renderListItem(item, width, marker)
    lines.push(...itemLines)
  })
  return lines
}

function renderListItem(item: Tokens.ListItem, width: number, marker: string): string[] {
  const body: string[] = []
  const tokens = item.tokens ?? []
  const markerPlainWidth = stringWidth(stripAnsi(marker))

  for (const token of tokens) {
    if (token.type === "checkbox") continue
    if (token.type === "list") {
      body.push(...renderList(token as Tokens.List, Math.max(1, width - 2)))
      continue
    }
    if (token.type === "paragraph" || token.type === "text") {
      const text = token as Tokens.Paragraph | Tokens.Text
      body.push(...wrapText(renderInline(text.tokens, text.text), Math.max(1, width - markerPlainWidth)))
      continue
    }
    body.push(...renderBlock(token, Math.max(1, width - markerPlainWidth)))
  }
  if (body.length === 0) body.push(...wrapText(item.text, Math.max(1, width - markerPlainWidth)))
  const continuation = " ".repeat(Math.min(markerPlainWidth, Math.max(0, width - 1)))
  return body.map((line, index) => `${index === 0 ? marker : continuation}${line}`)
}

function renderBlockquote(token: Tokens.Blockquote, width: number): string[] {
  const body = token.tokens?.length
    ? renderBlocks(token.tokens, Math.max(1, width - 2))
    : wrapText(token.text, Math.max(1, width - 2))
  return body.map((line) => `\u001b[38;5;75m│\u001b[0m \u001b[3;90m${line}\u001b[0m`)
}

function renderTable(token: Tokens.Table, width: number): string[] {
  const header = token.header.map((cell) => renderInline(cell.tokens, cell.text))
  const rows = token.rows.map((row) => row.map((cell) => renderInline(cell.tokens, cell.text)))
  if (width < 60 || tableNaturalWidth(header, rows) > width) return renderCompactTable(header, rows, width)
  return renderWideTable(token, header, rows, width)
}

function tableNaturalWidth(header: string[], rows: string[][]): number {
  const columnCount = Math.max(header.length, ...rows.map(row => row.length), 1)
  const cellsWidth = Array.from({ length: columnCount }, (_, column) => (
    Math.max(stringWidth(stripAnsi(header[column] ?? "")), ...rows.map(row => stringWidth(stripAnsi(row[column] ?? ""))), 1)
  )).reduce((sum, value) => sum + value, 0)
  return cellsWidth + columnCount * 3 + 1
}

function renderCompactTable(header: string[], rows: string[][], width: number): string[] {
  const lines: string[] = []
  for (const row of rows) {
    const values = row.length > 0 ? row : [""]
    values.forEach((value, index) => {
      const key = header[index] || `列 ${index + 1}`
      lines.push(...wrapWithPrefix(value, `\u001b[38;5;75;1m${key}:\u001b[0m `, width))
    })
  }
  if (lines.length === 0) {
    for (const key of header) lines.push(fitToWidth(`\u001b[38;5;75;1m${key}:\u001b[0m`, width))
  }
  return lines
}

function renderWideTable(token: Tokens.Table, header: string[], rows: string[][], width: number): string[] {
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length), 1)
  const normalizedHeader = Array.from({ length: columnCount }, (_, index) => header[index] ?? "")
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ""))
  const naturalWidths = normalizedHeader.map((value, column) =>
    Math.max(stringWidth(stripAnsi(value)), ...normalizedRows.map((row) => stringWidth(stripAnsi(row[column] ?? ""))), 1),
  )
  const widths = fitTableWidths(naturalWidths, width)
  const lines = [renderTableRow(normalizedHeader.map(h => `\u001b[1m${h}\u001b[0m`), widths, token.align)]
  lines.push(renderTableDivider(widths))
  for (const row of normalizedRows) lines.push(renderTableRow(row, widths, token.align))
  return lines
}

function fitTableWidths(natural: number[], width: number): number[] {
  const available = Math.max(1, width - (natural.length * 3 + 1))
  const result = natural.map((value) => Math.max(1, value))
  let excess = result.reduce((sum, value) => sum + value, 0) - available
  while (excess > 0) {
    const index = result.findIndex((value) => value > 1)
    if (index < 0) break
    result[index] -= 1
    excess -= 1
  }
  return result
}

function renderTableRow(values: string[], widths: number[], alignments: Array<"center" | "left" | "right" | null>): string {
  const cells = values.map((value, index) => {
    const cellWidth = widths[index] ?? 1
    const content = fitToWidth(value, cellWidth)
    return padCell(content, cellWidth, alignments[index] ?? null)
  })
  return `\u001b[90m|\u001b[0m ${cells.join(" \u001b[90m|\u001b[0m ")} \u001b[90m|\u001b[0m`
}

function renderTableDivider(widths: number[]): string {
  return `\u001b[90m| ${widths.map((value) => "─".repeat(value)).join(" | ")} |\u001b[0m`
}

function padCell(value: string, width: number, alignment: "center" | "left" | "right" | null): string {
  const plainWidth = stringWidth(stripAnsi(value))
  const padding = Math.max(0, width - plainWidth)
  if (alignment === "right") return " ".repeat(padding) + value
  if (alignment === "center") {
    const left = Math.floor(padding / 2)
    return " ".repeat(left) + value + " ".repeat(padding - left)
  }
  return value + " ".repeat(padding)
}

function renderInline(tokens: readonly Token[] | undefined, fallback = ""): string {
  if (!tokens || tokens.length === 0) return fallback
  return tokens.map((token) => renderInlineToken(token)).join("")
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "strong": {
      const inline = token as Tokens.Strong
      return `\u001b[1;37m${renderInline(inline.tokens, inline.text)}\u001b[0m`
    }
    case "em": {
      const inline = token as Tokens.Em
      return `\u001b[3m${renderInline(inline.tokens, inline.text)}\u001b[0m`
    }
    case "del": {
      const inline = token as Tokens.Del
      return `\u001b[9;90m${renderInline(inline.tokens, inline.text)}\u001b[0m`
    }
    case "codespan": {
      const code = token as Tokens.Codespan
      return `\u001b[48;5;236m\u001b[38;5;153m${code.text}\u001b[0m`
    }
    case "br":
      return "\n"
    case "checkbox": {
      const checkbox = token as Tokens.Checkbox
      return checkbox.checked ? "\u001b[32m☑\u001b[0m " : "\u001b[90m☐\u001b[0m "
    }
    case "link": {
      const link = token as Tokens.Link
      const label = renderInline(link.tokens, link.text)
      const href = safeHttpUrl(link.href)
      return href ? `\u001b[4;38;5;75m${label}\u001b[0m \u001b[90m(${href})\u001b[0m` : `\u001b[4;38;5;75m${label}\u001b[0m`
    }
    case "image": {
      const image = token as Tokens.Image
      return image.text
    }
    case "html": {
      const html = token as Tokens.HTML
      return html.text
    }
    case "escape": {
      const escaped = token as Tokens.Escape
      return escaped.text
    }
    case "text": {
      const text = token as Tokens.Text
      return text.tokens?.length ? renderInline(text.tokens, text.text) : text.text
    }
    default:
      return safeTokenText(token)
  }
}

function safeHttpUrl(value: string): string | undefined {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return undefined
  try {
    const url = new URL(trimmed)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

function safeTokenText(token: Token): string {
  const value = token as { text?: unknown; raw?: unknown }
  return typeof value.text === "string" ? value.text : typeof value.raw === "string" ? value.raw : ""
}

type AnsiToken =
  | { type: "ansi"; sequence: string }
  | { type: "char"; grapheme: string; width: number }

function tokenizeAnsi(line: string): AnsiToken[] {
  const tokens: AnsiToken[] = []
  ANSI_SEQUENCE.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = ANSI_SEQUENCE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      const text = line.slice(lastIndex, match.index)
      for (const seg of GRAPHEME_SEGMENTER.segment(text)) {
        tokens.push({ type: "char", grapheme: seg.segment, width: stringWidth(seg.segment) })
      }
    }
    tokens.push({ type: "ansi", sequence: match[0] })
    lastIndex = ANSI_SEQUENCE.lastIndex
  }

  if (lastIndex < line.length) {
    const text = line.slice(lastIndex)
    for (const seg of GRAPHEME_SEGMENTER.segment(text)) {
      tokens.push({ type: "char", grapheme: seg.segment, width: stringWidth(seg.segment) })
    }
  }

  return tokens
}

function wrapWithPrefix(value: string, prefix: string, width: number, continuationPrefix?: string): string[] {
  const prefixPlainWidth = stringWidth(stripAnsi(prefix))
  if (prefixPlainWidth >= width) {
    return [
      ...wrapText(prefix.trimEnd(), width),
      ...wrapText(value, width),
    ]
  }
  const available = Math.max(1, width - prefixPlainWidth)
  const wrapped = wrapText(value, available)
  const continuation = continuationPrefix !== undefined ? continuationPrefix : " ".repeat(prefixPlainWidth)
  return wrapped.map((line, index) => `${index === 0 ? prefix : continuation}${line}`)
}

function wrapText(value: string, width: number): string[] {
  const sourceLines = value.split("\n")
  return sourceLines.flatMap((line) => wrapLine(line, width))
}

function wrapLine(value: string, width: number): string[] {
  if (value === "") return [""]
  const tokens = tokenizeAnsi(value)
  const lines: string[] = []
  let currentLine = ""
  let currentWidth = 0
  let activeStyles = ""

  for (const token of tokens) {
    if (token.type === "ansi") {
      currentLine += token.sequence
      if (token.sequence === "\u001b[0m" || token.sequence === "\u001b[m") {
        activeStyles = ""
      } else {
        activeStyles += token.sequence
      }
      continue
    }

    const charWidth = token.width
    if (charWidth === 0) {
      currentLine += token.grapheme
      continue
    }

    if (currentWidth + charWidth > width && currentWidth > 0) {
      lines.push(currentLine + (activeStyles ? "\u001b[0m" : ""))
      currentLine = activeStyles + token.grapheme
      currentWidth = charWidth
    } else {
      currentLine += token.grapheme
      currentWidth += charWidth
    }
  }

  if (currentLine || lines.length === 0) {
    lines.push(currentLine)
  }

  return lines
}

function fitToWidth(value: string, width: number): string {
  if (width <= 0) return ""
  const tokens = tokenizeAnsi(value)
  let result = ""
  let used = 0
  let hasAnsi = false

  for (const token of tokens) {
    if (token.type === "ansi") {
      result += token.sequence
      hasAnsi = true
      continue
    }
    if (used + token.width > width) break
    result += token.grapheme
    used += token.width
  }

  if (hasAnsi && !result.endsWith("\u001b[0m")) {
    result += "\u001b[0m"
  }
  return result
}
