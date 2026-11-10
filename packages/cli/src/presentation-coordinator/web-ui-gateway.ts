/**
 * WebUiGateway：把共享 InteractiveController 与 WorkspaceExplorer 的 snapshot
 * 发布为 UI 契约状态帧，并把 Browser 提交的 intent 按 domain 送入对应领域、
 * 按 requestId 回传 outcome。
 *
 * 本模块是渲染 channel 的唯一写者（handoff.state 也经它转发），保证服务器到
 * Browser 的消息顺序单一。Coordinator 负责生命周期与输入租约，本模块只做视图
 * 序列化、revision 门禁与 intent 受理。
 */

import type { TraceLiveSource } from "../trace-log/runtime"
import type { TraceSpanEvent } from "./contracts/trace"
import { parseServerFrame } from "./contracts/validation"
import { TraceHistorySession } from "./trace-history-session"
import type { TraceHistorySource } from "../trace-log/history"
import {
  selectCommandView,
  selectConversationView,
  selectInteractionView,
  selectNavigationView,
  selectRuntimeView,
  selectWorkItemView,
} from "../interactive/selectors"
import type { DiagnosticLog } from "../diagnostic-log/runtime"
import type { InteractiveController, InteractiveIntent, InteractiveSnapshot, IntentOutcome } from "../interactive/types"
import type { GatewayChannel, PresentationCoordinator } from "./coordinator"
import { parseClientFrame, type WebUiClientMessage, type WebUiPatch, type WebUiServerMessage, type WebUiState } from "./contracts"
import { isWebActive, type PresentationState } from "./state"
import type { WorkspaceExplorer, WorkspaceOutcome, WorkspaceSnapshot } from "../workspace/types"

const OUTCOME_CACHE_LIMIT = 256
const BASE_REVISION = 1

/** replace 之后每个补丁递增的 revision 基准；连接重建时从 replace 重新计数。 */

export type WebUiGatewayOptions = {
  coordinator: PresentationCoordinator
  controller: InteractiveController
  workspaceExplorer: WorkspaceExplorer
  traceHistory?: TraceHistorySource
  traceLive?: TraceLiveSource
  diagnostics?: DiagnosticLog
}

export interface WebUiGateway {
  /** 接管一个已完成认证的渲染 channel：发送首帧 replace 与 handoff.state，并开始消费。 */
  connectRenderer(channel: GatewayChannel, reconnectToken: string): void
  close(): Promise<void>
}

type CachedOutcome = IntentOutcome | WorkspaceOutcome

class WebUiGatewayImpl implements WebUiGateway {
  private readonly coordinator: PresentationCoordinator
  private readonly controller: InteractiveController
  private readonly workspaceExplorer: WorkspaceExplorer
  private readonly diagnostics: DiagnosticLog | undefined
  private readonly unsubscribeController: () => void
  private readonly unsubscribeCoordinator: () => void
  private readonly unsubscribeExplorer: () => void

  private readonly traceLive: TraceLiveSource | undefined
  private readonly unsubscribeTrace: () => void
  private traceRevision = 0
  private traceSending = Promise.resolve()
  private readonly traceHistory: TraceHistorySource | undefined
  private traceSession: TraceHistorySession | null = null
  private channel: GatewayChannel | null = null
  private lastState: WebUiState | null = null
  private revision = 0
  private readonly inFlight = new Map<string, Promise<IntentOutcome>>()
  private readonly outcomeCache = new Map<string, CachedOutcome>()

  constructor(options: WebUiGatewayOptions) {
    this.traceLive = options.traceLive
    this.unsubscribeTrace = options.traceLive?.subscribe(span => this.onTraceSpan(span)) ?? (() => {})
    this.traceHistory = options.traceHistory
    this.coordinator = options.coordinator
    this.controller = options.controller
    this.workspaceExplorer = options.workspaceExplorer
    this.diagnostics = options.diagnostics
    this.unsubscribeController = this.controller.subscribe(() => this.onControllerPublish())
    this.unsubscribeCoordinator = this.coordinator.subscribe(state => this.onCoordinatorPublish(state))
    this.unsubscribeExplorer = this.workspaceExplorer.subscribe(() => this.onExplorerPublish())
  }

  connectRenderer(channel: GatewayChannel, reconnectToken: string): void {
    this.traceSession?.close()
    this.channel = channel
    this.traceSession = new TraceHistorySession(this.traceHistory, message => channel.send(message), () => this.channel === channel && isWebActive(this.coordinator.getSnapshot()))
    this.revision = BASE_REVISION
    this.lastState = buildWebUiState(this.controller.getSnapshot(), this.workspaceExplorer.getSnapshot())
    this.diagnostics?.info("presentation.gateway.connected", {})
    void this.send({ type: "handoff.token", token: reconnectToken })
    void this.send({ type: "state.replace", revision: this.revision, state: this.lastState })
    void this.send({ type: "handoff.state", state: this.coordinator.getSnapshot() })
    this.traceRevision = 0
    this.traceSending = Promise.resolve()
    for (const span of this.traceLive?.snapshot() ?? []) this.onTraceSpan(span)
    void this.consume(channel)
  }

  async close(): Promise<void> {
    this.traceSession?.close()
    this.unsubscribeTrace()
    this.unsubscribeController()
    this.unsubscribeCoordinator()
    this.unsubscribeExplorer()
    this.channel = null
    this.outcomeCache.clear()
  }

  /** 消费渲染 channel 的全部客户端帧；畸形帧由 Coordinator fail-closed 收敛。 */
  private async consume(channel: GatewayChannel): Promise<void> {
    try {
      for await (const raw of channel.messages) {
        if (this.channel !== channel) return
        const message = parseClientFrame(raw)
        if (message === undefined) {
          this.coordinator.notifyInvalidMessage()
          return
        }
        await this.handleClientMessage(message)
      }
    } catch {
      // channel fail/close 与 for await 结束走同一个断开收敛路径。
    }
    if (this.channel === channel) {
      this.traceSession?.close()
      this.channel = null
      this.coordinator.notifyRendererDisconnected("browser-close")
    }
  }

  private async handleClientMessage(message: WebUiClientMessage): Promise<void> {
    switch (message.type) {
      case "trace.load":
        void this.traceSession?.load(message).catch(() => {})
        return
      case "handoff.ready":
        this.coordinator.requestReady()
        return
      case "handoff.return":
        if (this.controller.getSnapshot().git.busy) return
        this.coordinator.requestReturn()
        return
      case "handoff.exit":
        if (this.controller.getSnapshot().git.busy) return
        this.coordinator.requestExit()
        return
      case "interactive.intent":
        // Git 写入可持续数秒；继续消费后续帧，才能在到达时拒绝写入期间的新任务。
        if (message.intent.type === "git.commit" || message.intent.type === "git.push") {
          void this.handleIntent(message).catch(() => {})
          return
        }
        await this.handleIntent(message)
        return
      case "workspace.intent":
        await this.handleWorkspaceIntent(message)
        return
    }
  }

  private async handleIntent(message: Extract<WebUiClientMessage, { type: "interactive.intent" }>): Promise<void> {
    const { requestId, revision, intent } = message
    // 非 web-active：不发 outcome，只推当前 handoff.state；Browser 据此保留草稿并进入只读等待。
    if (!isWebActive(this.coordinator.getSnapshot())) {
      await this.send({ type: "handoff.state", state: this.coordinator.getSnapshot() })
      return
    }
    const cached = this.outcomeCache.get(`interactive:${requestId}`)
    if (cached !== undefined) {
      await this.sendOutcome(requestId, "interactive", cached as IntentOutcome)
      return
    }
    const inFlight = this.inFlight.get(requestId)
    if (inFlight) {
      await this.sendOutcome(requestId,"interactive",await inFlight)
      return
    }
    if ((intent.type === "git.commit" || intent.type === "git.push") && revision !== this.revision) {
      const outcome: IntentOutcome = {status:"rejected",code:"invalid-argument",message:"界面状态已更新，请检查并重新提交。"}
      await this.sendOutcome(requestId,"interactive",outcome)
      return
    }
    // revision 门禁：Browser 视图必须已覆盖最近一次 replace（>=1），且不超前于网关发布序列。
    if (revision < BASE_REVISION || revision > this.revision) {
      await this.sendOutcome(requestId, "interactive", {
        status: "rejected",
        code: "invalid-argument",
        message: "Invalid revision; resync from state.replace",
      })
      return
    }
    const pending = (async (): Promise<IntentOutcome> => {
      try { return await this.fulfillSideQuestion(await this.controller.dispatch(intent)) }
      catch { return {status:"rejected",code:"agent-error",message:"操作失败，请刷新后检查当前状态。"} }
    })()
    this.inFlight.set(requestId,pending)
    const outcome = await pending
    this.inFlight.delete(requestId)
    this.cacheOutcome(requestId, "interactive", outcome)
    await this.sendOutcome(requestId, "interactive", outcome)
  }

  /** Browser 不能直连 sidecar；在 CLI 侧补全 /btw 回答后再回传 outcome。 */
  private async fulfillSideQuestion(outcome: IntentOutcome): Promise<IntentOutcome> {
    if (outcome.status !== "accepted" || !outcome.effects?.length) return outcome
    const gateway = this.controller.getGateway?.()
    if (!gateway) return outcome
    const effects = []
    for (const effect of outcome.effects) {
      if (effect.type !== "side-question" || effect.replyText !== undefined || effect.error !== undefined) {
        effects.push(effect)
        continue
      }
      try {
        const result = await gateway.sideQuestion({
          thread_id: effect.threadId ?? "default",
          question: effect.question,
        })
        effects.push({
          ...effect,
          replyText: result.reply_text,
          modelProfileId: result.model_profile_id,
        })
      } catch (error) {
        effects.push({
          ...effect,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { ...outcome, effects }
  }

  /** workspace intent 受理：与 interactive 共用 web-active 检查、revision 门禁与重放去重。 */
  private async handleWorkspaceIntent(message: Extract<WebUiClientMessage, { type: "workspace.intent" }>): Promise<void> {
    const { requestId, revision, intent } = message
    if (!isWebActive(this.coordinator.getSnapshot())) {
      await this.send({ type: "handoff.state", state: this.coordinator.getSnapshot() })
      return
    }
    if (revision < BASE_REVISION || revision > this.revision) {
      await this.sendOutcome(requestId, "workspace", {
        status: "rejected",
        code: "invalid-argument",
        message: "Invalid revision; resync from state.replace",
      })
      return
    }
    const cached = this.outcomeCache.get(`workspace:${requestId}`)
    if (cached !== undefined) {
      await this.sendOutcome(requestId, "workspace", cached as WorkspaceOutcome)
      return
    }
    let outcome: WorkspaceOutcome
    try {
      outcome = await this.workspaceExplorer.dispatch(intent)
    } catch {
      outcome = { status: "rejected", code: "io-error", message: "工作区操作失败" }
    }
    this.cacheOutcome(requestId, "workspace", outcome)
    await this.sendOutcome(requestId, "workspace", outcome)
  }

  /** Controller snapshot 发布 → 分片 diff → state.patch（revision 单调）。 */
  private onControllerPublish(): void {
    const next = buildWebUiState(this.controller.getSnapshot(), this.workspaceExplorer.getSnapshot())
    const previous = this.lastState ?? next
    this.lastState = next
    if (this.channel === null) return
    const changed: Record<string, unknown> = {}
    if (!sameSlice(previous.conversation, next.conversation)) changed.conversation = next.conversation
    if (!sameSlice(previous.interaction, next.interaction)) changed.interaction = next.interaction
    if (!sameSlice(previous.navigation, next.navigation)) changed.navigation = next.navigation
    if (!sameSlice(previous.command, next.command)) changed.command = next.command
    if (!sameSlice(previous.runtime, next.runtime)) changed.runtime = next.runtime
    if (!sameSlice(previous.workItem, next.workItem)) changed.workItem = next.workItem
    this.revision += 1
    void this.send({ type: "state.patch", revision: this.revision, patch: changed as unknown as WebUiPatch })
  }

  /** Explorer snapshot 发布 → workspace 两分片 diff → state.patch（revision 单调）。 */
  private onExplorerPublish(): void {
    const next = buildWebUiState(this.controller.getSnapshot(), this.workspaceExplorer.getSnapshot())
    const previous = this.lastState ?? next
    this.lastState = next
    if (this.channel === null) return
    const changed: Record<string, unknown> = {}
    if (!sameSlice(previous.workspaceTree, next.workspaceTree)) changed.workspaceTree = next.workspaceTree
    if (!sameSlice(previous.workspacePreview, next.workspacePreview)) changed.workspacePreview = next.workspacePreview
    if (Object.keys(changed).length === 0) return
    this.revision += 1
    void this.send({ type: "state.patch", revision: this.revision, patch: changed as unknown as WebUiPatch })
  }

  /** Coordinator 状态变化 → 转发 handoff.state；会话结束时关闭渲染 channel。 */
  private onCoordinatorPublish(state: PresentationState): void {
    if (this.channel === null) return
    void this.send({ type: "handoff.state", state })
    if (state.phase === "returning-tui" || state.phase === "tui-active") {
      this.traceSession?.close()
      const channel = this.channel
      this.channel = null
      void channel.close(1000, "handoff-converged")
    }
  }

  private async sendOutcome(requestId: string, domain: "interactive", outcome: IntentOutcome): Promise<void>
  private async sendOutcome(requestId: string, domain: "workspace", outcome: WorkspaceOutcome): Promise<void>
  private async sendOutcome(requestId: string, domain: "interactive" | "workspace", outcome: CachedOutcome): Promise<void> {
    if (domain === "interactive") {
      await this.send({ type: "intent.outcome", requestId, domain, outcome: outcome as IntentOutcome })
      return
    }
    await this.send({ type: "intent.outcome", requestId, domain, outcome: outcome as WorkspaceOutcome })
  }

  /** 单连接顺序发布；旧连接队列在执行时检查身份，不借当前 send 路由到新连接。 */
  private onTraceSpan(span: TraceSpanEvent): void {
    const channel = this.channel
    if (!channel) return
    const message = { type: "trace.live" as const, revision: ++this.traceRevision, span }
    if (!parseServerFrame(JSON.stringify(message))) {
      this.diagnostics?.warn("logging.dropped", { debug_count: 0, info_count: 0, warn_count: 0, error_count: 0, invalid_count: 1, oversize_count: 0, reason: "contract_violation" })
      return
    }
    this.traceSending = this.traceSending.then(async () => {
      if (this.channel === channel) await channel.send(message)
    }).catch(() => {})
  }

  private async send(message: WebUiServerMessage): Promise<void> {
    const channel = this.channel
    if (channel === null) return
    await channel.send(message)
  }

  private cacheOutcome(requestId: string, domain: "interactive" | "workspace", outcome: CachedOutcome): void {
    // 缓存按 domain 分键：跨域同 requestId 永不互相重放（类型形状不同）。
    this.outcomeCache.set(`${domain}:${requestId}`, outcome)
    if (this.outcomeCache.size > OUTCOME_CACHE_LIMIT) {
      const oldest = this.outcomeCache.keys().next()
      if (!oldest.done) this.outcomeCache.delete(oldest.value)
    }
  }
}

/** 创建 WebUiGateway 的唯一工厂。 */
export function createWebUiGateway(options: WebUiGatewayOptions): WebUiGateway {
  return new WebUiGatewayImpl(options)
}

/** 把 Controller 与 Explorer 快照收敛为八个 Selector 分片的完整视图。 */
export function buildWebUiState(interactive: InteractiveSnapshot, workspace: WorkspaceSnapshot): WebUiState {
  return {
    conversation: selectConversationView(interactive),
    interaction: selectInteractionView(interactive),
    navigation: selectNavigationView(interactive),
    command: selectCommandView(interactive),
    runtime: selectRuntimeView(interactive),
    workItem: selectWorkItemView(interactive),
    workspaceTree: workspace.tree,
    workspacePreview: workspace.preview,
  }
}

/** 分片结构性比较：Selector 输出均为纯 JSON，序列化比较即可。 */
function sameSlice(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous) === JSON.stringify(next)
}
