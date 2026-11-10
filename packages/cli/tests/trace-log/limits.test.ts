/** Trace 历史资源边界：真实临时文件验证上限和跨文件合并，不产生模型请求。 */
import { afterEach, expect, test } from "bun:test"
import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTraceHistorySource } from "../../src/trace-log/history"

const roots: string[] = []
const mib = 1024 * 1024
const marker = (value: unknown) => `[[za38-log]]${JSON.stringify(value)}[[za38-log]]\n`
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup(files: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "hc-trace-limits-")); roots.push(root)
  await writeFile(join(root, "za38-trace-index.ndjson"), files.map(trace_file => JSON.stringify({ v: 1, kind: "thread", thread_id: "t1", trace_file })).join("\n"))
  return { root, source: createTraceHistorySource({ root }) }
}

async function sparse(path: string, size: number) {
  const handle = await open(path, "w")
  try { await handle.truncate(size) } finally { await handle.close() }
}

test("start/end 分布在不同日志时仍保留父节点、输入和完整耗时，文件顺序不改变结果", async () => {
  const { root, source } = await setup(["end.log", "start.log"])
  await writeFile(join(root, "start.log"), marker({ trace_id: "r", span_id: "s", parent_span_id: "parent", start_time: 10, thread_id: "t1", metadata: { input: "原始请求" } }))
  await writeFile(join(root, "end.log"), marker({ trace_id: "r", span_id: "s", end_time: 50, status: "SUCCESS", metadata: { output: "结果" } }))
  const expected = { parentSpanId: "parent", startTime: 10, endTime: 50, durationMs: 40, threadId: "t1", metadata: { input: "原始请求", output: "结果" } }
  expect((await source.loadThread("t1")).spans).toMatchObject([expected])
  await writeFile(join(root, "za38-trace-index.ndjson"), ["start.log", "end.log"].map(trace_file => JSON.stringify({ v: 1, kind: "thread", thread_id: "t1", trace_file })).join("\n"))
  expect((await source.loadThread("t1")).spans).toMatchObject([expected])
})

test("64 MiB 单文件上限和 8 MiB 索引上限拒绝读取，不返回部分历史", async () => {
  const { root, source } = await setup(["large.log"])
  await sparse(join(root, "large.log"), 64 * mib + 1)
  await expect(source.loadThread("t1")).rejects.toThrow("轨迹日志读取失败")
  await sparse(join(root, "za38-trace-index.ndjson"), 8 * mib + 1)
  await expect(source.loadThread("t1")).rejects.toThrow("轨迹日志读取失败")
})

test("超过 256 个候选文件在读取前失败", async () => {
  const { source } = await setup(Array.from({ length: 257 }, (_, i) => `${i}.log`))
  await expect(source.loadThread("t1")).rejects.toThrow("轨迹日志读取失败")
})

test("累计读取超过 128 MiB 整体失败", async () => {
  const { root, source } = await setup(["a.log", "b.log", "c.log"])
  await Promise.all(["a.log", "b.log", "c.log"].map(file => sparse(join(root, file), 43 * mib)))
  await expect(source.loadThread("t1")).rejects.toThrow("轨迹日志读取失败")
}, { timeout: 15_000 })

test("恰好达到单文件和累计字节上限仍可完整回读", async () => {
  const { root, source } = await setup(["a.log", "b.log"])
  for (const file of ["a.log", "b.log"]) {
    const handle = await open(join(root, file), "w")
    try {
      await handle.writeFile(marker({ trace_id: "r", span_id: file, thread_id: "t1", start_time: 1 }))
      await handle.truncate(64 * mib)
    } finally { await handle.close() }
  }
  expect((await source.loadThread("t1")).spans.map(span => span.spanId)).toEqual(["a.log", "b.log"])
}, { timeout: 15_000 })

test("100000 个 Span 完整返回，超过后整体失败", async () => {
  const { root, source } = await setup(["many.log"])
  await writeFile(join(root, "many.log"), Array.from({ length: 100000 }, (_, i) => marker({ trace_id: "r", span_id: String(i), thread_id: "t1", start_time: i })).join(""))
  expect((await source.loadThread("t1")).spans).toHaveLength(100000)
  await appendFile(join(root, "many.log"), marker({ trace_id: "r", span_id: "overflow", thread_id: "t1", start_time: 100000 }))
  await expect(source.loadThread("t1")).rejects.toThrow("轨迹日志读取失败")
}, { timeout: 15_000 })
