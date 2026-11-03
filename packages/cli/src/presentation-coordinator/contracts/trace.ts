/**
 * Trace 链路事件契约：CLI 回读 za38-trace-*.log 归一化后的 span 事件，
 * 经 WebUiGateway 以 trace.span / trace.loaded 帧传给 Browser。
 *
 * 字段对齐 trace_viewer.py `_merge_trace_method_entries` 合并后的形状（Spec §6），
 * 全部 JSON 可序列化；Web 侧按 threadId 归集后建树渲染。
 */

/** 单个 span 事件（start/end 合并后的归一化形状）。 */
export type TraceSpanEvent = {
  /** 链路 trace ID。 */
  readonly traceId: string
  /** 当前 span ID；无 span_id 的 trace-level 汇总日志在 CLI 侧直接丢弃。 */
  readonly spanId: string
  /** 父 span ID；"0" / 自环 / 未知父在 CLI 侧归一为 null。 */
  readonly parentSpanId: string | null
  /** span 名称，如 run.accept / thread.persist / LLM。 */
  readonly name: string
  /** span 类型：RUN/FUNC/LLM/TOOL/NODE/AGENT/RETRIEVER/RERANK/EMBEDDING/INTERACTION/POLICY/DB/CONTEXT 之一或省略。 */
  readonly type?: string
  /** 开始时间（epoch ms）。 */
  readonly startTime: number
  /** 结束时间（epoch ms）；进行中为 null。 */
  readonly endTime: number | null
  /** 耗时 ms；未合并出 duration 时由 start/end 差值兜底。 */
  readonly durationMs: number | null
  /** 状态：SUCCESS/FAILED/RUNNING/UNKNOWN。 */
  readonly status?: string
  /** span metadata（input/output/custom_metadata 等；由生产端与服务端负责敏感内容处理）。 */
  readonly metadata?: Record<string, unknown>
  /** 归属 thread；从 metadata 抽取，null 归会话级。 */
  readonly threadId: string | null
  /** deep_merge 后的原始 JSON（详情面板展示）。 */
  readonly raw: Record<string, unknown>
}
/** 一次历史回读的终态；失败不发布部分历史，错误文案不含路径。 */
export type TraceLoadResult = {
  readonly spans: readonly TraceSpanEvent[]
  readonly hasAnyTrace: boolean
  readonly error: string | null
}

export type TraceLoadRequest = { type: "trace.load"; requestId: string; threadId: string }
export type TraceLiveMessage = { type: "trace.live"; revision: number; span: TraceSpanEvent }
export type TraceHistoryMessage =
  | { type: "trace.span"; requestId: string; threadId: string; span: TraceSpanEvent }
  | { type: "trace.loaded"; requestId: string; threadId: string; spanCount: number; hasAnyTrace: boolean; error: string | null }
