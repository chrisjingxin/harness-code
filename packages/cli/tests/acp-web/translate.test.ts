/** RunTranslator 表驱动用例（设计 §6.4）：含录制帧与合成帧。 */

import { describe, expect, test } from "bun:test"

import { RunTranslator, MAX_OUTPUT_CHARS, type AcpSessionUpdate, type PromptOutcome } from "../../src/acp-web/client/translate"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const now = () => 1000
const opts = { runId: "r1", threadId: "t1", startedAtMs: 900, now }

function wireFrames(name: string): Array<Record<string, unknown>> {
  const path = join(import.meta.dir, "support/wire", `${name}.jsonl`)
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => (JSON.parse(line) as { frame: Record<string, unknown> }).frame)
}

function wireUpdates(name: string): { updates: AcpSessionUpdate[]; promptOutcome: PromptOutcome } {
  const frames = wireFrames(name)
  const updates: AcpSessionUpdate[] = []
  let promptOutcome: PromptOutcome = { stopReason: "end_turn" }
  for (const frame of frames) {
    if (frame.method === "session/update") {
      updates.push((frame.params as { update: AcpSessionUpdate }).update)
    } else if ("result" in frame && (frame.result as { stopReason?: string }).stopReason) {
      promptOutcome = frame.result as PromptOutcome
    }
  }
  return { updates, promptOutcome }
}

describe("RunTranslator：信封", () => {
  test("sequence 从 1 严格递增；event_id / thread_id / run_id / timestamp_ms 正确", () => {
    const t = new RunTranslator(opts)
    const events = [t.started(), ...t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }), ...t.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "b" } })]
    expect(events.map(e => e.sequence)).toEqual([1, 2, 3])
    expect(events[0]).toMatchObject({ event_id: "r1:1", thread_id: "t1", run_id: "r1", timestamp_ms: 1000, payload: { mode: "build", resumed: false } })
  })

  test("终态后再喂 update 无输出", () => {
    const t = new RunTranslator(opts)
    t.finish({ stopReason: "end_turn" })
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })).toEqual([])
  })
})

describe("RunTranslator：正文 / 思考", () => {
  test("agent_message_chunk → content.delta；agent_thought_chunk → reasoning.delta", () => {
    const t = new RunTranslator(opts)
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } })[0]).toMatchObject({ type: "content.delta", payload: { text: "你好" } })
    expect(t.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想一下" } })[0]).toMatchObject({ type: "reasoning.delta", payload: { text: "想一下" } })
  })

  test("空文本、非文本内容丢弃", () => {
    const t = new RunTranslator(opts)
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([])
    expect(t.update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } })).toEqual([])
  })
})

describe("RunTranslator：工具生命周期（tools 录制帧）", () => {
  test("tool_call(pending) → tool.started；终态 update → delta(arguments) + completed", () => {
    const t = new RunTranslator(opts)
    const { updates } = wireUpdates("tools")
    const events = updates.flatMap(u => t.update(u))
    const types = events.map(e => e.type)
    // 终态 update 自带 rawInput/rawOutput：先补 arguments_delta 再 completed。
    expect(types).toEqual(["tool.started", "tool.delta", "tool.completed", "content.delta"])
    expect(events[0]).toMatchObject({ payload: { name: "read_file" } })
    expect(events[1]).toMatchObject({ payload: { arguments_delta: expect.any(String) } })
    const completed = events.find(e => e.type === "tool.completed")
    expect(completed).toMatchObject({ payload: { result: { content: "hello from file", is_error: false } } })
  })
})

describe("RunTranslator：审批卡（approval 录制帧）", () => {
  test("tool_call 自带 rawInput → started + delta(arguments)；in_progress 无内容不产事件；终态 completed", () => {
    const t = new RunTranslator(opts)
    const { updates } = wireUpdates("approval")
    const events = updates.flatMap(u => t.update(u))
    const types = events.map(e => e.type)
    expect(types).toEqual(["tool.started", "tool.delta", "tool.completed", "content.delta"])
    expect(events[0]).toMatchObject({ payload: { name: "execute" } })
    expect(events[1]).toMatchObject({ payload: { arguments_delta: '{"command":"npm test"}' } })
    expect(events[2]).toMatchObject({ payload: { result: { content: "已执行", is_error: false } } })
  })
})

describe("RunTranslator：累计内容 → 增量", () => {
  const mkTool = (t: RunTranslator) => t.update({ sessionUpdate: "tool_call", toolCallId: "x:c0", title: "cat", status: "pending" })

  test('"a"→"ab"→"abc" 增量依次 a/b/c；重发、收缩、非前缀均不再发；终态整文本覆盖', () => {
    const t = new RunTranslator(opts)
    mkTool(t)
    const feed = (text: string) => t.update({ sessionUpdate: "tool_call_update", toolCallId: "x:c0", status: "in_progress", content: [{ type: "content", content: { type: "text", text } }] })
    expect(feed("a").map(e => (e.payload as { output_delta?: string }).output_delta)).toEqual(["a"])
    expect(feed("ab").map(e => (e.payload as { output_delta?: string }).output_delta)).toEqual(["b"])
    expect(feed("abc").map(e => (e.payload as { output_delta?: string }).output_delta)).toEqual(["c"])
    expect(feed("abc")).toEqual([]) // 重发
    expect(feed("ab")).toEqual([])  // 收缩（截断后）
    expect(feed("x")).toEqual([])   // 非前缀：diverged，不发增量
    // 终态带完整文本 → 不补增量，result.content 整体覆盖。
    const final = t.update({ sessionUpdate: "tool_call_update", toolCallId: "x:c0", status: "completed", content: [{ type: "content", content: { type: "text", text: "abcdef" } }] })
    expect(final[0]).toMatchObject({ type: "tool.completed", payload: { result: { content: "abcdef" } } })
  })

  test("多字节与代理对：emoji + 中文的前缀换算不切坏字符", () => {
    const t = new RunTranslator(opts)
    mkTool(t)
    const feed = (text: string) => t.update({ sessionUpdate: "tool_call_update", toolCallId: "x:c0", content: [{ type: "content", content: { type: "text", text } }] })
    const d1 = feed("你好🎉").map(e => (e.payload as { output_delta?: string }).output_delta)
    const d2 = feed("你好🎉🎉吗").map(e => (e.payload as { output_delta?: string }).output_delta)
    expect(d1).toEqual(["你好🎉"])
    expect(d2).toEqual(["🎉吗"])
    expect(`你好🎉${d2[0]}`).toBe("你好🎉🎉吗")
  })
})

describe("RunTranslator：失败与边界", () => {
  test("status failed → is_error true；重复终态丢弃；无 started 的完整卡合成两条", () => {
    const t = new RunTranslator(opts)
    t.update({ sessionUpdate: "tool_call", toolCallId: "x:f0", title: "rm", status: "pending" })
    const failed = t.update({ sessionUpdate: "tool_call_update", toolCallId: "x:f0", status: "failed" })
    expect(failed.at(-1)).toMatchObject({ payload: { result: { is_error: true } } })
    expect(t.update({ sessionUpdate: "tool_call_update", toolCallId: "x:f0", status: "completed" })).toEqual([])

    const t2 = new RunTranslator(opts)
    const events = t2.update({ sessionUpdate: "tool_call", toolCallId: "x:c9", title: "ls", status: "completed" })
    expect(events.map(e => e.type)).toEqual(["tool.started", "tool.completed"])
  })

  test("未登记的 toolCallId 纯更新 → 先合成 tool.started", () => {
    const t = new RunTranslator(opts)
    const events = t.update({ sessionUpdate: "tool_call_update", toolCallId: "x:u0", status: "in_progress" })
    expect(events[0]).toMatchObject({ type: "tool.started", payload: { name: "tool" } })
  })

  test("终态截断标记：内容达到上限时 truncated=true", () => {
    const t = new RunTranslator(opts)
    const big = "a".repeat(MAX_OUTPUT_CHARS)
    const events = t.update({ sessionUpdate: "tool_call", toolCallId: "x:b0", title: "cat", status: "completed", content: [{ type: "content", content: { type: "text", text: big } }] })
    const completed = events.at(-1) as { payload: { result: { truncated: boolean; original_bytes: number } } }
    expect(completed.payload.result.truncated).toBe(true)
    expect(completed.payload.result.original_bytes).toBe(MAX_OUTPUT_CHARS)
  })
})

describe("RunTranslator：终态映射", () => {
  test("end_turn + _meta.harnessCode.run → run.completed 原样", () => {
    const t = new RunTranslator(opts)
    const final = t.finish({ stopReason: "end_turn", _meta: { harnessCode: { run: { usage: { input_tokens: 3, output_tokens: 5 }, duration_ms: 42, context: { a: 1 } } } } })
    expect(final).toMatchObject({ type: "run.completed", payload: { usage: { input_tokens: 3, output_tokens: 5 }, duration_ms: 42, finish_reason: "end_turn", context: { a: 1 } } })
  })

  test("PromptResponse.usage 优先于扩展里的 run.usage", () => {
    const t = new RunTranslator(opts)
    const final = t.finish({
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 4, cachedReadTokens: 1, totalTokens: 8 },
      _meta: { harnessCode: { run: { usage: { input_tokens: 9, output_tokens: 9 }, duration_ms: 7 } } },
    })
    expect(final).toMatchObject({
      type: "run.completed",
      payload: { usage: { input_tokens: 3, output_tokens: 4, cached_tokens: 1 }, duration_ms: 7 },
    })
  })

  test("缺 _meta → 零值与 now - startedAt；cancelled / max_tokens / refusal", () => {
    const t = new RunTranslator(opts)
    expect(t.finish({ stopReason: "end_turn" })).toMatchObject({ payload: { usage: { input_tokens: 0, output_tokens: 0 }, duration_ms: 100, context: {} } })
    expect(new RunTranslator(opts).finish({ stopReason: "cancelled" })).toMatchObject({ type: "run.cancelled", payload: { reason: "user cancelled" } })
    expect(new RunTranslator(opts).finish({ stopReason: "max_tokens" })).toMatchObject({ payload: { finish_reason: "max_tokens" } })
    expect(new RunTranslator(opts).finish({ stopReason: "refusal" })).toMatchObject({ type: "run.failed", payload: { error: { code: "MODEL_REFUSAL", retryable: false } } })
  })

  test("RequestError → run.failed 字段原样", () => {
    const t = new RunTranslator(opts)
    const final = t.finish({ error: { code: -32603, message: "boom", data: { code: "MODEL_CONFIGURATION_REQUIRED", message: "未配置模型", retryable: false } } })
    expect(final).toMatchObject({ type: "run.failed", payload: { error: { code: "MODEL_CONFIGURATION_REQUIRED", message: "未配置模型", retryable: false } } })
  })
})

describe("RunTranslator：计划与用量", () => {
  test("plan 还原成 compose.progress，revision 递增", () => {
    const t = new RunTranslator(opts)
    const first = t.update({
      sessionUpdate: "plan",
      entries: [
        { content: "需求", status: "completed", priority: "medium" },
        { content: "规格（失败）", status: "completed", priority: "medium" },
        { content: "计划", status: "in_progress", priority: "medium" },
        { content: "实现", status: "pending", priority: "medium" },
        { content: "检视", status: "pending", priority: "medium" },
      ],
    })
    expect(first[0]).toMatchObject({
      type: "compose.progress",
      payload: {
        revision: 1,
        thread_id: "t1",
        current_stage: "plan",
        stages: [
          { id: "requirement", state: "confirmed" },
          { id: "spec", state: "failed" },
          { id: "plan", state: "current" },
          { id: "implement", state: "pending" },
          { id: "review", state: "pending" },
        ],
      },
    })
    const second = t.update({
      sessionUpdate: "plan",
      entries: [{ content: "需求", status: "in_progress", priority: "medium" }],
    })
    expect(second[0]).toMatchObject({ payload: { revision: 2, current_stage: "grill" } })
  })

  test("usage_update 变成上下文数字", () => {
    const t = new RunTranslator(opts)
    expect(t.update({ sessionUpdate: "usage_update", used: 12, size: 100 })[0]).toMatchObject({
      type: "context.updated",
      payload: { action: "usage", estimated_tokens: 12, input_cap_tokens: 100 },
    })
  })
})

describe("RunTranslator：未知 update", () => {
  test("plan / usage_update → 无事件，计数加一", () => {
    const logs: Array<{ event: string }> = []
    const t = new RunTranslator({ ...opts, log: e => logs.push(e) })
    expect(t.update({ sessionUpdate: "plan" })).toEqual([])
    expect(t.update({ sessionUpdate: "usage_update" })).toEqual([])
    expect(logs).toHaveLength(2)
  })
})
