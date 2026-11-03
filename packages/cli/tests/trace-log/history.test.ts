/** 历史 Trace：保留内网日志语义，拒绝路径越界和混合会话。 */
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTraceText } from "../../src/trace-log/parser"
import { createTraceHistorySource } from "../../src/trace-log/history"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const record = (data: Record<string, unknown>) => `[[za38-log]]${JSON.stringify(data)}[[za38-log]]`
const start = { trace_id: "run", span_id: "parent", parent_span_id: "0", start_time: 10, name: "run.accept", metadata: { input: { command: "StartRun(thread_id='t1')" } } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hc-trace-")); dirs.push(root)
  await mkdir(join(root, "2026-11-02"))
  const file = "za38-trace-20261102-120000.log"
  await writeFile(join(root, "2026-11-02", file), record(start) + record({ trace_id: "run", span_id: "child", start_time: 11, parent_span_id: "parent" }))
  await writeFile(join(root, "za38-trace-index.ndjson"), JSON.stringify({ v: 1, kind: "thread", thread_id: "t1", trace_file: file }) + "\n")
  return { root, file, source: createTraceHistorySource({ root }) }
}

test("同一行多个 marker、乱序 end/start、父节点和 metadata 保留，忽略畸形项", () => {
  const spans = parseTraceText(record({ ...start, end_time: 20, parent_span_id: "bad", metadata: { result: "done" } }) + "[[za38-log]]oops[[za38-log]]" + record(start) + record({ span_id: "pending", start_time: 5 }))
  expect(spans).toHaveLength(2)
  expect(spans[0]).toMatchObject({ threadId: "t1", parentSpanId: null, durationMs: 10, metadata: { result: "done", input: start.metadata.input } })
  expect(spans[1]?.endTime).toBeNull()
})
test("日期目录回读并按 trace 回填未绑定节点，其他会话不混入", async () => {
  const { source } = await fixture()
  const result = await source.loadThread("t1")
  expect(result.hasAnyTrace).toBe(true)
  expect(result.spans.map(span => span.threadId)).toEqual(["t1", "t1"])
  expect((await source.loadThread("t2")).spans).toEqual([])
})
test("同一 trace 出现不同会话时不猜测未绑定节点归属", async () => {
  const { root, file, source } = await fixture()
  await writeFile(join(root, "2026-11-02", file), record(start) + record({ trace_id: "run", span_id: "other", thread_id: "t2", start_time: 12 }) + record({ trace_id: "run", span_id: "unbound", start_time: 13 }))
  expect((await source.loadThread("t1")).spans.map(span => span.spanId)).toEqual(["parent"])
})
test("不存在索引和已删除日志返回空结果", async () => {
  const { root, file, source } = await fixture()
  await rm(join(root, "2026-11-02", file))
  expect((await source.loadThread("t1")).spans).toEqual([])
  await rm(join(root, "za38-trace-index.ndjson"))
  expect(await source.loadThread("t1")).toEqual({ spans: [], hasAnyTrace: false })
})
test("恶意索引拒绝目录穿越、根外绝对路径及符号链接", async () => {
  const { root, source } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "hc-trace-outside-")); dirs.push(outside)
  const secret = join(outside, "outside.log"); await writeFile(secret, record(start))
  await symlink(secret, join(root, "link.log"))
  for (const trace_file of [secret, `../${outside.split("/").at(-1)}/outside.log`, "link.log"]) {
    await writeFile(join(root, "za38-trace-index.ndjson"), JSON.stringify({ v: 1, kind: "thread", thread_id: "t1", trace_file }))
    await expect(source.loadThread("t1")).rejects.toThrow("轨迹日志读取失败")
  }
})
test("只允许显式配置的外部日志，取消与读取上限收敛", async () => {
  const { root } = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "hc-trace-config-")); dirs.push(outside)
  const configuredFile = join(outside, "configured.log"); await writeFile(configuredFile, record(start))
  await writeFile(join(root, "za38-trace-index.ndjson"), JSON.stringify({ v: 1, kind: "thread", thread_id: "t1", trace_file: configuredFile }))
  expect((await createTraceHistorySource({ root, configuredFile }).loadThread("t1")).spans).toHaveLength(1)
  const controller = new AbortController(); controller.abort()
  await expect(createTraceHistorySource({ root }).loadThread("t1", controller.signal)).rejects.toThrow()
})
