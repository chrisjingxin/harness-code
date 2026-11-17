/** HC-222 Part A：本机执行视图的工具细节合并、色调映射与思考条目归并测试。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { applyLocalExecutionUpdate, emptyLocalExecutionView } from "../src/renderer/features/session/local-execution-view.ts"
import type { LocalExecutionTool } from "../src/local-execution-host.ts"

const author = { id: "u-1", displayName: "我" }

const accepted = (text = "请处理") => applyLocalExecutionUpdate(emptyLocalExecutionView, {
  kind: "accepted", turnId: "t-1", text, author,
})

const tool = (id: string, overrides: Partial<LocalExecutionTool> = {}): LocalExecutionTool => ({ id, ...overrides })

test("工具更新合并：后到的状态+输出不丢先到参数", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "tool", turnId: "t-1", tool: tool("c-1", { title: "编辑", kind: "edit", input: "参数", status: "in_progress" }) })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("c-1", { status: "completed", output: "完成" }) })
  const entry = state.entries.find(item => item.id === "local-execution:t-1:tool:c-1")
  assert.equal(entry?.kind, "tool")
  if (entry?.kind !== "tool") return
  assert.equal(entry.status, "completed")
  assert.equal(entry.detail?.argumentsText, "参数")
  assert.equal(entry.detail?.outputText, "完成")
  assert.equal(entry.detail?.copyText, "完成")
})

test("kind 映射色调：读类 read，写类 write，缺省 neutral", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "tool", turnId: "t-1", tool: tool("r-1", { kind: "search" }) })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("w-1", { kind: "move" }) })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("n-1", {}) })
  const tone = (id: string) => state.entries.find(e => e.id === `local-execution:t-1:tool:${id}`)
  assert.equal(tone("r-1")?.kind === "tool" && tone("r-1")?.tone === "read", true)
  assert.equal(tone("w-1")?.kind === "tool" && tone("w-1")?.tone === "write", true)
  assert.equal(tone("n-1")?.kind === "tool" && tone("n-1")?.tone === "neutral", true)
})

test("diff 转成增删行块", () => {
  const state = applyLocalExecutionUpdate(accepted(), {
    kind: "tool", turnId: "t-1",
    tool: tool("d-1", { diffs: [{ path: "a.ts", oldText: "x\ny", newText: "z" }] }),
  })
  const entry = state.entries.at(-1)
  if (entry?.kind !== "tool") return assert.fail("expected tool")
  assert.deepEqual(entry.detail?.blocks, [{
    kind: "diff", path: "a.ts",
    rows: [{ kind: "remove", text: "x" }, { kind: "remove", text: "y" }, { kind: "add", text: "z" }],
  }])
})

test("思考片段归并：连续合并同一条目，工具后出现新条目", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "thought", turnId: "t-1", text: "先想" })
  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "再想" })
  let reasoning = state.entries.at(-1)
  if (reasoning?.kind !== "reasoning") return assert.fail("expected reasoning")
  assert.equal(reasoning.text, "先想再想")
  assert.equal(reasoning.active, true)
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("x-1") })
  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "工具后的思考" })
  reasoning = state.entries.at(-1)
  if (reasoning?.kind !== "reasoning") return assert.fail("expected new reasoning")
  assert.equal(reasoning.id, "local-execution:t-1:reasoning:1")
  assert.equal(reasoning.text, "工具后的思考")
})

test("结束后思考置 inactive，运行中工具置失败", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "thought", turnId: "t-1", text: "思考" })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("z-1", { status: "in_progress" }) })
  state = applyLocalExecutionUpdate(state, { kind: "finished", turnId: "t-1" })
  const reasoning = state.entries.find(e => e.kind === "reasoning")
  assert.equal(reasoning?.kind === "reasoning" && reasoning.active, false)
  const toolEntry = state.entries.find(e => e.kind === "tool")
  assert.equal(toolEntry?.kind === "tool" && toolEntry.status, "failed")
})

test("结束后迟到的更新被忽略", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "finished", turnId: "t-1" })
  const before = state
  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "迟到" })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("late-1") })
  assert.equal(state, before)
})

test("受理的提问带有本机时间戳，供锚定预览显示", () => {
  const before = Date.now()
  const state = accepted()
  const entry = state.entries[0]
  assert.equal(entry?.kind, "message")
  if (entry?.kind !== "message") return
  assert.equal(typeof entry.createdAtMs, "number")
  assert.ok(entry.createdAtMs !== undefined && entry.createdAtMs >= before && entry.createdAtMs <= Date.now())
})
