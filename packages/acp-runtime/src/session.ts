/**
 * 单会话执行：绑定目录 → 受理一轮 → 懒启动或复用共享进程并握手 → 恢复/建会话 → 提交内容块 → 按序交付增量和终态。
 *
 * 兼容边界（绝不可破坏 `local-execution-ipc.ts`）：
 * - `subscribe(...)` 严格只发射 7 类轮次事件（text-delta / thought-delta / tool / permission / completed / cancelled / failed）
 *   且每轮 `sequence` 从 1 严格递增；
 * - 会话级更新（plan / commands / modes / configOptions / usage / sessionInfo / replay / elicitation / session-reset）
 *   全部通过 `subscribeSession(...)` 与 `getState()` 增量提供。
 */
import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import {
  type AgentCapabilities,
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
import {
  AgentProcess,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  within,
  type AgentProcessSessionReceiver,
} from "./agent-process.js"
import { sessionSetupPayload, type PreparedSessionSetup } from "./session-setup.js"
import type { NativeBinding } from "./native-binding.js"
import {
  cloneSessionState,
  configMode,
  emptySessionState,
  mergeSessionInfo,
  metadata,
  parseCommands,
  parseConfigOptions,
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
  LocalAcpAuthMethod,
  LocalAcpAvailability,
  LocalAcpCommand,
  LocalAcpConfigOption,
  LocalAcpElicitationAnswer,
  LocalAcpEvent,
  LocalAcpHostOptions,
  LocalAcpImplementation,
  LocalAcpMeta,
  LocalAcpModelsState,
  LocalAcpModesState,
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
  extensionUpdate?: (update: unknown) => void
  endExtension?: () => void
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

type OpenedMeta = {
  readonly modes?: SessionModeState | null
  readonly configOptions?: readonly SessionConfigOption[] | null
  readonly models?: unknown
}

/** 同工作区共享的只读能力模板，严禁包含任何会话私有字段（如 sessionId / title / plans / usage）。 */
export type CachedWorkspaceCapabilities = {
  readonly protocolVersion?: number
  readonly agentInfo?: LocalAcpImplementation
  readonly agentCapabilities?: AgentCapabilities
  readonly authMethods: readonly LocalAcpAuthMethod[]
  readonly modes?: LocalAcpModesState
  readonly currentModeId?: string
  readonly models?: LocalAcpModelsState
  readonly configOptions: readonly LocalAcpConfigOption[]
  readonly availableCommands: readonly LocalAcpCommand[]
}

export type ProcessLeaseProvider = {
  acquireProcess(): Promise<AgentProcess>
  releaseSharedProcess(proc: AgentProcess): void
  onCapabilitiesObserved?(capabilities: CachedWorkspaceCapabilities): void
}

function hasPromptContent(blocks: readonly LocalAcpPromptBlock[]): boolean {
  if (!blocks.length) return false
  return blocks.some(block => block.type !== "text" || Boolean(block.text.trim()))
}

function extractWorkspaceCapabilities(state: LocalAcpSessionState): CachedWorkspaceCapabilities | undefined {
  if (state.protocolVersion === undefined && !state.agentCapabilities && !state.modes && !state.configOptions.length) {
    return undefined
  }
  return {
    ...(state.protocolVersion !== undefined ? { protocolVersion: state.protocolVersion } : {}),
    ...(state.agentInfo ? { agentInfo: structuredClone(state.agentInfo) } : {}),
    ...(state.agentCapabilities ? { agentCapabilities: structuredClone(state.agentCapabilities) } : {}),
    authMethods: structuredClone(state.authMethods),
    ...(state.modes ? { modes: structuredClone(state.modes) } : {}),
    ...(state.currentModeId !== undefined ? { currentModeId: state.currentModeId } : {}),
    ...(state.models ? { models: structuredClone(state.models) } : {}),
    configOptions: structuredClone(state.configOptions),
    availableCommands: structuredClone(state.availableCommands),
  }
}

export class BoundSession implements LocalAcpSession, AgentProcessSessionReceiver {
  readonly #listeners = new Set<(event: LocalAcpEvent) => void>()
  readonly #sessionListeners = new Set<(event: LocalAcpSessionUpdateEvent) => void>()
  readonly #outbox: LocalAcpEvent[] = []
  readonly #sessionOutbox: LocalAcpSessionUpdateEvent[] = []
  #emitting = false
  #emittingSession = false
  #active?: Turn
  #process?: AgentProcess
  #nativeId?: string
  #initPromise?: Promise<AgentProcess>
  #openPromise?: Promise<AgentProcess>
  #openingNewSession = false
  #replayingSessionId?: string
  #resumingSessionId?: string
  #replayActivity?: () => void
  #replayFrames?: LocalAcpReplayFrame[]
  #pendingSessionUpdates?: SessionUpdate[]
  #permission?: Permission
  #elicitation?: PendingElicitation
  #closing?: Promise<void>
  #state: LocalAcpSessionState
  #legacyModes?: LocalAcpModesState
  #configRevision = 0
  #needsHistory = false

  constructor(
    private readonly root: string,
    private readonly device: bigint,
    private readonly inode: bigint,
    private readonly command: AgentCommand | undefined,
    private readonly nativeBinding: NativeBinding,
    private readonly release: () => void,
    private readonly diagnostic: (pid: number, turnId: string | undefined, stderr: string) => void,
    private readonly options: LocalAcpHostOptions,
    private readonly setup: PreparedSessionSetup,
    private readonly leaseProvider: ProcessLeaseProvider,
    initialCapabilities?: CachedWorkspaceCapabilities,
  ) {
    const base = emptySessionState()
    this.#state = initialCapabilities
      ? {
          ...base,
          ...(initialCapabilities.protocolVersion !== undefined ? { protocolVersion: initialCapabilities.protocolVersion } : {}),
          ...(initialCapabilities.agentInfo ? { agentInfo: structuredClone(initialCapabilities.agentInfo) } : {}),
          ...(initialCapabilities.agentCapabilities ? { agentCapabilities: structuredClone(initialCapabilities.agentCapabilities) } : {}),
          authMethods: structuredClone(initialCapabilities.authMethods),
          ...(initialCapabilities.modes ? { modes: structuredClone(initialCapabilities.modes) } : {}),
          ...(initialCapabilities.currentModeId !== undefined ? { currentModeId: initialCapabilities.currentModeId } : {}),
          ...(initialCapabilities.models ? { models: structuredClone(initialCapabilities.models) } : {}),
          configOptions: structuredClone(initialCapabilities.configOptions),
          availableCommands: structuredClone(initialCapabilities.availableCommands),
        }
      : base
    this.#legacyModes = initialCapabilities?.modes ? structuredClone(initialCapabilities.modes) : undefined
  }

  get nativeSessionId(): string | undefined {
    return this.#nativeId
  }

  hasActiveTurn(): boolean {
    return this.#active !== undefined
  }

  hasPendingInteraction(): boolean {
    return this.#permission !== undefined || this.#elicitation !== undefined
  }

  assertSessionSetup(setup: PreparedSessionSetup): void {
    if (setup.signature !== this.setup.signature) throw new Error("请关闭绑定后再修改附加目录或 MCP 配置。")
  }

  private async sessionPayload() {
    const { payload, diagnostics } = await sessionSetupPayload(this.root, this.setup, this.#state.agentCapabilities)
    this.#state = { ...this.#state, setupDiagnostics: diagnostics.length ? diagnostics : undefined }
    return payload
  }

  private get handshakeTimeoutMs(): number {
    return this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  }

  private get restorePolicy() {
    return this.options.restorePolicy ?? "fallback-new"
  }

  private publishCachedCapabilities(): void {
    const snapshot = extractWorkspaceCapabilities(this.#state)
    if (snapshot) this.leaseProvider.onCapabilitiesObserved?.(snapshot)
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
    if (this.#process?.disconnected && this.#process.stopping && !this.#process.exitedConfirmed) {
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
    await this.openSessionWithRecovery()
    if (!this.#nativeId) throw new Error("本机会话尚未打开。")
    return this.getState()
  }

  send(text: string): LocalAcpSendResult {
    if (!text.trim()) {
      const availability = this.getAvailability()
      return { status: "rejected", reason: availability.available ? "empty-text" : availability.reason }
    }
    return this.sendPrompt([{ type: "text", text }])
  }

  sendPrompt(blocks: readonly LocalAcpPromptBlock[], historyOnReset: readonly LocalAcpPromptBlock[] = []): LocalAcpSendResult {
    const availability = this.getAvailability()
    if (!availability.available) return { status: "rejected", reason: availability.reason }
    if (!hasPromptContent(blocks)) return { status: "rejected", reason: "empty-text" }
    const turn: Turn = { id: randomUUID(), sequence: 0, prompting: false }
    this.#active = turn
    this.#process?.touchActivity()
    // 留出当前调用栈，确保消费者先拿到受理结果和 turnId。
    queueMicrotask(() => void this.run(turn, [...blocks], [...historyOnReset]))
    return { status: "accepted", turnId: turn.id }
  }

  cancel(turnId: string): boolean {
    const turn = this.#active
    if (!turn || turn.id !== turnId || this.#closing) return false
    if (turn.cancelling) return true
    turn.cancelling = true
    const proc = this.#process
    const nativeId = this.#nativeId
    this.resolvePermission(turn, declined)
    this.resolveElicitation({ action: "cancel" }, turn)
    if (!turn.prompting || !proc || !nativeId) return true
    // ACP 的取消是通知，只有 prompt 的返回值能确认 Agent 停在何处。
    void proc.connection.cancel({ sessionId: nativeId }).catch(() => this.abortUnconfirmed(turn, proc))
    turn.cancelTimer = setTimeout(() => this.abortUnconfirmed(turn, proc), 10_000)
    return true
  }

  async requestDuringTurn(
    turnId: string, method: string, params: LocalAcpMeta,
    insertion?: Parameters<LocalAcpSession["requestDuringTurn"]>[3],
  ): Promise<LocalAcpMeta> {
    const turn = this.#active
    const proc = this.#process
    const nativeId = this.#nativeId
    if (!turn?.prompting || turn.id !== turnId || turn.cancelling || this.#closing
      || !proc || !nativeId || proc.disconnected || !method.startsWith("_")) {
      throw new Error("当前轮次无法接收追发。")
    }
    proc.touchActivity()
    const seen = new Set<string>()
    let receiptId: string | undefined
    let settle: (ok: boolean) => void = () => {}
    const confirmed = new Promise<boolean>(resolve => { settle = resolve })
    if (insertion) {
      if (turn.extensionUpdate) throw new Error("上一条追发仍在确认。")
      turn.extensionUpdate = update => {
        const id = insertion.updateId(update)
        if (!id) return
        if (id === receiptId) settle(true)
        if (seen.size < 32) seen.add(id)
      }
      turn.endExtension = () => settle(false)
    }
    try {
      const result = await within(proc.connection.extMethod(method, { ...params, sessionId: nativeId }), 30_000)
      if (insertion) {
        receiptId = insertion.receiptId(result)
        if (!receiptId || (!seen.has(receiptId) && !await within(confirmed, 30_000))) {
          throw new Error("Agent 未确认追发已进入当前轮。")
        }
      }
      return result
    } finally {
      if (insertion) {
        turn.extensionUpdate = undefined
        turn.endExtension = undefined
      }
    }
  }

  private abortUnconfirmed(turn: Turn, proc: AgentProcess): void {
    if (this.#active !== turn) return
    proc.disconnected = true
    void proc.stop().catch(() => {}).then(() => {
      if (this.#process === proc) {
        this.#process = undefined
        this.#nativeId = undefined
      }
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
    const proc = await this.openSessionWithRecovery()
    const nativeId = this.#nativeId!
    const modern = configMode(this.#state.configOptions)
    if (modern) {
      if (!modern.options.some(item => item.value === modeId)) throw new Error("该会话模式不可用。")
      return this.setConfigOption(modern.id, modeId)
    }
    proc.touchActivity()
    await proc.connection.setSessionMode({ sessionId: nativeId, modeId })
    this.updateModeState(modeId, true)
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    const proc = await this.openSessionWithRecovery()
    const nativeId = this.#nativeId!
    const payload = typeof value === "boolean"
      ? { sessionId: nativeId, configId, type: "boolean" as const, value }
      : { sessionId: nativeId, configId, value }
    const before = this.#configRevision
    proc.touchActivity()
    const response = await proc.connection.setSessionConfigOption(payload)
    if (before === this.#configRevision) this.updateConfigOptions(response.configOptions, true)
  }

  async authenticate(methodId: string): Promise<void> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    if (!this.command) throw new Error("尚未配置本机 Agent。")
    const proc = await this.ensureInitialized()
    proc.beginOpen()
    try {
      await within(proc.connection.authenticate({ methodId }), this.handshakeTimeoutMs)
    } catch (error) {
      if (!this.#nativeId && !proc.shared) {
        proc.detach(this)
        await proc.stop().catch(() => {})
        if (this.#process === proc) this.#process = undefined
      }
      throw error
    } finally {
      proc.endOpen()
    }
  }

  async listSessions(cursor?: string): Promise<ListSessionsResponse> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    const proc = await this.ensureInitialized()
    proc.touchActivity()
    return within(
      proc.connection.listSessions({ cwd: this.root, ...(cursor !== undefined ? { cursor } : {}) }),
      this.handshakeTimeoutMs,
    )
  }

  async resumeSession(sessionId: string): Promise<LocalAcpSessionState> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    await this.assertDirectoryIntact()
    const proc = await this.ensureInitialized()
    proc.beginOpen()
    const prevId = this.#nativeId
    if (prevId && prevId !== sessionId) proc.unregisterNativeSession(prevId, this)
    // 整个恢复握手及原生绑定落盘期间均保持 resumingSessionId，防止 Agent 抢先推送的命令/状态更新丢失。
    this.#resumingSessionId = sessionId
    this.#pendingSessionUpdates = []
    this.#nativeId = undefined
    this.resetTransientSessionUpdates()
    proc.registerNativeSession(sessionId, this)
    let resumed: Awaited<ReturnType<AgentProcess["connection"]["resumeSession"]>>
    let pendingUpdates: SessionUpdate[] = []
    try {
      resumed = await within(
        proc.connection.resumeSession({ ...await this.sessionPayload(), sessionId }),
        this.handshakeTimeoutMs,
      )
      if (proc.disconnected || proc.evicting || this.#closing) throw new Error("本机 Agent 已断开。")
      await this.nativeBinding.write(sessionId)
      if (proc.disconnected || proc.evicting || this.#closing) throw new Error("本机 Agent 已断开。")
      this.#nativeId = sessionId
      pendingUpdates = this.#pendingSessionUpdates ?? []
    } catch (error) {
      proc.unregisterNativeSession(sessionId, this)
      throw error
    } finally {
      this.#resumingSessionId = undefined
      this.#pendingSessionUpdates = undefined
      proc.endOpen()
    }
    this.#needsHistory = false
    this.applyOpenedResponse(resumed)
    for (const update of pendingUpdates) this.applySessionUpdateToState(update)
    this.#state = {
      ...this.#state,
      connected: true,
      sessionId,
      restoreStatus: { kind: "restored", sessionId },
    }
    this.publishCachedCapabilities()
    this.emitSession({ type: "session-opened", state: this.getState() })
    for (const update of pendingUpdates) this.emitSessionUpdateEvent(update)
    return this.getState()
  }

  onDiagnostic(pid: number, stderr: string): void {
    this.diagnostic(pid, this.#active?.id, stderr)
  }

  onProcessDisconnected(proc: AgentProcess): void {
    if (this.#process !== proc) return
    this.#state = { ...this.#state, connected: false }
    this.resolveElicitation({ action: "cancel" })
    const turn = this.#active && this.#nativeId ? this.#active : undefined
    void proc.stop().catch(() => {}).then(() => {
      if (this.#process === proc) {
        this.#process = undefined
        this.#nativeId = undefined
      }
      if (turn) this.finish(turn, { type: "failed", reason: "agent-disconnected" })
    })
  }

  onProcessEvicted(proc: AgentProcess): void {
    if (this.#process !== proc) return
    this.#process = undefined
    this.#nativeId = undefined
    this.#state = { ...this.#state, connected: false }
  }

  onPermissionRequest(input: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.#active
    if (!this.#process || this.#nativeId !== input.sessionId || !turn?.prompting || turn.cancelling || this.#closing) {
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
      this.#process?.scheduleIdleCheck()
      this.emit(turn, { type: "permission", request: {
        id,
        title: input.toolCall.title || "Agent 请求工具权限",
        // 附带规范化工具细节（diff、参数、关联位置、终端引用），供桌面审批卡片呈现决策上下文。
        ...metadata(input._meta),
        tool: { ...toLocalAcpTool(input.toolCall), ...metadata(input.toolCall._meta) },
        options: input.options.map(option => ({
          id: option.optionId, label: option.name, allows: option.kind.startsWith("allow_"), ...metadata(option._meta),
        })),
      } })
    })
  }

  onElicitationRequest(input: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const proc = this.#process
    if (!proc || proc.disconnected || this.#closing) {
      return Promise.resolve({ action: "cancel" })
    }
    if (input.mode !== "form") {
      return Promise.resolve({ action: "decline" })
    }
    if ("sessionId" in input && this.#nativeId && input.sessionId !== this.#nativeId) {
      return Promise.resolve({ action: "cancel" })
    }
    const turn = this.#active
    if (turn?.cancelling || this.#elicitation) {
      return Promise.resolve({ action: "cancel" })
    }
    const id = randomUUID()
    return new Promise(resolve => {
      this.#elicitation = { id, turn, resolve }
      proc.scheduleIdleCheck()
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
    this.#process?.touchActivity()
  }

  private resolveElicitation(response: CreateElicitationResponse, onlyTurn?: Turn): void {
    const pending = this.#elicitation
    if (!pending) return
    if (onlyTurn && pending.turn !== onlyTurn) return
    this.#elicitation = undefined
    pending.resolve(response)
    this.emitSession({ type: "elicitation", request: null })
    this.#process?.touchActivity()
  }

  private async assertDirectoryIntact(): Promise<void> {
    const root = await realpath(this.root)
    const identity = await stat(root, { bigint: true })
    if (!identity.isDirectory()) throw new Error("本机工作目录不可用。")
    this.assertBinding(root, identity.dev, identity.ino)
  }

  private async ensureInitialized(): Promise<AgentProcess> {
    if (this.#closing) throw new Error("本机会话已关闭。")
    if (!this.command) throw new Error("尚未配置本机 Agent。")
    if (this.#initPromise) return this.#initPromise

    const existing = this.#process
    if (existing && !existing.disconnected && !existing.stopping && !existing.evicting && existing.initializeResult) {
      existing.touchActivity()
      return existing
    }

    const promise = (async () => {
      if (existing && !existing.shared) {
        existing.detach(this)
        await existing.stop().catch(() => {})
        if (this.#process === existing) {
          this.#process = undefined
          this.#nativeId = undefined
        }
      }
      const proc = await this.leaseProvider.acquireProcess()
      if (this.#closing) {
        if (!proc.shared) await proc.stop().catch(() => {})
        throw new Error("本机会话已关闭。")
      }
      proc.attach(this)
      this.#process = proc
      proc.beginOpen()
      try {
        const initInfo = await proc.ensureInitialized()
        if (this.#closing || proc.disconnected || proc.evicting) {
          throw new Error("本机 Agent 已断开。")
        }
        const shouldEmitInit = !this.#state.connected || this.#state.protocolVersion !== initInfo.protocolVersion
        this.#state = {
          ...this.#state,
          connected: true,
          protocolVersion: initInfo.protocolVersion,
          agentInfo: initInfo.agentInfo,
          agentCapabilities: initInfo.agentCapabilities,
          authMethods: [...initInfo.authMethods],
        }
        this.publishCachedCapabilities()
        if (shouldEmitInit) {
          this.emitSession({ type: "initialized", state: this.getState() })
        }
        return proc
      } catch (error) {
        proc.detach(this)
        if (this.#process === proc) {
          this.#process = undefined
          this.#nativeId = undefined
        }
        if (!proc.shared) {
          await proc.stop().catch(() => {})
        }
        throw error
      } finally {
        proc.endOpen()
      }
    })()

    this.#initPromise = promise
    try {
      return await promise
    } finally {
      if (this.#initPromise === promise) this.#initPromise = undefined
    }
  }

  /** 串行化初始化与建会话/恢复逻辑；出错时仅在独占模式停止失败进程，共享模式下保留健康共享进程。 */
  private async openSessionWithRecovery(): Promise<AgentProcess> {
    if (this.#openPromise) return this.#openPromise
    const current = this.#process
    if (current && !current.disconnected && !current.stopping && !current.evicting && this.#nativeId) {
      current.touchActivity()
      return current
    }

    const promise = (async () => {
      const initialProc = await this.ensureInitialized()
      if (this.#nativeId && this.#process === initialProc && !initialProc.disconnected) {
        return initialProc
      }
      try {
        return await this.openSession(initialProc)
      } catch (error) {
        const activeProc = this.#process
        if (activeProc && !activeProc.shared) {
          activeProc.detach(this)
          await activeProc.stop().catch(() => {})
          if (this.#process === activeProc) {
            this.#process = undefined
            this.#nativeId = undefined
          }
        } else if (activeProc && this.#nativeId) {
          activeProc.unregisterNativeSession(this.#nativeId, this)
          this.#nativeId = undefined
        }
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

  private async run(turn: Turn, blocks: readonly LocalAcpPromptBlock[], historyOnReset: readonly LocalAcpPromptBlock[]): Promise<void> {
    try {
      await this.assertDirectoryIntact()
    } catch {
      this.finish(turn, { type: "failed", reason: "directory-unavailable" })
      return
    }
    if (this.#active !== turn) return
    if (turn.cancelling) { this.finish(turn, { type: "cancelled" }); return }

    let proc = this.#process
    if (!proc || proc.disconnected || proc.stopping || proc.evicting || !this.#nativeId) {
      try {
        proc = await this.openSessionWithRecovery()
      } catch (error) {
        this.finish(turn, {
          type: "failed",
          reason: error instanceof RestoreError ? error.reason : "agent-start-failed",
        })
        return
      }
    }

    const nativeId = this.#nativeId
    if (this.#active !== turn) return
    if (turn.cancelling) { this.finish(turn, { type: "cancelled" }); return }
    if (!nativeId || proc.disconnected || proc.evicting) {
      this.finish(turn, { type: "failed", reason: "agent-disconnected" })
      return
    }
    turn.prompting = true
    proc.touchActivity()
    try {
      // 重建时只交接一次。RPC 发出后即算消费，避免回复丢失时重复注入。
      const prompt = this.#needsHistory ? [...historyOnReset, ...blocks] : blocks
      this.#needsHistory = false
      const metaKey = this.options.promptTurnIdMetaKey
      const result = await proc.connection.prompt({
        sessionId: nativeId, prompt: toSdkPromptBlocks(prompt),
        ...(metaKey ? { _meta: { [metaKey]: turn.id } } : {}),
      })
      this.finish(turn, result.stopReason === "end_turn"
        ? { type: "completed", shareable: !turn.cancelling && !turn.denied && this.#permission?.turn !== turn, ...metadata(result._meta) }
        : result.stopReason === "cancelled" ? { type: "cancelled" }
        : { type: "failed", reason: "agent-stopped", stopReason: result.stopReason })
    } catch {
      const disconnected = proc.disconnected || proc.connection.signal.aborted
      if (disconnected) {
        await proc.stop().catch(() => {})
        if (this.#process === proc) {
          this.#process = undefined
          this.#nativeId = undefined
        }
      }
      this.finish(turn, { type: "failed", reason: disconnected ? "agent-disconnected" : "prompt-failed" })
    }
  }

  private async openSession(initialProc: AgentProcess): Promise<AgentProcess> {
    let proc = initialProc
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
    if (proc.disconnected || proc.evicting || this.#closing) throw new Error("本机 Agent 已断开。")

    if (nativeId) {
      const useResume = Boolean(
        this.options.shareProcessPerWorkspace
        && this.#state.agentCapabilities?.sessionCapabilities?.resume,
      )
      const canLoad = Boolean(this.#state.agentCapabilities?.loadSession)
      if (!useResume && !canLoad) {
        if (this.restorePolicy === "strict") throw new RestoreError("session-restore-unsupported")
        await this.nativeBinding.clear()
        resetReason = "session-restore-unsupported"
        staleId = nativeId
      } else {
        proc.beginOpen()
        let restored = false
        try {
          restored = useResume
            ? await this.tryResumeSession(proc, nativeId)
            : await this.tryLoadSession(proc, nativeId)
        } finally {
          proc.endOpen()
        }
        if (restored) return proc
        if (this.restorePolicy === "strict") {
          if (!proc.shared) {
            proc.detach(this)
            await proc.stop().catch(() => {})
            if (this.#process === proc) this.#process = undefined
          }
          throw new RestoreError("session-restore-failed")
        }
        if (this.#closing) throw new Error("本机会话已关闭。")
        if (!proc.shared || proc.disconnected || proc.evicting) {
          // 独占模式下未完成的 load 可能迟到：确认旧进程退出后再重建新会话；
          // 共享模式下仅当进程已断开才切换新进程，健康共享进程直接留在同一进程新建会话。
          proc.detach(this)
          await proc.stop().catch(() => {})
          if (this.#process === proc) this.#process = undefined
          if (this.#closing) throw new Error("本机会话已关闭。")
          await this.nativeBinding.clear()
          proc = await this.ensureInitialized()
        } else {
          await this.nativeBinding.clear()
        }
        resetReason = "session-restore-failed"
        staleId = nativeId
      }
    }

    proc.beginOpen()
    try {
      await this.openNewSession(proc, resetReason ? { reason: resetReason, previousSessionId: staleId ?? "" } : undefined)
    } finally {
      proc.endOpen()
    }
    return proc
  }

  private async tryResumeSession(proc: AgentProcess, nativeId: string): Promise<boolean> {
    this.#resumingSessionId = nativeId
    this.#pendingSessionUpdates = []
    this.resetTransientSessionUpdates()
    proc.registerNativeSession(nativeId, this)
    try {
      const resumed = await within(
        proc.connection.resumeSession({ ...await this.sessionPayload(), sessionId: nativeId }),
        this.handshakeTimeoutMs,
      )
      if (proc.disconnected || proc.evicting || this.#closing) {
        proc.unregisterNativeSession(nativeId, this)
        return false
      }
      const pendingUpdates = this.#pendingSessionUpdates ?? []
      this.#resumingSessionId = undefined
      this.#pendingSessionUpdates = undefined
      this.#nativeId = nativeId
      this.#needsHistory = false
      this.applyOpenedResponse(resumed)
      for (const update of pendingUpdates) this.applySessionUpdateToState(update)
      this.#state = {
        ...this.#state,
        connected: true,
        sessionId: nativeId,
        restoreStatus: { kind: "restored", sessionId: nativeId },
      }
      this.publishCachedCapabilities()
      this.emitSession({ type: "session-opened", state: this.getState() })
      for (const update of pendingUpdates) this.emitSessionUpdateEvent(update)
      return true
    } catch {
      this.#resumingSessionId = undefined
      this.#pendingSessionUpdates = undefined
      this.resetTransientSessionUpdates()
      proc.unregisterNativeSession(nativeId, this)
      return false
    }
  }

  private async tryLoadSession(proc: AgentProcess, nativeId: string): Promise<boolean> {
    this.#replayingSessionId = nativeId
    this.#replayFrames = []
    this.#pendingSessionUpdates = []
    this.resetTransientSessionUpdates()
    proc.registerNativeSession(nativeId, this)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const idleMs = this.options.sessionLoadReplayIdleMs
      const idle = new Promise<never>((_, reject) => {
        if (idleMs !== undefined && Number.isSafeInteger(idleMs) && idleMs > 0) {
          this.#replayActivity = () => {
            clearTimeout(idleTimer)
            idleTimer = setTimeout(() => reject(new RestoreError("session-restore-failed")), idleMs)
          }
        }
      })
      const request = proc.connection.loadSession({ ...await this.sessionPayload(), sessionId: nativeId })
      const loaded = await within(Promise.race([request, idle]), this.handshakeTimeoutMs)
      if (proc.disconnected || proc.evicting || this.#closing) {
        proc.unregisterNativeSession(nativeId, this)
        return false
      }
      const replayFrames = this.#replayFrames ?? []
      const pendingUpdates = this.#pendingSessionUpdates ?? []
      this.#replayingSessionId = undefined
      this.#replayFrames = undefined
      this.#pendingSessionUpdates = undefined
      this.#nativeId = nativeId
      this.#needsHistory = false
      this.applyOpenedResponse(loaded)
      for (const update of pendingUpdates) this.applySessionUpdateToState(update)
      this.#state = {
        ...this.#state,
        connected: true,
        sessionId: nativeId,
        restoreStatus: { kind: "restored", sessionId: nativeId },
      }
      this.publishCachedCapabilities()
      this.emitSession({ type: "session-opened", state: this.getState() })
      for (const frame of replayFrames) this.emitSession({ type: "replay", frame })
      for (const update of pendingUpdates) this.emitSessionUpdateEvent(update)
      return true
    } catch {
      this.#replayingSessionId = undefined
      this.#replayFrames = undefined
      this.#pendingSessionUpdates = undefined
      this.resetTransientSessionUpdates()
      proc.unregisterNativeSession(nativeId, this)
      return false
    } finally {
      clearTimeout(idleTimer)
      this.#replayActivity = undefined
    }
  }

  private async openNewSession(
    proc: AgentProcess,
    resetFrom?: { readonly reason: LocalAcpRestoreReason; readonly previousSessionId: string },
  ): Promise<void> {
    // 保持 openingNewSession 覆盖整个 newSession + nativeBinding 落盘过程：
    // Agent 在返回 NewSessionResponse 的同时可能异步推送 available_commands_update，
    // 若提前清掉标志而此时 nativeBinding 尚未写完、#nativeId 仍为 undefined，命令更新会被暂存不丢。
    this.#openingNewSession = true
    this.#pendingSessionUpdates = []
    this.resetTransientSessionUpdates()
    let opened: Awaited<ReturnType<AgentProcess["runNewSession"]>>["opened"]
    let nativeId: string
    let pendingUpdates: SessionUpdate[] = []
    try {
      const result = await proc.runNewSession(this, await this.sessionPayload(), this.handshakeTimeoutMs)
      opened = result.opened
      nativeId = opened.sessionId
      if (proc.disconnected || proc.evicting || this.#closing) throw new Error("本机 Agent 已断开。")
      try {
        await this.nativeBinding.write(nativeId)
      } catch (error) {
        proc.unregisterNativeSession(nativeId, this)
        throw error
      }
      if (proc.disconnected || proc.evicting || this.#closing) {
        proc.unregisterNativeSession(nativeId, this)
        throw new Error("本机 Agent 已断开。")
      }
      this.#nativeId = nativeId
      pendingUpdates = [...result.pendingUpdates, ...(this.#pendingSessionUpdates ?? [])]
    } finally {
      this.#openingNewSession = false
      this.#pendingSessionUpdates = undefined
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
    this.#needsHistory = Boolean(resetFrom)
    this.publishCachedCapabilities()
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
    this.#legacyModes = undefined
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
    this.#legacyModes = parseModes(response.modes)
    const models = parseModels(response.models)
    this.#state = { ...this.#state, ...(models ? { models } : {}) }
    this.updateConfigOptions(response.configOptions ?? [], false)
  }

  onSessionUpdate({ sessionId, update }: SessionNotification): void {
    if (!this.#process || this.#process.disconnected || this.#closing) return

    // 1) loadSession 回放窗口：收集回放帧，禁止进入当前轮次的 subscribe() 通道。
    if (this.#replayingSessionId === sessionId && !this.#nativeId) {
      const frame = toReplayFrame(update)
      if (frame) {
        this.#replayActivity?.()
        this.#replayFrames?.push(frame)
        return
      }
      if (this.isSessionLevelUpdate(update)) {
        this.#pendingSessionUpdates?.push(update)
      }
      return
    }

    // 2) newSession / resumeSession 响应或落盘窗口：先暂存会话级通知，拿到 #nativeId 后再原子落地。
    if ((this.#openingNewSession || this.#resumingSessionId === sessionId) && !this.#nativeId) {
      if (this.isSessionLevelUpdate(update)) {
        this.#pendingSessionUpdates?.push(update)
      }
      return
    }

    if (this.#nativeId !== sessionId) return
    this.#active?.extensionUpdate?.(update)

    // 3) 已建会话上的会话级更新：无论是否处于 prompting，一律刷新状态并推送到 subscribeSession()。
    if (this.isSessionLevelUpdate(update)) {
      this.applySessionUpdateToState(update)
      this.publishCachedCapabilities()
      this.emitSessionUpdateEvent(update)
      return
    }

    // 4) 轮次流式内容与工具更新：仅在当前活跃 prompting 轮次发射给 subscribe()。
    if (!this.#active?.prompting) return
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.emit(this.#active, { type: "tool", tool: { ...toLocalAcpTool(update), ...metadata(update._meta) } })
      return
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text" && update.content.text) {
        this.emit(this.#active, { type: "thought-delta", text: update.content.text })
      }
      return
    }
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text) {
      this.emit(this.#active, {
        type: "text-delta", text: update.content.text, messageId: update.messageId ?? undefined,
        ...metadata(update.content._meta), ...metadata(update._meta),
      })
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
    if (this.#legacyModes) this.#legacyModes = { ...this.#legacyModes, currentModeId }
    if (configMode(this.#state.configOptions)) return
    this.#state = { ...this.#state, currentModeId, modes: this.#legacyModes }
    this.publishCachedCapabilities()
    if (emitEvent) this.emitSession({ type: "current-mode", currentModeId })
  }

  private updateConfigOptions(raw: readonly SessionConfigOption[], emitEvent: boolean): void {
    this.#configRevision++
    const configOptions = parseConfigOptions(raw)
    const modern = configMode(configOptions)
    const modes = modern ? {
      currentModeId: modern.currentValue,
      availableModes: modern.options.map(({ value, name, description }) => ({ id: value, name, ...(description ? { description } : {}) })),
    } : this.#legacyModes
    this.#state = { ...this.#state, configOptions, modes, currentModeId: modes?.currentModeId }
    this.publishCachedCapabilities()
    if (emitEvent) this.emitSession({ type: "config-options", configOptions: structuredClone(configOptions) })
  }

  private finish(turn: Turn, event: EventData): void {
    if (this.#active !== turn) return
    clearTimeout(turn.cancelTimer)
    turn.endExtension?.()
    this.resolvePermission(turn, declined)
    this.resolveElicitation({ action: "cancel" }, turn)
    if (this.#process && this.#nativeId) {
      void this.#process.capabilities.cleanupTerminals(this.#nativeId).catch(() => {})
    }
    // 终态回调查询可用性时已经空闲。过期请求不能清理下一轮的状态。
    this.#active = undefined
    this.#process?.touchActivity()
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
      const proc = this.#process
      const nativeId = this.#nativeId
      this.#process = undefined
      this.#nativeId = undefined
      if (proc) {
        if (proc.shared) {
          if (nativeId) await proc.closeNativeSession(nativeId).catch(() => {})
          proc.detach(this)
          this.leaseProvider.releaseSharedProcess(proc)
        } else {
          proc.detach(this)
          await proc.stop().catch(() => {})
        }
      }
      this.release()
    })
  }
}
