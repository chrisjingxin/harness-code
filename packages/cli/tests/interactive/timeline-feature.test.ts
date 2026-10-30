import { expect, test } from "bun:test"
import { EventType } from "@za38/protocol"
import { makeHarness, flush, notices, terminalEvent } from "./harness"

test("重复/倒序 Event 被丢弃，sequence 缺口只追加诊断并继续", async () => {
  const harness = makeHarness()
  try {
    await harness.controller.dispatch({ type: "input.submit", value: "测试事件" })
    const run = harness.runHandles.at(-1)!
    harness.port.emitEvent(terminalEvent(EventType.CONTENT_DELTA, run.threadId, run.runId, 1, { text: "A" }))
    harness.port.emitEvent(terminalEvent(EventType.CONTENT_DELTA, run.threadId, run.runId, 1, { text: "重复" }))
    harness.port.emitEvent(terminalEvent(EventType.CONTENT_DELTA, run.threadId, run.runId, 3, { text: "C" }))
    harness.port.emitEvent(terminalEvent(EventType.CONTENT_DELTA, run.threadId, run.runId, 2, { text: "倒序" }))
    await flush()
    const snapshot = harness.controller.getSnapshot()
    const contents = snapshot.timeline
      .filter(item => item.type === "message" && item.message.role === "assistant")
      .map(item => item.message.content)
      .join("")
    expect(contents).toBe("AC")
    // 必须恰好一条：序号检查只能有 acceptSequence 这一个决策点。
    expect(notices(snapshot).split("\n").filter(line => line.startsWith("sequence-gap"))).toEqual([
      "sequence-gap: expected 2, got 3",
    ])
  } finally {
    await harness.controller.close()
  }
})

