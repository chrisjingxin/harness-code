/**
 * 解析 Harness ACP `/undo list` 返回的回合文本并生成精确回退命令。
 */

export type UndoMode = "both" | "code" | "conversation"

export type UndoChoiceItem = {
  readonly turnNumber: number
  readonly summary: string
  readonly filesNote?: string
}

/** 仅识别以「可回退的回合」开头且至少包含一条 `#N ...` 列表项的助手消息。 */
export function parseUndoListMessage(text: string): UndoChoiceItem[] | null {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length < 2) return null
  if (!lines[0]!.startsWith("可回退的回合")) return null

  const items: UndoChoiceItem[] = []
  for (const line of lines.slice(1)) {
    const match = /^-\s*#(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const turnNumber = Number(match[1])
    if (!Number.isSafeInteger(turnNumber) || turnNumber < 1) continue
    const rawBody = match[2]!.trim()
    const filesMatch = /^(.*?)（(涉及\s*\d+\s*个文件)）$/.exec(rawBody)
    if (filesMatch) {
      items.push({
        turnNumber,
        summary: filesMatch[1]!.trim() || `第 ${turnNumber} 轮`,
        filesNote: filesMatch[2]!,
      })
    } else {
      items.push({
        turnNumber,
        summary: rawBody,
      })
    }
  }
  return items.length > 0 ? items : null
}

/** 构造发送给 ACP 内核的精确回退斜杠命令。 */
export function buildUndoCommand(turnNumber: number, mode: UndoMode): string {
  return `/undo ${turnNumber} ${mode}`
}
