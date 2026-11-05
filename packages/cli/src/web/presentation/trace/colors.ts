/** 轨迹视图配色：保留内网类型与状态映射；实际颜色由工作台 theme.css 统一定义。 */

/** span 类型 → 条形/徽章颜色。每种 type 一个色相，具体色值在 theme.css。 */
export const TYPE_COLORS: Readonly<Record<string, string>> = {
  ROOT: "var(--trace-root)",
  RUN: "var(--trace-run)",
  FUNC: "var(--trace-func)",
  AGENT: "var(--trace-agent)",
  NODE: "var(--trace-node)",
  LLM: "var(--trace-llm)",
  TOOL: "var(--trace-tool)",
  RETRIEVER: "var(--trace-retriever)",
  RERANK: "var(--trace-rerank)",
  EMBEDDING: "var(--trace-embedding)",
  INTERACTION: "var(--trace-interaction)",
  POLICY: "var(--trace-policy)",
  DB: "var(--trace-db)",
  CONTEXT: "var(--trace-context)",
}

/** 未知类型的兜底色（slate）。 */
export const DEFAULT_TYPE_COLOR = "var(--trace-unknown)"

/** span 状态 → 展示色（trace_viewer.py STATUS_COLORS 平移）。 */
export const STATUS_COLORS: Readonly<Record<string, string>> = {
  SUCCESS: "var(--trace-success)",
  FAILED: "var(--trace-failed)",
  ERROR: "var(--trace-error)",
  RUNNING: "var(--trace-running)",
}

/** 未知状态的兜底色。 */
export const DEFAULT_STATUS_COLOR = "var(--trace-unknown)"

/** 按 type 取条形颜色。 */
export function typeColor(type: string | undefined): string {
  return type !== undefined ? (TYPE_COLORS[type] ?? DEFAULT_TYPE_COLOR) : DEFAULT_TYPE_COLOR
}

/** 按 status 取状态色。 */
export function statusColor(status: string | undefined): string {
  return status !== undefined ? (STATUS_COLORS[status] ?? DEFAULT_STATUS_COLOR) : DEFAULT_STATUS_COLOR
}
