/** 共享 Worker、超时与有界缓存；最后一个视图离开时结束 Worker 并收敛请求。 */
import type { LanguageId } from "./language-catalog.js"
import type { SyntaxWorkerRequest, SyntaxWorkerResponse } from "./protocol.js"

const TIMEOUT_MS = 1500
const MAX_CACHE_SIZE = 128
const MAX_CACHE_BYTES = 4 * 1024 * 1024
const MAX_CODE_BYTES = 64 * 1024
const MAX_CODE_LINES = 2_000
const MAX_FATALS = 3
let consecutiveFatals = 0
let circuitBroken = false

type Pending = { resolve: (value: SyntaxWorkerResponse) => void; timer: ReturnType<typeof setTimeout> }
type CacheEntry = { response: SyntaxWorkerResponse; bytes: number }

class HighlightService {
  private worker: Worker | null = null
  private nextId = 0
  private pending = new Map<number, Pending>()
  private cache = new Map<string, CacheEntry>()
  private cacheBytes = 0

  private getWorker(): Worker | null {
    if (circuitBroken || typeof Worker === "undefined") return null
    if (this.worker) return this.worker
    try {
      // 静态相对入口由消费侧构建器输出，不能借旧 Web 服务的绝对路径。
      const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
      worker.onmessage = (event: MessageEvent<SyntaxWorkerResponse>) => {
        const response = event.data
        const pending = this.pending.get(response.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(response.requestId)
        if (response.type === "highlighted") consecutiveFatals = 0
        pending.resolve(response)
      }
      worker.onerror = () => this.failWorker()
      this.worker = worker
      return worker
    } catch {
      this.recordFatal()
      return null
    }
  }

  private recordFatal() {
    consecutiveFatals += 1
    if (consecutiveFatals >= MAX_FATALS) circuitBroken = true
  }

  private failWorker() {
    this.recordFatal()
    this.worker?.terminate()
    this.worker = null
    for (const [requestId, item] of this.pending) {
      clearTimeout(item.timer)
      item.resolve({ type: "plain", requestId, reason: "load-failed" })
    }
    this.pending.clear()
  }

  highlight(language: LanguageId, code: string): Promise<SyntaxWorkerResponse> {
    const codeBytes = new TextEncoder().encode(code).length
    if (codeBytes > MAX_CODE_BYTES || (code ? code.split("\n").length : 0) > MAX_CODE_LINES) {
      return Promise.resolve({ type: "plain", requestId: 0, reason: "too-large" })
    }
    // 整段代码是键的一部分，不能以短哈希碰撞复用另一段文本的范围。
    const key = JSON.stringify([language, "dark-plus", code])
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached)
      return Promise.resolve(cached.response)
    }
    const worker = this.getWorker()
    if (!worker) return Promise.resolve({ type: "plain", requestId: 0, reason: "load-failed" })
    const requestId = ++this.nextId
    const request: SyntaxWorkerRequest = { type: "highlight", requestId, language, code, theme: "dark-plus" }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.recordFatal()
        resolve({ type: "plain", requestId, reason: "timeout" })
        if (circuitBroken) {
          this.worker?.terminate()
          this.worker = null
        }
      }, TIMEOUT_MS)
      this.pending.set(requestId, { timer, resolve: response => {
        if (response.type === "highlighted") this.remember(key, response, codeBytes)
        resolve(response)
      } })
      try { worker.postMessage(request) }
      catch { this.failWorker() }
    })
  }

  private remember(key: string, response: Extract<SyntaxWorkerResponse, { type: "highlighted" }>, codeBytes: number) {
    const bytes = codeBytes + response.spans.length * 24
    if (bytes > MAX_CACHE_BYTES) return
    const previous = this.cache.get(key)
    if (previous) { this.cache.delete(key); this.cacheBytes -= previous.bytes }
    while (this.cache.size >= MAX_CACHE_SIZE || this.cacheBytes + bytes > MAX_CACHE_BYTES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cacheBytes -= this.cache.get(oldest)?.bytes ?? 0
      this.cache.delete(oldest)
    }
    this.cache.set(key, { response, bytes })
    this.cacheBytes += bytes
  }

  close() {
    this.worker?.terminate()
    this.worker = null
    for (const [requestId, item] of this.pending) {
      clearTimeout(item.timer)
      item.resolve({ type: "plain", requestId, reason: "load-failed" })
    }
    this.pending.clear(); this.cache.clear(); this.cacheBytes = 0
  }
}

let service: HighlightService | null = null
let users = 0
export function acquireHighlightService(): HighlightService {
  service ??= new HighlightService()
  users += 1
  return service
}
export function releaseHighlightService(instance: HighlightService): void {
  if (instance !== service) return
  users -= 1
  if (users === 0) { service = null; instance.close() }
}
