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
