/**
 * 文件提及的纯输入策略，从旧 Web 的词法与八行窗口迁出。
 * 这里只处理字符串和光标，不访问设备、目录或文件内容。
 */
export type MentionToken = { readonly query: string; readonly start: number; readonly end: number; readonly quoted: boolean }

/** 仅在行首或空白之后识别 @，避免把邮箱识别成文件提及。 */
export function extractMentionToken(text: string, cursor: number): MentionToken | null {
  if (cursor < 0 || cursor > text.length) return null
  const prefix = text.slice(0, cursor)
  const quoted = prefix.match(/(?:^|\s)@"([^"]*)$/)
  if (quoted && quoted.index !== undefined) {
    return { query: quoted[1] ?? "", start: quoted.index + quoted[0].indexOf('@"'), end: cursor, quoted: true }
  }
  const plain = prefix.match(/(?:^|\s)@([^\s"']*)$/)
  if (!plain || plain.index === undefined) return null
  return { query: plain[1] ?? "", start: plain.index + plain[0].indexOf("@"), end: cursor, quoted: false }
}

/** 文件选择只替换当前 token；返回的光标位置由调用方与草稿一起保存。 */
export function replaceMentionToken(text: string, token: MentionToken, relativePath: string): { text: string; cursor: number } {
  const formatted = token.quoted || /\s/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`
  const before = text.slice(0, token.start)
  const replacement = `${formatted} `
  return { text: `${before}${replacement}${text.slice(token.end).trimStart()}`, cursor: before.length + replacement.length }
}

/** 在选区位置插入 `@` 触发符；若前一个字符非空白，自动补前导空格以便识别提及词元。 */
export function insertMentionTrigger(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(text.length, selectionStart))
  const end = Math.max(start, Math.min(text.length, selectionEnd))
  const needsSpace = start > 0 && !/\s/.test(text[start - 1]!)
  const insertion = needsSpace ? " @" : "@"
  return {
    text: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    cursor: start + insertion.length,
  }
}

/** 合并追加本机文件或目录附件路径并按原顺序去重。 */
export function mergeAttachmentPaths(current: readonly string[], additions: readonly string[]): string[] {
  return [...new Set([...current, ...additions].filter(item => item.length > 0))]
}

export type ComposerHighlightSegment = {
  readonly kind: "plain" | "mention" | "command"
  readonly text: string
}

const LEADING_COMMAND_PATTERN = /^(\s*)(\/[a-zA-Z][\w:-]*)(?=\s|$)/
const LEADING_COMMAND_WITH_SPACE_PATTERN = /^(\s*)(\/[a-zA-Z][\w:-]*)([ \t])/

/** 将输入与用户消息正文切分为普通文本、行首 `/命令` 与 `@引用` 段，不改变原有字符长度与空格，确保输入框叠层光标对齐。 */
export function splitComposerHighlightSegments(
  text: string,
  options?: {
    readonly includeBareLeadingCommand?: boolean
    readonly commandIds?: readonly string[]
  },
): ComposerHighlightSegment[] {
  const segments: ComposerHighlightSegment[] = []
  let restStart = 0
  const commandMatch = LEADING_COMMAND_PATTERN.exec(text)
  if (commandMatch) {
    const leadingWhitespace = commandMatch[1] ?? ""
    const commandToken = commandMatch[2] ?? ""
    const cmdEnd = leadingWhitespace.length + commandToken.length
    const hasFollowingWhitespace = cmdEnd < text.length && /\s/.test(text[cmdEnd]!)
    const commandName = commandToken.slice(1).toLowerCase()
    const matchesKnownCommand = Boolean(options?.commandIds?.some(id => id.toLowerCase() === commandName))
    const atEndOfText = cmdEnd === text.length
    if (hasFollowingWhitespace || (atEndOfText && (options?.includeBareLeadingCommand || matchesKnownCommand))) {
      if (leadingWhitespace) segments.push({ kind: "plain", text: leadingWhitespace })
      segments.push({ kind: "command", text: commandToken })
      restStart = cmdEnd
    }
  }

  const rest = restStart > 0 ? text.slice(restStart) : text
  if (rest.length > 0) {
    if (!rest.includes("@")) {
      segments.push({ kind: "plain", text: rest })
    } else {
      const pattern = /(^|\s)(@"(?:[^"\n]*)"|@[^\s@]+)/g
      let cursor = 0
      for (const match of rest.matchAll(pattern)) {
        const start = match.index ?? 0
        const leadingSpace = match[1] ?? ""
        const mention = match[2] ?? ""
        const mentionStart = start + leadingSpace.length
        if (mentionStart > cursor) {
          segments.push({ kind: "plain", text: rest.slice(cursor, mentionStart) })
        }
        if (mention) {
          segments.push({ kind: "mention", text: mention })
        }
        cursor = mentionStart + mention.length
      }
      if (cursor < rest.length) {
        segments.push({ kind: "plain", text: rest.slice(cursor) })
      }
    }
  }

  return segments.length > 0 ? segments : [{ kind: "plain", text: "" }]
}

/** 当光标停留在行首 `/command` 结尾或紧随空格后按 Backspace 时，整块删除命令并保留后续正文。 */
export function removeLeadingCommandOnBackspace(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { readonly text: string; readonly cursor: number } | null {
  if (selectionStart !== selectionEnd) return null
  const match = LEADING_COMMAND_WITH_SPACE_PATTERN.exec(text)
  if (!match) return null
  const cmdStart = match[1]!.length
  const cmdEnd = cmdStart + match[2]!.length
  const afterSpace = cmdEnd + 1
  if (selectionStart !== afterSpace && selectionStart !== cmdEnd) return null
  return {
    text: `${text.slice(0, cmdStart)}${text.slice(afterSpace)}`,
    cursor: cmdStart,
  }
}

/** 在行首应用或替换斜杠命令（已有命令时直接替换而不叠加），并定位光标到命令空格之后。 */
export function applyLeadingSlashCommand(
  text: string,
  commandId: string,
): { readonly text: string; readonly cursor: number } {
  const commandPrefix = `/${commandId} `
  const cursor = commandPrefix.length
  if (/^\s*\/[^\s/]*$/.test(text)) {
    return { text: commandPrefix, cursor }
  }
  const existing = /^(\s*)\/[a-zA-Z][\w:-]*([ \t]+|$)/.exec(text)
  if (existing) {
    return { text: `${commandPrefix}${text.slice(existing[0].length)}`, cursor }
  }
  if (text.trim().length > 0) {
    return { text: `${commandPrefix}${text}`, cursor }
  }
  return { text: commandPrefix, cursor }
}

/** 选中项始终留在最多八行的窗口内；首尾移动不循环。 */
export function mentionWindow(selected: number, start: number, count: number): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 }
  const rows = 8
  const current = Math.max(0, Math.min(count - 1, selected))
  const maxStart = Math.max(0, count - rows)
  let nextStart = Math.max(0, Math.min(maxStart, start))
  if (current < nextStart) nextStart = current
  if (current >= nextStart + rows) nextStart = current - rows + 1
  return { start: nextStart, end: Math.min(count, nextStart + rows) }
}
