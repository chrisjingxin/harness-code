/** HC-222 停点 2：工具分组分段与一轮进行中判定的纯函数测试。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { deriveMinimapItems, isTurnActive, segmentAgentEntries } from "@workbench/ui/timeline-model"
import type { ConversationTimelineEntry } from "@workbench/ui"

const tool = (id: string, status: "running" | "completed" | "failed" = "completed"): ConversationTimelineEntry => ({
  kind: "tool", id, label: id, status, tone: "neutral",
})

const message = (id: string, streaming = false): ConversationTimelineEntry => ({
  kind: "message", id, role: "assistant", text: "正文", streaming,
})

const reasoning = (id: string, active = false): ConversationTimelineEntry => ({
  kind: "reasoning", id, text: "思考", active,
})

test("连续 ≥2 个工具合成组，组 id 取首个工具", () => {
  const segments = segmentAgentEntries([tool("a"), tool("b"), message("m"), tool("c"), tool("d"), tool("e")])
  assert.deepEqual(segments.map(s => s.kind), ["tool-group", "entry", "tool-group"])
  assert.equal(segments[0].kind === "tool-group" && segments[0].id, "group:a")
  assert.equal(segments[0].kind === "tool-group" && segments[0].tools.length, 2)
  assert.equal(segments[2].kind === "tool-group" && segments[2].tools.length, 3)
})

test("单个工具不分组，原样通过", () => {
  const segments = segmentAgentEntries([tool("a"), message("m"), tool("b")])
  assert.deepEqual(segments.map(s => s.kind), ["entry", "entry", "entry"])
})

test("进行中的判定覆盖推理、流式回答、运行工具与末组活动", () => {
  assert.equal(isTurnActive([reasoning("r", true)]), true)
  assert.equal(isTurnActive([message("m", true)]), true)
  assert.equal(isTurnActive([tool("t", "running")]), true)
  assert.equal(isTurnActive([tool("t")], { active: true, label: "执行中" }), true)
  assert.equal(isTurnActive([tool("t"), reasoning("r"), message("m")], { active: false, label: "x" }), false)
  assert.equal(isTurnActive([tool("t"), reasoning("r"), message("m")]), false)
})

const userMessage = (id: string, text: string, createdAtMs?: number): ConversationTimelineEntry => ({
  kind: "message", id, role: "user", text, createdAtMs,
})

test("锚点只取用户提问：折叠空白、跳过空提问、透传时间", () => {
  const items = deriveMinimapItems([
    userMessage("u-1", "  第一行\n\n第二行\t", 1_700_000_000_000),
    message("a-1"),
    userMessage("u-2", "   \n  "),
    tool("t-1"),
    userMessage("u-3", "没有时间的提问"),
  ])
  assert.deepEqual(items, [
    { entryId: "u-1", text: "第一行 第二行", createdAtMs: 1_700_000_000_000 },
    { entryId: "u-3", text: "没有时间的提问", createdAtMs: undefined },
  ])
})
