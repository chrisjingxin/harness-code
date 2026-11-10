/** v2 解析只读新 schema，并跨文件解析去重载荷。 */
import { expect, test } from "bun:test"
import { TraceLogParser } from "../../src/trace-log/parser"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createWorkspaceTraceReader } from "../../src/trace-log/history"

test("v2 resolves payloads across files and rejects v1", () => {
  const parser = new TraceLogParser()
  const span = { event: "span.end", trace_id: "t", span_id: "s", session_id: "thread", name: "llm.call", start_time_ms: 1, end_time_ms: 5, duration_ms: 4, attributes: { output_ref: "p1" } }
  parser.pushText(JSON.stringify({ ...span, schema_version: 1, span_id: "old" }))
  parser.pushText(JSON.stringify({ ...span, schema_version: 2 }))
  parser.pushText(JSON.stringify({ schema_version: 2, event: "payload", trace_id: "t", payload_id: "p1", bytes: 8, kind: "output", body: "hello" }))
  expect(parser.snapshot()).toHaveLength(1)
  expect(parser.snapshot()[0]!.raw.payloads).toEqual({ p1: { bytes: 8, kind: "output", body: "hello" } })
})

test("工作区指纹与 Python 一致，根目录 marker 与旧工作区日志不混入", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-v2-path-"))
  try {
    const python = resolve("../agent/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
    const fingerprint = execFileSync(python, ["-c", "import hashlib,pathlib,sys; print(hashlib.sha256(str(pathlib.Path(sys.argv[1]).resolve()).encode('utf-8')).hexdigest())", root], { encoding: "utf8" }).trim()
    const directory = join(root, fingerprint)
    await mkdir(directory)
    await mkdir(join(root, "log"))
    const row = { schema_version: 2, event: "span.end", trace_id: "t", span_id: "s", session_id: "thread", name: "tool.call", start_time_ms: 1, end_time_ms: 2, duration_ms: 1 }
    await writeFile(join(directory, "Trace-log-test.jsonl"), JSON.stringify(row))
    await writeFile(join(root, "log", "old.jsonl"), JSON.stringify({ ...row, span_id: "old" }))
    const result = await createWorkspaceTraceReader(root, root).read()
    expect(result.spans.map(span => span.spanId)).toEqual(["s"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
