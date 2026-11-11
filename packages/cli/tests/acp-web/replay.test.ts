/** ReplayBuffer 表驱动用例（设计 §6.4）：history 录制帧 + 合成帧。 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ReplayBuffer } from "../../src/acp-web/client/replay"
import type { AcpSessionUpdate } from "../../src/acp-web/client/translate"

function wireUpdates(name: string): AcpSessionUpdate[] {
  return readFileSync(join(import.meta.dir, "support/wire", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => (JSON.parse(line) as { frame: Record<string, unknown> }).frame)
    .filter(frame => frame.method === "session/update")
    .map(frame => (frame.params as { update: AcpSessionUpdate }).update)
}

describe("ReplayBuffer：history 录制帧", () => {
  test("user/assistant/tool 顺序保持；消息内容、工具名取自 title 首段", () => {
    const replay = new ReplayBuffer()
    for (const update of wireUpdates("history")) replay.accept(update)
    expect(replay.messages).toEqual([
      { kind: "user", content: "先看一眼" },
      { kind: "assistant", content: "看完了。" },
      { kind: "tool", tool_name: "read_file", content: "工具输出", tool_call_id: "history-seed:h2", status: "completed" },
    ])
  })

  test("消息不含 created_at_ms", () => {
    const replay = new ReplayBuffer()
    for (const update of wireUpdates("history")) replay.accept(update)
    for (const message of replay.messages) expect(message).not.toHaveProperty("created_at_ms")
  })
})

describe("ReplayBuffer：拼接与边界", () => {
  const chunk = (kind: string, messageId: string, text: string): AcpSessionUpdate => ({
    sessionUpdate: kind,
    messageId,
    content: { type: "text", text },
  })

  test("同 messageId 的连续助手块拼接；不同 id 不拼", () => {
    const replay = new ReplayBuffer()
    replay.accept(chunk("agent_message_chunk", "s:m1", "第一段"))
    replay.accept(chunk("agent_message_chunk", "s:m1", "续"))
    replay.accept(chunk("agent_message_chunk", "s:m2", "第二条"))
    expect(replay.messages).toEqual([
      { kind: "assistant", content: "第一段续" },
      { kind: "assistant", content: "第二条" },
    ])
  })

  test("user 块之间插入 assistant 块后回到同 id 不拼接（非连续）", () => {
    const replay = new ReplayBuffer()
    replay.accept(chunk("agent_message_chunk", "s:m1", "A"))
    replay.accept(chunk("user_message_chunk", "s:u1", "U"))
    replay.accept(chunk("agent_message_chunk", "s:m1", "B"))
    expect(replay.messages.map(m => m.content)).toEqual(["A", "U", "B"])
  })

  test("空正文跳过；tool_call 无文本跳过；tool_call_update / thought 忽略", () => {
    const replay = new ReplayBuffer()
    replay.accept(chunk("agent_message_chunk", "s:m1", ""))
    replay.accept({ sessionUpdate: "tool_call", toolCallId: "s:t1", title: "ls", status: "completed", content: [] })
    replay.accept({ sessionUpdate: "tool_call_update", toolCallId: "s:t1", status: "completed" })
    replay.accept({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } })
    expect(replay.messages).toEqual([])
  })

  test("tool 块后回到消息块正常开新条", () => {
    const replay = new ReplayBuffer()
    replay.accept(chunk("agent_message_chunk", "s:m1", "前半"))
    replay.accept({ sessionUpdate: "tool_call", toolCallId: "s:t1", title: "cat x", status: "completed", content: [{ type: "content", content: { type: "text", text: "out" } }] })
    replay.accept(chunk("agent_message_chunk", "s:m2", "后半"))
    expect(replay.messages).toEqual([
      { kind: "assistant", content: "前半" },
      { kind: "tool", tool_name: "cat", content: "out", tool_call_id: "s:t1", status: "completed" },
      { kind: "assistant", content: "后半" },
    ])
  })
})

describe("回放 tool_call 带 args/status（2.9/2.12）", () => {
  test("rawInput → arguments；status failed → failed", () => {
    const buf = new ReplayBuffer()
    buf.accept({
      sessionUpdate: "tool_call",
      toolCallId: "s1:h0",
      title: "execute ls",
      rawInput: { command: "ls" },
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "boom" } }],
    } as never)
    const msg = buf.messages.find(m => m.kind === "tool")!
    expect(msg.tool_call_id).toBe("s1:h0")
    expect(msg.arguments).toEqual({ command: "ls" })
    expect(msg.status).toBe("failed")
  })

  test("completed → completed；旧数据无 rawInput → 无 arguments", () => {
    const buf = new ReplayBuffer()
    buf.accept({
      sessionUpdate: "tool_call",
      toolCallId: "s1:h0",
      title: "execute ls",
      rawInput: { command: "ls" },
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    } as never)
    buf.accept({
      sessionUpdate: "tool_call",
      toolCallId: "s1:h1",
      title: "legacy",
      content: [{ type: "content", content: { type: "text", text: "old" } }],
    } as never)
    const [a, b] = buf.messages.filter(m => m.kind === "tool")
    expect(a!.status).toBe("completed")
    expect(a!.arguments).toEqual({ command: "ls" })
    expect(b!.arguments).toBeUndefined()
    expect(b!.status).toBe("completed")
  })
})
