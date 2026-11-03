/** Web Trace 应用状态：按会话保存历史，只有显式进入或切换才触发加载。 */
import type { TraceLoadResult, TraceSpanEvent } from "../../presentation-coordinator/contracts/trace"
import type { TraceViewState } from "../presentation/trace/view-state"

/** 独立于整个 WebAdapter，便于迁回内网时替换传输端口。 */
export class TraceStore {
  private readonly states = new Map<string, TraceViewState>()
  private readonly loading = new Set<string>()
  private selected: string | null = null
  private active = false
  private closed = false
  private hasAnyTrace = false
  private live = new Map<string, TraceSpanEvent>()
  constructor(private readonly load: (threadId: string) => Promise<TraceLoadResult>, private readonly changed: () => void, private readonly notify: (message: string) => void) {}

  /** 每次工作台更新可调用；同一活动会话的普通发布不会重复回读。 */
  select(threadId: string | null, active: boolean): void {
    const entering = active && (!this.active || this.selected !== threadId)
    this.active = active; this.selected = threadId
    if (this.closed || !entering || !threadId || this.loading.has(threadId)) return
    this.loading.add(threadId)
    this.states.set(threadId, { ...this.baseState(threadId), loading: true })
    this.changed()
    const complete = (result: TraceLoadResult) => {
      if (this.closed) return
      this.loading.delete(threadId)
      this.hasAnyTrace ||= result.hasAnyTrace
      const previous = this.baseState(threadId)
      this.states.set(threadId, { ...previous, loading: false, loaded: true, spans: result.error ? previous.spans : result.spans, hasAnyTrace: this.hasAnyTrace })
      if (result.error && this.active && this.selected === threadId) this.notify(result.error)
      this.changed()
    }
    const failed = () => complete({ spans: [], hasAnyTrace: false, error: "轨迹加载失败，请重新进入轨迹。" })
    try { void this.load(threadId).then(complete, failed) } catch { failed() }
  }

  /** 已按当前会话隔离的展示输入，不暴露其他会话原始数据。 */
  getState(threadId: string | null): TraceViewState {
    const base = this.baseState(threadId)
    const merged = new Map(base.spans.map(span => [JSON.stringify([span.traceId, span.spanId]), span]))
    for (const [key, span] of this.live) {
      if (threadId !== null && span.threadId === threadId) merged.set(key, span)
      else merged.delete(key)
    }
    return { ...base, spans: [...merged.values()], hasAnyTrace: this.hasAnyTrace }
  }

  /** 同键实时结果总是优先于磁盘回读；null 归属会撤回此前的推断绑定。 */
  replaceLive(spans: readonly TraceSpanEvent[]): void {
    if (this.closed) return
    this.live = new Map(spans.map(span => [JSON.stringify([span.traceId, span.spanId]), span]))
    this.hasAnyTrace ||= spans.length > 0
    this.changed()
  }

  private baseState(threadId: string | null): TraceViewState {
    return (threadId ? this.states.get(threadId) : undefined) ?? { threadId, spans: [], loading: false, loaded: false, hasAnyTrace: this.hasAnyTrace }
  }

  /** 关闭后忽略未决 Promise，订阅方不再收到更新。 */
  close(): void { this.closed = true; this.states.clear(); this.loading.clear(); this.live.clear() }
}
