/** SDK 同格式持续消费验证；HARNESS_TRACE_SOAK_MS 可延长真实运行时长，不调用模型。 */
import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTraceRuntime } from "../../src/trace-log/runtime"
import { createTraceHistorySource } from "../../src/trace-log/history"
import { TraceLiveClient } from "../../src/web/infrastructure/trace-live-client"
import { TraceStore } from "../../src/web/application/trace-store"
import { TraceHistorySession } from "../../src/presentation-coordinator/trace-history-session"
import { TraceHistoryClient } from "../../src/web/infrastructure/trace-history-client"
import { parseServerFrame } from "../../src/presentation-coordinator/contracts/validation"

const requestedDuration = Number(process.env.HARNESS_TRACE_SOAK_MS ?? 1000)
const duration = Number.isFinite(requestedDuration) ? Math.max(1000, Math.min(600000, requestedDuration)) : 1000
const record = (data: unknown) => `[[za38-log]]${JSON.stringify(data)}[[za38-log]]\n`

test("多轮持续更新后实时、网关历史和重新打开文件的结果一致，关闭释放订阅", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-trace-soak-"))
  const errors: string[] = []
  const runtime = createTraceRuntime({ root, file: join(root, "session.log"), onError: error => errors.push(error) })
  const live = new TraceLiveClient()
  const store = new TraceStore(async threadId => ({ ...await runtime.loadThread(threadId), error: null }), () => {}, () => {})
  let revision = 0
  let events = 0
  const detach = runtime.subscribe(span => {
    const message = { type: "trace.live" as const, revision: ++revision, span }
    expect(parseServerFrame(JSON.stringify(message))).not.toBeUndefined()
    live.receive(message)
    events++
  })
  live.subscribe(spans => store.replaceLive(spans))
  const started = performance.now()
  const heapStart = process.memoryUsage().heapUsed
  let heapPeak = heapStart
  let rounds = 0
  let failures = 0
  try {
    do {
      const trace_id = `round-${rounds}`
      const thread_id = `thread-${rounds % 3}`
      const start_time = rounds * 1000
      const rootSpan = { trace_id, span_id: `${trace_id}-root`, parent_span_id: "0", name: "run.root", type: "RUN", start_time, metadata: { sessionId: "-" } }
      const accept = { trace_id, span_id: `${trace_id}-accept`, parent_span_id: rootSpan.span_id, name: "run.accept", type: "RUN", start_time: start_time + 1, metadata: { input: { command: `StartRun(thread_id='${thread_id}', message='中文多轮 ${rounds}')` } } }
      const model = { trace_id, span_id: `${trace_id}-model`, parent_span_id: accept.span_id, name: "model", type: "LLM", start_time: start_time + 2, metadata: { input: "问题" } }
      // 先收到未绑定内部节点，再到 run.accept；包含噪声和跨 chunk 中文。
      const starts = Buffer.from("ordinary stderr\n" + record(rootSpan) + record(model) + record(accept))
      for (let offset = 0; offset < starts.length; offset += 31) runtime.push(starts.subarray(offset, offset + 31))
      await runtime.flush()
      expect(store.getState(thread_id).spans.some(span => span.spanId === model.span_id && span.endTime === null)).toBe(true)
      const status = rounds % 7 === 0 ? "FAILED" : "SUCCESS"
      if (status === "FAILED") failures++
      for (const span of [rootSpan, model, accept]) {
        const end = record({ trace_id, span_id: span.span_id, end_time: start_time + 100, status, metadata: { output: "持续更新完成" } })
        runtime.push(Buffer.from(end + end)) // 重复完成帧不得新增节点。
        runtime.push(Buffer.from(record(span))) // 迟到 start 不回退结束状态。
      }
      await runtime.flush()
      expect(live.snapshot()).toHaveLength((rounds + 1) * 3)
      expect(store.getState(thread_id).spans.find(span => span.spanId === model.span_id)?.status).toBe(status)
      store.select(thread_id, true)
      store.select(thread_id, false)
      rounds++
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
      await Bun.sleep(50)
    } while (performance.now() - started < duration)

    expect(errors).toEqual([])
    expect(rounds).toBeGreaterThan(1)
    expect(failures).toBeGreaterThan(0)
    // 真正经过历史服务、网关预检与分帧、Browser 请求聚合后，结果仍与实时一致。
    let session!: TraceHistorySession
    const historyClient = new TraceHistoryClient(request => { void session.load(request); return true })
    session = new TraceHistorySession(runtime, async frame => { historyClient.receive(frame) }, () => true)
    for (let i = 0; i < 3; i++) {
      const threadId = `thread-${i}`
      const result = await historyClient.loadThread(threadId)
      expect(result.error).toBeNull()
      const byKey = (spans: typeof result.spans) => [...spans].sort((a, b) => a.spanId.localeCompare(b.spanId))
      expect(byKey(result.spans)).toEqual(byKey(store.getState(threadId).spans))
    }
    session.close(); historyClient.cancel()
    detach()
    const published = events
    await runtime.close()
    expect(runtime.close()).toBe(runtime.close())
    expect(runtime.snapshot()).toEqual([])
    runtime.push(Buffer.from(record({ span_id: "after-close", thread_id: "thread-0" })))
    expect(events).toBe(published)
    live.close(); store.close()
    expect(live.snapshot()).toEqual([])
    const reopened = await createTraceHistorySource({ root }).loadThread("thread-0")
    expect(reopened.spans).toHaveLength(Math.ceil(rounds / 3) * 3)
    expect(reopened.spans.every(span => span.endTime !== null && span.threadId === "thread-0")).toBe(true)
    const index = (await readFile(join(root, "za38-trace-index.ndjson"), "utf8")).trim().split("\n")
    expect(index).toHaveLength(3)
    console.log(JSON.stringify({ traceSoak: { elapsedMs: Math.round(performance.now() - started), rounds, spans: rounds * 3, liveEvents: events, heapStartMiB: Math.round(heapStart / 1048576), heapPeakMiB: Math.round(heapPeak / 1048576) } }))
  } finally {
    detach(); live.close(); store.close()
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
}, { timeout: duration + 30000 })
