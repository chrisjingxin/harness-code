/** 浏览器 Trace 请求关联：分条接收、终态计数、超时及连接关闭收敛。 */
import type { TraceHistoryMessage, TraceLoadRequest, TraceLoadResult, TraceSpanEvent } from "../../presentation-coordinator/contracts/trace"

type Pending = { threadId: string; spans: TraceSpanEvent[]; resolve: (result: TraceLoadResult) => void; timer: ReturnType<typeof setTimeout> }
const FAILED = "轨迹加载失败，请重新进入轨迹。"

/** 传输只传入发送函数；不持有 DOM、工作台或 SDK 状态。 */
export class TraceHistoryClient {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly send: (message: TraceLoadRequest) => boolean, private readonly timeoutMs = 30000) {}

  /** 请求完成或失败均 resolve，避免断连留下永久 loading。 */
  loadThread(threadId: string): Promise<TraceLoadResult> {
    const requestId = crypto.randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finish(requestId, FAILED), this.timeoutMs)
      this.pending.set(requestId, { threadId, spans: [], resolve, timer })
      try { if (!this.send({ type: "trace.load", requestId, threadId })) this.finish(requestId, FAILED) }
      catch { this.finish(requestId, FAILED) }
    })
  }

  /** 只接受当前请求与会话匹配的消息；结束后迟到的帧直接丢弃。 */
  receive(message: TraceHistoryMessage): void {
    const pending = this.pending.get(message.requestId)
    if (!pending || pending.threadId !== message.threadId) return
    if (message.type === "trace.span") {
      if (pending.spans.length >= 100000) { this.finish(message.requestId, FAILED); return }
      pending.spans.push(message.span)
    } else {
      this.finish(message.requestId, message.error ?? (pending.spans.length === message.spanCount ? null : FAILED), message.hasAnyTrace)
    }
  }

  /** 断连或归还控制权时释放所有计时器与缓冲结果。 */
  cancel(): void { for (const id of [...this.pending.keys()]) this.finish(id, FAILED) }

  private finish(id: string, error: string | null, hasAnyTrace = false): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve({ spans: error ? [] : pending.spans, hasAnyTrace, error })
  }
}
