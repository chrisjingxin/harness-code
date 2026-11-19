/**
 * 单会话执行：绑定目录 → 受理一轮 → 首次启动并握手 → 恢复/建会话 → 提交内容块 → 按序交付增量和终态。
 *
 * 兼容边界（绝不可破坏 `local-execution-ipc.ts`）：
 * - `subscribe(...)` 严格只发射 7 类轮次事件（text-delta / thought-delta / tool / permission / completed / cancelled / failed）
 *   且每轮 `sequence` 从 1 严格递增；
 * - 会话级更新（plan / commands / modes / configOptions / usage / sessionInfo / replay / elicitation / session-reset）
 *   全部通过 `subscribeSession(...)` 与 `getState()` 增量提供。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { Writable } from "node:stream"
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationContentValue,
  type ListSessionsResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"
import { setTimeout as delay } from "node:timers/promises"
import { agentStdout } from "./agent-stdio.js"
import { createClientCapabilityHandlers, type ClientCapabilityController } from "./client-capabilities.js"
import type { NativeBinding } from "./native-binding.js"
import {
  buildClientCapabilities,
  cloneSessionState,
  emptySessionState,
  mergeSessionInfo,
  parseAuthMethods,
  parseCommands,
  parseConfigOptions,
  parseImplementation,
  parseModels,
  parseModes,
  parsePlanEntries,
  parseUsageUpdate,
  toReplayFrame,
  toSdkPromptBlocks,
  upsertPlan,
} from "./session-state.js"
import { toLocalAcpTool } from "./tool-update.js"
import type {
  AgentCommand,
  LocalAcpAvailability,
  LocalAcpElicitationAnswer,
  LocalAcpEvent,
  LocalAcpHostOptions,
  LocalAcpPromptBlock,
  LocalAcpReplayFrame,
  LocalAcpRestoreReason,
  LocalAcpSendResult,
  LocalAcpSession,
  LocalAcpSessionState,
  LocalAcpSessionUpdateEvent,
} from "./index.js"

type EventData<T = LocalAcpEvent> = T extends LocalAcpEvent ? Omit<T, "turnId" | "sequence"> : never
type Turn = {
  id: string
  sequence: number
  prompting: boolean
  cancelling?: boolean
  denied?: boolean
  cancelTimer?: ReturnType<typeof setTimeout>
}
type Permission = {
  turn: Turn
  id: string
  options: RequestPermissionRequest["options"]
  resolve: (reply: RequestPermissionResponse) => void
}
type PendingElicitation = {
  id: string
  turn?: Turn
  resolve: (reply: CreateElicitationResponse) => void
}
class RestoreError extends Error {
  constructor(readonly reason: LocalAcpRestoreReason) { super(reason) }
}
const declined: RequestPermissionResponse = { outcome: { outcome: "cancelled" } }
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000

type Agent = {
  child: ChildProcessWithoutNullStreams
  exited: Promise<void>
  connection: ClientSideConnection
  capabilities: ClientCapabilityController
  initialized: boolean
  sessionId?: string
  openingNewSession?: boolean
  replayingSessionId?: string
  replayFrames?: LocalAcpReplayFrame[]
  pendingSessionUpdates?: SessionUpdate[]
  disconnected: boolean
  stopping?: Promise<void>
  exitedConfirmed?: boolean
}

type OpenedMeta = {
  readonly modes?: SessionModeState | null
  readonly configOptions?: readonly SessionConfigOption[] | null
  readonly models?: unknown
}

/** 启动和关闭时限各自只约束子进程生命周期，正常回复可持续流式输出。 */
async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("等待本机 Agent 响应超时。")), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function hasPromptContent(blocks: readonly LocalAcpPromptBlock[]): boolean {
  if (!blocks.length) return false
  return blocks.some(block => block.type !== "text" || Boolean(block.text.trim()))
}

export class BoundSession implements LocalAcpSession {
  readonly #listeners = new Set<(event: LocalAcpEvent) => void>()
  readonly #sessionListeners = new Set<(event: LocalAcpSessionUpdateEvent) => void>()
  readonly #outbox: LocalAcpEvent[] = []
  readonly #sessionOutbox: LocalAcpSessionUpdateEvent[] = []
  #emitting = false
  #emittingSession = false
  #active?: Turn
  #agent?: Agent
  #openPromise?: Promise<Agent>
  #permission?: Permission
  #elicitation?: PendingElicitation
  #closing?: Promise<void>
  #state: LocalAcpSessionState = emptySessionState()

  constructor(
    private readonly root: string,
    private readonly device: bigint,
    private readonly inode: bigint,
    private readonly command: AgentCommand | undefined,
    private readonly nativeBinding: NativeBinding,
    private readonly release: () => void,
    private readonly diagnostic: (pid: number, turnId: string | undefined, stderr: string) => void,
    private readonly options: LocalAcpHostOptions = {},
  ) {}

  private get handshakeTimeoutMs(): number {
    return this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  }

  private get restorePolicy() {
    return this.options.restorePolicy ?? "fallback-new"
  }

  assertBinding(root: string, device: bigint, inode: bigint): void {
    if (root !== this.root || device !== this.device || inode !== this.inode) {
      throw new Error("本机会话绑定的工作目录已变更，请释放后重新绑定。")
    }
  }

  getAvailability(): LocalAcpAvailability {
    if (this.#closing) return { available: false, reason: "session-closed" }
    if (!this.command) return { available: false, reason: "agent-not-configured" }
    if (this.#active) return { available: false, reason: "session-busy" }
    if (this.#agent?.disconnected && this.#agent.stopping && !this.#agent.exitedConfirmed) {
      return { available: false, reason: "agent-disconnected" }
    }
    return { available: true }
  }

  getState(): LocalAcpSessionState {
    return cloneSessionState(this.#state)
  }

  subscribe(listener: (event: LocalAcpEvent) => void): () => void {
    if (this.#closing) throw new Error("本机会话已关闭。")
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  subscribeSession(listener: (event: LocalAcpSessionUpdateEvent) => void): () => void {
    if (this.#closing) throw new Error("本机会话已关闭。")
    this.#sessionListeners.add(listener)
    return () => { this.#sessionListeners.delete(listener) }
  }

  async connect(): Promise<LocalAcpSessionState> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    if (!this.command) throw new Error("尚未配置本机 Agent。")
    await this.assertDirectoryIntact()
    const agent = await this.openSessionWithRecovery()
    if (!agent.sessionId) throw new Error("本机会话尚未打开。")
    return this.getState()
  }

  send(text: string): LocalAcpSendResult {
    if (!text.trim()) {
      const availability = this.getAvailability()
      return { status: "rejected", reason: availability.available ? "empty-text" : availability.reason }
    }
    return this.sendPrompt([{ type: "text", text }])
  }

  sendPrompt(blocks: readonly LocalAcpPromptBlock[]): LocalAcpSendResult {
    const availability = this.getAvailability()
    if (!availability.available) return { status: "rejected", reason: availability.reason }
    if (!hasPromptContent(blocks)) return { status: "rejected", reason: "empty-text" }
    const turn: Turn = { id: randomUUID(), sequence: 0, prompting: false }
    this.#active = turn
    // 留出当前调用栈，确保消费者先拿到受理结果和 turnId。
    queueMicrotask(() => void this.run(turn, [...blocks]))
    return { status: "accepted", turnId: turn.id }
  }

  cancel(turnId: string): boolean {
    const turn = this.#active
    if (!turn || turn.id !== turnId || this.#closing) return false
    if (turn.cancelling) return true
    turn.cancelling = true
    const agent = this.#agent
    this.resolvePermission(turn, declined)
    this.resolveElicitation({ action: "cancel" }, turn)
    if (!turn.prompting || !agent?.sessionId) return true
    // ACP 的取消是通知，只有 prompt 的返回值能确认 Agent 停在何处。
    void agent.connection.cancel({ sessionId: agent.sessionId }).catch(() => this.abortUnconfirmed(turn, agent))
    turn.cancelTimer = setTimeout(() => this.abortUnconfirmed(turn, agent), 10_000)
    return true
  }

  private abortUnconfirmed(turn: Turn, agent: Agent): void {
    if (this.#active !== turn) return
    agent.disconnected = true
    void this.stopAgent(agent).catch(() => {}).then(() => {
      this.finish(turn, { type: "failed", reason: "agent-disconnected" })
    })
  }

  answerPermission(turnId: string, requestId: string, optionId: string): boolean {
    const pending = this.#permission
    if (!pending || pending.turn.id !== turnId || pending.id !== requestId || pending.turn.cancelling || this.#closing) return false
    const option = pending.options.find(item => item.optionId === optionId)
    if (!option) return false
    pending.turn.denied ||= option.kind.startsWith("reject_")
    this.resolvePermission(pending.turn, { outcome: { outcome: "selected", optionId } })
    return true
  }

  answerElicitation(requestId: string, answer: LocalAcpElicitationAnswer): boolean {
    const pending = this.#elicitation
    if (!pending || pending.id !== requestId || this.#closing || pending.turn?.cancelling) return false
    const reply: CreateElicitationResponse = answer.action === "accept"
      ? {
          action: "accept",
          ...(answer.content !== undefined
            ? {
                content: Object.fromEntries(
                  Object.entries(answer.content).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
                ) as Record<string, ElicitationContentValue>,
              }
            : {}),
        }
      : { action: answer.action }
    this.resolveElicitation(reply)
    return true
  }

  async setMode(modeId: string): Promise<void> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    const agent = await this.openSessionWithRecovery()
    await agent.connection.setSessionMode({ sessionId: agent.sessionId!, modeId })
    this.updateModeState(modeId, true)
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    const agent = await this.openSessionWithRecovery()
    const payload = typeof value === "boolean"
      ? { sessionId: agent.sessionId!, configId, type: "boolean" as const, value }
      : { sessionId: agent.sessionId!, configId, value }
    const response = await agent.connection.setSessionConfigOption(payload)
    this.updateConfigOptions(response.configOptions, true)
  }

  async authenticate(methodId: string): Promise<void> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    if (!this.command) throw new Error("尚未配置本机 Agent。")
    const agent = await this.ensureInitialized()
    try {
      await within(agent.connection.authenticate({ methodId }), this.handshakeTimeoutMs)
    } catch (error) {
      if (!agent.sessionId) {
        await this.stopAgent(agent).catch(() => {})
        if (this.#agent === agent) this.#agent = undefined
      }
      throw error
    }
  }

  async listSessions(cursor?: string): Promise<ListSessionsResponse> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    const agent = await this.ensureInitialized()
    return within(
      agent.connection.listSessions({ cwd: this.root, ...(cursor !== undefined ? { cursor } : {}) }),
      this.handshakeTimeoutMs,
    )
  }

  async resumeSession(sessionId: string): Promise<LocalAcpSessionState> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    await this.assertDirectoryIntact()
    const agent = await this.ensureInitialized()
    // 整个恢复握手及原生绑定落盘期间均保持 openingNewSession，防止 Agent 抢先推送的命令/状态更新丢失。
    agent.openingNewSession = true
    agent.pendingSessionUpdates = []
    agent.sessionId = undefined
    this.resetTransientSessionUpdates()
    let resumed: Awaited<ReturnType<Agent["connection"]["resumeSession"]>>
    let pendingUpdates: SessionUpdate[] = []
    try {
      resumed = await within(
        agent.connection.resumeSession({ sessionId, cwd: this.root, mcpServers: [] }),
        this.handshakeTimeoutMs,
      )
      if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
      await this.nativeBinding.write(sessionId)
      if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
      agent.sessionId = sessionId
      pendingUpdates = agent.pendingSessionUpdates ?? []
    } finally {
      agent.openingNewSession = false
      agent.pendingSessionUpdates = undefined
    }
    this.applyOpenedResponse(resumed)
    for (const update of pendingUpdates) this.applySessionUpdateToState(update)
    this.#state = {
      ...this.#state,
      connected: true,
      sessionId,
      restoreStatus: { kind: "restored", sessionId },
    }
    this.emitSession({ type: "session-opened", state: this.getState() })
    for (const update of pendingUpdates) this.emitSessionUpdateEvent(update)
    return this.getState()
  }

  private requestPermission(agent: Agent, input: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.#active
    if (this.#agent !== agent || agent.sessionId !== input.sessionId || !turn?.prompting || turn.cancelling || this.#closing) {
      return Promise.resolve(declined)
    }
    if (this.#permission || !input.options.length || new Set(input.options.map(option => option.optionId)).size !== input.options.length) {
      // 输入区只展示一个请求。遇到并发或畸形请求时拒绝它，原请求仍等用户。
      turn.denied = true
      return Promise.resolve(declined)
    }
    return new Promise(resolve => {
      const id = randomUUID()
      this.#permission = { turn, id, options: input.options, resolve }
      this.emit(turn, { type: "permission", request: {
        id,
        title: input.toolCall.title || "Agent 请求工具权限",
        // 附带规范化工具细节（diff、参数、关联位置、终端引用），供桌面审批卡片呈现决策上下文。
        tool: toLocalAcpTool(input.toolCall),
        options: input.options.map(option => ({
          id: option.optionId, label: option.name, allows: option.kind.startsWith("allow_"),
        })),
      } })
    })
  }

  private createElicitation(agent: Agent, input: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (this.#agent !== agent || agent.disconnected || this.#closing) {
      return Promise.resolve({ action: "cancel" })
    }
    if (input.mode !== "form") {
      return Promise.resolve({ action: "decline" })
    }
    if ("sessionId" in input && agent.sessionId && input.sessionId !== agent.sessionId) {
      return Promise.resolve({ action: "cancel" })
    }
    const turn = this.#active
    if (turn?.cancelling || this.#elicitation) {
      return Promise.resolve({ action: "cancel" })
    }
    const id = randomUUID()
    return new Promise(resolve => {
      this.#elicitation = { id, turn, resolve }
      this.emitSession({
        type: "elicitation",
        request: {
          id,
          ...("sessionId" in input ? { sessionId: input.sessionId } : {}),
          ...("toolCallId" in input && input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          ...("requestId" in input && input.requestId !== undefined ? { requestId: input.requestId } : {}),
          message: input.message,
          requestedSchema: input.requestedSchema as unknown as Readonly<Record<string, unknown>>,
        },
      })
    })
  }

  private resolvePermission(turn: Turn, response: RequestPermissionResponse): void {
    const pending = this.#permission
    if (!pending || pending.turn !== turn) return
    this.#permission = undefined
    pending.resolve(response)
    this.emit(turn, { type: "permission", request: null })
  }

  private resolveElicitation(response: CreateElicitationResponse, onlyTurn?: Turn): void {
    const pending = this.#elicitation
    if (!pending) return
    if (onlyTurn && pending.turn !== onlyTurn) return
    this.#elicitation = undefined
    pending.resolve(response)
    this.emitSession({ type: "elicitation", request: null })
  }

  private async assertDirectoryIntact(): Promise<void> {
    const root = await realpath(this.root)
    const identity = await stat(root, { bigint: true })
    if (!identity.isDirectory()) throw new Error("本机工作目录不可用。")
    this.assertBinding(root, identity.dev, identity.ino)
  }

  private async ensureInitialized(): Promise<Agent> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    if (!this.command) throw new Error("尚未配置本机 Agent。")
    const existing = this.#agent
    if (existing && !existing.disconnected && existing.initialized) return existing
    if (existing) await this.stopAgent(existing).catch(() => {})

    const agent = this.launchAgent(this.command)
    this.#agent = agent
    try {
      const initialized = await within(
        agent.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: buildClientCapabilities(this.options),
        }),
        this.handshakeTimeoutMs,
      )
      if (initialized.protocolVersion !== PROTOCOL_VERSION || agent.disconnected || this.#closing) {
        throw new Error("本机 Agent 握手失败。")
      }
      agent.initialized = true
      this.#state = {
        ...this.#state,
        connected: true,
        protocolVersion: initialized.protocolVersion,
        agentInfo: parseImplementation(initialized.agentInfo),
        agentCapabilities: initialized.agentCapabilities ? structuredClone(initialized.agentCapabilities) : undefined,
        authMethods: parseAuthMethods(initialized.authMethods),
      }
      this.emitSession({ type: "initialized", state: this.getState() })
      return agent
    } catch (error) {
      await this.stopAgent(agent).catch(() => {})
      if (this.#agent === agent) this.#agent = undefined
      throw error
    }
  }

  /** 串行化初始化与建会话/恢复逻辑；出错时清理本次失败的 Agent 进程，不影响下次发送。 */
  private async openSessionWithRecovery(): Promise<Agent> {
    if (this.#openPromise) return this.#openPromise
    const current = this.#agent
    if (current && !current.disconnected && current.sessionId) return current

    const promise = (async () => {
      const agent = await this.ensureInitialized()
      if (agent.sessionId) return agent
      try {
        await this.openSession(agent)
        return agent
      } catch (error) {
        await this.stopAgent(agent).catch(() => {})
        if (this.#agent === agent) this.#agent = undefined
        throw error
      }
    })()
    this.#openPromise = promise
    try {
      return await promise
    } finally {
      if (this.#openPromise === promise) this.#openPromise = undefined
    }
  }

  private async run(turn: Turn, blocks: readonly LocalAcpPromptBlock[]): Promise<void> {
    try {
      await this.assertDirectoryIntact()
    } catch {
      this.finish(turn, { type: "failed", reason: "directory-unavailable" })
      return
    }
    if (this.#active !== turn) return
    if (turn.cancelling) { this.finish(turn, { type: "cancelled" }); return }

    let agent = this.#agent
    if (!agent || agent.disconnected || !agent.sessionId) {
      try {
        agent = await this.openSessionWithRecovery()
      } catch (error) {
        this.finish(turn, {
          type: "failed",
          reason: error instanceof RestoreError ? error.reason : "agent-start-failed",
        })
        return
      }
    }

    if (this.#active !== turn) return
    if (turn.cancelling) { this.finish(turn, { type: "cancelled" }); return }
    turn.prompting = true
    try {
      const result = await agent.connection.prompt({
        sessionId: agent.sessionId!,
        prompt: toSdkPromptBlocks(blocks),
      })
      this.finish(turn, result.stopReason === "end_turn"
        ? { type: "completed", shareable: !turn.cancelling && !turn.denied && this.#permission?.turn !== turn }
        : result.stopReason === "cancelled" ? { type: "cancelled" }
        : { type: "failed", reason: "agent-stopped", stopReason: result.stopReason })
    } catch {
      const disconnected = agent.disconnected || agent.connection.signal.aborted
      if (disconnected) await this.stopAgent(agent).catch(() => {})
      this.finish(turn, { type: "failed", reason: disconnected ? "agent-disconnected" : "prompt-failed" })
    }
  }

  private launchAgent(command: AgentCommand): Agent {
    const child = spawn(command.executable, command.args ?? [], {
      cwd: this.root, env: command.env as NodeJS.ProcessEnv | undefined, stdio: "pipe", windowsHide: true, shell: false, detached: process.platform !== "win32",
    })
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()))
    // stderr 不进入协议、对话正文、窗口或上传。诊断消费者只接收受限大小的分片。
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (child.pid !== undefined) this.diagnostic(child.pid, this.#agent === agent ? this.#active?.id : undefined, chunk.slice(0, 8192))
    })
    let agent!: Agent
    const capabilities = createClientCapabilityHandlers({
      root: this.root,
      device: this.device,
      inode: this.inode,
      env: command.env,
      enableFs: this.options.enableClientFs !== false,
      enableTerminal: this.options.enableClientTerminal === true,
      maxFsFileBytes: this.options.maxFsFileBytes,
      getSessionId: () => agent.sessionId,
      isActive: () => this.#agent === agent && !agent.disconnected && !this.#closing,
    })
    const stream = ndJsonStream(Writable.toWeb(child.stdin), new ReadableStream({ start(controller) { controller.close() } }))
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: async notification => this.onUpdate(agent, notification),
      requestPermission: input => this.requestPermission(agent, input),
      ...capabilities.handlers,
      ...(this.options.enableElicitation === true
        ? { unstable_createElicitation: (input: CreateElicitationRequest) => this.createElicitation(agent, input) }
        : {}),
    }), { readable: agentStdout(child.stdout), writable: stream.writable })

    agent = { child, exited, connection, capabilities, initialized: false, disconnected: false }
    const disconnected = () => {
      agent.disconnected = true
      if (this.#agent === agent) {
        this.#state = { ...this.#state, connected: false }
        this.resolveElicitation({ action: "cancel" })
      }
      const turn = this.#agent === agent && agent.sessionId ? this.#active : undefined
      void this.stopAgent(agent).catch(() => {}).then(() => {
        if (turn) this.finish(turn, { type: "failed", reason: "agent-disconnected" })
      })
    }
    child.on("error", disconnected)
    void exited.then(disconnected)
    void connection.closed.then(disconnected, disconnected)
    return agent
  }

  private async openSession(agent: Agent): Promise<void> {
    let nativeId: string | undefined
    let resetReason: LocalAcpRestoreReason | undefined
    let staleId: string | undefined
    try {
      nativeId = await this.nativeBinding.read()
    } catch {
      if (this.restorePolicy === "strict") throw new RestoreError("session-restore-failed")
      await this.nativeBinding.clear().catch(() => {})
      resetReason = "session-restore-failed"
      staleId = "<invalid>"
    }
    if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")

    if (nativeId) {
      if (!this.#state.agentCapabilities?.loadSession) {
        if (this.restorePolicy === "strict") throw new RestoreError("session-restore-unsupported")
        await this.nativeBinding.clear()
        resetReason = "session-restore-unsupported"
        staleId = nativeId
      } else {
        const loaded = await this.tryLoadSession(agent, nativeId)
        if (loaded) return
        if (this.restorePolicy === "strict") throw new RestoreError("session-restore-failed")
        await this.nativeBinding.clear().catch(() => {})
        if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
        resetReason = "session-restore-failed"
        staleId = nativeId
      }
    }

    await this.openNewSession(agent, resetReason ? { reason: resetReason, previousSessionId: staleId ?? "" } : undefined)
  }

  private async tryLoadSession(agent: Agent, nativeId: string): Promise<boolean> {
    agent.replayingSessionId = nativeId
    agent.replayFrames = []
    agent.pendingSessionUpdates = []
    this.resetTransientSessionUpdates()
    try {
      const loaded = await within(
        agent.connection.loadSession({ sessionId: nativeId, cwd: this.root, mcpServers: [] }),
        this.handshakeTimeoutMs,
      )
      if (agent.disconnected || this.#closing) return false
      const replayFrames = agent.replayFrames
      const pendingUpdates = agent.pendingSessionUpdates
      agent.replayingSessionId = undefined
      agent.replayFrames = undefined
      agent.pendingSessionUpdates = undefined
      agent.sessionId = nativeId
      this.applyOpenedResponse(loaded)
      for (const update of pendingUpdates) this.applySessionUpdateToState(update)
      this.#state = {
        ...this.#state,
        connected: true,
        sessionId: nativeId,
        restoreStatus: { kind: "restored", sessionId: nativeId },
      }
      this.emitSession({ type: "session-opened", state: this.getState() })
      for (const frame of replayFrames) this.emitSession({ type: "replay", frame })
      for (const update of pendingUpdates) this.emitSessionUpdateEvent(update)
      return true
    } catch {
      agent.replayingSessionId = undefined
      agent.replayFrames = undefined
      agent.pendingSessionUpdates = undefined
      this.resetTransientSessionUpdates()
      return false
    }
  }

  private async openNewSession(
    agent: Agent,
    resetFrom?: { readonly reason: LocalAcpRestoreReason; readonly previousSessionId: string },
  ): Promise<void> {
    // 保持 openingNewSession 覆盖整个 newSession + nativeBinding 落盘过程：
    // Agent 在返回 NewSessionResponse 的同时可能异步推送 available_commands_update，
    // 若提前清掉标志而此时 nativeBinding 尚未写完、sessionId 仍为 undefined，命令更新会被丢弃。
    agent.openingNewSession = true
    agent.pendingSessionUpdates = []
    this.resetTransientSessionUpdates()
    let opened: Awaited<ReturnType<Agent["connection"]["newSession"]>>
    let nativeId: string
    let pendingUpdates: SessionUpdate[] = []
    try {
      opened = await within(agent.connection.newSession({ cwd: this.root, mcpServers: [] }), this.handshakeTimeoutMs)
      nativeId = opened.sessionId
      if (!nativeId) throw new Error("无法创建本机 Agent 会话。")
      if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
      await this.nativeBinding.write(nativeId)
      if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
      agent.sessionId = nativeId
      pendingUpdates = agent.pendingSessionUpdates ?? []
    } finally {
      agent.openingNewSession = false
      agent.pendingSessionUpdates = undefined
    }
    this.applyOpenedResponse(opened)
    for (const update of pendingUpdates) this.applySessionUpdateToState(update)
    this.#state = {
      ...this.#state,
      connected: true,
      sessionId: nativeId,
      restoreStatus: resetFrom
        ? { kind: "reset", reason: resetFrom.reason, previousSessionId: resetFrom.previousSessionId, sessionId: nativeId }
        : { kind: "new", sessionId: nativeId },
    }
    if (resetFrom) {
      this.emitSession({
        type: "session-reset",
        reason: resetFrom.reason,
        previousSessionId: resetFrom.previousSessionId,
        sessionId: nativeId,
      })
    }
    this.emitSession({ type: "session-opened", state: this.getState() })
    for (const update of pendingUpdates) this.emitSessionUpdateEvent(update)
  }

  private resetTransientSessionUpdates(): void {
    this.#state = {
      ...this.#state,
      modes: undefined,
      currentModeId: undefined,
      models: undefined,
      configOptions: [],
      availableCommands: [],
      plans: [],
      sessionInfo: undefined,
      usage: undefined,
    }
  }

  private applyOpenedResponse(response: OpenedMeta): void {
    const modes = parseModes(response.modes)
    const models = parseModels(response.models)
    const configOptions = parseConfigOptions(response.configOptions)
    this.#state = {
      ...this.#state,
      ...(modes ? { modes, currentModeId: modes.currentModeId } : {}),
      ...(models ? { models } : {}),
      ...(response.configOptions ? { configOptions } : {}),
    }
  }

  private onUpdate(agent: Agent, { sessionId, update }: SessionNotification): void {
    if (this.#agent !== agent || agent.disconnected || this.#closing) return

    // 1) loadSession 回放窗口：收集回放帧，禁止进入当前轮次的 subscribe() 通道。
    if (agent.replayingSessionId === sessionId && !agent.sessionId) {
      const frame = toReplayFrame(update)
      if (frame) {
        agent.replayFrames?.push(frame)
        return
      }
      if (this.isSessionLevelUpdate(update)) {
        agent.pendingSessionUpdates?.push(update)
      }
      return
    }

    // 2) newSession 响应前紧随到达的会话级通知先暂存，拿到 sessionId 后再原子落地。
    if (agent.openingNewSession && !agent.sessionId && this.isSessionLevelUpdate(update)) {
      agent.pendingSessionUpdates?.push(update)
      return
    }

    if (agent.sessionId !== sessionId) return

    // 3) 已建会话上的会话级更新：无论是否处于 prompting，一律刷新状态并推送到 subscribeSession()。
    if (this.isSessionLevelUpdate(update)) {
      this.applySessionUpdateToState(update)
      this.emitSessionUpdateEvent(update)
      return
    }

    // 4) 轮次流式内容与工具更新：仅在当前活跃 prompting 轮次发射给 subscribe()。
    if (!this.#active?.prompting) return
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.emit(this.#active, { type: "tool", tool: toLocalAcpTool(update) })
      return
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text" && update.content.text) {
        this.emit(this.#active, { type: "thought-delta", text: update.content.text })
      }
      return
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text) {
      this.emit(this.#active, { type: "text-delta", text: update.content.text, messageId: update.messageId ?? undefined })
    }
  }

  private isSessionLevelUpdate(update: SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case "plan":
      case "plan_update":
      case "plan_removed":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        return true
      default:
        return false
    }
  }

  private applySessionUpdateToState(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "plan":
        this.#state = {
          ...this.#state,
          plans: upsertPlan(this.#state.plans, { kind: "entries", entries: parsePlanEntries(update.entries) }),
        }
        return
      case "plan_update": {
        const plan = update.plan
        const next = plan.type === "items"
          ? { kind: "entries" as const, id: plan.id, entries: parsePlanEntries(plan.entries) }
          : plan.type === "markdown"
            ? { kind: "markdown" as const, id: plan.id, content: plan.content }
            : { kind: "file" as const, id: plan.id, uri: plan.uri }
        this.#state = { ...this.#state, plans: upsertPlan(this.#state.plans, next) }
        return
      }
      case "plan_removed":
        this.#state = { ...this.#state, plans: this.#state.plans.filter(item => item.id !== update.id) }
        return
      case "available_commands_update":
        this.#state = { ...this.#state, availableCommands: parseCommands(update.availableCommands) }
        return
      case "current_mode_update":
        this.updateModeState(update.currentModeId, false)
        return
      case "config_option_update":
        this.updateConfigOptions(update.configOptions, false)
        return
      case "session_info_update":
        this.#state = { ...this.#state, sessionInfo: mergeSessionInfo(this.#state.sessionInfo, update) }
        return
      case "usage_update":
        this.#state = { ...this.#state, usage: parseUsageUpdate(update) }
        return
    }
  }

  private emitSessionUpdateEvent(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "plan":
      case "plan_update":
      case "plan_removed":
        this.emitSession({ type: "plan", plans: cloneSessionState(this.#state).plans })
        return
      case "available_commands_update":
        this.emitSession({ type: "available-commands", commands: cloneSessionState(this.#state).availableCommands })
        return
      case "current_mode_update":
        this.emitSession({ type: "current-mode", currentModeId: update.currentModeId })
        return
      case "config_option_update":
        this.emitSession({ type: "config-options", configOptions: cloneSessionState(this.#state).configOptions })
        return
      case "session_info_update":
        if (this.#state.sessionInfo) {
          this.emitSession({ type: "session-info", sessionInfo: { ...this.#state.sessionInfo } })
        }
        return
      case "usage_update":
        if (this.#state.usage) {
          this.emitSession({ type: "usage", usage: structuredClone(this.#state.usage) })
        }
        return
    }
  }

  private updateModeState(currentModeId: string, emitEvent: boolean): void {
    const prevModes = this.#state.modes
    this.#state = {
      ...this.#state,
      currentModeId,
      ...(prevModes ? { modes: { ...prevModes, currentModeId } } : {}),
    }
    if (emitEvent) this.emitSession({ type: "current-mode", currentModeId })
  }

  private updateConfigOptions(raw: readonly SessionConfigOption[], emitEvent: boolean): void {
    const configOptions = parseConfigOptions(raw)
    this.#state = { ...this.#state, configOptions }
    if (emitEvent) this.emitSession({ type: "config-options", configOptions: structuredClone(configOptions) })
  }

  private finish(turn: Turn, event: EventData): void {
    if (this.#active !== turn) return
    clearTimeout(turn.cancelTimer)
    this.resolvePermission(turn, declined)
    this.resolveElicitation({ action: "cancel" }, turn)
    if (this.#agent) void this.#agent.capabilities.cleanupTerminals().catch(() => {})
    // 终态回调查询可用性时已经空闲。过期请求不能清理下一轮的状态。
    this.#active = undefined
    this.emit(turn, event)
  }

  private emit(turn: Turn, event: EventData): void {
    const value = Object.freeze({ ...event, turnId: turn.id, sequence: ++turn.sequence })
    // 订阅者可能同步回答审批。先向所有订阅者交付当前序号，再交付由回答触发的事件。
    this.#outbox.push(value)
    if (this.#emitting) return
    this.#emitting = true
    try {
      while (this.#outbox.length) {
        const next = this.#outbox.shift()!
        for (const listener of [...this.#listeners]) {
          try { listener(next) } catch { /* 消费方异常不会打断协议和其他订阅。 */ }
        }
      }
    } finally {
      this.#emitting = false
    }
  }

  private emitSession(event: LocalAcpSessionUpdateEvent): void {
    this.#sessionOutbox.push(Object.freeze(event))
    if (this.#emittingSession) return
    this.#emittingSession = true
    try {
      while (this.#sessionOutbox.length) {
        const next = this.#sessionOutbox.shift()!
        for (const listener of [...this.#sessionListeners]) {
          try { listener(next) } catch { /* 会话级订阅方异常不会打断协议分发。 */ }
        }
      }
    } finally {
      this.#emittingSession = false
    }
  }

  close(): Promise<void> {
    // 先登记关闭，终态回调便不能重新发送或递归关闭。
    return this.#closing ??= Promise.resolve().then(async () => {
      if (this.#active) this.finish(this.#active, { type: "failed", reason: "session-closed" })
      this.resolveElicitation({ action: "cancel" })
      this.#listeners.clear()
      this.#sessionListeners.clear()
      this.#state = { ...this.#state, connected: false }
      if (this.#agent) await this.stopAgent(this.#agent)
      this.release()
    })
  }

  private stopAgent(agent: Agent): Promise<void> {
    return agent.stopping ??= (async () => {
      await agent.capabilities.cleanupTerminals().catch(() => {})
      await this.waitForExit(agent)
      agent.exitedConfirmed = true
    })()
  }

  private async waitForExit(agent: Agent): Promise<void> {
    const { child, exited } = agent
    child.stdin.end()
    const pid = child.pid
    const group = pid !== undefined && process.platform !== "win32" ? -pid : undefined
    function groupAlive(): boolean {
      if (group === undefined) return false
      try { process.kill(group, 0); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    function signal(name: NodeJS.Signals): void {
      if (group === undefined) { child.kill(name); return }
      try { process.kill(group, name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    const wait = async () => {
      const deadline = Date.now() + 2_000
      await within(exited, 2_000)
      while (groupAlive()) {
        if (Date.now() >= deadline) throw new Error("Agent 进程组仍在运行。")
        await delay(30)
      }
    }
    // 先给 Agent 正常处理 EOF 的机会，再逐步结束同一进程组。每轮等待都会停止自己的检查。
    for (const name of [undefined, "SIGTERM", "SIGKILL"] as const) {
      if (name) signal(name)
      try { await wait(); return }
      catch { if (name === "SIGKILL") throw new Error("未确认本机 Agent 进程退出。") }
    }
  }
}
