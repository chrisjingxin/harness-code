/** 单个 Browser 连接的 Trace 历史请求：控制并发、取消和分帧，不持有工作台状态。 */
import type { TraceHistorySource } from "../trace-log/history"
import { MAX_UI_FRAME_BYTES } from "./contracts/messages"
import type { TraceHistoryMessage, TraceLoadRequest } from "./contracts/trace"
import { parseServerFrame } from "./contracts/validation"

/** 连接替换时关闭整个实例，异步结果不会写入下一个连接。 */
export class TraceHistorySession {
  private readonly pending = new Map<string, AbortController>()
  private closed = false
  constructor(private readonly source: TraceHistorySource | undefined, private readonly send: (message: TraceHistoryMessage) => Promise<void>, private readonly active: () => boolean) {}

  /** 回读可以并行，不阻塞 handoff.return；每个 requestId 只执行一次在途读取。 */
  async load(request: TraceLoadRequest): Promise<void> {
    if (this.closed || this.pending.has(request.requestId)) return
    const controller = new AbortController()
    const terminal = (error: string | null, spanCount = 0, hasAnyTrace = false): TraceHistoryMessage => ({ type: "trace.loaded", requestId: request.requestId, threadId: request.threadId, spanCount, hasAnyTrace, error })
    if (!this.active() || this.pending.size >= 4) {
      await this.send(terminal("轨迹暂时无法加载，请重新进入轨迹。"))
      return
    }
    this.pending.set(request.requestId, controller)
    try {
      const result = await this.source?.loadThread(request.threadId, controller.signal) ?? { spans: [], hasAnyTrace: false }
      if (this.closed || !this.active()) return
      const frames: TraceHistoryMessage[] = result.spans.map(span => ({ type: "trace.span", requestId: request.requestId, threadId: request.threadId, span }))
      // 完整预检后才发送，不能把另一会话或被截断的 raw 作为成功历史。
      for (const frame of frames) {
        const json = JSON.stringify(frame)
        if (Buffer.byteLength(json) > MAX_UI_FRAME_BYTES || !parseServerFrame(json)) throw new Error("invalid trace")
      }
      for (const frame of frames) {
        if (this.closed || !this.active()) return
        await this.send(frame)
      }
      if (!this.closed && this.active()) await this.send(terminal(null, frames.length, result.hasAnyTrace))
    } catch {
      if (!this.closed && this.active()) await this.send(terminal("轨迹日志读取失败，请检查日志文件后重新进入轨迹。"))
    } finally { this.pending.delete(request.requestId) }
  }

  /** 中止未完成的文件读取，并禁止所有迟到结果发送。 */
  close(): void {
    this.closed = true
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
  }
}
