/** 公共数字显示：只接收数值，不依赖会话或 Agent 内部状态。 */

/** 将毫秒耗时格式化为紧凑的毫秒或秒；缺失和不足一毫秒不展示。 */
export function formatDuration(durationMs: number | undefined): string | undefined {
  if (!durationMs || durationMs < 1) return undefined
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

/** 显示经过的秒数；无效或负值回到 0s。 */
export function formatElapsed(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1000) return "0s"
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

/** 将输入和输出用量格式化成紧凑摘要；缺失时不展示。 */
export function formatUsage(usage: { inputTokens: number; outputTokens: number } | undefined): string | undefined {
  if (!usage) return undefined
  return `${compactNumber(usage.inputTokens)} in · ${compactNumber(usage.outputTokens)} out`
}

/** 将估算用量和预算格式化成摘要；缺失或零预算时不展示。 */
export function formatContext(estimatedTokens: number | undefined, inputCapTokens: number | undefined): string | undefined {
  if (!estimatedTokens || !inputCapTokens) return undefined
  return `${compactNumber(estimatedTokens)}/${compactNumber(inputCapTokens)}`
}

function compactNumber(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
}
