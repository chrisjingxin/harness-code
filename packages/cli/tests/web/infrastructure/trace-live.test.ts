/** 实时消息与历史合并：同键覆盖、旧修订丢弃、会话隔离及冲突解绑。 */
import { expect, test } from "bun:test"
import { TraceLiveClient } from "../../../src/web/infrastructure/trace-live-client"
import { TraceStore } from "../../../src/web/application/trace-store"
import { parseServerFrame } from "../../../src/presentation-coordinator/contracts/validation"
import type { TraceLoadResult } from "../../../src/presentation-coordinator/contracts/trace"
import { createWebUiClient, type UiSocket } from "../../../src/web/ui-client"
const span = { traceId: "r", spanId: "s", parentSpanId: null, threadId: "t1", name: "test", startTime: 1, endTime: null, durationMs: null, raw: {} }
test("实时契约、单调修订与关闭订阅", () => {
  const first = { type: "trace.live" as const, revision: 1, span }
  expect(parseServerFrame(JSON.stringify(first))).toEqual(first)
  const client = new TraceLiveClient()
  let calls = 0; client.subscribe(() => { calls++ })
  client.receive(first)
  client.receive({ ...first, revision: 2, span: { ...span, endTime: 20, durationMs: 19 } })
  client.receive(first)
  expect(client.snapshot()).toHaveLength(1)
  expect(client.snapshot()[0]?.endTime).toBe(20)
  expect(calls).toBe(2)
  client.close(); client.receive({ ...first, revision: 3 })
  expect(calls).toBe(2)
})
test("加载中的旧历史不能覆盖最新实时结果；解绑不会从历史复活", async () => {
  const deferred = Promise.withResolvers<TraceLoadResult>()
  const store = new TraceStore(() => deferred.promise, () => {}, () => {})
  store.select("t1", true)
  store.replaceLive([{ ...span, endTime: 20, durationMs: 19 }])
  deferred.resolve({ spans: [span], hasAnyTrace: true, error: null }); await Promise.resolve()
  expect(store.getState("t1").spans).toHaveLength(1)
  expect(store.getState("t1").spans[0]?.endTime).toBe(20)
  store.replaceLive([{ ...span, threadId: null }])
  expect(store.getState("t1").spans).toEqual([])
  store.replaceLive([{ ...span, threadId: "t2" }])
  expect(store.getState("t1").spans).toEqual([])
  expect(store.getState("t2").spans).toHaveLength(1)
  store.close()
})

test("实际 WebUiClient 分派实时与历史消息，断连结算请求并终止发布", async () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const sent: any[] = []
  const socket: UiSocket = {
    readyState: 1,
    send: data => { sent.push(JSON.parse(data)) },
    close: () => {},
    addEventListener: (event, listener) => { const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set) },
    removeEventListener: (event, listener) => { listeners.get(event)?.delete(listener) },
  }
  const emit = (message: unknown) => { for (const listener of listeners.get("message") ?? []) listener({ data: JSON.stringify(message) }) }
  const client = createWebUiClient({ socket })
  emit({ type: "handoff.state", state: { phase: "web-active", handoffId: "test" } })
  let updates = 0; client.subscribeTrace(() => { updates++ })
  emit({ type: "trace.live", revision: 1, span })
  expect(client.getLiveTrace()).toEqual([span])
  const loaded = client.loadThreadTrace("t1")
  const requestId = sent.at(-1).requestId
  emit({ type: "trace.span", requestId, threadId: "t1", span })
  emit({ type: "trace.loaded", requestId, threadId: "t1", spanCount: 1, hasAnyTrace: true, error: null })
  expect((await loaded).spans).toEqual([span])
  const pending = client.loadThreadTrace("t1")
  client.close()
  expect((await pending).error).not.toBeNull()
  emit({ type: "trace.live", revision: 2, span })
  expect(updates).toBe(1)
})
