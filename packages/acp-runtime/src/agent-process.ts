/**
 * ACP Agent 进程与多会话复用治理模块：
 *
 * 1. 功能定义：管理底层 Agent 子进程与 `ClientSideConnection`，支持同一工作区多会话共享常驻进程
 *    （按 `sessionId` 精确路由流式更新、权限审批、交互表单与工作区沙箱能力），并提供统一的空闲超时回收
 *    与全局 LRU 进程数量上限控制。
 * 2. 协作边界：仅作为 `@workbench/acp-runtime` 内部实现，服务于 `LocalAcpHost`、`AcpAgentRegistry` 与 `BoundSession`，
 *    不对外暴露进程句柄。
 * 3. 核心防护：
 *    - 同一进程上的 `session/new` 通过 `#newSessionTail` 串行化，确保建会话期间抢先到达的会话级更新准确落盘到对应会话；
 *    - 存在活跃轮次、正在握手/开会话、或存在挂起权限/表单交互的进程绝对不会被空闲回收或 LRU 淘汰；
 *    - 空闲定时器一律调用 `.unref()`，避免阻塞测试或宿主退出。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"
import { agentStdout } from "./agent-stdio.js"
import { createClientCapabilityHandlers, type ClientCapabilityController } from "./client-capabilities.js"
import { buildClientCapabilities, parseAuthMethods, parseImplementation } from "./session-state.js"
import type {
  AgentCommand,
  LocalAcpAuthMethod,
  LocalAcpHostOptions,
  LocalAcpImplementation,
} from "./types.js"

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_MAX_LIVE_PROCESSES = 4
const CLOSE_SESSION_TIMEOUT_MS = 3_000

const declined: RequestPermissionResponse = { outcome: { outcome: "cancelled" } }

/** 受限超时包装：仅约束握手、建会或关闭阶段，不截断正常流式轮次。 */
export async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("等待本机 Agent 响应超时。")), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export type AgentInitInfo = {
  readonly protocolVersion: number
  readonly agentInfo?: LocalAcpImplementation
  readonly agentCapabilities?: AgentCapabilities
  readonly authMethods: readonly LocalAcpAuthMethod[]
}

/** `BoundSession` 注册到 `AgentProcess` 的事件与状态接收契约。 */
export type AgentProcessSessionReceiver = {
  readonly nativeSessionId: string | undefined
  hasActiveTurn(): boolean
  hasPendingInteraction(): boolean
  onSessionUpdate(notification: SessionNotification): void
  onPermissionRequest(input: RequestPermissionRequest): Promise<RequestPermissionResponse>
  onElicitationRequest(input: CreateElicitationRequest): Promise<CreateElicitationResponse>
  onProcessDisconnected(proc: AgentProcess): void
  onProcessEvicted(proc: AgentProcess): void
  onDiagnostic(pid: number, stderr: string): void
}

/** 宿主/注册表级常驻进程预算控制器：超限时仅按 LRU 淘汰最早空闲的进程。 */
export class ProcessBudget {
  readonly #processes = new Set<AgentProcess>()
  #roomTail: Promise<void> = Promise.resolve()

  constructor(private readonly maxLiveProcesses: number = DEFAULT_MAX_LIVE_PROCESSES) {}

  get liveCount(): number {
    return this.#processes.size
  }

  register(proc: AgentProcess): void {
    this.#processes.add(proc)
  }

  unregister(proc: AgentProcess): void {
    this.#processes.delete(proc)
  }

  /** 在启动新进程前腾出配额；存在活跃工作时保留进程，不强杀执行中的轮次。 */
  makeRoom(exclude?: AgentProcess): Promise<void> {
    if (this.maxLiveProcesses <= 0) return Promise.resolve()
    const task = this.#roomTail.then(async () => {
      while (this.#processes.size >= this.maxLiveProcesses) {
        const candidates = [...this.#processes]
          .filter(proc => proc !== exclude && proc.isIdle() && !proc.evicting)
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
        const victim = candidates[0]
        if (!victim) break
        await victim.evict()
      }
    })
    this.#roomTail = task.then(() => {}, () => {})
    return task
  }
}

const hostBudgets = new WeakMap<object, ProcessBudget>()

/** 供同包 `AcpAgentRegistry` 注入跨 Provider 共享的进程预算，不暴露到公开入口。 */
export function attachHostBudget(host: object, budget: ProcessBudget): void {
  hostBudgets.set(host, budget)
}

export function resolveHostBudget(host: object, fallbackMax: number): ProcessBudget {
  let budget = hostBudgets.get(host)
  if (!budget) {
    budget = new ProcessBudget(fallbackMax)
    hostBudgets.set(host, budget)
  }
  return budget
}

export type AgentProcessOptions = {
  readonly root: string
  readonly device: bigint
  readonly inode: bigint
  readonly command: AgentCommand
  readonly hostOptions: LocalAcpHostOptions
  readonly shared: boolean
  readonly idleTimeoutMs: number
  readonly budget?: ProcessBudget
  readonly onRemoveFromPool?: () => void
}

/**
 * 封装单个本机 ACP Agent 子进程与 JSON-RPC 连接。
 * 既可用于独占会话，也可作为同一工作区多个会话共享的常驻连接载体。
 */
export class AgentProcess {
  readonly root: string
  readonly device: bigint
  readonly inode: bigint
  readonly shared: boolean
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  readonly connection: ClientSideConnection
  readonly capabilities: ClientCapabilityController

  disconnected = false
  evicting = false
  exitedConfirmed = false
  lastActiveAt = Date.now()

  readonly #command: AgentCommand
  readonly #hostOptions: LocalAcpHostOptions
  readonly #idleTimeoutMs: number
  readonly #budget?: ProcessBudget
  readonly #onRemoveFromPool?: () => void
  readonly #receivers = new Set<AgentProcessSessionReceiver>()
  readonly #byNativeId = new Map<string, AgentProcessSessionReceiver>()

  #initPromise?: Promise<AgentInitInfo>
  #initializeResult?: AgentInitInfo
  #inFlightOpens = 0
  #newSessionTail: Promise<void> = Promise.resolve()
  #openingReceiver?: {
    readonly receiver: AgentProcessSessionReceiver
    readonly buffer: Array<{ readonly sessionId: string; readonly update: SessionUpdate }>
  }
  #idleTimer?: ReturnType<typeof setTimeout>
  #stopping?: Promise<void>

  constructor(options: AgentProcessOptions) {
    this.root = options.root
    this.device = options.device
    this.inode = options.inode
    this.shared = options.shared
    this.#command = options.command
    this.#hostOptions = options.hostOptions
    this.#idleTimeoutMs = options.idleTimeoutMs
    this.#budget = options.budget
    this.#onRemoveFromPool = options.onRemoveFromPool

    const child = spawn(this.#command.executable, this.#command.args ?? [], {
      cwd: this.root,
      env: this.#command.env as NodeJS.ProcessEnv | undefined,
      stdio: "pipe",
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    })
    this.child = child
    this.exited = new Promise<void>(resolve => child.once("close", () => resolve()))

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (child.pid === undefined) return
      const excerpt = chunk.slice(0, 8192)
      const activeReceivers = [...this.#receivers].filter(receiver => receiver.hasActiveTurn())
      const targets = activeReceivers.length > 0 ? activeReceivers : [...this.#receivers]
      for (const receiver of targets) {
        receiver.onDiagnostic(child.pid, excerpt)
      }
    })

    this.capabilities = createClientCapabilityHandlers({
      root: this.root,
      device: this.device,
      inode: this.inode,
      env: this.#command.env,
      enableFs: this.#hostOptions.enableClientFs !== false,
      enableTerminal: this.#hostOptions.enableClientTerminal === true,
      maxFsFileBytes: this.#hostOptions.maxFsFileBytes,
      hasSessionId: sessionId => this.#byNativeId.has(sessionId),
      isActive: () => !this.disconnected && !this.#stopping && !this.evicting,
    })

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin),
      new ReadableStream({ start(controller) { controller.close() } }),
    )
    this.connection = new ClientSideConnection(() => ({
      sessionUpdate: async notification => this.#handleSessionUpdate(notification),
      requestPermission: input => this.#handlePermissionRequest(input),
      ...this.capabilities.handlers,
      ...(this.#hostOptions.enableElicitation === true
        ? { unstable_createElicitation: (input: CreateElicitationRequest) => this.#handleElicitationRequest(input) }
        : {}),
    }), { readable: agentStdout(child.stdout), writable: stream.writable })

    const onDisconnect = () => {
      if (this.disconnected) return
      this.disconnected = true
      this.#clearIdleTimer()
      this.#onRemoveFromPool?.()
      this.#budget?.unregister(this)
      for (const receiver of [...this.#receivers]) {
        receiver.onProcessDisconnected(this)
      }
      void this.stop().catch(() => {})
    }
    child.on("error", onDisconnect)
    void this.exited.then(onDisconnect)
    void this.connection.closed.then(onDisconnect, onDisconnect)

    this.#budget?.register(this)
  }

  get handshakeTimeoutMs(): number {
    return this.#hostOptions.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  }

  get initializeResult(): AgentInitInfo | undefined {
    return this.#initializeResult
  }

  get stopping(): boolean {
    return this.#stopping !== undefined
  }

  attach(receiver: AgentProcessSessionReceiver): void {
    this.#receivers.add(receiver)
    this.touchActivity()
  }

  detach(receiver: AgentProcessSessionReceiver): void {
    this.#receivers.delete(receiver)
    for (const [nativeId, registered] of this.#byNativeId) {
      if (registered === receiver) this.#byNativeId.delete(nativeId)
    }
    this.scheduleIdleCheck()
  }

  registerNativeSession(nativeId: string, receiver: AgentProcessSessionReceiver): void {
    this.#byNativeId.set(nativeId, receiver)
  }

  unregisterNativeSession(nativeId: string, receiver: AgentProcessSessionReceiver): void {
    if (this.#byNativeId.get(nativeId) === receiver) {
      this.#byNativeId.delete(nativeId)
    }
  }

  beginOpen(): void {
    this.#inFlightOpens += 1
    this.touchActivity()
  }

  endOpen(): void {
    this.#inFlightOpens = Math.max(0, this.#inFlightOpens - 1)
    this.touchActivity()
  }

  touchActivity(): void {
    this.lastActiveAt = Date.now()
    this.scheduleIdleCheck()
  }

  isIdle(): boolean {
    if (this.disconnected || this.#stopping || this.evicting || this.#inFlightOpens > 0) {
      return false
    }
    for (const receiver of this.#receivers) {
      if (receiver.hasActiveTurn() || receiver.hasPendingInteraction()) return false
    }
    return true
  }

  scheduleIdleCheck(): void {
    this.#clearIdleTimer()
    if (this.#idleTimeoutMs <= 0 || !this.isIdle()) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.isIdle()) {
        void this.evict().catch(() => {})
      }
    }, this.#idleTimeoutMs)
    this.#idleTimer.unref()
  }

  async ensureInitialized(): Promise<AgentInitInfo> {
    if (this.#initializeResult && !this.disconnected && !this.#stopping) {
      return this.#initializeResult
    }
    if (this.#initPromise) return this.#initPromise
    if (this.disconnected || this.#stopping || this.evicting) {
      throw new Error("本机 Agent 已断开。")
    }

    const promise = (async () => {
      try {
        const initialized = await within(
          this.connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: buildClientCapabilities(this.#hostOptions),
          }),
          this.handshakeTimeoutMs,
        )
        if (initialized.protocolVersion !== PROTOCOL_VERSION || this.disconnected || this.#stopping) {
          throw new Error("本机 Agent 握手失败。")
        }
        const info: AgentInitInfo = {
          protocolVersion: initialized.protocolVersion,
          agentInfo: parseImplementation(initialized.agentInfo),
          agentCapabilities: initialized.agentCapabilities ? structuredClone(initialized.agentCapabilities) : undefined,
          authMethods: parseAuthMethods(initialized.authMethods),
        }
        this.#initializeResult = info
        this.touchActivity()
        return info
      } catch (error) {
        this.#initPromise = undefined
        this.#onRemoveFromPool?.()
        await this.stop().catch(() => {})
        throw error
      }
    })()

    this.#initPromise = promise
    return promise
  }

  /**
   * 在同一进程上串行执行 `session/new`，保证在 RPC 返回前先到达的会话更新
   * 能按 `sessionId` 准确归属给本次发起创建的接收方。
   */
  runNewSession(
    receiver: AgentProcessSessionReceiver,
    payload: NewSessionRequest,
    timeoutMs: number,
  ): Promise<{ readonly opened: NewSessionResponse; readonly pendingUpdates: readonly SessionUpdate[] }> {
    const task = this.#newSessionTail.then(async () => {
      if (this.disconnected || this.#stopping || this.evicting) {
        throw new Error("本机 Agent 已断开。")
      }
      const buffer: Array<{ readonly sessionId: string; readonly update: SessionUpdate }> = []
      this.#openingReceiver = { receiver, buffer }
      try {
        const opened = await within(this.connection.newSession(payload), timeoutMs)
        if (!opened.sessionId) throw new Error("无法创建本机 Agent 会话。")
        if (this.disconnected || this.#stopping) throw new Error("本机 Agent 已断开。")
        this.#byNativeId.set(opened.sessionId, receiver)
        const pendingUpdates = buffer
          .filter(item => item.sessionId === opened.sessionId)
          .map(item => item.update)
        return { opened, pendingUpdates }
      } finally {
        this.#openingReceiver = undefined
      }
    })
    this.#newSessionTail = task.then(() => {}, () => {})
    return task
  }

  async closeNativeSession(nativeId: string): Promise<void> {
    this.#byNativeId.delete(nativeId)
    if (!this.disconnected && !this.#stopping && this.#initializeResult?.agentCapabilities?.sessionCapabilities?.close) {
      await within(this.connection.closeSession({ sessionId: nativeId }), CLOSE_SESSION_TIMEOUT_MS).catch(() => {})
    }
    await this.capabilities.cleanupTerminals(nativeId).catch(() => {})
  }

  /** 空闲或 LRU 淘汰：从池中摘除并通知各会话恢复未连接待命态，然后优雅停止子进程。 */
  async evict(): Promise<void> {
    if (this.evicting || this.#stopping || this.disconnected || !this.isIdle()) return
    this.evicting = true
    this.#clearIdleTimer()
    this.#onRemoveFromPool?.()
    this.#budget?.unregister(this)
    const receivers = [...this.#receivers]
    this.#byNativeId.clear()
    this.#receivers.clear()
    for (const receiver of receivers) {
      receiver.onProcessEvicted(this)
    }
    await this.stop().catch(() => {})
  }

  stop(): Promise<void> {
    return this.#stopping ??= (async () => {
      this.#clearIdleTimer()
      this.#onRemoveFromPool?.()
      this.#budget?.unregister(this)
      await this.capabilities.cleanupTerminals().catch(() => {})
      await this.#waitForExit()
      this.exitedConfirmed = true
    })()
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
  }

  #handleSessionUpdate(notification: SessionNotification): void {
    if (this.disconnected || this.#stopping) return
    const target = this.#byNativeId.get(notification.sessionId)
    if (target) {
      this.lastActiveAt = Date.now()
      target.onSessionUpdate(notification)
      return
    }
    if (this.#openingReceiver) {
      this.#openingReceiver.buffer.push({ sessionId: notification.sessionId, update: notification.update })
    }
  }

  #handlePermissionRequest(input: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.disconnected || this.#stopping) return Promise.resolve(declined)
    const target = this.#byNativeId.get(input.sessionId)
    if (!target) return Promise.resolve(declined)
    this.touchActivity()
    return target.onPermissionRequest(input)
  }

  #handleElicitationRequest(input: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (this.disconnected || this.#stopping) return Promise.resolve({ action: "cancel" })
    const sessionId = "sessionId" in input && typeof input.sessionId === "string" ? input.sessionId : undefined
    let target = sessionId ? this.#byNativeId.get(sessionId) : undefined
    // 部分单会话外部 Agent 可能省略 sessionId，仅在非共享且唯一接收方时兜底路由。
    if (!target && !sessionId && !this.shared && this.#receivers.size === 1) {
      target = this.#receivers.values().next().value
    }
    if (!target) return Promise.resolve({ action: "cancel" })
    this.touchActivity()
    return target.onElicitationRequest(input)
  }

  async #waitForExit(): Promise<void> {
    const { child, exited } = this
    child.stdin.end()
    const pid = child.pid
    const group = pid !== undefined && process.platform !== "win32" ? -pid : undefined
    function groupAlive(): boolean {
      if (group === undefined) return false
      try {
        process.kill(group, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    function signal(name: NodeJS.Signals): void {
      if (group === undefined) {
        child.kill(name)
        return
      }
      try {
        process.kill(group, name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
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
      try {
        await wait()
        return
      } catch {
        if (name === "SIGKILL") throw new Error("未确认本机 Agent 进程退出。")
      }
    }
  }
}
