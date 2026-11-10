/** 网关历史请求：异步读取不持有控制权，不向新连接发送旧结果。 */
import { expect, test } from "bun:test"
import { TraceHistorySession } from "../../src/presentation-coordinator/trace-history-session"
import type { TraceHistory } from "../../src/trace-log/history"
import type { TraceHistoryMessage } from "../../src/presentation-coordinator/contracts/trace"
import { MAX_UI_FRAME_BYTES } from "../../src/presentation-coordinator/contracts/messages"
const span = { traceId: "r", spanId: "s", parentSpanId: null, name: "test", threadId: "t1", startTime: 1, endTime: null, durationMs: null, raw: {} }
test("服务回读按 span 分帧，失败只有终态且不泄露原始异常", async () => {
  const messages: TraceHistoryMessage[] = []
  let fail = false
  const session = new TraceHistorySession({ loadThread: async () => { if (fail) throw new Error("/private/secrets"); return { spans: [span], hasAnyTrace: true } } }, async message => { messages.push(message) }, () => true)
  await session.load({ type: "trace.load", requestId: "a", threadId: "t1" })
  expect(messages.map(message => message.type)).toEqual(["trace.span", "trace.loaded"])
  fail = true; messages.length = 0
  await session.load({ type: "trace.load", requestId: "b", threadId: "t1" })
  expect(messages).toHaveLength(1)
  expect(JSON.stringify(messages)).not.toContain("/private/")
  expect(messages[0]).toMatchObject({ type: "trace.loaded", spanCount: 0 })
})
test("关闭中止源请求并丢弃旧连接结果，相同 requestId 在途去重", async () => {
  const deferred = Promise.withResolvers<TraceHistory>()
  const messages: TraceHistoryMessage[] = []
  let signal: AbortSignal | undefined
  let calls = 0
  const session = new TraceHistorySession({ loadThread: async (_id, abort) => { calls++; signal = abort; return deferred.promise } }, async message => { messages.push(message) }, () => true)
  const request = { type: "trace.load" as const, requestId: "a", threadId: "t1" }
  const first = session.load(request); await session.load(request)
  expect(calls).toBe(1)
  session.close(); expect(signal?.aborted).toBe(true)
  deferred.resolve({ spans: [span], hasAnyTrace: true }); await first
  expect(messages).toEqual([])
})
test("错误会话或超大 span 整体失败，不发送部分历史", async () => {
  const messages: TraceHistoryMessage[] = []
  const session = new TraceHistorySession({ loadThread: async () => ({ spans: [span, { ...span, threadId: "other" }], hasAnyTrace: true }) }, async message => { messages.push(message) }, () => true)
  await session.load({ type: "trace.load", requestId: "a", threadId: "t1" })
  expect(messages).toHaveLength(1)
  expect(messages[0]?.type).toBe("trace.loaded")
})

test("超大 raw 的请求先整体预检，不发布前面的正常节点，也不截掉原始详情", async () => {
  const messages: TraceHistoryMessage[] = []
  const session = new TraceHistorySession({ loadThread: async () => ({ spans: [span, { ...span, spanId: "huge", raw: { output: "x".repeat(MAX_UI_FRAME_BYTES) } }], hasAnyTrace: true }) }, async message => { messages.push(message) }, () => true)
  await session.load({ type: "trace.load", requestId: "big", threadId: "t1" })
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ type: "trace.loaded", spanCount: 0 })
  expect(messages[0]?.type === "trace.loaded" && messages[0].error).not.toBeNull()
  session.close()
})

test("单连接并发上限不阻塞已有四个请求，关闭时全部中止且迟到结果不再发送", async () => {
  const deferred = Promise.withResolvers<TraceHistory>()
  const signals: AbortSignal[] = []
  const messages: TraceHistoryMessage[] = []
  const session = new TraceHistorySession({ loadThread: async (_thread, signal) => { signals.push(signal!); return deferred.promise } }, async message => { messages.push(message) }, () => true)
  const requests = Array.from({ length: 4 }, (_, i) => session.load({ type: "trace.load", requestId: String(i), threadId: "t1" }))
  await session.load({ type: "trace.load", requestId: "overflow", threadId: "t1" })
  expect(signals).toHaveLength(4)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ type: "trace.loaded", requestId: "overflow", spanCount: 0 })
  session.close()
  expect(signals.every(signal => signal.aborted)).toBe(true)
  deferred.resolve({ spans: [span], hasAnyTrace: true })
  await Promise.all(requests)
  expect(messages).toHaveLength(1)
})
