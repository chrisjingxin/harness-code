/** 用量契约区分未知与零，并拒绝完整标记与缺失计数矛盾的载荷。 */
import { expect, test } from "bun:test"
import { assertEventEnvelope } from "@za38/protocol"

function completed(usage: unknown) {
  return { event_id: "event", thread_id: "thread", run_id: "run", sequence: 1, timestamp_ms: 1, type: "run.completed", payload: { duration_ms: 1, finish_reason: "completed", context: {}, usage } }
}

test("完整用量支持缓存子集，部分统计允许 null", () => {
  expect(() => assertEventEnvelope(completed({ input_tokens: 100, output_tokens: 20, input_complete: true, output_complete: true, cached_tokens: 80 }))).not.toThrow()
  expect(() => assertEventEnvelope(completed({ input_tokens: 100, output_tokens: null, input_complete: false, output_complete: false }))).not.toThrow()
})

test("完整标记不能伴随未知计数，计数不能为负或超出安全整数", () => {
  const base = { input_tokens: 100, output_tokens: 20, input_complete: true, output_complete: true }
  for (const patch of [{ input_tokens: null }, { output_tokens: -1 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => assertEventEnvelope(completed({ ...base, ...patch }))).toThrow()
  }
})
