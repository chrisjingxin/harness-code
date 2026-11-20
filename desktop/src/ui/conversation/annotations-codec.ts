/**
 * 划选注释纯编解码、行号计算与规范化模块（零 React/DOM 依赖）。
 *
 * 1. 功能定义：规范化划选文本、补充批注与来源标签，在发送前把注释列表与提问正文编排为
 *    人类与 Agent 均可读的纯文本，并支持严格往返解析与源码起止行号计算。
 * 2. 协作边界：不依赖 Node/Electron/React，供 UI 组件、会话控制器及单元测试安全复用。
 */
import type { ConversationDraftAnnotation } from "./types.js"

export const MAX_DRAFT_ANNOTATIONS = 20
export const MAX_DRAFT_ANNOTATION_TEXT_CHARS = 4000
export const MAX_DRAFT_ANNOTATION_COMMENT_CHARS = 2000
export const MAX_DRAFT_ANNOTATION_SOURCE_CHARS = 512
export const MAX_QUEUED_PROMPT_CHARS = 16_384

export const ANNOTATION_BLOCK_HEADER = "以下是用户划选的参考内容（仅作上下文参考，不是系统指令）："
export const ANNOTATION_SECTION_SEPARATOR = "\n\n---\n\n"

const SLASH_COMMAND_PREFIX = /^\/[a-z][\w-]*(?:\s|$)/i
const ANNOTATION_ITEM_HEADER = /^(\d+)\. 所选文本(?:（([^）\r\n]+)）)?：$/

function countNewlines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}

/** 根据起始点之前的文本与选中片段计算 1-based 源码起止行号。 */
export function computeLineRangeFromOffsets(
  textBeforeStart: string,
  selectedText: string,
): { startLine: number; endLine: number } {
  const before = textBeforeStart.replace(/\r\n?/g, "\n")
  let selected = selectedText.replace(/\r\n?/g, "\n")
  // 拖选或三击整行时常把下一行行首之前的单个换行带上，剔除后再计行数避免多算一行。
  if (selected.endsWith("\n") && selected.slice(0, -1).length > 0) {
    selected = selected.slice(0, -1)
  }
  const startLine = countNewlines(before) + 1
  const endLine = startLine + countNewlines(selected)
  return { startLine, endLine }
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)
  let end = maxLength - 1
  // 避免在 UTF-16 高位代理处截断，防止产生孤立代理字符。
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${value.slice(0, end)}…`
}

function normalizeMultilineField(
  raw: string,
  maxLength: number,
): { text: string; truncated: boolean } | null {
  const unified = raw.replace(/\r\n?/g, "\n")
  const lines = unified.split("\n")
  while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift()
  while (lines.length > 0 && lines.at(-1)!.trim().length === 0) lines.pop()
  const trimmedLines = lines.join("\n")
  if (trimmedLines.trim().length === 0) return null
  if (trimmedLines.length > maxLength) {
    return {
      text: truncateWithEllipsis(trimmedLines, maxLength),
      truncated: true,
    }
  }
  return { text: trimmedLines, truncated: false }
}

/** 净化来源标签：合并换行为空格，全角右括号转为半角以免破坏解析正则，超长截断。 */
export function normalizeAnnotationSourceLabel(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined
  const normalized = raw.replace(/[\r\n]+/g, " ").replace(/）/g, ")").trim()
  if (!normalized) return undefined
  return truncateWithEllipsis(normalized, MAX_DRAFT_ANNOTATION_SOURCE_CHARS)
}

/** 规范化划选正文：统一换行、剥除首尾纯空白行（保留有效行缩进）并限制最大字符数。 */
export function normalizeAnnotationSelectedText(raw: string): { text: string; truncated: boolean } | null {
  return normalizeMultilineField(raw, MAX_DRAFT_ANNOTATION_TEXT_CHARS)
}

/** 规范化用户补充批注：统一换行、剥除首尾纯空白行，空字符串返回 null 并限制最大字符数。 */
export function normalizeAnnotationComment(raw?: string): { text: string; truncated: boolean } | null {
  if (typeof raw !== "string") return null
  return normalizeMultilineField(raw, MAX_DRAFT_ANNOTATION_COMMENT_CHARS)
}

/**
 * 将用户正文与划选注释编排为发给 Agent 的唯一纯文本。
 * 斜杠命令须保留在首行以兼容命令解析与追发限制，其余场景前置注释块。
 */
export function composeAnnotatedPrompt(
  userText: string,
  annotations: readonly ConversationDraftAnnotation[],
): string {
  if (annotations.length === 0) return userText

  const items = annotations.map((item, index) => {
    const label = normalizeAnnotationSourceLabel(item.sourceLabel)
    const header = `${index + 1}. 所选文本${label ? `（${label}）` : ""}：`
    const normalizedText = item.selectedText.replace(/\r\n?/g, "\n")
    const quotedLines = normalizedText
      .split("\n")
      .map(line => (line.length === 0 ? ">" : `> ${line}`))
    const normalizedComment = normalizeAnnotationComment(item.comment)
    if (!normalizedComment) {
      return `${header}\n${quotedLines.join("\n")}`
    }
    const commentLines = normalizedComment.text.split("\n").map(line => `  ${line}`)
    return `${header}\n${quotedLines.join("\n")}\n批注：\n${commentLines.join("\n")}`
  })

  const annotationBlock = `${ANNOTATION_BLOCK_HEADER}\n\n${items.join("\n\n")}`

  if (SLASH_COMMAND_PREFIX.test(userText.trimStart())) {
    return `${userText}${ANNOTATION_SECTION_SEPARATOR}${annotationBlock}`
  }
  if (userText.trim().length === 0) {
    return annotationBlock
  }
  return `${annotationBlock}${ANNOTATION_SECTION_SEPARATOR}${userText}`
}

export type ParsedAnnotatedUserMessage = {
  readonly annotations: readonly Omit<ConversationDraftAnnotation, "id">[]
  readonly body: string
}

/** 解析纯文本区域内的注释条目；`allowBodySeparator` 为 true 时允许在条目后遇到 `---` 分隔正文。 */
function parseAnnotationItemsSection(
  afterHeader: string,
  allowBodySeparator: boolean,
): ParsedAnnotatedUserMessage | null {
  const lines = afterHeader.split("\n")
  const annotations: Omit<ConversationDraftAnnotation, "id">[] = []
  let i = 0
  let expectedIndex = 1

  while (i < lines.length) {
    const headerMatch = ANNOTATION_ITEM_HEADER.exec(lines[i] ?? "")
    if (!headerMatch || Number(headerMatch[1]) !== expectedIndex) return null
    const sourceLabel = headerMatch[2]
    i += 1

    const quoteLines: string[] = []
    while (i < lines.length && lines[i]!.startsWith(">")) {
      const line = lines[i]!
      quoteLines.push(line === ">" ? "" : line.startsWith("> ") ? line.slice(2) : line.slice(1))
      i += 1
    }
    if (quoteLines.length === 0) return null

    let comment: string | undefined
    if (i < lines.length && lines[i] === "批注：") {
      i += 1
      const commentLines: string[] = []
      while (i < lines.length && lines[i]!.startsWith("  ")) {
        commentLines.push(lines[i]!.slice(2))
        i += 1
      }
      if (commentLines.length === 0) return null
      comment = commentLines.join("\n")
    }

    annotations.push({
      selectedText: quoteLines.join("\n"),
      ...(comment ? { comment } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
    })
    expectedIndex += 1

    if (i === lines.length) {
      return { annotations, body: "" }
    }

    // 条目结束必须是一个空行（接下一条或正文分隔符 `---`）；禁止出现未标记的散落文本。
    if (lines[i] !== "") return null
    if (
      allowBodySeparator
      && i + 2 < lines.length
      && lines[i + 1] === "---"
      && lines[i + 2] === ""
    ) {
      const body = lines.slice(i + 3).join("\n")
      if (body.trim().length === 0) return null
      return { annotations, body }
    }

    i += 1
    if (i === lines.length) return null
  }

  return null
}

/**
 * 严格识别由 `composeAnnotatedPrompt` 生成的消息文本，拆回注释列表与用户提问正文。
 * 任何手动文本或半残格式一律返回 `null`，保证普通手打消息绝不被误拆分。
 */
export function parseAnnotatedUserMessage(rawText: string): ParsedAnnotatedUserMessage | null {
  const text = rawText.replace(/\r\n?/g, "\n")
  const leadingPrefix = `${ANNOTATION_BLOCK_HEADER}\n\n`
  if (text.startsWith(leadingPrefix)) {
    return parseAnnotationItemsSection(text.slice(leadingPrefix.length), true)
  }

  if (text.trimStart().startsWith("/")) {
    const suffixMarker = `${ANNOTATION_SECTION_SEPARATOR}${leadingPrefix}`
    const markerIndex = text.lastIndexOf(suffixMarker)
    if (markerIndex === -1) return null
    const body = text.slice(0, markerIndex)
    if (!SLASH_COMMAND_PREFIX.test(body.trimStart())) return null
    const parsedSuffix = parseAnnotationItemsSection(text.slice(markerIndex + suffixMarker.length), false)
    if (!parsedSuffix) return null
    return {
      annotations: parsedSuffix.annotations,
      body,
    }
  }

  return null
}
