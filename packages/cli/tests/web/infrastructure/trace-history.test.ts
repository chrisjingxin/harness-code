/** Trace 传输和状态生命周期；仅合成数据，不依赖模型或监听端口。 */
import { expect, test } from "bun:test"
import { TraceHistoryClient } from "../../../src/web/infrastructure/trace-history-client"
import { TraceStore } from "../../../src/web/application/trace-store"
import { parseClientFrame, parseServerFrame } from "../../../src/presentation-coordinator/contracts/validation"
import type { TraceLoadResult } from "../../../src/presentation-coordinator/contracts/trace"

const span = { traceId: "r", spanId: "s", parentSpanId: null, threadId: "t1", name: "test", startTime: 1, endTime: null, durationMs: null, raw: {} }
test("Trace 帧精确校验字段、会话和数值", () => {
  const load = { type: "trace.load", requestId: "req", threadId: "t1" }
  expect(parseClientFrame(JSON.stringify(load))).toEqual(load)
  expect(parseClientFrame(JSON.stringify({ ...load, path: "/secret" }))).toBeUndefined()
  expect(parseClientFrame(JSON.stringify({ ...load, threadId: "x".repeat(257) }))).toBeUndefined()
  const event = { type: "trace.span", requestId: "req", threadId: "t1", span }
  expect(parseServerFrame(JSON.stringify(event))).toEqual(event)
  expect(parseServerFrame(JSON.stringify({ ...event, span: { ...span, threadId: "t2" } }))).toBeUndefined()
  expect(parseServerFrame(JSON.stringify({ ...event, span: { ...span, raw: [] } }))).toBeUndefined()
})
test("分条接收直至终态才发布，错误请求及会话帧不能串入", async () => {
  const sent: any[] = []
  const client = new TraceHistoryClient(message => { sent.push(message); return true })
  const promise = client.loadThread("t1")
  const requestId = sent[0].requestId
  client.receive({ type: "trace.span", requestId, threadId: "t2", span: { ...span, threadId: "t2" } })
  client.receive({ type: "trace.span", requestId, threadId: "t1", span })
  client.receive({ type: "trace.loaded", requestId, threadId: "t1", spanCount: 1, hasAnyTrace: true, error: null })
  expect(await promise).toEqual({ spans: [span], hasAnyTrace: true, error: null })
  client.cancel()
})
test("数量不一致、发送失败、断连和超时全部收敛", async () => {
  const sent: any[] = []
  const client = new TraceHistoryClient(message => { sent.push(message); return true }, 5)
  const mismatch = client.loadThread("t1")
  client.receive({ type: "trace.loaded", requestId: sent[0].requestId, threadId: "t1", spanCount: 1, hasAnyTrace: true, error: null })
  expect((await mismatch).error).not.toBeNull()
  const disconnected = client.loadThread("t1"); client.cancel()
  expect((await disconnected).error).not.toBeNull()
  expect((await client.loadThread("t1")).error).not.toBeNull()
  expect((await new TraceHistoryClient(() => false).loadThread("t1")).error).not.toBeNull()
})
test("应用层仅进入／切换／重入加载；旧请求不覆盖当前会话，关闭后不发布", async () => {
  const pending: Array<{ thread: string; resolve: (value: TraceLoadResult) => void }> = []
  let changes = 0
  const notices: string[] = []
  const store = new TraceStore(thread => new Promise(resolve => pending.push({ thread, resolve })), () => { changes++ }, message => notices.push(message))
  store.select("t1", false); expect(pending).toHaveLength(0)
  store.select("t1", true); store.select("t1", true); expect(pending).toHaveLength(1)
  store.select("t2", true); expect(pending).toHaveLength(2)
  pending[0]!.resolve({ spans: [span], hasAnyTrace: true, error: null }); await Promise.resolve()
  expect(store.getState("t2").spans).toEqual([])
  pending[1]!.resolve({ spans: [], hasAnyTrace: true, error: "读取失败" }); await Promise.resolve()
  expect(store.getState("t2").loading).toBe(false); expect(notices).toEqual(["读取失败"])
  store.select("t1", false); store.select("t1", true); expect(pending).toHaveLength(3)
  expect(store.getState("t1").spans).toEqual([span])
  store.close(); const before = changes
  pending[2]!.resolve({ spans: [], hasAnyTrace: false, error: null }); await Promise.resolve()
  expect(changes).toBe(before)
})
