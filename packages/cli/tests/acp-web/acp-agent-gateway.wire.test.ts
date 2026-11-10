/**
 * 回放真实 Python Agent 的录制帧（`support/wire/*.jsonl`）驱动网关：
 * `connect → startRun → 事件 → 终态`（tools / approval / host）与
 * `listThreads → openThread`（history）。Python 侧帧形状变化会让它先红。
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { EventEnvelope } from "@za38/protocol"
import { AcpAgentGateway } from "../../src/acp-web/client/acp-agent-gateway"
import { FakeAgent, pairedStreams } from "./support/fake-agent"

type WireFrame = Record<string, unknown>

function loadWire(name: string): WireFrame[] {
  return readFileSync(join(import.meta.dir, "support/wire", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => (JSON.parse(line) as { frame: WireFrame }).frame)
}

/** 把录制帧变成 FakeAgent 脚本：按录制顺序在 prompt/load 时重放 update 与响应。 */
function wireAgent(name: string): FakeAgent {
  const frames = loadWire(name)
  const updates = frames
    .filter(f => f.method === "session/update")
    .map(f => f.params as { sessionId: string; update: Record<string, unknown> })
  const permission = frames.find(f => f.method === "session/request_permission")
  const promptResult = frames.find(f => "result" in f && (f.result as { stopReason?: string }).stopReason)?.result as { stopReason: string; _meta?: unknown } | undefined
  const loadResult = frames.find(f => "result" in f && !(f.result as { stopReason?: string }).stopReason && f.id !== 1)?.result as { modes?: unknown } | undefined

  return new FakeAgent({
    onPrompt: async (a, sessionId) => {
      // prompt 帧：依次重放 update，遇到 request_permission 时先处理审批再发完。
      for (const u of updates) {
        if (permission && (u.update as { toolCallId?: string }).toolCallId
          === ((permission.params as { toolCall: { toolCallId: string } }).toolCall.toolCallId)
          && u.update.sessionUpdate === "tool_call_update" && u.update.status === "in_progress") {
          const params = permission.params as { toolCall: Record<string, unknown>; options: Array<{ optionId: string; name: string; kind: string }> }
          const outcome = await a.requestPermission(sessionId, params.toolCall, params.options) as { outcome: { outcome: string } }
          if (outcome.outcome.outcome !== "selected") return { stopReason: "cancelled" }
        }
        await a.update(sessionId, u.update)
      }
      return promptResult ?? { stopReason: "end_turn" }
    },
    onLoadSession: async (a, sessionId) => {
      for (const u of updates) await a.update(sessionId, u.update)
      return loadResult ?? { modes: null }
    },
    onListSessions: () => ({ sessions: [{ sessionId: "history-seed", cwd: "/tmp/ws", title: "历史", updatedAt: "2025-01-01T00:00:00Z" }], nextCursor: null }),
  })
}

async function collect(events: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const event of events) out.push(event)
  return out
}

describe("acp-agent-gateway：回放真实录制帧", () => {
  test.each(["host", "tools", "approval"] as const)("%s：connect → startRun → 事件 → 终态", async name => {
    const agent = wireAgent(name)
    const { client, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    const { gateway } = await AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", now: () => 1, commandsTimeoutMs: 10 })
    gateway.setInteractionHandler(async request =>
      ({ request_id: request.request_id, type: request.type, ...(request.type === "approval" ? { decision: "approve_once" } : { decision: "allow_session" }) }) as never)
    const run = gateway.startRun({
      input: { kind: "user", message: "你好" },
      mode: "build",
    })
    const events = await collect(run.events)
    expect(events[0]!.type).toBe("run.started")
    expect(events.at(-1)!.type).toBe("run.completed")
    // 消息正文与工具卡都应到场（host 只有文字）。
    expect(events.some(e => e.type === "content.delta" || e.type === "tool.completed")).toBe(true)
    const completion = await run.completion
    expect(completion.outcome).toBe("completed")
  })

  test("history：listThreads → openThread 回放消息", async () => {
    const agent = wireAgent("history")
    const { client, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    const { gateway } = await AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", now: () => 1, commandsTimeoutMs: 10 })
    const { threads } = await gateway.listThreads()
    expect(threads[0]!.thread_id).toBe("history-seed")
    const result = await gateway.openThread("history-seed")
    expect(result.messages).toEqual([
      { kind: "user", content: "先看一眼" },
      { kind: "assistant", content: "看完了。" },
      { kind: "tool", tool_name: "read_file", content: "工具输出", tool_call_id: "history-seed:h2", status: "completed" },
    ])
  })
})
