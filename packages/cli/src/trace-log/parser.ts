/** 内网 Trace 日志纯解析：marker 提取、start/end 合并与会话字段解释。 */
import type { TraceSpanEvent } from "../presentation-coordinator/contracts/trace"
const LOG_MARKER = "[[za38-log]]"

function extractAllMarkerJson(text: string): readonly Record<string, unknown>[] {
  const results: Record<string, unknown>[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(LOG_MARKER, cursor)
    if (start < 0) break
    const afterStart = text.indexOf(LOG_MARKER, start + LOG_MARKER.length)
    if (afterStart < 0) break
    const jsonText = text.slice(start + LOG_MARKER.length, afterStart)
    cursor = afterStart + LOG_MARKER.length
    try {
      const parsed = JSON.parse(jsonText)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        results.push(parsed as Record<string, unknown>)
      }
    } catch {
      // 畸形条目跳过。
    }
  }
  return results
}

/** 把一条日志归一化为 TraceSpanEvent。 */
function normalizeSpan(traceId: string, spanId: string, json: Record<string, unknown>): TraceSpanEvent {
  const raw = { ...json }
  const metadata = typeof json.metadata === "object" && json.metadata !== null && !Array.isArray(json.metadata)
    ? json.metadata as Record<string, unknown>
    : {}
  const threadId = extractThreadId(json, metadata)
  const startTime = typeof json.start_time === "number" && Number.isFinite(json.start_time) ? json.start_time : 0
  const hasEnd = typeof json.end_time === "number" && Number.isFinite(json.end_time)
  const endTime = hasEnd ? json.end_time as number : null
  const durationMs = typeof json.duration_ms === "number" && Number.isFinite(json.duration_ms)
    ? json.duration_ms
    : hasEnd
      ? Math.max(0, endTime! - startTime)
      : null
  const parentSpanId = typeof json.parent_span_id === "string"
    ? json.parent_span_id === "0" || json.parent_span_id === spanId ? null : json.parent_span_id
    : null
  return {
    traceId,
    spanId,
    parentSpanId,
    name: typeof json.name === "string" ? json.name : typeof json.method === "string" ? json.method : "span",
    type: typeof json.type === "string" ? json.type : undefined,
    startTime,
    endTime,
    durationMs,
    status: typeof json.status === "string" ? json.status : undefined,
    metadata,
    threadId,
    raw,
  }
}

/** 从日志 JSON/metadata 提取 thread_id 归属。覆盖真实 SDK 日志的多种载体： */
export function extractThreadId(json: Record<string, unknown>, metadata: Record<string, unknown>): string | null {
  const candidates: unknown[] = []
  if (json.thread_id !== undefined) candidates.push(json.thread_id)
  if (metadata.thread_id !== undefined) candidates.push(metadata.thread_id)
  // SDK 日志的 sessionId：thread 绑定（值为 "-" 时表示未绑定，跳过）。
  const sessionId = (metadata as Record<string, unknown>).sessionId
  if (sessionId !== undefined && sessionId !== "-") candidates.push(sessionId)
  // 自定义元数据（HC-180 挂载点）：custom_metadata.thread_id / custom_metadata.sessionId。
  const custom = metadata.custom_metadata as Record<string, unknown> | undefined
  if (custom && typeof custom === "object") {
    if (custom.thread_id !== undefined) candidates.push(custom.thread_id)
    if (custom.sessionId !== undefined && custom.sessionId !== "-") candidates.push(custom.sessionId)
  }
  // run.accept 的 metadata.input.command 内含 thread_id；context.project 的 input 同理。
  const input = metadata.input as Record<string, unknown> | undefined
  if (input && typeof input === "object") {
    if (typeof input.thread_id === "string") candidates.push(input.thread_id)
    const command = input.command as Record<string, unknown> | undefined
    if (command && typeof command === "object" && typeof command.thread_id === "string") candidates.push(command.thread_id)
    // command 是 StartRun(...) repr 字符串时，thread_id 以 'xxx' 引号形式出现（真实 SDK 日志）。
    if (typeof input.command === "string") {
      const match = /thread_id='([^']*)'/.exec(input.command)
      if (match && match[1] !== "") candidates.push(match[1])
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return null
}

/** 跨文件共享 start/end 缓冲，不保留整份日志文本；同键按内网既有规则合并。 */
export class TraceLogParser {
  private readonly starts = new Map<string, Record<string, unknown>>()
  private readonly ends = new Map<string, Record<string, unknown>>()
  private readonly keys = new Set<string>()

  /** 累计去重后的节点数，供历史服务在构造结果前检查资源上限。 */
  get size(): number { return this.keys.size }

  /** 接收一份完整日志；同一物理行内的多个 marker 都会解析，畸形记录跳过。 */
  pushText(text: string): void {
    for (const json of extractAllMarkerJson(text)) {
      const spanId = typeof json.span_id === "string" ? json.span_id : undefined
      if (!spanId) continue
      const traceId = typeof json.trace_id === "string" ? json.trace_id : "unknown-trace"
      const key = JSON.stringify([traceId, spanId])
      this.keys.add(key)
      if (typeof json.end_time === "number") {
        if (!this.ends.has(key)) this.ends.set(key, json)
      } else this.starts.set(key, json)
    }
  }

  /** 所有文件读完后统一归一化，结束记录优先，父节点与输入仍可来自 start。 */
  snapshot(): TraceSpanEvent[] {
    const spans: TraceSpanEvent[] = []
    for (const [key, endJson] of this.ends) {
      const startJson = this.starts.get(key)
      const mergedJson = { ...startJson, ...endJson }
      // 父子关系以 start 日志为准（对齐 Tailer 单批逻辑与 trace_viewer._merge_trace_method_entries）。
      const startParent = startJson && typeof startJson.parent_span_id === "string" ? startJson.parent_span_id : undefined
      const endParent = typeof endJson.parent_span_id === "string" ? endJson.parent_span_id : undefined
      mergedJson.parent_span_id = startParent ?? endParent ?? "0"
      const startMeta = startJson && typeof startJson.metadata === "object" && startJson.metadata !== null
        ? startJson.metadata as Record<string, unknown>
        : {}
      const endMeta = typeof endJson.metadata === "object" && endJson.metadata !== null
        ? endJson.metadata as Record<string, unknown>
        : {}
      if (Object.keys(startMeta).length > 0 || Object.keys(endMeta).length > 0) {
        mergedJson.metadata = { ...startMeta, ...endMeta }
      }
      const [traceId, spanId] = JSON.parse(key) as [string, string]
      spans.push(normalizeSpan(traceId, spanId, mergedJson))
    }
    for (const [key, startJson] of this.starts) {
      if (this.ends.has(key)) continue
      const [traceId, spanId] = JSON.parse(key) as [string, string]
      spans.push(normalizeSpan(traceId, spanId, startJson))
    }
    return spans
  }
}

/** 批量解析单份完整日志；跨文件读取时由同一个 TraceLogParser 累计。 */
export function parseTraceText(text: string): TraceSpanEvent[] {
  const parser = new TraceLogParser()
  parser.pushText(text)
  return parser.snapshot()
}
