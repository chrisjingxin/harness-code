/** Trace 历史端口与只读实现：内网索引定位日志，路径校验后按真实会话归属过滤。 */
import { constants } from "node:fs"
import { open, readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { TraceSpanEvent } from "../presentation-coordinator/contracts/trace"
import { TraceLogParser } from "./parser"

export type TraceHistory = { readonly spans: readonly TraceSpanEvent[]; readonly hasAnyTrace: boolean }
/** 网关只依赖此端口；浏览器无需知道日志路径或 SDK。 */
export interface TraceHistorySource {
  loadThread(threadId: string, signal?: AbortSignal): Promise<TraceHistory>
}
const INDEX = "za38-trace-index.ndjson"
const FILE_LIMIT = 64 * 1024 * 1024
const TOTAL_LIMIT = 128 * 1024 * 1024
const READ_ERROR = "轨迹日志读取失败，请检查日志文件后重新进入轨迹。"

/** 创建按需读取的历史服务；不启动监视器，不写索引。 */
export function createTraceHistorySource(options: { root?: string; configuredFile?: string } = {}): TraceHistorySource {
  const root = resolve(options.root ?? join(homedir(), ".harness", "trace"))
  const configuredFile = options.configuredFile ? resolve(options.configuredFile) : undefined
  return {
    async loadThread(threadId, signal) {
      try {
        signal?.throwIfAborted()
        const canonicalRoot = await realpath(root).catch(error => { if (missing(error)) return undefined; throw error })
        if (!canonicalRoot) return { spans: [], hasAnyTrace: false }
        const indexPath = await checkedPath(join(canonicalRoot, INDEX), canonicalRoot)
        if (!indexPath) return { spans: [], hasAnyTrace: false }
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
      } catch {
        // 固定错误文案，文件内容与宿主绝对路径不进入 Browser 或诊断日志。
        throw new Error(READ_ERROR)
      }
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
