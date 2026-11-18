/**
 * ACP 工具更新 → 本机工具显示值：把 rawInput、rawOutput、content 提炼成可读文本、差异块和终端引用。
 *
 * 更新是增量语义：缺失字段必须保持缺省（undefined），不能凭空置空，合并由视图层完成；
 * 超长文本截断并追加明确标记，防止一次输出把通知撑爆。
 */
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk"
import type { LocalAcpTool, LocalAcpToolLocation } from "./index.js"

const INPUT_LIMIT = 16 * 1024
const OUTPUT_LIMIT = 64 * 1024
const DIFF_TEXT_LIMIT = 32 * 1024
const DIFF_LIMIT = 8
const MAX_LOCATIONS = 8
const MAX_TERMINAL_ID = 256
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/
const TRUNCATED = "\n…（内容过长，已截断）"

/** 超长文本按字符截断并附截断说明，让界面能看出内容不完整。 */
function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}${TRUNCATED}` : text
}

/** rawInput 原样保留字符串，其余值用美化 JSON 展示。 */
function toInput(rawInput: unknown): string | undefined {
  if (rawInput === undefined || rawInput === null) return undefined
  const text = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2)
  return text === undefined || text === "" ? undefined : truncate(text, INPUT_LIMIT)
}

/** content 的正文片段优先；没有文本时退回 rawOutput；两者皆无则保持缺省。 */
function toOutput(update: ToolCall | ToolCallUpdate): string | undefined {
  const items = update.content ?? []
  const texts = items.flatMap(item =>
    item.type === "content" && item.content.type === "text" && item.content.text ? [item.content.text] : [],
  )
  let text = texts.length ? texts.join("\n") : undefined
  if (text === undefined) {
    const raw = update.rawOutput
    if (raw !== undefined && raw !== null) text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)
  }
  return text === undefined || text === "" ? undefined : truncate(text, OUTPUT_LIMIT)
}

/** content 的 diff 项转成可显示的 {path, oldText, newText}。 */
function toDiffs(update: ToolCall | ToolCallUpdate): LocalAcpTool["diffs"] {
  const items = update.content ?? []
  const diffs = items.flatMap(item =>
    item.type === "diff" ? [{ path: item.path, oldText: item.oldText ?? undefined, newText: item.newText }] : [],
  ).slice(0, DIFF_LIMIT)
  if (!diffs.length) return undefined
  return diffs.map(diff => ({
    path: diff.path,
    oldText: diff.oldText === undefined ? undefined : truncate(diff.oldText, DIFF_TEXT_LIMIT),
    newText: truncate(diff.newText, DIFF_TEXT_LIMIT),
  }))
}

/** 提取首个合法的终端引用标识，过滤控制字符与空白串。 */
function toTerminalId(update: ToolCall | ToolCallUpdate): string | undefined {
  const items = update.content ?? []
  for (const item of items) {
    if (item.type !== "terminal" || typeof item.terminalId !== "string") continue
    const trimmed = item.terminalId.trim()
    if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) continue
    return trimmed.slice(0, MAX_TERMINAL_ID)
  }
  return undefined
}

/** 提取并清洗工具关联路径，过滤控制字符与无效行号，并限制上限以防 IPC 载荷膨胀。 */
function toLocations(locations: (ToolCall | ToolCallUpdate)["locations"]): readonly LocalAcpToolLocation[] | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined
  const items: LocalAcpToolLocation[] = []
  for (const item of locations) {
    if (!item || typeof item.path !== "string") continue
    const path = item.path.trim()
    if (!path || CONTROL_CHAR_PATTERN.test(path)) continue
    const line = typeof item.line === "number" && Number.isSafeInteger(item.line) && item.line > 0 ? item.line : undefined
    items.push(line === undefined ? { path } : { path, line })
    if (items.length >= MAX_LOCATIONS) break
  }
  return items.length > 0 ? items : undefined
}

/** 单条 tool_call / tool_call_update 通知的显示投影；未携带的字段一律缺省。 */
export function toLocalAcpTool(update: ToolCall | ToolCallUpdate): LocalAcpTool {
  const terminalId = toTerminalId(update)
  return {
    id: update.toolCallId,
    title: update.title ?? undefined,
    status: update.status ?? undefined,
    kind: update.kind ?? undefined,
    input: toInput(update.rawInput),
    output: toOutput(update),
    diffs: toDiffs(update),
    locations: toLocations(update.locations),
    ...(terminalId !== undefined ? { terminalId } : {}),
  }
}
