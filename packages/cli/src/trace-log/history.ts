/** Trace 历史端口与只读实现：读取内网索引日志和工作区 session JSONL，并按真实会话归属过滤。 */
import { constants } from "node:fs"
import { open, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { TraceSpanEvent } from "../presentation-coordinator/contracts/trace"
import { TraceLogParser } from "./parser"

export type TraceHistory = { readonly spans: readonly TraceSpanEvent[]; readonly hasAnyTrace: boolean }
/** 网关只依赖此端口；浏览器无需知道日志路径或 SDK。 */
export interface TraceHistorySource {
  loadThread(threadId: string, signal?: AbortSignal): Promise<TraceHistory>
}
/** 工作区读取器同时服务历史回读和实时刷新，文件内容缓存只保留归一化 Span。 */
export interface WorkspaceTraceReader {
  read(signal?: AbortSignal): Promise<TraceHistory>
}
const INDEX = "za38-trace-index.ndjson"
const FILE_LIMIT = 64 * 1024 * 1024
const TOTAL_LIMIT = 128 * 1024 * 1024
const READ_ERROR = "轨迹日志读取失败，请检查日志文件后重新进入轨迹。"
const EMPTY: TraceHistory = { spans: [], hasAnyTrace: false }

/** 创建按需读取的历史服务；不启动监视器，不写索引。 */
export function createTraceHistorySource(options: {
  root?: string
  configuredFile?: string
  workspace?: string
  workspaceReader?: WorkspaceTraceReader
} = {}): TraceHistorySource {
  const root = resolve(options.root ?? join(homedir(), ".harness", "trace"))
  const configuredFile = options.configuredFile ? resolve(options.configuredFile) : undefined
  const workspaceReader = options.workspaceReader ?? (options.workspace ? createWorkspaceTraceReader(options.workspace) : undefined)
  return {
    async loadThread(threadId, signal) {
      try {
        signal?.throwIfAborted()
        const [legacy, session] = await Promise.all([
          loadIndexedThread(root, configuredFile, threadId, signal),
          workspaceReader?.read(signal) ?? Promise.resolve(EMPTY),
        ])
        const merged = new Map<string, TraceSpanEvent>()
        for (const span of legacy.spans) merged.set(JSON.stringify([span.traceId, span.spanId]), span)
        for (const span of session.spans) {
          if (span.threadId === threadId) merged.set(JSON.stringify([span.traceId, span.spanId]), span)
        }
        return { spans: [...merged.values()], hasAnyTrace: legacy.hasAnyTrace || session.hasAnyTrace }
      } catch {
        // 固定错误文案，文件内容与宿主绝对路径不进入 Browser 或诊断日志。
        throw new Error(READ_ERROR)
      }
    },
  }
}

/** 旧 SDK 日志仍按索引定位，未绑定节点只在该 trace 有唯一会话时回填。 */
async function loadIndexedThread(root: string, configuredFile: string | undefined, threadId: string, signal?: AbortSignal): Promise<TraceHistory> {
  const canonicalRoot = await realpath(root).catch(error => { if (missing(error)) return undefined; throw error })
  if (!canonicalRoot) return EMPTY
  const indexPath = await checkedPath(join(canonicalRoot, INDEX), canonicalRoot)
  if (!indexPath) return EMPTY
  const index = await readBounded(indexPath, 8 * 1024 * 1024, signal)
  const files = new Set<string>()
  let hasAnyTrace = false
  for (const line of index.split("\n")) {
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!isBinding(entry)) continue
    hasAnyTrace = true
    if (entry.thread_id === threadId) files.add(entry.trace_file)
  }
  if (files.size > 256) throw new Error("limit")
  const parser = new TraceLogParser()
  const dates = (await readdir(root)).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()
  let total = 0
  for (const file of files) {
    signal?.throwIfAborted()
    // 索引不可信；绝对路径仅允许根内或宿主显式指定的单个日志。
    if (file.split(/[\\/]/).includes("..") || file.includes("\0")) throw new Error("path")
    const candidates = isAbsolute(file) ? [file] : [join(canonicalRoot, file), ...(!file.includes("/") && !file.includes("\\") ? dates.map(date => join(canonicalRoot, date, basename(file))) : [])]
    for (const candidate of candidates) {
      const path = await checkedPath(candidate, canonicalRoot, configuredFile)
      if (!path) continue
      const text = await readBounded(path, Math.min(FILE_LIMIT, TOTAL_LIMIT - total), signal)
      total += Buffer.byteLength(text)
      parser.pushText(text)
      if (parser.size > 100000) throw new Error("limit")
      break
    }
  }
  const spans = parser.snapshot()
  const owners = new Map<string, Set<string>>()
  for (const span of spans) {
    if (!span.threadId) continue
    const ids = owners.get(span.traceId) ?? new Set<string>()
    ids.add(span.threadId); owners.set(span.traceId, ids)
  }
  return { hasAnyTrace, spans: spans.flatMap(span => {
    if (span.threadId === threadId) return [span]
    const ids = owners.get(span.traceId)
    return span.threadId === null && ids?.size === 1 && ids.has(threadId) ? [{ ...span, threadId }] : []
  }) }
}

/** 扫描当前工作区 log/*.jsonl；文件名仅用于定位，会话隔离始终以事件内 session_id 为准。 */
export function createWorkspaceTraceReader(workspace: string): WorkspaceTraceReader {
  const root = resolve(workspace, "log")
  const cache = new Map<string, { mtimeMs: number; size: number; spans: readonly TraceSpanEvent[] }>()
  return {
    async read(signal) {
      signal?.throwIfAborted()
      const canonicalRoot = await realpath(root).catch(error => { if (missing(error)) return undefined; throw error })
      if (!canonicalRoot) {
        cache.clear()
        return EMPTY
      }
      const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
        .sort((a, b) => a.name.localeCompare(b.name))
      if (entries.length > 256) throw new Error("limit")
      const present = new Set<string>()
      const spans: TraceSpanEvent[] = []
      let total = 0
      let hasAnyTrace = false
      for (const entry of entries) {
        signal?.throwIfAborted()
        const path = await checkedPath(join(canonicalRoot, entry.name), canonicalRoot)
        if (!path) continue
        const info = await stat(path)
        if (!info.isFile() || info.size > FILE_LIMIT) throw new Error("limit")
        total += info.size
        if (total > TOTAL_LIMIT) throw new Error("limit")
        present.add(path)
        let cached = cache.get(path)
        if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
          const text = await readBounded(path, FILE_LIMIT, signal)
          const parser = new TraceLogParser()
          parser.pushText(text)
          if (parser.size > 100000) throw new Error("limit")
          // 缺少 session_id 的事件不参与展示，避免把其他工作区或匿名数据并入当前会话。
          cached = { mtimeMs: info.mtimeMs, size: info.size, spans: parser.snapshot().filter(span => span.threadId !== null) }
          cache.set(path, cached)
        }
        if (cached.spans.length > 0) hasAnyTrace = true
        spans.push(...cached.spans)
      }
      for (const path of cache.keys()) if (!present.has(path)) cache.delete(path)
      return { spans, hasAnyTrace }
    },
  }
}

function isBinding(value: unknown): value is { thread_id: string; trace_file: string } {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return entry.v === 1 && entry.kind === "thread" && typeof entry.thread_id === "string" && entry.thread_id.length > 0 && typeof entry.trace_file === "string" && entry.trace_file.length > 0
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT" }
function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
async function checkedPath(path: string, root: string, configuredFile?: string): Promise<string | undefined> {
  const resolved = resolve(path)
  const allowed = configuredFile === resolved
  if (!inside(resolved, root) && !allowed) throw new Error("path")
  try {
    const canonical = await realpath(resolved)
    if (!inside(canonical, root) && !(allowed && canonical === await realpath(configuredFile!))) throw new Error("path")
    return canonical
  } catch (error) { if (missing(error)) return undefined; throw error }
}
async function readBounded(path: string, limit: number, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw new Error("limit")
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      signal?.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(65536, limit - size + 1))
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      size += bytesRead
      if (size > limit) throw new Error("limit")
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally { await handle.close() }
}
