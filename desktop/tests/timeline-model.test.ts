/** HC-222 停点 2：工具分组分段与一轮进行中判定的纯函数测试。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationTimeline } from "../src/ui/conversation/timeline.tsx"
import { deriveMinimapItems, isTurnActive, segmentAgentEntries, splitTurnProcess } from "../src/ui/conversation/timeline-model.ts"
import type { ConversationTimelineEntry } from "../src/ui/index.ts"

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

test("已完成的过程用一行展示 Agent 实际名称、耗时和完成时间，正文无独立名称栏", () => {
  const now = new Date()
  const finishedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 52).getTime()
  const html = renderToStaticMarkup(createElement(ConversationTimeline, {
    scope: { namespace: "test", accountId: "a", workspaceId: "w", conversationId: "c" },
    visible: true,
    contentRevision: 1,
    entries: [
      { ...userMessage("prompt", "问题", finishedAt - 60_000), author: { id: "a", displayName: "测试用户" } },
      tool("completed-tool"),
      { ...message("reply"), createdAtMs: finishedAt, runSummary: { durationMs: 15_000, agentName: "Harness Code" } },
    ],
    personal: { expandedTools: [], expandedOutputs: [], scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null } },
    onPersonalChange() {},
  }))
  assert.match(html, /class="wb-conversation-process-header"[^>]*aria-expanded="false"/)
  assert.match(html, /Harness Code 用时 15s/)
  assert.match(html, /class="wb-conversation-time wb-conversation-process-time"[^>]*>10:52<\/time>/)
  assert.doesNotMatch(html, /测试用户|wb-conversation-message-meta|>Agent<|15\.0 秒/)
})

test("历史回复按相邻提问时间补算耗时，未结束时不显示完成信息", () => {
  const startedAt = 1_700_000_000_000
  const entries: ConversationTimelineEntry[] = [tool("a"), { ...message("reply"), createdAtMs: startedAt + 15_000 }]
  const finished = splitTurnProcess(entries, null, startedAt).processSummary
  assert.equal(finished?.durationMs, 15_000)
  assert.equal(finished?.completedAtMs, startedAt + 15_000)
  assert.equal(finished?.agentName, undefined)
  assert.equal(splitTurnProcess(entries, { label: "正在回复", active: true }, startedAt).processSummary, null)
  assert.equal(splitTurnProcess(entries, null, startedAt + 20_000).processSummary?.durationMs, undefined)
})

test("用户消息底栏可复制，按本机日期逐级补齐时间", () => {
  const now = new Date()
  const year = now.getFullYear()
  const sameYearMonth = now.getMonth() === 1 && now.getDate() === 17 ? 2 : 1
  const today = new Date(year, now.getMonth(), now.getDate(), 10, 52)
  const otherDay = new Date(year, sameYearMonth, 17, 10, 52)
  const otherYear = new Date(year - 1, 1, 17, 10, 52)
  const html = renderToStaticMarkup(createElement(ConversationTimeline, {
    scope: { namespace: "test", accountId: "a", workspaceId: "w", conversationId: "c" },
    visible: true,
    contentRevision: 1,
    entries: [
      userMessage("today", "第一条", today.getTime()),
      userMessage("other-day", "第二条", otherDay.getTime()),
      userMessage("other-year", "第三条", otherYear.getTime()),
      userMessage("undated", "没有时间", Number.MAX_VALUE),
      message("reply"),
    ],
    personal: { expandedTools: [], expandedOutputs: [], scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null } },
    rendering: { copyText: async () => {} },
  }))
  assert.equal((html.match(/aria-label="复制消息"/g) ?? []).length, 4)
  assert.deepEqual([...html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map(match => match[1]), [
    "10:52", `0${sameYearMonth + 1}-17 10:52`, `${year - 1}-02-17 10:52`,
  ])
  assert.match(html, /aria-label="复制回答"/)
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

test("splitTurnProcess：单段过程不包外层；多轮思考与工具在正文输出或结束后自动收起", () => {
  const single = splitTurnProcess([reasoning("r-1"), message("m-1")])
  assert.equal(single.processSummary, null)
  assert.equal(single.processSegments.length, 1)
  assert.equal(single.finalEntry?.id, "m-1")

  const stillRunningTool = splitTurnProcess(
    [reasoning("r-1", false), tool("t-1", "completed"), tool("t-2", "running")],
    { active: true, label: "执行中" },
  )
  assert.equal(stillRunningTool.processSummary?.id, "process:r-1")
  assert.equal(stillRunningTool.processSummary?.label, "思考过程 · 2 个操作")
  assert.equal(stillRunningTool.processSummary?.running, true)
  assert.equal(stillRunningTool.finalEntry, undefined)

  const answering = splitTurnProcess(
    [reasoning("r-1", false), tool("t-1", "completed"), tool("t-2", "failed"), reasoning("r-2", false), tool("t-3", "completed"), message("final", true)],
    { active: true, label: "正在回复" },
  )
  assert.equal(answering.processSummary?.label, "思考 2 次 · 3 个操作")
  assert.equal(answering.processSummary?.failedCount, 1)
  assert.equal(answering.processSummary?.running, false)
  assert.equal(answering.processSegments.length, 4)
  assert.equal(answering.finalEntry?.id, "final")
})

test("splitTurnProcess：末尾仅跟思考条目时不把助手最终回复吞入思考过程", () => {
  const withTrailingThought = splitTurnProcess([
    reasoning("r-1", false),
    tool("t-1", "completed"),
    message("final", false),
    reasoning("r-2", false),
  ])
  assert.equal(withTrailingThought.finalEntry?.id, "final")
  assert.equal(withTrailingThought.processSummary?.label, "思考 2 次 · 1 个操作")
  assert.equal(withTrailingThought.processSummary?.running, false)
  assert.equal(withTrailingThought.processSegments.length, 3)

  const withActiveTrailingThought = splitTurnProcess(
    [reasoning("r-1", false), tool("t-1", "completed"), message("final", false), reasoning("r-2", true)],
    { active: true, label: "执行中" },
  )
  assert.equal(withActiveTrailingThought.finalEntry?.id, "final")
  assert.equal(withActiveTrailingThought.processSummary?.running, true)

  const singleTrailingThought = splitTurnProcess([message("final", false), reasoning("r-2", false)])
  assert.equal(singleTrailingThought.finalEntry?.id, "final")
  assert.equal(singleTrailingThought.processSummary, null)
  assert.equal(singleTrailingThought.processSegments.length, 1)

  const toolAfterMessage = splitTurnProcess([
    reasoning("r-1", false),
    message("mid", false),
    tool("t-2", "completed"),
    reasoning("r-2", false),
  ])
  assert.equal(toolAfterMessage.finalEntry, undefined)
  assert.equal(toolAfterMessage.processSummary?.label, "思考 2 次 · 1 个操作")
  assert.equal(toolAfterMessage.processSegments.length, 4)
})
