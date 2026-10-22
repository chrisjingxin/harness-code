/** 从 write/edit 工具参数里抽出路径和正文，避免把整段 JSON 当 UI。 */

/** edit_file 的一处精确替换。 */
export type FileEdit = { oldString: string; newString: string }

export type FileMutationArgs = {
  path: string | null
  content: string | null
  /** edit_file 的 edits[]；流式传输中只含已完整到达的项，没有任何完整项时为 null。 */
  edits: FileEdit[] | null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** 只认 file_path/path 与 content；完整 JSON 优先，流式残片用字段扫描。 */
export function parseFileMutationArgs(raw: string): FileMutationArgs {
  if (!raw.trim()) return { path: null, content: null, edits: null }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      path: asNonEmptyString(parsed.file_path) ?? asNonEmptyString(parsed.path),
      content: typeof parsed.content === "string" ? parsed.content : null,
      edits: toFileEdits(parsed.edits),
    }
  } catch {
    return {
      path: extractJsonStringField(raw, "file_path") ?? extractJsonStringField(raw, "path"),
      content: extractJsonStringField(raw, "content"),
      edits: extractCompletedEdits(raw),
    }
  }
}

/** 完整 JSON 里的 edits：只保留恰好带两个字符串字段的项；没有可用项返回 null。 */
function toFileEdits(value: unknown): FileEdit[] | null {
  if (!Array.isArray(value)) return null
  const edits: FileEdit[] = []
  for (const item of value) {
    if (item === null || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (typeof record.old_string === "string" && typeof record.new_string === "string") {
      edits.push({ oldString: record.old_string, newString: record.new_string })
    }
  }
  return edits.length > 0 ? edits : null
}

/** 返回以 start 处 `{` 开头的 JSON 对象的结束位置（不含）；对象尚未闭合返回 -1。 */
function findObjectEnd(raw: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (char === "\\") index += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return -1
}

/** 流式未闭合 JSON：只取 edits 数组里已经完整到达的对象，半截项先不展示。 */
function extractCompletedEdits(raw: string): FileEdit[] | null {
  const header = /"edits"\s*:\s*\[/.exec(raw)
  if (!header) return null
  let index = header.index + header[0].length
  const collected: unknown[] = []
  while (index < raw.length) {
    while (index < raw.length && /[\s,]/.test(raw[index] ?? "")) index += 1
    if (raw[index] !== "{") break
    const end = findObjectEnd(raw, index)
    if (end < 0) break
    try {
      collected.push(JSON.parse(raw.slice(index, end)))
    } catch {
      break
    }
    index = end
  }
  return toFileEdits(collected)
}

/** 从可能未闭合的 JSON 里抽出一个字符串字段；未结束的 content 返回已到达部分。 */
function extractJsonStringField(raw: string, field: string): string | null {
  const header = new RegExp(`"${field}"\\s*:\\s*"`)
  const match = header.exec(raw)
  if (!match) return null
  let index = match.index + match[0].length
  let value = ""
  while (index < raw.length) {
    const char = raw[index]
    if (char === "\\") {
      if (index + 1 >= raw.length) return value || null
      const next = raw[index + 1]
      if (next === "n") value += "\n"
      else if (next === "t") value += "\t"
      else if (next === "r") value += "\r"
      else if (next === '"') value += '"'
      else if (next === "\\") value += "\\"
      else if (next === "/") value += "/"
      else if (next === "u" && index + 5 < raw.length) {
        value += String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 6), 16))
        index += 6
        continue
      } else value += next
      index += 2
      continue
    }
    if (char === '"') return value
    value += char
    index += 1
  }
  return value || null
}

/** 从工具结果 JSON 抽出恢复展示用的路径和正文窗口。 */
export function parseToolResultPreview(raw: string): FileMutationArgs {
  if (!raw.trim()) return { path: null, content: null, edits: null }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      path: asNonEmptyString(parsed.path) ?? asNonEmptyString(parsed.file_path),
      content: typeof parsed.content === "string" ? parsed.content : null,
      edits: null,
    }
  } catch {
    return { path: null, content: null, edits: null }
  }
}

/** 展示用短路径：取最后两段，避免占满终端。 */
export function shortMutationPath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  if (parts.length <= 2) return parts.join("/") || path
  return parts.slice(-2).join("/")
}

/** 用 old/new 替换片段生成可被 Diff renderer 消费的 unified diff。 */
export function unifiedDiffFromReplacement(path: string, oldText: string, newText: string): string {
  return unifiedDiffFromEdits(path, [{ oldString: oldText, newString: newText }])
}

/**
 * 把一批 edits 合成一份多 hunk 的 unified diff。
 * 参数里没有文件全文，行号只能是相对序号：各 hunk 的起始行依次顺延，避免互相重叠。
 */
export function unifiedDiffFromEdits(path: string, edits: readonly FileEdit[]): string {
  const file = path.replace(/^\//, "") || "file"
  const hunks: string[] = []
  let oldBase = 0
  let newBase = 0
  for (const edit of edits) {
    hunks.push(...replacementHunk(edit.oldString, edit.newString, oldBase, newBase))
    oldBase += edit.oldString.split("\n").length + 1
    newBase += edit.newString.split("\n").length + 1
  }
  return [`--- a/${file}`, `+++ b/${file}`, ...hunks].join("\n")
}

function replacementHunk(oldText: string, newText: string, oldBase: number, newBase: number): string[] {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }
  const removed = oldLines.slice(start, oldEnd)
  const added = newLines.slice(start, newEnd)
  return [
    `@@ -${oldBase + start + 1},${removed.length} +${newBase + start + 1},${added.length} @@`,
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
  ]
}
