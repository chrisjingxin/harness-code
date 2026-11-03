/** 内网 SDK 日志消费宿主：解析 stderr 成对 marker，串行落盘索引并发布实时 Span。 */
import { constants } from "node:fs"
import { mkdir, open, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import type { TraceSpanEvent } from "../presentation-coordinator/contracts/trace"
import { createTraceHistorySource, type TraceHistorySource } from "./history"
import { parseTraceText } from "./parser"

const MARKER = "[[za38-log]]"
const RECORD_LIMIT = 8 * 1024 * 1024
const CACHE_LIMIT = 128 * 1024 * 1024
/** 实时来源端口；不要求浏览器或网关知道 SDK、进程和文件。 */
export interface TraceLiveSource {
  snapshot(): readonly TraceSpanEvent[]
  subscribe(listener: (span: TraceSpanEvent) => void): () => void
}
export interface TraceRuntime extends TraceHistorySource, TraceLiveSource {
  push(chunk: Uint8Array): void
  flush(): Promise<void>
  close(): Promise<void>
}
export type TraceRuntimeOptions = { root?: string; file?: string; startedAtMs?: number; onError?: (message: string) => void }

/** 沿用内网日期目录、秒级文件名与 HARNESS_ZA38_TRACE_LOG 开关。 */
export function createTraceRuntime(options: TraceRuntimeOptions = {}): TraceRuntime {
  const root = resolve(options.root ?? join(homedir(), ".harness", "trace"))
  const date = new Date(options.startedAtMs ?? Date.now())
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const stamp = `${day.replaceAll("-", "")}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const target = options.file ?? (process.env.HARNESS_ZA38_TRACE_LOG || join(root, day, `za38-trace-${stamp}.log`))
  return new TraceRuntimeImpl(root, target, options.onError)
}

class TraceRuntimeImpl implements TraceRuntime {
  private readonly decoder = new StringDecoder("utf8")
  private buffer = ""
  private accepting = true
  private failed = false
  private pending = Promise.resolve()
  private queuedBytes = 0
  private cacheBytes = 0
  private log: FileHandle | undefined
  private index: FileHandle | undefined
  private closing: Promise<void> | undefined
  private readonly records = new Map<string, { start?: string; end?: string }>()
  private readonly rawSpans = new Map<string, TraceSpanEvent>()
  private readonly spans = new Map<string, TraceSpanEvent>()
  private readonly traceKeys = new Map<string, Set<string>>()
  private readonly owners = new Map<string, Set<string>>()
  private readonly indexed = new Set<string>()
  private readonly listeners = new Set<(span: TraceSpanEvent) => void>()
  private readonly history: TraceHistorySource

  constructor(private readonly root: string, private readonly file: string, private readonly onError?: (message: string) => void) {
    this.history = createTraceHistorySource({ root, configuredFile: file === "off" ? undefined : file })
  }

  /** stderr 可能拆分 UTF-8 和 marker，只有完整 JSON 记录才进入写队列。 */
  push(chunk: Uint8Array): void {
    if (!this.accepting || this.failed || this.file === "off") return
    this.buffer += this.decoder.write(Buffer.from(chunk))
    while (true) {
      const start = this.buffer.indexOf(MARKER)
      if (start < 0) { this.buffer = this.buffer.slice(-(MARKER.length - 1)); return }
      this.buffer = this.buffer.slice(start)
      const end = this.buffer.indexOf(MARKER, MARKER.length)
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > RECORD_LIMIT) this.fail()
        return
      }
      const json = this.buffer.slice(MARKER.length, end)
      this.buffer = this.buffer.slice(end + MARKER.length)
      try {
        const value: unknown = JSON.parse(json)
        if (!value || typeof value !== "object" || Array.isArray(value)) continue
        const size = Buffer.byteLength(json)
        if (size > RECORD_LIMIT || this.queuedBytes + size > CACHE_LIMIT) { this.fail(); return }
        this.queuedBytes += size
        this.pending = this.pending.then(async () => {
          if (!this.failed) await this.consume(json, value as Record<string, unknown>)
        }).catch(() => this.fail()).finally(() => { this.queuedBytes -= size })
      } catch { /* 非 SDK JSON 不影响 stderr 和 RPC 的原有处理。 */ }
    }
  }

  /** 等待此前完整记录落盘，历史回读不越过写入队列。 */
  async flush(): Promise<void> { await this.pending }
  /** 保留内网既有历史格式，并将失败显式交给网关终态处理。 */
  async loadThread(threadId: string, signal?: AbortSignal) { await this.flush(); return this.history.loadThread(threadId, signal) }
  /** 当前进程快照包含未归属节点，Browser 按 threadId 过滤。 */
  snapshot(): readonly TraceSpanEvent[] { return [...this.spans.values()] }
  /** 返回精确解绑函数，Gateway 关闭时必须调用。 */
  subscribe(listener: (span: TraceSpanEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** 停止接受新字节，完成已入队记录，然后释放文件和订阅；重复调用复用同一 Promise。 */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.accepting = false
    this.closing = this.flush().finally(async () => {
      await Promise.allSettled([this.log?.close(), this.index?.close()])
      this.listeners.clear(); this.buffer = ""; this.records.clear(); this.rawSpans.clear(); this.spans.clear(); this.traceKeys.clear(); this.owners.clear(); this.indexed.clear()
      this.cacheBytes = 0
    })
    return this.closing
  }

  private fail(): void {
    if (this.failed) return
    this.failed = true; this.accepting = false; this.buffer = ""
    try { this.onError?.("轨迹采集已停止：日志写入失败或超过资源上限。") } catch { /* 诊断失败不得传播到 sidecar stderr 监听器。 */ }
    void Promise.allSettled([this.log?.close(), this.index?.close()])
  }

  private async consume(json: string, value: Record<string, unknown>): Promise<void> {
    if (!this.log) {
      await mkdir(dirname(resolve(this.file)), { recursive: true, mode: 0o700 })
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW
      this.log = await open(this.file, flags, 0o600)
      this.index = await open(join(this.root, "za38-trace-index.ndjson"), flags, 0o600)
    }
    await this.log.appendFile(`${MARKER}${json}${MARKER}\n`)
    const first = parseTraceText(`${MARKER}${json}${MARKER}`)[0]
    if (!first) return
    const key = JSON.stringify([first.traceId, first.spanId])
    const previous = this.records.get(key) ?? {}
    const part = typeof value.end_time === "number" ? "end" : "start"
    // end 以首次完成记录为准，迟到 start 只补缺失输入和父节点。
    const next = part === "end" && previous.end ? previous : { ...previous, [part]: json }
    this.cacheBytes += Buffer.byteLength(next[part] ?? "") - Buffer.byteLength(previous[part] ?? "")
    if ((!this.records.has(key) && this.records.size >= 100000) || this.cacheBytes > CACHE_LIMIT) throw new Error("limit")
    this.records.set(key, next)
    const span = parseTraceText([next.start, next.end].filter(Boolean).map(text => `${MARKER}${text}${MARKER}`).join(""))[0]!
    this.rawSpans.set(key, span)
    const keys = this.traceKeys.get(span.traceId) ?? new Set<string>()
    keys.add(key); this.traceKeys.set(span.traceId, keys)
    const owners = this.owners.get(span.traceId) ?? new Set<string>()
    const ownerChanged = span.threadId !== null && !owners.has(span.threadId)
    if (span.threadId) {
      owners.add(span.threadId); this.owners.set(span.traceId, owners)
      if (!this.indexed.has(span.threadId)) {
        const rel = relative(this.root, resolve(this.file))
        const trace_file = rel.startsWith("..") ? resolve(this.file) : rel
        await this.index!.appendFile(JSON.stringify({ v: 1, kind: "thread", thread_id: span.threadId, trace_file }) + "\n")
        this.indexed.add(span.threadId)
      }
    }
    for (const changedKey of ownerChanged ? keys : [key]) {
      const raw = this.rawSpans.get(changedKey)!
      const threadId = raw.threadId ?? (owners.size === 1 ? [...owners][0]! : null)
      const updated = { ...raw, threadId }
      if (JSON.stringify(this.spans.get(changedKey)) === JSON.stringify(updated)) continue
      this.spans.set(changedKey, updated)
      for (const listener of [...this.listeners]) { try { listener(updated) } catch { /* 观察者失败不影响日志落盘。 */ } }
    }
  }
}
