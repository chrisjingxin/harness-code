/** 当前连接的实时 Trace 缓存：独立修订号，按 trace/span 身份替换。 */
import type { TraceLiveMessage, TraceSpanEvent } from "../../presentation-coordinator/contracts/trace"

/** 缓存未知归属的节点，threadId 回填或冲突解绑仍使用同一身份。 */
export class TraceLiveClient {
  private revision = 0
  private closed = false
  private readonly spans = new Map<string, TraceSpanEvent>()
  private readonly listeners = new Set<(spans: readonly TraceSpanEvent[]) => void>()
  /** 返回当前连接的完整增量缓存；应用层负责按会话选择。 */
  snapshot(): readonly TraceSpanEvent[] { return [...this.spans.values()] }
  /** 生命周期由 WebUiClient 管理，close 后不再发布。 */
  subscribe(listener: (spans: readonly TraceSpanEvent[]) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** 旧修订不能覆盖完成状态；每个连接独立计数。 */
  receive(message: TraceLiveMessage): void {
    if (this.closed || message.revision <= this.revision) return
    const key = JSON.stringify([message.span.traceId, message.span.spanId])
    if (!this.spans.has(key) && this.spans.size >= 100000) return
    this.revision = message.revision
    this.spans.set(key, message.span)
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) listener(snapshot)
  }
  /** 释放订阅与缓存。 */
  close(): void { this.closed = true; this.listeners.clear(); this.spans.clear() }
}
