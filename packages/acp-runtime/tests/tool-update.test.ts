/** HC-222 Part A：ACP 工具更新到本机显示值的投影测试：提取、回退、截断与缺省保持。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { toLocalAcpTool } from "../src/tool-update.ts"
import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk"

const baseCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  toolCallId: "call-1",
  title: "读取配置",
  ...overrides,
})

test("rawInput 对象转成美化 JSON", () => {
  const tool = toLocalAcpTool(baseCall({ rawInput: { path: "src/a.ts", line: 3 } }))
  assert.equal(tool.input, '{\n  "path": "src/a.ts",\n  "line": 3\n}')
})

test("rawInput 字符串原样保留，undefined/null 保持缺省", () => {
  assert.equal(toLocalAcpTool(baseCall({ rawInput: "plain args" })).input, "plain args")
  assert.equal(toLocalAcpTool(baseCall()).input, undefined)
  assert.equal(toLocalAcpTool(baseCall({ rawInput: null })).input, undefined)
})

test("content 文本优先于 rawOutput，缺失时回退 rawOutput", () => {
  const withContent = toLocalAcpTool(baseCall({
    content: [{ type: "content", content: { type: "text", text: "第一段" } }, { type: "content", content: { type: "text", text: "第二段" } }],
    rawOutput: "不应出现",
  }))
  assert.equal(withContent.output, "第一段\n第二段")
  const fallback = toLocalAcpTool(baseCall({ rawOutput: { exit: 0 } }))
  assert.equal(fallback.output, '{\n  "exit": 0\n}')
  assert.equal(toLocalAcpTool(baseCall({ rawOutput: "raw 文本" })).output, "raw 文本")
  assert.equal(toLocalAcpTool(baseCall()).output, undefined)
})

test("终端内容忽略；diff 转成 path/oldText/newText 并去 null", () => {
  const tool = toLocalAcpTool(baseCall({
    content: [
      { type: "terminal", terminalId: "t-1" } as never,
      { type: "diff", path: "a.ts", newText: "after", oldText: null },
      { type: "diff", path: "b.ts", oldText: "before", newText: "after" },
    ],
  }))
  assert.deepEqual(tool.diffs, [
    { path: "a.ts", oldText: undefined, newText: "after" },
    { path: "b.ts", oldText: "before", newText: "after" },
  ])
  assert.equal(tool.diffs?.length, 2)
})

test("超长字段截断并附截断标记", () => {
  const tool = toLocalAcpTool(baseCall({
    rawInput: "x".repeat(17 * 1024),
    rawOutput: "y".repeat(65 * 1024),
    content: [{ type: "diff", path: "c.ts", oldText: "o".repeat(33 * 1024), newText: "n" }],
  }))
  assert.ok(tool.input!.endsWith("…（内容过长，已截断）"))
  assert.ok(tool.input!.length < 17 * 1024 + 40)
  assert.ok(tool.output!.endsWith("…（内容过长，已截断）"))
  assert.ok(tool.diffs![0].oldText!.endsWith("…（内容过长，已截断）"))
})

test("content 含 diff 但无文本时仍回退 rawOutput", () => {
  const tool = toLocalAcpTool(baseCall({
    content: [{ type: "diff", path: "c.ts", newText: "n" }],
    rawOutput: "finished",
  }))
  assert.equal(tool.output, "finished")
})

test("tool_call_update 的缺省字段保持 undefined", () => {
  const update: ToolCallUpdate = { toolCallId: "call-9", status: "in_progress" }
  const tool = toLocalAcpTool(update)
  assert.deepEqual(tool, {
    id: "call-9",
    status: "in_progress",
    title: undefined,
    kind: undefined,
    input: undefined,
    output: undefined,
    diffs: undefined,
    locations: undefined,
  })
})

test("locations 提取有效路径与正整数行号，过滤控制字符并截断至 8 项", () => {
  const tool = toLocalAcpTool(baseCall({
    locations: [
      { path: " src/a.ts ", line: 12 },
      { path: "src/b.ts", line: 0 },
      { path: "src/c.ts", line: 1.5 },
      { path: "bad\npath.ts", line: 3 },
      { path: "   " },
      ...Array.from({ length: 10 }, (_, idx) => ({ path: `src/item-${idx}.ts`, line: idx + 1 })),
    ],
  }))
  assert.equal(tool.locations?.length, 8)
  assert.deepEqual(tool.locations?.slice(0, 4), [
    { path: "src/a.ts", line: 12 },
    { path: "src/b.ts" },
    { path: "src/c.ts" },
    { path: "src/item-0.ts", line: 1 },
  ])
})
