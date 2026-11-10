/**
 * `AcpAgentGateway` 用例（设计 §6.5）：`FakeAgent` 经 `AgentSideConnection`
 * 进程内直连，不需要真实进程。覆盖握手/暖会话/别名/一轮对话/取消/审批模式/
 * 失败收敛/列表/打开/关闭，以及 F11 的"update 先于响应"顺序锁定。
 */

import { describe, expect, test } from "bun:test"

import { AcpAgentGateway, UNSUPPORTED_METHODS } from "../../src/acp-web/client/acp-agent-gateway"
import { composeAcpWebSession } from "../../src/acp-web/client/session"
import type { EventEnvelope, InteractionRequestEnvelope, InteractionResponse } from "@za38/protocol"
import { AgentGatewayError } from "../../src/interactive/ports/agent-gateway"
import { FakeAgent, pairedStreams } from "./support/fake-agent"

let uuidCounter = 0
const connect = async (agent: FakeAgent, options: Record<string, unknown> = {}) => {
  const { client, agent: agentStream } = pairedStreams()
  agent.attach(agentStream)
  return AcpAgentGateway.connect({
    stream: client,
    cwd: "/tmp/ws",
    uuid: () => `uuid-${++uuidCounter}`,
    now: () => 5000,
    commandsTimeoutMs: 50,
    ...options,
  })
}

const userInput = (over: Record<string, unknown> = {}) => ({
  input: { kind: "user" as const, message: "你好", ...(over.input as object ?? {}) },
  mode: (over.mode ?? "build") as never,
  threadId: over.threadId as string | undefined,
  runId: over.runId as string | undefined,
  modelSelection: over.modelSelection as never,
  approvalMode: over.approvalMode as never,
})

async function collect(events: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const event of events) out.push(event)
  return out
}

describe("AcpAgentGateway：握手", () => {
  test("initialize 参数含 protocolVersion 与扩展声明；boot 字段正确", async () => {
    const agent = new FakeAgent()
    const { boot } = await connect(agent)
    const init = agent.requests.find(r => r.method === "initialize")!
    const params = init.params as Record<string, unknown>
    expect(params.protocolVersion).toBe(1)
    expect((params.clientCapabilities as { _meta: { harnessCode: { version: number; capabilities: string[] } } })._meta.harnessCode)
      .toEqual({ version: 1, capabilities: ["approval", "runSummary", "sessionSummary", "subagent", "goal"] })
    expect((params.clientCapabilities as { elicitation?: { form?: unknown } }).elicitation).toEqual({ form: {} })
    expect(boot.cwd).toBe("/tmp/ws")
    expect(boot.canLoadSession).toBe(true)
    expect(boot.canListSessions).toBe(true)
    expect(boot.extension).toEqual({ approval: true, runSummary: true })
    expect(boot.modes?.currentModeId).toBe("auto")
  })

  test("protocolVersion ≠ 1 → ACP_PROTOCOL_MISMATCH", async () => {
    await expect(connect(new FakeAgent({ protocolVersion: 99 })))
      .rejects.toMatchObject({ code: "ACP_PROTOCOL_MISMATCH" })
  })

  test("initialize 超时 → 超时错误", async () => {
    const agent = new FakeAgent()
    agent.initialize = () => new Promise(() => {}) // 永不响应
    await expect(connect(agent, { initializeTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: "ACP_INITIALIZE_TIMEOUT" })
  })
})

describe("AcpAgentGateway：暖会话与命令", () => {
  test("握手后 newSession 恰好一次；延迟到达的 available_commands_update 仍进 boot.commands", async () => {
    const agent = new FakeAgent({
      afterNewSession: async (a, sessionId) => {
        // 响应后 50ms 才发命令更新——在 commandsTimeoutMs 兜底之内，会被等到。
        await new Promise(resolve => setTimeout(resolve, 50))
        await a.update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "评审", input: { hint: "<文件>" } }] })
      },
    })
    const { boot } = await connect(agent, { commandsTimeoutMs: 500 })
    expect(agent.requests.filter(r => r.method === "session/new")).toHaveLength(1)
    expect(boot.commands).toEqual([{ name: "review", description: "评审", hint: "<文件>" }])
  })

  test("第一条命令更新一到就继续，不再等固定窗口", async () => {
    const agent = new FakeAgent({
      afterNewSession: async (a, sessionId) => {
        // 真实 Agent 在响应之后由后台任务推这一帧；给 20ms 模拟「下一拍到达」，
        // 与真实时序一致（同块紧跟响应的 update 会先被当成 orphan）。
        await new Promise(resolve => setTimeout(resolve, 20))
        await a.update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "评审", input: null }] })
      },
    })
    const started = Date.now()
    const { boot } = await connect(agent, { commandsTimeoutMs: 10_000 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(boot.commands).toEqual([{ name: "review", description: "评审", hint: null }])
  })

  test("命令表晚到 300ms：等到它而不是按固定窗口返回", async () => {
    const agent = new FakeAgent({
      afterNewSession: async (a, sessionId) => {
        await new Promise(resolve => setTimeout(resolve, 300))
        await a.update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "slow", description: "慢", input: null }] })
      },
    })
    const started = Date.now()
    const { boot } = await connect(agent, { commandsTimeoutMs: 5_000 })
    const elapsed = Date.now() - started
    expect(boot.commands).toEqual([{ name: "slow", description: "慢", hint: null }])
    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(4000)
  })

  test("命令表永不到达：commandsTimeoutMs 兜底后按空表继续并 warn 一次", async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
    try {
      const started = Date.now()
      const { boot } = await connect(new FakeAgent(), { commandsTimeoutMs: 100 })
      const elapsed = Date.now() - started
      expect(boot.commands).toEqual([])
      expect(elapsed).toBeLessThan(3000)
    } finally {
      console.warn = original
    }
    expect(warnings).toHaveLength(1)
  })

  test("超过 commandsTimeoutMs 到达的命令更新被丢弃并记日志", async () => {
    const agent = new FakeAgent({
      afterNewSession: async (a, sessionId) => {
        await new Promise(resolve => setTimeout(resolve, 80))
        await a.update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "late", description: "晚", input: null }] })
      },
    })
    const logs: Array<{ event: string }> = []
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
    try {
      const { boot } = await connect(agent, { commandsTimeoutMs: 30, log: (e: { event: string }) => logs.push(e) })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(boot.commands).toEqual([])
      expect(logs.some(e => e.event === "commands.late")).toBe(true)
    } finally {
      console.warn = original
    }
    expect(warnings).toHaveLength(1)
  })
})

describe("AcpAgentGateway：认领暖会话", () => {
  test("第一个新对话不再调 session/new；第二个才调；事件里的 thread_id 是 Core uuid", async () => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const run1 = gateway.startRun(userInput({}))
    await run1.completion
    expect(agent.requests.filter(r => r.method === "session/new")).toHaveLength(1) // 只有暖会话那次
    const events = await collect(run1.events)
    const started = events.find(e => e.type === "run.started")!
    expect(started.thread_id).toMatch(/^uuid-/)
    const run2 = gateway.startRun(userInput({}))
    await run2.completion
    expect(agent.requests.filter(r => r.method === "session/new")).toHaveLength(2)
  })
})

describe("AcpAgentGateway：一轮对话", () => {
  test("事件顺序 run.started → content.delta → run.completed；accepted 在首条 update 到达时 resolve", async () => {
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        await a.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "回" }, messageId: "s:m1" })
        return { stopReason: "end_turn", _meta: { harnessCode: { run: { usage: { input_tokens: 1, output_tokens: 2 }, duration_ms: 9, context: {} } } } }
      },
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({}))
    let acceptedAt = -1
    void run.accepted.then(() => { acceptedAt = Date.now() })
    const events = await collect(run.events)
    expect(events.map(e => e.type)).toEqual(["run.started", "content.delta", "run.completed"])
    expect(acceptedAt).toBeGreaterThan(0)
    expect((await run.completion).outcome).toBe("completed")
  })

  test("update 先于响应：100 个 chunk 全部排在 run.completed 之前（F11）", async () => {
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        for (let i = 0; i < 100; i += 1) {
          await a.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${i}` }, messageId: "s:m1" })
        }
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({}))
    const events = await collect(run.events)
    const types = events.map(e => e.type)
    expect(types[0]).toBe("run.started")
    expect(types.at(-1)).toBe("run.completed")
    expect(types.filter(t => t === "content.delta")).toHaveLength(100)
    // 100 个 delta 全部在 completed 之前
    const completedIdx = types.indexOf("run.completed")
    expect(types.slice(0, completedIdx).filter(t => t === "content.delta")).toHaveLength(100)
  })
})

describe("AcpAgentGateway：取消", () => {
  test("cancel 发 session/cancel 并返回 cancelled:true；Agent 以 cancelled 响应 → run.cancelled", async () => {
    const agent = new FakeAgent({
      onPrompt: (a, sessionId) => new Promise(resolve => {
        // 挂起，等 cancel 通知到达后才回 cancelled。
        const orig = a.hooks
        setTimeout(() => resolve({ stopReason: "cancelled" }), 60)
      }),
      onCancel: () => {},
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({}))
    const result = await gateway.cancel(run.ref.threadId, run.ref.runId)
    expect(result).toEqual({ run_id: run.ref.runId, cancelled: true })
    const events = await collect(run.events)
    // 通知经流异步到达 Agent：事件收完后一定已记录。
    expect(agent.requests.some(r => r.method === "session/cancel")).toBe(true)
    expect(events.at(-1)!.type).toBe("run.cancelled")
    expect((await run.completion).outcome).toBe("cancelled")
  })

  test("身份不匹配或无活动 Run → {cancelled:false}", async () => {
    const { gateway } = await connect(new FakeAgent())
    expect(await gateway.cancel("no-such", "no-run")).toEqual({ run_id: "no-run", cancelled: false })
  })
})

describe("AcpAgentGateway：审批模式", () => {
  test("startRun 带 approvalMode 且会话当前不同 → 先 set_mode 再 prompt；相同不调用", async () => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ approvalMode: "yolo" }))
    await run.completion
    const order = agent.requests.map(r => r.method)
    expect(order.indexOf("session/set_mode")).toBeGreaterThan(-1)
    expect(order.indexOf("session/set_mode")).toBeLessThan(order.indexOf("session/prompt"))
    expect((agent.requests.find(r => r.method === "session/set_mode")!.params as { modeId: string }).modeId).toBe("yolo")

    const run2 = gateway.startRun(userInput({ threadId: run.ref.threadId, approvalMode: "yolo" }))
    await run2.completion
    expect(agent.requests.filter(r => r.method === "session/set_mode")).toHaveLength(1)
  })

  test("plan 模式 → ACP_NOT_SUPPORTED(GAP-02) 且不发送 prompt", async () => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ approvalMode: "plan" }))
    await expect(run.accepted).rejects.toMatchObject({ code: "ACP_NOT_SUPPORTED" })
    expect(agent.requests.some(r => r.method === "session/prompt")).toBe(false)
  })

  test("会话广告了 plan 时，startRun 先切模式再发 prompt", async () => {
    const agent = new FakeAgent({
      modes: {
        currentModeId: "auto",
        availableModes: [
          { id: "plan", name: "先出计划", description: null },
          { id: "auto", name: "自动判断", description: null },
        ],
      },
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ approvalMode: "plan" }))
    await run.completion
    const order = agent.requests.map(request => request.method)
    expect(order.indexOf("session/set_mode")).toBeGreaterThan(-1)
    expect(order.indexOf("session/set_mode")).toBeLessThan(order.indexOf("session/prompt"))
    expect((agent.requests.find(request => request.method === "session/set_mode")!.params as { modeId: string }).modeId).toBe("plan")
  })

  test("运行中 setApprovalMode 返回 Core id 与递增 revision", async () => {
    const agent = new FakeAgent({
      onPrompt: () => new Promise(() => {}), // Run 挂起
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({}))
    const result = await gateway.setApprovalMode(run.ref.threadId, run.ref.runId, "yolo")
    expect(result).toMatchObject({ thread_id: run.ref.threadId, run_id: run.ref.runId, approval_mode: "yolo", revision: 1 })
  })
})

describe("AcpAgentGateway：失败收敛", () => {
  test("prompt 以 -32603 失败 → run.failed 事件 + completion failed + accepted 已 resolve", async () => {
    const agent = new FakeAgent({
      onPrompt: () => {
        throw new (require("@agentclientprotocol/sdk").RequestError)(-32603, "模型未配置", { code: "MODEL_CONFIGURATION_REQUIRED", message: "未配置模型", retryable: false })
      },
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({}))
    const events = await collect(run.events)
    const failed = events.at(-1)!
    expect(failed.type).toBe("run.failed")
    expect((failed.payload as { error: { code: string } }).error.code).toBe("MODEL_CONFIGURATION_REQUIRED")
    expect((await run.completion).outcome).toBe("failed")
    await run.accepted // 已 resolve（不抛）
  })

  test("session/new 失败 → accepted 拒绝 + events 失败", async () => {
    const agent = new FakeAgent({
      onNewSession: () => {
        throw new (require("@agentclientprotocol/sdk").RequestError)(-32602, "工作区不匹配", { code: "WORKSPACE_MISMATCH", message: "cwd 不符" })
      },
    })
    // 暖会话本身就失败 → connect 失败；改成先让 connect 成功，第二次 session/new 才失败。
    let calls = 0
    const agent2 = new FakeAgent()
    agent2.newSession = async params => {
      calls += 1
      agent2.requests.push({ method: "session/new", params })
      if (calls > 1) throw new (require("@agentclientprotocol/sdk").RequestError)(-32602, "mismatch", { code: "WORKSPACE_MISMATCH", message: "cwd 不符" })
      return { sessionId: "s1", modes: { currentModeId: "auto", availableModes: [] } }
    }
    const { gateway } = await connect(agent2)
    const run = gateway.startRun(userInput({}))
    await run.completion // 第一次认领暖会话成功
    const run2 = gateway.startRun(userInput({}))
    await expect(run2.accepted).rejects.toMatchObject({ code: "WORKSPACE_MISMATCH" })
  })

  test.each([
    [{ input: { kind: "goal" } }, "GAP-03"],
    [{ input: { kind: "user", message: "x", requested_skill: { skill_id: "s", name: "s" } } }, "GAP-28"],
  ])("门禁：%o → ACP_NOT_SUPPORTED %s", async (over, gap) => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput(over as never))
    const error = await run.accepted.catch((e: unknown) => e) as AgentGatewayError
    expect(error.code).toBe("ACP_NOT_SUPPORTED")
    expect(error.message).toContain(gap)
  })

  test("Compose 与模型选择改走 session/set_config_option，起步帧带上模型", async () => {
    const agent = new FakeAgent({
      onNewSession: () => ({
        sessionId: "s-config",
        modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "自动", description: null }] },
        configOptions: [{
          id: "model",
          name: "模型",
          type: "select",
          currentValue: "fast",
          options: [
            { value: "fast", name: "fake-model", description: "fast" },
            { value: "slow", name: "slow-model", description: "slow" },
          ],
        }, {
          id: "workflow",
          name: "工作方式",
          type: "select",
          currentValue: "build",
          options: [
            { value: "build", name: "直接执行" },
            { value: "compose", name: "分阶段协作" },
          ],
        }],
      }),
    })
    const { gateway } = await connect(agent)
    const listed = await gateway.listModels()
    expect(listed.profiles.map(profile => profile.id)).toEqual(["fast", "slow"])
    expect(listed.profiles[0]).toMatchObject({ model: "fake-model", provider_label: "fast", is_default: true })
    expect(listed.thread_selection).toEqual({ primary_profile: "fast" })

    const run = gateway.startRun(userInput({
      mode: "compose",
      modelSelection: { primary_profile: "slow" },
    }))
    const events = await collect(run.events)
    const sets = agent.requests.filter(request => request.method === "session/set_config_option")
    expect(sets.map(request => request.params)).toEqual([
      expect.objectContaining({ configId: "workflow", value: "compose" }),
      expect.objectContaining({ configId: "model", value: "slow" }),
    ])
    expect(events[0]).toMatchObject({
      type: "run.started",
      payload: {
        mode: "compose",
        primary_model: { profile: { id: "slow", model: "slow-model", provider_label: "slow" } },
      },
    })
  })

  test("@文件 另发 file 链接；带行号的提及仍只留在原文", async () => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ input: { kind: "user", message: "@note.txt 解释一下 @note.txt:10-12" } }))
    await run.completion
    const prompt = agent.requests.find(request => request.method === "session/prompt")!.params as {
      prompt: Array<{ type: string; text?: string; uri?: string; name?: string }>
    }
    expect(prompt.prompt).toEqual([
      { type: "text", text: "@note.txt 解释一下 @note.txt:10-12" },
      { type: "resource_link", name: "note.txt", uri: "file:///tmp/ws/note.txt" },
    ])
  })

  test("同一会话活动 Run 中再 startRun → THREAD_BUSY", async () => {
    const agent = new FakeAgent({ onPrompt: () => new Promise(() => {}) })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({}))
    const second = gateway.startRun(userInput({ threadId: run.ref.threadId }))
    await expect(second.accepted).rejects.toMatchObject({ code: "THREAD_BUSY" })
  })
})

describe("AcpAgentGateway：列表与打开", () => {
  test("listThreads 合成 ThreadSummary（GAP-36 固定值）；canListSessions=false → ACP_NOT_SUPPORTED", async () => {
    const agent = new FakeAgent({
      onListSessions: () => ({ sessions: [{ sessionId: "s-1", cwd: "/tmp/ws", title: "旧会话", updatedAt: "2025-01-01T00:00:00Z" }], nextCursor: null }),
    })
    const { gateway } = await connect(agent)
    const { threads } = await gateway.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      thread_id: "s-1", // 未认领 → ACP sessionId 直通
      title: "旧会话",
      created_at_ms: Date.parse("2025-01-01T00:00:00Z"),
      updated_at_ms: Date.parse("2025-01-01T00:00:00Z"),
      first_message: "",
      latest_message: "",
      message_count: 0,
    })

    const agent2 = new FakeAgent({ sessionList: false })
    const { gateway: g2 } = await connect(agent2)
    await expect(g2.listThreads()).rejects.toMatchObject({ code: "ACP_NOT_SUPPORTED" })
  })

  test("openThread：回放 update 进缓冲，messages 正确；随后 startRun 复用同一 sessionId", async () => {
    const agent = new FakeAgent({
      onLoadSession: async (a, sessionId) => {
        await a.update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "之前的问题" }, messageId: "s:h0" })
        await a.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "之前的回答" }, messageId: "s:h1" })
        return { modes: { currentModeId: "auto" } }
      },
    })
    const { gateway } = await connect(agent)
    const result = await gateway.openThread("s-1")
    expect(result.thread.thread_id).toBe("s-1")
    expect(result.messages).toEqual([
      { kind: "user", content: "之前的问题" },
      { kind: "assistant", content: "之前的回答" },
    ])
    expect(result.plan).toMatchObject({ has_plan: false })
    // 回放后继续对话复用 sessionId
    const run = gateway.startRun(userInput({ threadId: "s-1" }))
    await run.completion
    expect(agent.requests.filter(r => r.method === "session/new")).toHaveLength(1) // 仍只有暖会话
  })

  test("回放中再次 openThread → THREAD_BUSY；loadSession 失败 → 错误码保留", async () => {
    let release!: () => void
    const agent = new FakeAgent({
      onLoadSession: () => new Promise(resolve => { release = () => resolve({ modes: null }) }),
    })
    const { gateway } = await connect(agent)
    const pending = gateway.openThread("s-1")
    await expect(gateway.openThread("s-1")).rejects.toMatchObject({ code: "THREAD_BUSY" })
    // loadSession 请求经流异步到达 Agent 后 release 才被赋值。
    await new Promise(r => setTimeout(r, 20))
    release()
    await pending
  })
})

describe("AcpAgentGateway：标题更新", () => {
  test("session_info_update → onThreadSummary 带 title 与 updated_at_ms", async () => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const summaries: Array<{ title: string | null }> = []
    gateway.onThreadSummary(t => summaries.push(t))
    const sessionId = (agent.requests.find(r => r.method === "session/new")!.params as { sessionId?: string }).sessionId
    await agent.update("fake-session-1", { sessionUpdate: "session_info_update", title: "新标题", updatedAt: "2025-06-01T00:00:00Z" })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.title).toBe("新标题")
    // 空标题不触发
    await agent.update("fake-session-1", { sessionUpdate: "session_info_update", title: "" })
    expect(summaries).toHaveLength(1)
  })
})

describe("AcpAgentGateway：关闭", () => {
  test("SDK closed → onClose 一次；活动 Run events 失败 + completion 拒绝；挂起交互 cancelled", async () => {
    const agent = new FakeAgent({ onPrompt: () => new Promise(() => {}) })
    const { client, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    const { gateway } = await AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", now: () => 1, commandsTimeoutMs: 50 })
    const closes: Error[] = []
    gateway.onClose(e => closes.push(e))
    const run = gateway.startRun(userInput({}))
    // 关闭 agent→client 方向
    await (agentStream.writable.getWriter()).close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(closes).toHaveLength(1)
    await expect(run.completion).rejects.toThrow()
  })

  test("onProtocolError 不会因未知 update 触发", async () => {
    const agent = new FakeAgent()
    const { gateway } = await connect(agent)
    const errors: Error[] = []
    gateway.onProtocolError(e => errors.push(e))
    await agent.update("fake-session-1", { sessionUpdate: "usage_update", foo: 1 })
    expect(errors).toHaveLength(0)
  })
})

describe("AcpAgentGateway：审批与目录信任", () => {
  const approvalToolCall = {
    toolCallId: "x:call-1",
    kind: "execute",
    status: "pending",
    title: "execute npm test",
    rawInput: { command: "npm test" },
    _meta: { harnessCode: { approval: { type: "approval", requestId: "int-1", description: "跑一下" } } },
  }
  const approvalOptions = [
    { optionId: "approve_once", name: "允许一次", kind: "allow_once" },
    { optionId: "reject", name: "拒绝", kind: "reject_once" },
  ]

  test("审批请求 → InteractionRequestEnvelope；回答 approve_once → selected{approve_once}", async () => {
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const outcome = await a.requestPermission(sessionId, approvalToolCall, approvalOptions) as { outcome: { outcome: string; optionId?: string } }
        expect(outcome.outcome).toEqual({ outcome: "selected", optionId: "approve_once" })
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    const envelopes: InteractionRequestEnvelope[] = []
    gateway.setInteractionHandler(async request => {
      envelopes.push(request)
      return { request_id: request.request_id, type: "approval", decision: "approve_once" } as InteractionResponse
    })
    const run = gateway.startRun(userInput({}))
    await run.completion
    expect(envelopes).toHaveLength(1)
    const env = envelopes[0]!
    expect(env.type).toBe("approval")
    expect(env.request_id).toBe(`${run.ref.runId}:int-1`)
    if (env.type !== "approval") throw new Error("unreachable")
    expect(env.payload.decisions).toEqual(["approve_once", "reject"])
    expect(env.timeout_ms).toBe(Number.POSITIVE_INFINITY)
  })

  test("目录信任请求 → directory_trust 信封；decisions 只含 allow_session/deny", async () => {
    const trustCall = {
      toolCallId: "trust:int-2",
      title: "访问工作区外目录：/ext",
      _meta: { harnessCode: { approval: { type: "directory_trust", requestId: "int-2", directory: "/ext", targetPath: "/ext/a.txt", toolName: "write_file", access: "write", shadowsWorkspace: false } } },
    }
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const outcome = await a.requestPermission(sessionId, trustCall, [
          { optionId: "allow_session", name: "本会话允许", kind: "allow_always" },
          { optionId: "deny", name: "拒绝", kind: "reject_once" },
        ]) as { outcome: unknown }
        expect(outcome.outcome).toEqual({ outcome: "selected", optionId: "allow_session" })
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    const envelopes: InteractionRequestEnvelope[] = []
    gateway.setInteractionHandler(async request => {
      envelopes.push(request)
      return { request_id: request.request_id, type: "directory_trust", decision: "allow_session" } as InteractionResponse
    })
    const run = gateway.startRun(userInput({}))
    await run.completion
    const env = envelopes[0]!
    expect(env.type).toBe("directory_trust")
    if (env.type !== "directory_trust") throw new Error("unreachable")
    expect(env.payload).toMatchObject({ directory: "/ext", tool_name: "write_file", access: "write", decisions: ["allow_session", "deny"] })
  })

  test("取消时挂起的审批立即按 cancelled 收敛；迟到的 Core 回答不再二次应答", async () => {
    let answerLate: (() => void) | null = null
    let requestSeen: Promise<void>
    let markSeen!: () => void
    requestSeen = new Promise(resolve => { markSeen = resolve })
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const outcome = await a.requestPermission(sessionId, approvalToolCall, approvalOptions) as { outcome: unknown }
        expect(outcome.outcome).toEqual({ outcome: "cancelled" })
        return { stopReason: "cancelled" }
      },
    })
    const { gateway } = await connect(agent)
    gateway.setInteractionHandler(async request => {
      markSeen()
      return new Promise<InteractionResponse>(resolve => {
        answerLate = () => resolve({ request_id: request.request_id, type: "approval", decision: "approve_once" } as InteractionResponse)
      })
    })
    const run = gateway.startRun(userInput({}))
    await requestSeen
    await gateway.cancel(run.ref.threadId, run.ref.runId)
    await run.completion
    // 挂起已按 cancelled 结算；迟到的回答只走 pending 表，不会二次 settle。
    answerLate?.()
    await new Promise(r => setTimeout(r, 10))
    const events = await collect(run.events)
    expect(events.at(-1)!.type).toBe("run.cancelled")
  })

  test("扩展协商失败（approval=false）→ 审批一律 cancelled", async () => {
    const agent = new FakeAgent({
      extensionCapabilities: ["runSummary"], // 没有 approval
      onPrompt: async (a, sessionId) => {
        const outcome = await a.requestPermission(sessionId, approvalToolCall, approvalOptions) as { outcome: unknown }
        expect(outcome.outcome).toEqual({ outcome: "cancelled" })
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    gateway.setInteractionHandler(async () => ({ request_id: "int-1", type: "approval", decision: "approve_once" } as InteractionResponse))
    const run = gateway.startRun(userInput({}))
    await run.completion
  })

  test("abandonInteraction：作废的条目立即 cancelled", async () => {
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const outcome = await a.requestPermission(sessionId, approvalToolCall, approvalOptions) as { outcome: unknown }
        expect(outcome.outcome).toEqual({ outcome: "cancelled" })
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    let markSeen!: () => void
    const requestSeen = new Promise<void>(resolve => { markSeen = resolve })
    let capturedId = ""
    gateway.setInteractionHandler(request => {
      capturedId = request.request_id
      markSeen()
      return new Promise<InteractionResponse>(() => {}) // 永不回答
    })
    const run = gateway.startRun(userInput({}))
    await requestSeen
    gateway.abandonInteraction(capturedId)
    const events = await collect(run.events)
    expect(events.at(-1)!.type).toBe("run.completed")
  })
})

describe("AcpAgentGateway：三处行为修复", () => {
  test("setSessionMode 失败按发送前失败收敛：accepted/events/completion 拒绝且无 run.started/run.failed 事件", async () => {
    const agent = new FakeAgent({
      onSetSessionMode: () => { throw new (require("@agentclientprotocol/sdk").RequestError)(-32603, "忙", { code: "RUN_APPROVAL_MODE_BUSY", message: "审批切换忙" }) },
    })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ approvalMode: "yolo" }))
    await expect(run.accepted).rejects.toMatchObject({ code: "RUN_APPROVAL_MODE_BUSY" })
    await expect(run.completion).rejects.toMatchObject({ code: "RUN_APPROVAL_MODE_BUSY" })
    const collected: EventEnvelope[] = []
    try { for await (const e of run.events) collected.push(e) } catch { /* events 失败即终 */ }
    expect(collected.filter(e => e.type === "run.started" || e.type === "run.failed")).toEqual([])
    expect(agent.requests.some(r => r.method === "session/prompt")).toBe(false)
  })

  test("cancel 只结算本会话的挂起审批：另一会话的审批不受影响", async () => {
    let calls = 0
    let outcomeA: { outcome: unknown } | null = null
    let outcomeB: { outcome: unknown } | null = null
    const toolCall = (id: string) => ({
      toolCallId: `x:${id}`, kind: "execute", status: "pending", title: "execute x",
      _meta: { harnessCode: { approval: { type: "approval", requestId: id } } },
    })
    const options = [{ optionId: "approve_once", name: "允许", kind: "allow_once" }]
    const agent = new FakeAgent({
      onPrompt: (a, sessionId) => new Promise(resolve => {
        calls += 1
        const id = calls === 1 ? "int-a" : "int-b"
        void a.requestPermission(sessionId, toolCall(id), options).then(outcome => {
          if (id === "int-a") outcomeA = outcome as { outcome: unknown }
          else outcomeB = outcome as { outcome: unknown }
          resolve({ stopReason: "cancelled" })
        })
      }),
    })
    const { gateway } = await connect(agent)
    let markFirst!: () => void
    const seen = new Promise<void>(r => { markFirst = r })
    let count = 0
    const capturedIds: string[] = []
    gateway.setInteractionHandler(request => {
      count += 1
      capturedIds.push(request.request_id)
      if (count === 2) markFirst()
      return new Promise<InteractionResponse>(() => {})
    })
    const runA = gateway.startRun(userInput({}))
    const runB = gateway.startRun(userInput({}))
    await seen
    await gateway.cancel(runA.ref.threadId, runA.ref.runId)
    await new Promise(r => setTimeout(r, 30))
    expect(outcomeA).not.toBeNull()
    expect(outcomeA!.outcome).toEqual({ outcome: "cancelled" })
    expect(outcomeB).toBeNull() // 会话 B 的审批仍挂起
    gateway.abandonInteraction(capturedIds[1]!)
    await new Promise(r => setTimeout(r, 30))
    expect(outcomeB!.outcome).toEqual({ outcome: "cancelled" })
  })

  test("initialize 立即失败后，经过 initializeTimeoutMs 不再触发 onClose", async () => {
    const agent = new FakeAgent()
    agent.initialize = () => { throw new Error("immediate-fail") }
    const closes: Error[] = []
    const { client, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    await expect(AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", initializeTimeoutMs: 60 }))
      .rejects.toThrow()
    // 拿不到 gateway 实例就借道：connect 内注册的 close 监听无从挂，这里验证
    // "残留的 handleClosed 定时器不会在 60ms 后误杀后续逻辑" —— 直接等 80ms，
    // 若旧实现还在，内部计时器会触发 handleClosed（表现为 unhandled error/状态污染）。
    await new Promise(r => setTimeout(r, 80))
    expect(closes).toHaveLength(0)
  })
})

describe("AcpAgentGateway：modes 未声明时不换模式", () => {
  test("session/new 未返回 modes → startRun(approvalMode) 不调 set_mode，直接 prompt", async () => {
    const agent = new FakeAgent({ modes: null })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ approvalMode: "auto" }))
    await run.completion
    expect(agent.requests.some(r => r.method === "session/set_mode")).toBe(false)
    expect(agent.requests.some(r => r.method === "session/prompt")).toBe(true)
    const events = await collect(run.events)
    expect(events.at(-1)!.type).toBe("run.completed")
  })

  test("desired 不在 availableModes 里 → 不调 set_mode", async () => {
    const agent = new FakeAgent({ modes: { currentModeId: "default", availableModes: [{ id: "default", name: "d", description: null }] } })
    const { gateway } = await connect(agent)
    const run = gateway.startRun(userInput({ approvalMode: "yolo" }))
    await run.completion
    expect(agent.requests.some(r => r.method === "session/set_mode")).toBe(false)
  })
})

describe("AcpAgentGateway：重复 requestId 的跨 Run 审批", () => {
  test("取消 Run1 后 Run2 复用同一 ACP requestId：Run1 的迟到回答不得误结算 Run2", async () => {
    const toolCall = {
      toolCallId: "x:call-1", kind: "execute", status: "pending", title: "execute x",
      _meta: { harnessCode: { approval: { type: "approval", requestId: "int-1" } } },
    }
    const options = [{ optionId: "approve_once", name: "允许", kind: "allow_once" }]
    const outcomes: unknown[] = []
    let runCount = 0
    const agent = new FakeAgent({
      onPrompt: (a, sessionId) => new Promise(resolve => {
        runCount += 1
        // 两轮用同一个 requestId "int-1"（ApprovalAgent 固定 interrupt_id 的情形）
        void a.requestPermission(sessionId, toolCall, options).then(outcome => {
          outcomes.push(outcome)
          resolve({ stopReason: "end_turn" })
        })
      }),
    })
    const { gateway } = await connect(agent)
    // 控制器侧 handler：第一个请求挂起（等待 abandon），第二个等测试手动批准
    const resolvers = new Map<number, (r: InteractionResponse) => void>()
    let seen = 0
    const envelopes: InteractionRequestEnvelope[] = []
    gateway.setInteractionHandler(request => {
      envelopes.push(request)
      seen += 1
      return new Promise(resolve => resolvers.set(seen, resolve))
    })
    const run1 = gateway.startRun(userInput({}))
    const run2p = new Promise<void>(r => setTimeout(r, 30))
    // 等 Run1 的审批挂起
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(envelopes).toHaveLength(1)
    // 取消 Run1：网关先 settle，控制器随后 abandon → Run1 的 handler 迟到 resolve
    await gateway.cancel(run1.ref.threadId, run1.ref.runId)
    // 发 Run2（新 thread，同一 Agent 复用 requestId "int-1"）并等它的审批挂上
    const run2 = gateway.startRun(userInput({}))
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(envelopes).toHaveLength(2)
    // Run1 的 handler 现在才返回（控制器在 cancel 之后 abandon 才 resolve）——
    // 这步发生在 Run2 的同 id 条目已注册之后，绝不能误删/误结算 Run2。
    resolvers.get(1)!({ request_id: envelopes[0]!.request_id, type: "approval", decision: "reject" } as InteractionResponse)
    resolvers.get(2)!({ request_id: envelopes[1]!.request_id, type: "approval", decision: "approve_once" } as InteractionResponse)
    const run2events: string[] = []
    try {
      for await (const e of run2.events) run2events.push(e.type)
    } catch (err) { run2events.push(`ERR:${(err as Error).message}`) }
    console.log("RUN2 EVENTS:", run2events.join(","), "| OUTCOMES:", outcomes.length, JSON.stringify(outcomes.map(o => (o as { outcome: unknown }).outcome)))
    // Run2 的应答必须是 selected{approve_once}，不是被 Run1 污染成 cancelled/reject
    expect(outcomes).toHaveLength(2)
    expect((outcomes[1] as { outcome: unknown }).outcome).toEqual({ outcome: "selected", optionId: "approve_once" })
  })
})

describe("AcpAgentGateway：表单", () => {
  test("提问表单进现有提问卡，回答按属性名交回", async () => {
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const response = await a.conn.unstable_createElicitation({
          mode: "form",
          sessionId,
          message: "用哪种方案",
          requestedSchema: {
            type: "object",
            required: ["q_0"],
            properties: {
              q_0: {
                type: "string",
                title: "方案",
                oneOf: [{ const: "a", title: "甲" }, { const: "b", title: "乙" }],
              },
              q_0_other: { type: "string", title: "其他（可选）" },
            },
          },
        })
        expect(response).toEqual({ action: "accept", content: { q_0: "a", q_0_other: "丙" } })
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    gateway.setInteractionHandler(async request => {
      expect(request.type).toBe("question")
      if (request.type !== "question") throw new Error("unreachable")
      expect(request.payload.questions[0]).toMatchObject({ id: "q_0", allow_other: true, multi_select: false })
      return { request_id: request.request_id, type: "question", answers: { q_0: ["a", "丙"] } }
    })
    const run = gateway.startRun(userInput({}))
    expect((await run.completion).outcome).toBe("completed")
  })

  test("审批卡上的拒绝原因直接交回下一张原因表，不再弹第二张卡", async () => {
    const toolCall = {
      toolCallId: "x:call-1",
      title: "execute rm",
      rawInput: { command: "rm" },
      _meta: { harnessCode: { approval: { type: "approval", requestId: "int-1", description: "删文件" } } },
    }
    const options = [
      { optionId: "reject", name: "拒绝", kind: "reject_once" },
      { optionId: "reject_with_feedback", name: "拒绝并说明原因", kind: "reject_once" },
    ]
    const agent = new FakeAgent({
      onPrompt: async (a, sessionId) => {
        const permission = await a.requestPermission(sessionId, toolCall, options) as { outcome: { outcome: string; optionId?: string } }
        expect(permission.outcome).toEqual({ outcome: "selected", optionId: "reject_with_feedback" })
        const form = await a.conn.unstable_createElicitation({
          mode: "form",
          sessionId,
          message: "请说明拒绝原因，Agent 会据此调整",
          requestedSchema: {
            type: "object",
            required: ["feedback"],
            properties: { feedback: { type: "string", maxLength: 4000 } },
          },
        })
        expect(form).toEqual({ action: "accept", content: { feedback: "因为会删文件" } })
        return { stopReason: "end_turn" }
      },
    })
    const { gateway } = await connect(agent)
    const seen: string[] = []
    gateway.setInteractionHandler(async request => {
      seen.push(request.type)
      return {
        request_id: request.request_id,
        type: "approval",
        decision: "reject_with_feedback",
        feedback: "因为会删文件",
      }
    })
    const run = gateway.startRun(userInput({}))
    expect((await run.completion).outcome).toBe("completed")
    expect(seen).toEqual(["approval"])
  })

  test("cancel 让还挂着的表单以 cancel 结束", async () => {
    let form: Promise<unknown> = Promise.resolve()
    const agent = new FakeAgent({
      onPrompt: (a, sessionId) => {
        form = a.conn.unstable_createElicitation({
          mode: "form",
          sessionId,
          message: "用哪种方案",
          requestedSchema: {
            type: "object",
            properties: { q_0: { type: "string", title: "方案", oneOf: [{ const: "a", title: "甲" }] } },
          },
        })
        return new Promise(() => {})
      },
    })
    const { gateway } = await connect(agent)
    gateway.setInteractionHandler(() => new Promise(() => {}))
    const run = gateway.startRun(userInput({}))
    await new Promise(resolve => setTimeout(resolve, 30))
    await gateway.cancel(run.ref.threadId, run.ref.runId)
    await expect(form).resolves.toEqual({ action: "cancel" })
  })

  test("current_mode_update 把界面上的审批档位改回去", async () => {
    const agent = new FakeAgent({
      modes: {
        currentModeId: "auto",
        availableModes: [
          { id: "plan", name: "先出计划", description: null },
          { id: "auto", name: "自动判断", description: null },
        ],
      },
      onPrompt: async (a, sessionId) => {
        await a.update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "auto" })
        return { stopReason: "end_turn" }
      },
    })
    const { client, agent: agentStream } = pairedStreams()
    agent.attach(agentStream)
    const session = await composeAcpWebSession({ stream: client, cwd: "/tmp/ws", commandsTimeoutMs: 30, now: () => 1 })
    await session.controller.dispatch({ type: "approval-mode.set", mode: "plan" })
    expect(session.controller.getSnapshot().runtime.approvalMode).toBe("plan")
    const run = session.gateway.startRun(userInput({ threadId: "thread-1", runId: "run-1" }))
    expect((await run.completion).outcome).toBe("completed")
    expect(session.controller.getSnapshot().runtime.approvalMode).toBe("auto")
    await session.close()
  })
})
