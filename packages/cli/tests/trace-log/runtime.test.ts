import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
/** 实时 SDK 日志消费：合成字节流经过落盘、索引、回读与订阅，不调用真实模型。 */
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createTraceRuntime } from "../../src/trace-log/runtime"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const marker = (value: unknown) => `[[za38-log]]${JSON.stringify(value)}[[za38-log]]`
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hc-trace-live-")); roots.push(root)
  return { root, runtime: createTraceRuntime({ root, file: join(root, "session.log") }) }
}
test("每个字节切分仍正确解码中文，start/end 合并后实时与历史一致", async () => {
  const { root, runtime } = await setup()
  const events: unknown[] = []; runtime.subscribe(span => events.push(span))
  const start = { trace_id: "r", span_id: "s", name: "中文模型", type: "LLM", start_time: 1, thread_id: "t1", metadata: { input: "你好" } }
  for (const byte of Buffer.from(marker(start))) runtime.push(Buffer.from([byte]))
  await runtime.flush()
  expect(runtime.snapshot()[0]).toMatchObject({ name: "中文模型", endTime: null })
  runtime.push(Buffer.from(marker({ trace_id: "r", span_id: "s", end_time: 20, status: "SUCCESS", metadata: { output: "完成" } })))
  await runtime.flush()
  const history = await runtime.loadThread("t1")
  expect(history.spans).toHaveLength(1)
  expect(history.spans[0]).toMatchObject({ endTime: 20, metadata: { input: "你好", output: "完成" } })
  expect(runtime.snapshot()).toEqual(history.spans)
  expect(events).toHaveLength(2)
  expect((await readFile(join(root, "za38-trace-index.ndjson"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1)
  await runtime.close()
  runtime.push(Buffer.from(marker(start)))
  expect(events).toHaveLength(2)
})
test("先到未绑定节点，唯一会话出现后回填；乱序 start 不覆盖 end", async () => {
  const { runtime } = await setup()
  runtime.push(Buffer.from(marker({ trace_id: "r", span_id: "child", end_time: 30, status: "SUCCESS" })))
  runtime.push(Buffer.from(marker({ trace_id: "r", span_id: "child", start_time: 2, parent_span_id: "root" })))
  runtime.push(Buffer.from(marker({ trace_id: "r", span_id: "root", start_time: 1, metadata: { sessionId: "t1" } })))
  await runtime.flush()
  expect(runtime.snapshot().find(span => span.spanId === "child")).toMatchObject({ threadId: "t1", parentSpanId: "root", endTime: 30 })
  runtime.push(Buffer.from(marker({ trace_id: "r", span_id: "conflict", start_time: 3, thread_id: "t2" })))
  await runtime.flush()
  expect(runtime.snapshot().find(span => span.spanId === "child")?.threadId).toBeNull()
  expect((await runtime.loadThread("t1")).spans.map(span => span.spanId)).toEqual(["root"])
  await runtime.close()
})
test("off 和普通 stderr 不建文件，落盘失败只报告固定诊断并可关闭", async () => {
  const { root, runtime } = await setup()
  runtime.push(Buffer.from("ordinary stderr")); await runtime.close()
  expect(await readdir(root)).toEqual([])
  const off = createTraceRuntime({ root, file: "off" }); off.push(Buffer.from(marker({ span_id: "s", thread_id: "t" }))); await off.close()
  expect(await readdir(root)).toEqual([])
  await writeFile(join(root, "blocked"), "not a directory")
  const errors: string[] = []
  const failed = createTraceRuntime({ root, file: join(root, "blocked", "trace.log"), onError: message => errors.push(message) })
  failed.push(Buffer.from(marker({ span_id: "s", thread_id: "t" })))
  await failed.close()
  expect(errors).toEqual(["轨迹采集已停止：日志写入失败或超过资源上限。"])
  const diagnosticFailure = createTraceRuntime({ root, file: join(root, "blocked", "again.log"), onError: () => { throw new Error("observer failure") } })
  diagnosticFailure.push(Buffer.from(marker({ span_id: "s", thread_id: "t" })))
  await expect(diagnosticFailure.close()).resolves.toBeUndefined()
})

test("工作区 session JSONL 增量刷新并实时发布，历史与快照一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-session-live-")); roots.push(root)
  const runtime = createTraceRuntime({ root, file: "off", workspace: root })
  const events: unknown[] = []; runtime.subscribe(span => events.push(span))
  const start = { schema_version: 2, event: "span.start", session_id: "thread-1", trace_id: "trace-1", span_id: "llm", parent_span_id: "root", name: "graph.llm", kind: "LLM", start_time_ms: 1000, attributes: { model: "mock-model" } }
  const fingerprint = createHash("sha256").update(await realpath(root)).digest("hex")
  await mkdir(join(root, fingerprint))
  await writeFile(join(root, fingerprint, "session.jsonl"), JSON.stringify(start) + "\n")
  await runtime.flush()
  expect(runtime.snapshot()).toHaveLength(1)
  expect(runtime.snapshot()[0]).toMatchObject({ threadId: "thread-1", type: "LLM", endTime: null })
  await writeFile(join(root, fingerprint, "session.jsonl"), JSON.stringify(start) + "\n" + JSON.stringify({ ...start, event: "span.end", end_time_ms: 1250, duration_ms: 250, status: "SUCCESS" }) + "\n")
  await runtime.flush()
  expect(runtime.snapshot()[0]).toMatchObject({ endTime: 1250, durationMs: 250, status: "SUCCESS" })
  expect((await runtime.loadThread("thread-1")).spans).toEqual(runtime.snapshot())
  expect(events).toHaveLength(2)
  await runtime.close()
})

test("完整或未闭合的超大记录停止采集，固定诊断只发送一次且不会继续写入", async () => {
  for (const complete of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "hc-trace-record-limit-")); roots.push(root)
    const errors: string[] = []
    const runtime = createTraceRuntime({ root, file: join(root, "session.log"), onError: message => errors.push(message) })
    const text = marker({ span_id: "huge", thread_id: "t1", metadata: { output: "x".repeat(8 * 1024 * 1024) } })
    runtime.push(Buffer.from(complete ? text : text.slice(0, -"[[za38-log]]".length)))
    runtime.push(Buffer.from(marker({ span_id: "later", thread_id: "t1" })))
    await runtime.close()
    expect(errors).toEqual(["轨迹采集已停止：日志写入失败或超过资源上限。"])
    expect(runtime.snapshot()).toEqual([])
    expect(await readdir(root)).toEqual([])
  }
})

test("默认日期目录、文件名与 thread 索引沿用内网格式", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-trace-date-")); roots.push(root)
  const previous = process.env.HARNESS_ZA38_TRACE_LOG
  let runtime: ReturnType<typeof createTraceRuntime> | undefined
  try {
    delete process.env.HARNESS_ZA38_TRACE_LOG
    runtime = createTraceRuntime({ root, startedAtMs: new Date(2026, 9, 26, 12, 34, 56).getTime() })
    runtime.push(Buffer.from(marker({ span_id: "root", thread_id: "t1", start_time: 1 })))
    await runtime.close()
    expect(await readdir(join(root, "2026-10-26"))).toEqual(["za38-trace-20261026-123456.log"])
    expect(JSON.parse((await readFile(join(root, "za38-trace-index.ndjson"), "utf8")).trim())).toEqual({ v: 1, kind: "thread", thread_id: "t1", trace_file: join("2026-10-26", "za38-trace-20261026-123456.log") })
  } finally {
    if (previous === undefined) delete process.env.HARNESS_ZA38_TRACE_LOG
    else process.env.HARNESS_ZA38_TRACE_LOG = previous
    await runtime?.close()
  }
})
