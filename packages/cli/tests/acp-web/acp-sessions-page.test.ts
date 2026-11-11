/** Todo 1.10：session/list 游标分页 + session/resume 选择与摘要渲染（§4/§12）。 */
import { describe, expect, test } from "bun:test"
import { FakeAgent, pairedStreams } from "./support/fake-agent"
import { AcpAgentGateway } from "../../src/acp-web/client/acp-agent-gateway"

let uuidCounter = 0
function connect(agent: FakeAgent, options: Record<string, unknown> = {}) {
  const { client, agent: agentStream } = pairedStreams()
  agent.attach(agentStream)
  return AcpAgentGateway.connect({
    stream: client,
    cwd: "/tmp/ws",
    uuid: () => `uuid-${++uuidCounter}`,
    now: () => 5000,
    commandsTimeoutMs: 50,
    ...options,
  }).then(r => r.gateway)
}

const sessionRow = (id: string, updatedAt: string, meta?: unknown) => ({
  sessionId: id, cwd: "/tmp/ws", title: `t-${id}`, updatedAt,
  ...(meta === undefined ? {} : { _meta: meta }),
})
const summaryMeta = (messageCount: number) => ({
  harnessCode: { summary: { createdAt: "2025-01-01T00:00:00Z", messageCount, firstMessage: "首条", latestMessage: "最近一句" } },
})

describe("listThreads 游标分页", () => {
  test("带 cursor 请求并把 nextCursor 透传出去；末页 nextCursor 为 null", async () => {
    const agent = new FakeAgent({
      onListSessions: (_a, params) => {
        const cursor = (params as { cursor?: string | null }).cursor ?? null
        if (cursor === null) {
          return { sessions: [sessionRow("s-1", "2025-01-02T00:00:00Z", summaryMeta(3))], nextCursor: "c-1" }
        }
        if (cursor === "c-1") {
          return { sessions: [sessionRow("s-2", "2025-01-01T00:00:00Z", summaryMeta(1))], nextCursor: null }
        }
        throw new Error(`unexpected cursor ${cursor}`)
      },
    })
    const gateway = await connect(agent)
    const page1 = await gateway.listThreads()
    expect(page1.threads.map(t => t.thread_id)).toEqual(["s-1"])
    expect(page1.nextCursor).toBe("c-1")
    const page2 = await gateway.listThreads("c-1")
    expect(page2.threads.map(t => t.thread_id)).toEqual(["s-2"])
    expect(page2.nextCursor).toBeNull()
    const cursors = agent.requests.filter(r => r.method === "session/list")
      .map(r => (r.params as { cursor?: string | null }).cursor ?? null)
    expect(cursors).toEqual([null, "c-1"])
  })

  test("INVALID_CURSOR 错误原样冒泡而不是吞掉", async () => {
    const agent = new FakeAgent({
      onListSessions: (_a, params) => {
        const cursor = (params as { cursor?: string | null }).cursor ?? null
        if (cursor === "bad") throw Object.assign(new Error("INVALID_CURSOR"), { code: -32602 })
        return { sessions: [], nextCursor: null }
      },
    })
    const gateway = await connect(agent)
    await expect(gateway.listThreads("bad")).rejects.toThrow()
  })

  test("没有 _meta 的 SessionInfo：message_count 为 0、预览为空串（不回退到标题）", async () => {
    const agent = new FakeAgent({
      onListSessions: () => ({ sessions: [sessionRow("s-1", "2025-01-01T00:00:00Z")], nextCursor: null }),
    })
    const gateway = await connect(agent)
    const page = await gateway.listThreads()
    expect(page.threads[0].message_count).toBe(0)
    expect(page.threads[0].first_message).toBe("")
    expect(page.threads[0].latest_message).toBe("")
    expect(page.threads[0].title).toBe("t-s-1")
  })

  test("声明摘要时：messageCount/firstMessage/latestMessage 进 ThreadSummary", async () => {
    const agent = new FakeAgent({
      onListSessions: () => ({ sessions: [sessionRow("s-1", "2025-01-01T00:00:00Z", summaryMeta(7))], nextCursor: null }),
    })
    const gateway = await connect(agent)
    const page = await gateway.listThreads()
    expect(page.threads[0].message_count).toBe(7)
    expect(page.threads[0].first_message).toBe("首条")
    expect(page.threads[0].latest_message).toBe("最近一句")
  })
})

describe("openThread：重复打开一律 session/load（界面靠 messages 重建时间线）", () => {
  test("同一会话第二次 openThread：仍走 session/load 且返回历史消息", async () => {
    const agent = new FakeAgent({
      sessionResume: true,
      onListSessions: () => ({ sessions: [sessionRow("s-1", "2025-01-01T00:00:00Z")], nextCursor: null }),
      onLoadSession: (a) => {
        a.update("s-1", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史消息" }, messageId: "m1" })
        return {}
      },
    })
    const gateway = await connect(agent)
    const first = await gateway.openThread("s-1")
    const second = await gateway.openThread("s-1")
    const methods = agent.requests.filter(r => ["session/load", "session/resume"].includes(r.method)).map(r => r.method)
    expect(methods).toEqual(["session/load", "session/load"])
    expect(second.messages.length).toBeGreaterThan(0)
    expect(second.messages).toEqual(first.messages)
  })

  test("未声明 resume 时第二次 openThread 同样走 session/load", async () => {
    const agent = new FakeAgent({
      onListSessions: () => ({ sessions: [sessionRow("s-1", "2025-01-01T00:00:00Z")], nextCursor: null }),
    })
    const gateway = await connect(agent)
    await gateway.openThread("s-1")
    await gateway.openThread("s-1")
    const methods = agent.requests.filter(r => ["session/load", "session/resume"].includes(r.method)).map(r => r.method)
    expect(methods).toEqual(["session/load", "session/load"])
  })
})
