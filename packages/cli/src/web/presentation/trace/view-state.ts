/** Trace 展示输入：由应用层提供当前会话数据，不携带宿主和网络接口。 */
import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"

/** 当前会话轨迹与加载状态；合成数据只用于测试和独立预览。 */
export type TraceViewState = {
  readonly threadId: string | null
  readonly spans: readonly TraceSpanEvent[]
  readonly loading: boolean
  readonly loaded: boolean
  readonly hasAnyTrace: boolean
}
