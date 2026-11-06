/**
 * 进程内假 Agent：`AgentSideConnection` 与网关的 `ClientSideConnection`
 * 通过一对 TransformStream 直连，不需要真实进程/套接字。脚本化行为全部
 * 在 `FakeAgent` 的钩子函数里：测试可以观察每次请求、按序发 update、
 * 故意延迟命令/审批来制造竞态。
 */

import { AgentSideConnection, RequestError, type Stream } from "@agentclientprotocol/sdk"

/** 成对的消息流：client 写 → agent 读，agent 写 → client 读。 */
export function pairedStreams(): { client: Stream; agent: Stream } {
  const clientToAgent = new TransformStream<unknown, unknown>()
  const agentToClient = new TransformStream<unknown, unknown>()
  return {
    client: { writable: clientToAgent.writable, readable: agentToClient.readable } as Stream,
    agent: { writable: agentToClient.writable, readable: clientToAgent.readable } as Stream,
  }
}

export type FakeAgentHooks = {
  protocolVersion?: number
  /** 会话能力开关。 */
  loadSession?: boolean
  sessionList?: boolean
  extensionCapabilities?: readonly string[]
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string; description: string | null }> } | null
  /** session/new 之后的 update；warm 会话建好后按序发送。 */
  afterNewSession?: (agent: FakeAgent, sessionId: string) => Promise<void> | void
  /** prompt：返回 stopReason + 可选 _meta；脚本可先发任意 update 再 resolve。 */
  onPrompt?: (agent: FakeAgent, sessionId: string, params: { prompt: unknown }) => Promise<{ stopReason: string; _meta?: unknown }> | { stopReason: string; _meta?: unknown }
  onNewSession?: (agent: FakeAgent, params: Record<string, unknown>) => Promise<{ sessionId: string; modes?: unknown }> | { sessionId: string; modes?: unknown }
  onListSessions?: (agent: FakeAgent) => Promise<unknown> | unknown
  onLoadSession?: (agent: FakeAgent, sessionId: string) => Promise<unknown> | unknown
  onSetSessionMode?: (agent: FakeAgent, sessionId: string, modeId: string) => Promise<unknown> | unknown
  onCancel?: (agent: FakeAgent, sessionId: string) => void
  onRequestPermission?: (agent: FakeAgent, params: Record<string, unknown>) => Promise<unknown>
}

export class FakeAgent {
  readonly requests: Array<{ method: string; params: unknown }> = []
  private sessionCounter = 0
  private readonly hooks: FakeAgentHooks
  conn!: AgentSideConnection

  constructor(hooks: FakeAgentHooks = {}) {
    this.hooks = hooks
  }

  attach(stream: Stream): void {
    this.conn = new AgentSideConnection(agent => this, stream)
  }

  /** 向 client 发 session/update 通知。 */
  async update(sessionId: string, update: Record<string, unknown>): Promise<void> {
    await this.conn.sessionUpdate({ sessionId, update } as never)
  }

  /** 向 client 发 request_permission，返回 outcome。 */
  async requestPermission(sessionId: string, toolCall: Record<string, unknown>, options: Array<{ optionId: string; name: string; kind: string }>): Promise<unknown> {
    return this.conn.requestPermission({ sessionId, toolCall, options } as never)
  }

  // --- Agent 接口（SDK 会把 client 请求派到这里） ---

  async initialize(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method: "initialize", params })
    return {
      protocolVersion: this.hooks.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: this.hooks.loadSession ?? true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        ...(this.hooks.sessionList === false ? {} : { sessionCapabilities: { list: {} } }),
        _meta: {
          harnessCode: {
            version: 1,
            capabilities: [...(this.hooks.extensionCapabilities ?? ["approval", "runSummary"])],
          },
        },
      },
      agentInfo: { name: "fake-agent", title: "Fake", version: "0.0.1" },
    }
  }

  async newSession(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method: "session/new", params })
    if (this.hooks.onNewSession) {
      const result = await this.hooks.onNewSession(this, params)
      // 响应返回之后才发 update（Python 的 _spawn 同款时序）。
      if (this.hooks.afterNewSession) {
        const sessionId = result.sessionId
        void Promise.resolve().then(() => this.hooks.afterNewSession!(this, sessionId))
      }
      return result
    }
    const sessionId = `fake-session-${++this.sessionCounter}`
    const response = {
      sessionId,
      modes: this.hooks.modes === null ? undefined : this.hooks.modes ?? {
        currentModeId: "auto",
        availableModes: [
          { id: "default", name: "逐项确认", description: null },
          { id: "auto", name: "自动判断", description: null },
          { id: "yolo", name: "全自动", description: null },
        ],
      },
    }
    if (this.hooks.afterNewSession) {
      void Promise.resolve().then(() => this.hooks.afterNewSession!(this, sessionId))
    }
    return response
  }

  async loadSession(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method: "session/load", params })
    if (this.hooks.onLoadSession) return this.hooks.onLoadSession(this, (params as { sessionId: string }).sessionId)
    return { modes: this.hooks.modes ?? undefined }
  }

  async listSessions(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method: "session/list", params })
    if (this.hooks.onListSessions) return this.hooks.onListSessions(this)
    return { sessions: [], nextCursor: null }
  }

  async setSessionMode(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method: "session/set_mode", params })
    const { sessionId, modeId } = params as { sessionId: string; modeId: string }
    if (this.hooks.onSetSessionMode) return this.hooks.onSetSessionMode(this, sessionId, modeId)
    return {}
  }

  async prompt(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method: "session/prompt", params })
    const sessionId = (params as { sessionId: string }).sessionId
    if (this.hooks.onPrompt) return this.hooks.onPrompt(this, sessionId, params as { prompt: unknown })
    return { stopReason: "end_turn" }
  }

  async cancel(params: Record<string, unknown>): Promise<void> {
    this.requests.push({ method: "session/cancel", params })
    this.hooks.onCancel?.(this, (params as { sessionId: string }).sessionId)
  }
}

export { RequestError }
