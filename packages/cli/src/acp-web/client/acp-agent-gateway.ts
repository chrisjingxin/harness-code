/**
 * `AcpAgentGateway`：实现 `AgentGateway`，把 Interactive Core 接到 ACP
 * 通道（浏览器 WebSocket → 桥 → Python sidecar）。
 *
 *  ┌─────────┐  v3 事件   ┌──────────────┐  ACP JSON-RPC   ┌───────┐
 *  │ Control │ ◀──────── │ AcpAgentGate │ ◀──────────────▶│ ws    │
 *  │ ler     │  请求      │   RunTranslator/ReplayBuffer   │ stream│
 *  └─────────┘ ────────▶ │  pendingPermissions / 别名表   │       │
 *                       └──────────────┘                  └───────┘
 *
 * 核心工作（设计 §4.4）：
 * - `connect`：initialize 握手 + `session/new` 暖会话 + 等命令落定；
 * - `startRun`：同步返回 handle，后台完成 门禁 → 取会话 → 换模式 → prompt；
 * - `sessionUpdate` 在同一同步段内翻译并入队（F11：保证"update 先于响应"）；
 * - `requestPermission` ⇄ Core `InteractionRequestEnvelope`（pending 表恰好
 *   settle 一次：cancel/abandon/onClose 都可能抢先）；
 * - `listThreads`/`openThread`：session/list 合成 ThreadSummary（GAP-36
 *   固定值）、session/load 回放进 ReplayBuffer；
 * - 27 个不支持方法统一 `AgentGatewayError("ACP_NOT_SUPPORTED", GAP-xx)`；
 * - `onClose`：SDK closed 与 ws-stream closed 合并成一次 handleClosed，
 *   挂起交互按 cancelled 收敛，活动 Run 的 events 失败、completion 拒绝。
 */

import { ClientSideConnection, RequestError, type Stream } from "@agentclientprotocol/sdk"
import type {
  ApprovalMode,
  CodeIndexSnapshot,
  EventEnvelope,
  InteractionRequestEnvelope,
  InteractionResponse,
  RunCancelResult,
  RunSetApprovalModeResult,
  ThreadSummary,
  ThreadsListResult,
  ThreadsOpenResult,
} from "@za38/protocol"

import { AsyncQueue } from "../../ipc/transport"
import {
  AgentGatewayError,
  type AgentGateway,
  type AgentGatewayStartRunInput,
  type InteractiveAgentRun,
  type InteractiveRunCompletion,
} from "../../interactive/ports/agent-gateway"
import { BRIDGE_EXIT_METHOD } from "../ext"
import { buildInteractionRequest, mapInteractionResponse, type PermissionOutcome } from "./permission"
import { ReplayBuffer } from "./replay"
import { createAcpRuntime } from "./runtime"
import { metaApproval, nameOf, RunTranslator, type AcpSessionUpdate, type PromptOutcome } from "./translate"
import type { AcpBootInfo } from "./runtime"
import type { WsCloseInfo } from "./ws-stream"

export type { AcpBootInfo } from "./runtime"

export type AcpGatewayConnectOptions = {
  stream: Stream
  /** POST /acp/boot 返回的工作区绝对路径。 */
  cwd: string
  /** 来自 ws-stream；缺省时只用 SDK 的 connection.closed。 */
  closed?: Promise<WsCloseInfo>
  clientVersion?: string
  now?: () => number
  uuid?: () => string
  /** available_commands_update 的等待窗口；超时按空表处理。 */
  settleCommandsMs?: number
  /** initialize 超时（Python 冷启动约 1 秒）。 */
  initializeTimeoutMs?: number
  log?: (event: { event: string; [key: string]: unknown }) => void
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; settled: boolean }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const d: Deferred<T> = {
    promise: new Promise<T>((res, rej) => { resolve = res; reject = rej }),
    resolve: (value: T) => { if (!d.settled) { d.settled = true; resolve(value) } },
    reject: (error: unknown) => { if (!d.settled) { d.settled = true; reject(error) } },
    settled: false,
  }
  return d
}

type RunState = {
  ref: { threadId: string; runId: string }
  translator: RunTranslator
  events: AsyncQueue<EventEnvelope>
  accepted: Deferred<void>
  completion: Deferred<InteractiveRunCompletion>
  cancelRequested: boolean
  approvalRevision: number
  startedAtMs: number
}

type SessionState = {
  /** Core 侧 threadId；未被认领的暖会话为 null。 */
  coreThreadId: string | null
  acpSessionId: string
  currentModeId: string | null
  /** Agent 声明的模式表；空表/null 表示不支持换模式（不调 set_mode）。 */
  availableModeIds: readonly string[] | null
  run: RunState | null
  replay: ReplayBuffer | null
  /** 尚未被任何 Core 线程认领的暖会话。 */
  warm: boolean
}

type PendingPermission = {
  settle: (outcome: PermissionOutcome) => void
  request: InteractionRequestEnvelope
  abandoned: boolean
  /** 所属 ACP 会话：cancel(threadId) 只结算该会话的挂起审批。 */
  acpSessionId: string
}

const CANCELLED: PermissionOutcome = { outcome: "cancelled" }

/** 27 个不支持方法 → 缺口编号（GAP）。B8 用它与 AgentGateway 接口做漂移检查。 */
export const UNSUPPORTED_METHODS: Record<string, { gap: string; label: string }> = {
  compactContext: { gap: "GAP-07", label: "上下文用量与压缩" },
  configDetails: { gap: "GAP-18", label: "配置查看与修改" },
  previewConfig: { gap: "GAP-18", label: "配置查看与修改" },
  commitConfig: { gap: "GAP-18", label: "配置查看与修改" },
  setThreadTitle: { gap: "GAP-39", label: "手动重命名会话" },
  inspectGoal: { gap: "GAP-03", label: "目标闭环" },
  requestGoal: { gap: "GAP-03", label: "目标闭环" },
  mutateGoal: { gap: "GAP-03", label: "目标闭环" },
  listTurns: { gap: "GAP-09", label: "撤销 / 重做" },
  undo: { gap: "GAP-09", label: "撤销 / 重做" },
  redo: { gap: "GAP-09", label: "撤销 / 重做" },
  mcpStatus: { gap: "GAP-15", label: "MCP 运行期管理" },
  mcpAdd: { gap: "GAP-15", label: "MCP 运行期管理" },
  mcpRemove: { gap: "GAP-15", label: "MCP 运行期管理" },
  codeIndexStatus: { gap: "GAP-17", label: "代码索引" },
  codeIndexApply: { gap: "GAP-17", label: "代码索引" },
  listModels: { gap: "GAP-08", label: "模型选择与切换" },
  listSkills: { gap: "GAP-13", label: "技能管理" },
  setSkillEnabled: { gap: "GAP-13", label: "技能管理" },
  listAgents: { gap: "GAP-16", label: "子代理 / Team" },
  listTeams: { gap: "GAP-16", label: "子代理 / Team" },
  inspectTeam: { gap: "GAP-16", label: "子代理 / Team" },
  generateTeam: { gap: "GAP-16", label: "子代理 / Team" },
  runTeam: { gap: "GAP-16", label: "子代理 / Team" },
  cancelTeam: { gap: "GAP-16", label: "子代理 / Team" },
  abandonCompose: { gap: "GAP-04", label: "Compose 模式" },
  sideQuestion: { gap: "GAP-10", label: "旁路提问 /btw" },
}

function notSupported(method: string): AgentGatewayError {
  const entry = UNSUPPORTED_METHODS[method]!
  return new AgentGatewayError("ACP_NOT_SUPPORTED", `该功能暂未通过 ACP 提供（${entry.gap}：${entry.label}）`)
}

export class AcpAgentGateway implements AgentGateway {
  private conn!: ClientSideConnection
  private boot!: AcpBootInfo
  private readonly byCore = new Map<string, SessionState>()
  private readonly byAcp = new Map<string, SessionState>()
  private readonly summaries = new Map<string, ThreadSummary>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly threadSummaryListeners = new Set<(thread: ThreadSummary) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private readonly protocolErrorListeners = new Set<(error: Error) => void>()
  private interactionHandler: ((request: InteractionRequestEnvelope) => Promise<InteractionResponse>) | null = null
  private closedFlag = false
  private warmSession: SessionState | null = null
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly cwd: string
  private readonly log: (event: { event: string; [key: string]: unknown }) => void

  private constructor(options: AcpGatewayConnectOptions) {
    this.cwd = options.cwd
    this.now = options.now ?? (() => Date.now())
    this.uuid = options.uuid ?? (() => crypto.randomUUID())
    this.log = options.log ?? (() => {})
  }

  static async connect(options: AcpGatewayConnectOptions): Promise<{ gateway: AcpAgentGateway; boot: AcpBootInfo }> {
    const gateway = new AcpAgentGateway(options)
    const initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000
    const settleCommandsMs = options.settleCommandsMs ?? 500

    // available_commands_update 到齐时唤醒（见 onSessionUpdate）。
    const commandsDone = new Promise<void>(resolve => { gateway.commandsArrived = resolve })

    gateway.conn = new ClientSideConnection(() => ({
      sessionUpdate: async (params: { sessionId: string; update: Record<string, unknown> }) => {
        gateway.onSessionUpdate(params.sessionId, params.update as AcpSessionUpdate)
      },
      requestPermission: (params: { sessionId: string; toolCall: Record<string, unknown>; options: Array<{ optionId?: string }> }) =>
        gateway.onRequestPermission(params),
    }) as never, options.stream)

    const initializePromise = gateway.conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        _meta: { harnessCode: { version: 1, capabilities: ["approval", "runSummary"] } },
      } as never,
      clientInfo: { name: "harness-web", title: "Harness Code Web", version: options.clientVersion ?? "0.0.0" },
    } as never)
    // 单个超时计时器：initialize 成功或失败后都 clearTimeout，
    // 不让残留定时器在之后误触发 handleClosed。
    let initTimer: ReturnType<typeof setTimeout> | null = null
    const initialized = await Promise.race([
      initializePromise,
      new Promise((_, reject) => {
        initTimer = setTimeout(() => reject(new AgentGatewayError("ACP_INITIALIZE_TIMEOUT", "initialize 超时")), initializeTimeoutMs)
      }),
    ]).finally(() => { if (initTimer) clearTimeout(initTimer) }) as {
      protocolVersion: number
      agentInfo?: { name: string; title: string | null; version: string }
      agentCapabilities?: Record<string, unknown>
    }
    if (initialized.protocolVersion !== 1) {
      throw new AgentGatewayError("ACP_PROTOCOL_MISMATCH", `ACP 协议版本不匹配：期望 1，收到 ${initialized.protocolVersion}`)
    }

    const caps = initialized.agentCapabilities ?? {}
    const sessionCaps = (caps as { sessionCapabilities?: { list?: unknown } }).sessionCapabilities
    const harnessMeta = (caps as { _meta?: { harnessCode?: { capabilities?: unknown } } })._meta?.harnessCode
    const declared = new Set(Array.isArray(harnessMeta?.capabilities) ? harnessMeta.capabilities : [])

    // 暖会话：命令表在 session/new 响应之后才到，等 settleCommandsMs。
    gateway.pendingWarmCommands = []
    const session = await gateway.conn.newSession({ cwd: options.cwd, mcpServers: [] } as never) as {
      sessionId: string
      modes?: { currentModeId: string; availableModes?: Array<{ id: string; name: string; description: string | null }> }
    }
    const warm: SessionState = {
      coreThreadId: null,
      acpSessionId: session.sessionId,
      currentModeId: session.modes?.currentModeId ?? null,
      availableModeIds: session.modes?.availableModes?.map((mode: { id: string }) => mode.id) ?? null,
      run: null,
      replay: null,
      warm: true,
    }
    gateway.byAcp.set(session.sessionId, warm)
    gateway.warmSession = warm

    gateway.boot = {
      cwd: options.cwd,
      agentInfo: initialized.agentInfo ?? null,
      canLoadSession: (caps as { loadSession?: boolean }).loadSession === true,
      canListSessions: sessionCaps?.list != null,
      extension: {
        approval: declared.has("approval"),
        runSummary: declared.has("runSummary"),
      },
      modes: session.modes
        ? { currentModeId: session.modes.currentModeId, availableModes: session.modes.availableModes ?? [] }
        : null,
      commands: [],
    }

    // 等命令落定：收到第一条 available_commands_update 提前结束，
    // 提前结束时把计时器清掉，不留悬挂引用。
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      commandsDone,
      new Promise<void>(resolve => { settleTimer = setTimeout(resolve, settleCommandsMs) }),
    ])
    if (settleTimer) clearTimeout(settleTimer)
    gateway.boot.commands = gateway.pendingWarmCommands ?? []
    gateway.pendingWarmCommands = null

    if (options.closed) {
      void options.closed.then(info => gateway.handleClosed(info))
    }
    // SDK 的 connection.closed 是另一路关闭信号（无关闭码）。
    void (gateway.conn as unknown as { closed?: Promise<void> }).closed?.then(() => {
      gateway.handleClosed({ code: 1006, reason: "", wasClean: false, bridgeExit: null, localReason: null })
    })
    return { gateway, boot: gateway.boot }
  }

  private pendingWarmCommands: AcpBootInfo["commands"] | null = null

  // ---------------- sessionUpdate 路由（同一同步段，F11） ----------------

  private onSessionUpdate(sessionId: string, update: AcpSessionUpdate): void {
    const session = this.byAcp.get(sessionId)
    if (!session) {
      this.log({ event: "update.orphan", sessionId, kind: update.sessionUpdate })
      return
    }
    switch (update.sessionUpdate) {
      case "session_info_update": {
        this.onSessionInfo(session, update)
        return
      }
      case "current_mode_update": {
        session.currentModeId = typeof update.currentModeId === "string" ? update.currentModeId : session.currentModeId
        return
      }
      case "available_commands_update": {
        const commands = ((update as { availableCommands?: Array<{ name: string; description?: string; input?: { hint?: string } }> }).availableCommands ?? [])
          .map(command => ({ name: command.name, description: command.description ?? "", hint: command.input?.hint ?? null })) as AcpBootInfo["commands"]
        if (this.pendingWarmCommands !== null) {
          // 握手落定窗口内：攒进 pendingWarmCommands，connect 尾部取进 boot.commands。
          this.pendingWarmCommands = commands
        } else {
          // 窗口过后到达的命令更新只记录——页面刷新后才会出现。
          this.log({ event: "commands.late", count: commands.length })
        }
        this.commandsArrived?.()
        return
      }
      default:
        break
    }
    if (session.replay) {
      session.replay.accept(update)
      return
    }
    const run = session.run
    if (!run) return
    // F11：翻译与入队都在同一同步段——update 事件一定排在 prompt 响应之前。
    const events = run.translator.update(update)
    for (const event of events) run.events.push(event)
    run.accepted.resolve()
  }

  private commandsArrived: (() => void) | null = null

  private onSessionInfo(session: SessionState, update: AcpSessionUpdate): void {
    const info = update as { title?: string | null; updatedAt?: string }
    if (typeof info.title !== "string" || !info.title) return
    const coreId = session.coreThreadId ?? session.acpSessionId
    const existing = this.summaries.get(coreId)
    const updatedAt = typeof info.updatedAt === "string" ? Date.parse(info.updatedAt) : NaN
    const merged: ThreadSummary = {
      thread_id: coreId,
      title: info.title,
      updated_at_ms: Number.isNaN(updatedAt) ? this.now() : updatedAt,
      created_at_ms: existing?.created_at_ms ?? (Number.isNaN(updatedAt) ? this.now() : updatedAt),
      first_message: existing?.first_message ?? info.title,
      latest_message: existing?.latest_message ?? "",
      message_count: existing?.message_count ?? 0,
    }
    this.summaries.set(coreId, merged)
    for (const listener of this.threadSummaryListeners) listener(merged)
  }

  // ---------------- requestPermission ⇄ Core 交互 ----------------

  private onRequestPermission(params: { sessionId: string; toolCall: Record<string, unknown>; options: Array<{ optionId?: string }> }): Promise<{ outcome: unknown }> {
    const session = this.byAcp.get(params.sessionId)
    const run = session?.run ?? null
    const fail = (reason: string): Promise<{ outcome: unknown }> => {
      this.log({ event: "permission.dropped", reason })
      return Promise.resolve({ outcome: CANCELLED })
    }
    if (!session || !session.coreThreadId || !run || run.cancelRequested || !this.interactionHandler || !this.boot.extension.approval) {
      return fail("no-handler-or-approval")
    }
    const toolCall = params.toolCall as { toolCallId?: string; title?: string; rawInput?: unknown; _meta?: unknown }
    const meta = metaApproval(toolCall._meta)
    const requestId = meta?.requestId
    if (typeof requestId !== "string" || !requestId) return fail("no-request-id")
    const envelope = buildInteractionRequest(
      { sessionId: params.sessionId, toolCall, options: params.options },
      {
        coreThreadId: session.coreThreadId,
        coreRunId: run.ref.runId,
        registeredToolName: nameOf(toolCall.title, toolCall.toolCallId, toolCall._meta),
      },
    )
    if (!envelope) return fail("bad-shape")

    // Core 面对的 request_id 用 `${runId}:${acpRequestId}` 复合键：Agent 的
    // requestId 跨 Run 可能重复（ApprovalAgent 固定 interrupt_id "int-1"），
    // 裸用会让上一轮迟到的 settle 命中本轮同 id 的条目，把它的应答偷走。
    // ACP 回包只带 optionId，不含 requestId，复合键不外泄。
    const pendingKey = `${run.ref.runId}:${requestId}`
    const coreEnvelope = { ...envelope, request_id: pendingKey }

    return new Promise(resolve => {
      const settle = (outcome: PermissionOutcome): void => {
        const pending = this.pendingPermissions.get(pendingKey)
        if (!pending) return
        this.pendingPermissions.delete(pendingKey)
        resolve({ outcome: { outcome: outcome.outcome === "selected" ? "selected" : "cancelled", ...(outcome.outcome === "selected" ? { optionId: outcome.optionId } : {}) } })
      }
      // acpSessionId 记进条目：cancel() 只结算本会话挂起的审批。
      this.pendingPermissions.set(pendingKey, { settle, request: coreEnvelope, abandoned: false, acpSessionId: params.sessionId })
      void this.interactionHandler!(coreEnvelope)
        .then(response => settle(mapInteractionResponse(response, coreEnvelope)))
        .catch(() => settle(CANCELLED))
    })
  }

  // ---------------- AgentGateway：监听登记 ----------------

  onProtocolError(listener: (error: Error) => void): () => void {
    this.protocolErrorListeners.add(listener)
    return () => this.protocolErrorListeners.delete(listener)
  }

  onThreadSummary(listener: (thread: ThreadSummary) => void): () => void {
    this.threadSummaryListeners.add(listener)
    return () => this.threadSummaryListeners.delete(listener)
  }

  onCodeIndexChanged(_listener: (snapshot: CodeIndexSnapshot) => void): () => void {
    // GAP-17：ACP 无代码索引事件源；登记只是为了接口完整。
    return () => {}
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  setInteractionHandler(handler: (request: InteractionRequestEnvelope) => Promise<InteractionResponse>): () => void {
    this.interactionHandler = handler
    return () => { this.interactionHandler = null }
  }

  abandonInteraction(requestId: string): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return
    pending.abandoned = true
    pending.settle(CANCELLED)
  }

  // ---------------- startRun / cancel / setApprovalMode ----------------

  startRun(input: AgentGatewayStartRunInput): InteractiveAgentRun {
    const threadId = input.threadId ?? this.uuid()
    const runId = input.runId ?? this.uuid()
    const run: RunState = {
      ref: { threadId, runId },
      translator: new RunTranslator({ runId, threadId, startedAtMs: this.now(), now: this.now, log: this.log }),
      events: new AsyncQueue<EventEnvelope>(),
      accepted: deferred<void>(),
      completion: deferred<InteractiveRunCompletion>(),
      cancelRequested: false,
      approvalRevision: 0,
      startedAtMs: this.now(),
    }
    // 拒绝是给 handle 的消费者看的；挂一个静默 catch 防止未被 await 时
    // 触发 unhandled rejection（门禁失败路径的 completion 常被丢弃）。
    run.accepted.promise.catch(() => {})
    run.completion.promise.catch(() => {})
    void this.drive(run, input)
    return {
      ref: run.ref,
      accepted: run.accepted.promise,
      events: run.events,
      completion: run.completion.promise,
      cancel: async () => (await this.cancel(threadId, runId)).cancelled,
    }
  }

  private failRun(run: RunState, error: AgentGatewayError): void {
    run.events.fail(error)
    run.accepted.reject(error)
    run.completion.reject(error)
  }

  /** 发送前门禁失败 → 与现有 IPC 客户端一致的收敛：accepted 拒绝 + events 失败 + completion 拒绝。 */
  private async drive(run: RunState, input: AgentGatewayStartRunInput): Promise<void> {
    const notSupported = (gap: string, label: string) => new AgentGatewayError("ACP_NOT_SUPPORTED", `该功能暂未通过 ACP 提供（${gap}：${label}）`)
    // ① 门禁（任一不满足 → fail 整个 run）
    if (input.input.kind !== "user") return this.failRun(run, notSupported("GAP-03", "目标闭环输入"))
    if (input.mode !== "build") return this.failRun(run, notSupported("GAP-04", "Compose 工作模式"))
    if (input.modelSelection?.primary_profile) return this.failRun(run, notSupported("GAP-08", "模型选择与切换"))
    const requestedSkill = (input.input as { requested_skill?: { raw_invocation?: string } }).requested_skill
    if (requestedSkill && !requestedSkill.raw_invocation) return this.failRun(run, notSupported("GAP-28", "武装 Skill"))
    if (input.approvalMode === "plan") return this.failRun(run, notSupported("GAP-02", "plan 审批模式"))

    // ② 取会话：已有别名 → 用；否则认领暖会话；否则 session/new。
    let session: SessionState | null = null
    if (input.threadId) {
      session = this.byCore.get(input.threadId) ?? this.byAcp.get(input.threadId) ?? null
    }
    if (!session && this.warmSession && this.warmSession.warm && !this.warmSession.coreThreadId) {
      session = this.warmSession
      session.warm = false
      session.coreThreadId = run.ref.threadId
      this.byCore.set(run.ref.threadId, session)
    }
    if (!session) {
      try {
        const created = await this.conn.newSession({ cwd: this.cwd, mcpServers: [] } as never) as { sessionId: string; modes?: { currentModeId?: string; availableModes?: Array<{ id: string }> } }
        session = {
          coreThreadId: run.ref.threadId,
          acpSessionId: created.sessionId,
          currentModeId: created.modes?.currentModeId ?? null,
          availableModeIds: created.modes?.availableModes?.map((mode: { id: string }) => mode.id) ?? null,
          run: null,
          replay: null,
          warm: false,
        }
        this.byAcp.set(created.sessionId, session)
        this.byCore.set(run.ref.threadId, session)
      } catch (error) {
        return this.failRun(run, this.mapError(error, "创建会话失败"))
      }
    }
    // ③ 会话已有活动 Run → THREAD_BUSY
    if (session.run) return this.failRun(run, new AgentGatewayError("THREAD_BUSY", "该会话已有活动 Run"))
    session.run = run

    // ④ 审批模式：Agent 声明了模式表且 desired 在其中、与当前不同才
    // 调 setSessionMode；未声明 modes 或 desired 不在表里直接发 prompt
    // （脚本化/stub Agent 不实现 set_mode，Method not found 会炸掉 Run）。
    const desired = input.approvalMode
    const canSwitch = desired != null
      && session.availableModeIds != null
      && session.availableModeIds.includes(desired)
    if (canSwitch && desired !== session.currentModeId) {
      try {
        await this.conn.setSessionMode({ sessionId: session.acpSessionId, modeId: desired } as never)
        session.currentModeId = desired
      } catch (error) {
        session.run = null
        return this.failRun(run, this.mapError(error, "切换审批模式失败"))
      }
    }
    try {
      // ⑤ 推 run.started，发 prompt
      run.events.push(run.translator.started())
      const promptText = (input.input as { message: string }).message
      const response = await this.conn.prompt({
        sessionId: session.acpSessionId,
        prompt: [{ type: "text", text: promptText }],
      } as never) as { stopReason: string; _meta?: unknown }
      // ⑦ 终态
      const terminal = run.translator.finish(response as PromptOutcome)
      run.events.push(terminal)
      run.events.end()
      run.accepted.resolve()
      run.completion.resolve(this.mapCompletion(terminal))
    } catch (error) {
      // 连接已关闭：prompt 的 Promise 被拒绝——按"失败收敛"的关闭分支处理，
      // 不等 handleClosed（两者都可能先到，靠 closedFlag 幂等）。
      if (this.closedFlag || this.isConnectionClosed(error)) {
        const closedError = error instanceof Error ? error : new Error(String(error))
        run.events.fail(closedError)
        run.completion.reject(closedError)
        return
      }
      // prompt 以 JSON-RPC 错误结束：不是异常 → run.failed 事件 + completion failed。
      if (error instanceof RequestError || (error as { code?: unknown })?.code !== undefined) {
        const requestError = error as { code: number; message: string; data?: unknown }
        const terminal = run.translator.finish({ error: requestError } as PromptOutcome)
        run.events.push(terminal)
        run.events.end()
        run.accepted.resolve()
        run.completion.resolve(this.mapCompletion(terminal))
        return
      }
      this.failRun(run, this.mapError(error, "Run 失败"))
    } finally {
      if (session.run === run) session.run = null
    }
  }

  private isConnectionClosed(error: unknown): boolean {
    return error instanceof Error && /connection closed/i.test(error.message)
  }

  private mapCompletion(terminal: EventEnvelope): InteractiveRunCompletion {
    if (terminal.type === "run.completed") return { outcome: "completed", event: terminal as Extract<EventEnvelope, { type: "run.completed" }> }
    if (terminal.type === "run.cancelled") return { outcome: "cancelled", event: terminal as Extract<EventEnvelope, { type: "run.cancelled" }> }
    return { outcome: "failed", event: terminal as Extract<EventEnvelope, { type: "run.failed" }> }
  }

  private mapError(error: unknown, fallback: string): AgentGatewayError {
    if (error instanceof AgentGatewayError) return error
    const requestError = error as { code?: unknown; data?: { code?: unknown; message?: unknown }; message?: unknown }
    const dataCode = requestError?.data?.code
    const code = typeof dataCode === "string" ? dataCode : `ACP_${requestError?.code ?? "UNKNOWN"}`
    const detail = requestError?.data?.message
    return new AgentGatewayError(code, typeof detail === "string" ? detail : (requestError?.message as string) ?? fallback)
  }

  async cancel(threadId: string, runId: string): Promise<RunCancelResult> {
    const session = this.byCore.get(threadId) ?? this.byAcp.get(threadId)
    const run = session?.run
    if (!session || !run || run.ref.runId !== runId) {
      return { run_id: runId, cancelled: false }
    }
    run.cancelRequested = true
    // 只结算本会话挂起的审批（ACP 约定取消时客户端必须应答挂起请求），
    // 其它会话的审批不受影响。
    for (const pending of this.pendingPermissions.values()) {
      if (pending.acpSessionId === session.acpSessionId) pending.settle(CANCELLED)
    }
    this.conn.cancel({ sessionId: session.acpSessionId } as never).catch(() => {})
    return { run_id: runId, cancelled: true }
  }

  async setApprovalMode(threadId: string, runId: string, approvalMode: ApprovalMode): Promise<RunSetApprovalModeResult> {
    if (approvalMode === "plan") {
      throw new AgentGatewayError("ACP_NOT_SUPPORTED", "该功能暂未通过 ACP 提供（GAP-02：plan 审批模式）")
    }
    const session = this.byCore.get(threadId) ?? this.byAcp.get(threadId)
    const run = session?.run
    if (!session || !run || run.ref.runId !== runId) {
      throw new AgentGatewayError("RUN_NOT_FOUND", "没有匹配的活动 Run")
    }
    await this.conn.setSessionMode({ sessionId: session.acpSessionId, modeId: approvalMode } as never)
    session.currentModeId = approvalMode
    run.approvalRevision += 1
    return { thread_id: threadId, run_id: runId, approval_mode: approvalMode, revision: run.approvalRevision }
  }

  // ---------------- listThreads / openThread ----------------

  async listThreads(): Promise<ThreadsListResult> {
    if (!this.boot.canListSessions) {
      throw new AgentGatewayError("ACP_NOT_SUPPORTED", "该功能暂未通过 ACP 提供（GAP-36：会话列表）")
    }
    let result: { sessions?: Array<{ sessionId: string; title?: string | null; updatedAt?: string }> }
    try {
      result = await this.conn.listSessions({ cwd: this.cwd } as never) as typeof result
    } catch (error) {
      throw this.mapError(error, "列出会话失败")
    }
    const threads: ThreadSummary[] = (result.sessions ?? []).map(info => {
      const session = this.byAcp.get(info.sessionId)
      const coreId = session?.coreThreadId ?? info.sessionId
      const updatedAt = typeof info.updatedAt === "string" ? Date.parse(info.updatedAt) : NaN
      const summary: ThreadSummary = {
        thread_id: coreId,
        title: info.title ?? null,
        updated_at_ms: Number.isNaN(updatedAt) ? this.now() : updatedAt,
        created_at_ms: Number.isNaN(updatedAt) ? this.now() : updatedAt,
        first_message: info.title ?? "",
        latest_message: "",
        message_count: 0,
      }
      this.summaries.set(coreId, summary)
      return summary
    })
    return { threads } as ThreadsListResult
  }

  async openThread(threadId: string): Promise<ThreadsOpenResult> {
    const sessionId = this.byCore.get(threadId)?.acpSessionId ?? threadId
    let session = this.byAcp.get(sessionId)
    let fresh = false
    if (!session) {
      session = { coreThreadId: threadId, acpSessionId: sessionId, currentModeId: null, availableModeIds: null, run: null, replay: null, warm: false }
      this.byAcp.set(sessionId, session)
      this.byCore.set(threadId, session)
      fresh = true
    }
    if (session.run || session.replay) {
      throw new AgentGatewayError("THREAD_BUSY", "该会话正忙")
    }
    session.replay = new ReplayBuffer()
    try {
      const response = await this.conn.loadSession({ sessionId, cwd: this.cwd, mcpServers: [] } as never) as {
        modes?: { currentModeId?: string }
      }
      if (response?.modes?.currentModeId) session.currentModeId = response.modes.currentModeId
    } catch (error) {
      if (fresh) {
        this.byAcp.delete(sessionId)
        this.byCore.delete(threadId)
      }
      session.replay = null
      throw this.mapError(error, "打开会话失败")
    }
    const replayed = session.replay
    session.replay = null
    const now = this.now()
    return {
      thread: this.summaries.get(session.coreThreadId ?? sessionId) ?? {
        thread_id: session.coreThreadId ?? sessionId,
        title: null,
        created_at_ms: now,
        updated_at_ms: now,
        first_message: "",
        latest_message: "",
        message_count: 0,
      },
      messages: replayed.messages,
      plan: { has_plan: false, plan_markdown: "", plan_virtual_path: "/.harness/plan.md", plan_display_path: "" },
      thread_mode: null,
      goal: null,
      goal_pending: null,
      goal_activities: [],
    } as ThreadsOpenResult
  }

  // ---------------- 27 个不支持方法 ----------------

  async compactContext(): Promise<never> { throw notSupported("compactContext") }
  async configDetails(): Promise<never> { throw notSupported("configDetails") }
  async previewConfig(): Promise<never> { throw notSupported("previewConfig") }
  async commitConfig(): Promise<never> { throw notSupported("commitConfig") }
  async setThreadTitle(): Promise<never> { throw notSupported("setThreadTitle") }
  async inspectGoal(): Promise<never> { throw notSupported("inspectGoal") }
  async requestGoal(): Promise<never> { throw notSupported("requestGoal") }
  async mutateGoal(): Promise<never> { throw notSupported("mutateGoal") }
  async listTurns(): Promise<never> { throw notSupported("listTurns") }
  async undo(): Promise<never> { throw notSupported("undo") }
  async redo(): Promise<never> { throw notSupported("redo") }
  async mcpStatus(): Promise<never> { throw notSupported("mcpStatus") }
  async mcpAdd(): Promise<never> { throw notSupported("mcpAdd") }
  async mcpRemove(): Promise<never> { throw notSupported("mcpRemove") }
  async codeIndexStatus(): Promise<never> { throw notSupported("codeIndexStatus") }
  async codeIndexApply(): Promise<never> { throw notSupported("codeIndexApply") }
  async listModels(): Promise<never> { throw notSupported("listModels") }
  async listSkills(): Promise<never> { throw notSupported("listSkills") }
  async setSkillEnabled(): Promise<never> { throw notSupported("setSkillEnabled") }
  async listAgents(): Promise<never> { throw notSupported("listAgents") }
  async listTeams(): Promise<never> { throw notSupported("listTeams") }
  async inspectTeam(): Promise<never> { throw notSupported("inspectTeam") }
  async generateTeam(): Promise<never> { throw notSupported("generateTeam") }
  async runTeam(): Promise<never> { throw notSupported("runTeam") }
  async cancelTeam(): Promise<never> { throw notSupported("cancelTeam") }
  async abandonCompose(): Promise<never> { throw notSupported("abandonCompose") }
  async sideQuestion(): Promise<never> { throw notSupported("sideQuestion") }

  // ---------------- 关闭 ----------------

  private handleClosed(info: WsCloseInfo): void {
    if (this.closedFlag) return
    this.closedFlag = true
    for (const pending of this.pendingPermissions.values()) pending.settle(CANCELLED)
    for (const session of this.byAcp.values()) {
      if (session.run) {
        const error = new Error(describeClose(info))
        session.run.events.fail(error)
        session.run.accepted.reject(error)
        session.run.completion.reject(error)
        session.run = null
      }
      session.replay = null
    }
    const error = new Error(describeClose(info))
    for (const listener of this.closeListeners) listener(error)
  }

  /** 运行时合成（供 S3-C 的 session.ts 使用）。 */
  get runtime() {
    return createAcpRuntime(this.boot)
  }
}

/** 关闭文案（设计 §4.8）。 */
export function describeClose(info: WsCloseInfo): string {
  if (info.bridgeExit) {
    const tail = info.bridgeExit.stderrTail ? `。最后输出：${info.bridgeExit.stderrTail}` : ""
    return `本地 Agent 进程已退出（退出码 ${info.bridgeExit.code ?? "未知"}）${tail}`
  }
  if (info.code === 1008 || info.code === 1009 || info.code === 1003 || info.code === 1007) {
    return `与本地桥的连接因协议问题被关闭（${info.reason}）`
  }
  if (info.reason === "server-shutdown") {
    return "harness web 已退出，请重新运行 harness web"
  }
  return "与本地 Agent 的连接已断开，请刷新页面重试"
}
