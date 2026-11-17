/**
 * ACP 工具更新 → 本机工具显示值：把 rawInput、rawOutput、content 提炼成可读文本和差异块。
 *
 * 更新是增量语义：缺失字段必须保持缺省（undefined），不能凭空置空，合并由视图层完成；
 * 终端类内容不映射，超长文本截断并追加明确标记，防止一次输出把通知撑爆。
 */
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk"
import type { LocalAcpTool } from "./index.js"

const INPUT_LIMIT = 16 * 1024
const OUTPUT_LIMIT = 64 * 1024
const DIFF_TEXT_LIMIT = 32 * 1024
const DIFF_LIMIT = 8
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

/** content 的 diff 项转成可显示的 {path, oldText, newText}；终端项忽略。 */
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

/** 单条 tool_call / tool_call_update 通知的显示投影；未携带的字段一律缺省。 */
export function toLocalAcpTool(update: ToolCall | ToolCallUpdate): LocalAcpTool {
  return {
    id: update.toolCallId,
    title: update.title ?? undefined,
    status: update.status ?? undefined,
    kind: update.kind ?? undefined,
    input: toInput(update.rawInput),
    output: toOutput(update),
    diffs: toDiffs(update),
  }
}
