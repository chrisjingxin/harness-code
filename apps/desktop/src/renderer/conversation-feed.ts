/**
 * 当前会话的读取流程：确认权限 → 固定上界补历史 → 订阅 → 连续应用 → 下一次读取确认。
 * 页面只保存已经应用的投影；交付中断时停止旧订阅并从该位置重新补历史。
 */
import type { ConversationConnection, ConversationReadHost, ConversationSummary } from "@workbench/contracts"
import type { ConversationScope } from "@workbench/ui"
import { applyHistoryPage, emptyHistory } from "./conversation-history.js"
import type { HistoryProjection } from "./conversation-history.js"

export type HistoryView =
  | { phase: "empty" }
  | { phase: "loading"; pages: number }
  | { phase: "error"; message: string }
  | { phase: "ready"; conversation: ConversationSummary; projection: HistoryProjection; connection: ConversationConnection }

class HistoryFailure extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
class DeliveryInterrupted extends Error {
  constructor(readonly cursorAhead = false) { super("实时交付需要补读") }
}

export function conversationScopeKey(scope: ConversationScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId])
}

/** 只对本次会话有效，stop 后所有迟到结果都被丢弃。 */
export class ConversationFeed {
  #active = true
  #subscription: string | null = null
  #projection: HistoryProjection | undefined
  #conversation: ConversationSummary | undefined
  readonly #key: string

  constructor(
    private readonly host: ConversationReadHost,
    private readonly scope: ConversationScope,
    private readonly cache: Map<string, HistoryProjection>,
    private readonly changed: (view: HistoryView) => void,
    private readonly resetSeenRevision: (scope: ConversationScope) => void,
  ) { this.#key = conversationScopeKey(scope) }

  start(): void { void this.#run() }

  stop(): void {
    this.#active = false
    const id = this.#subscription
    this.#subscription = null
    if (id) void this.host.unsubscribeConversation(id).catch(() => {})
  }

  #ready(connection: ConversationConnection): void {
    if (this.#active && this.#conversation && this.#projection) {
      this.changed({ phase: "ready", conversation: this.#conversation, projection: this.#projection, connection })
    }
  }

  async #history(showLoading: boolean): Promise<void> {
    let projection = this.#projection ?? this.cache.get(this.#key)
    let incremental = Boolean(projection)
    let rebuilt = !incremental
    let throughSequence: string | undefined
    let pages = 0
    projection ??= emptyHistory()
    while (this.#active) {
      const page = await this.host.readHistory(this.scope.workspaceId, this.scope.conversationId, {
        afterSequence: projection.cursor,
        ...(throughSequence === undefined ? {} : { throughSequence }),
        limit: 100,
      })
      if (!this.#active) return
      if (!page.ok) {
        if (page.error.code === "CURSOR_AHEAD" && !rebuilt) {
          this.cache.delete(this.#key); this.#projection = undefined
          projection = emptyHistory(); incremental = false; rebuilt = true; throughSequence = undefined; pages = 0
          this.changed({ phase: "loading", pages: 0 })
          continue
        }
        throw new HistoryFailure(page.error.code, page.error.message)
      }
      throughSequence ??= page.value.throughSequence
      try {
        projection = applyHistoryPage(projection, page.value, this.scope.workspaceId, this.scope.conversationId, throughSequence, incremental)
      } catch (error) {
        if (rebuilt) throw error
        // 旧投影无法核对时不继续展示，从头重建一次；同一问题再次出现则报告错误。
        this.cache.delete(this.#key); this.#projection = undefined
        projection = emptyHistory(); incremental = false; rebuilt = true; throughSequence = undefined; pages = 0
        this.changed({ phase: "loading", pages: 0 })
        continue
      }
      pages++
      if (!page.value.hasMore) break
      if (showLoading || rebuilt) this.changed({ phase: "loading", pages })
    }
    if (!this.#active) return
    if (!incremental) this.resetSeenRevision(this.scope)
    this.#projection = projection
    this.cache.set(this.#key, projection)
  }

  async #readBatch(id: string, cursor: string) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.host.readConversationEvents(id, cursor),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryInterrupted()), 15_000) }),
      ])
    } finally { clearTimeout(timer) }
  }

  async #consume(): Promise<void> {
    const opened = await this.host.subscribeConversation(this.scope.workspaceId, this.scope.conversationId, this.#projection!.cursor)
    if (!opened.ok) throw new HistoryFailure(opened.error.code, opened.error.message)
    const id = opened.value.subscriptionId
    if (!this.#active) { void this.host.unsubscribeConversation(id).catch(() => {}); return }
    this.#subscription = id
    try {
      while (this.#active) {
        const result = await this.#readBatch(id, this.#projection!.cursor)
        if (!this.#active) return
        if (!result.ok) {
          if (["AUTHENTICATION_REQUIRED", "RESOURCE_NOT_FOUND", "REQUEST_SOURCE_REJECTED", "PROTOCOL_VERSION_UNSUPPORTED"].includes(result.error.code)) {
            throw new HistoryFailure(result.error.code, result.error.message)
          }
          throw new DeliveryInterrupted(result.error.code === "CURSOR_AHEAD")
        }
        const batch = result.value
        if (batch.subscriptionId !== id || batch.workspaceId !== this.scope.workspaceId || batch.conversationId !== this.scope.conversationId) throw new DeliveryInterrupted()
        if (batch.connection === "recovering") throw new DeliveryInterrupted(batch.recoveryReason === "cursorAhead" || batch.recoveryReason === "projectionUnverified")
        if (batch.events.length) {
          const through = batch.events[batch.events.length - 1]!.sequence
          try {
            this.#projection = applyHistoryPage(this.#projection!, {
              conversationId: this.scope.conversationId, throughSequence: through,
              events: batch.events, nextAfterSequence: through, hasMore: false,
            }, this.scope.workspaceId, this.scope.conversationId, through, true)
          } catch { throw new DeliveryInterrupted() }
          // 应用成功才改变本地游标；下一轮读取携带它以确认整批。
          this.cache.set(this.#key, this.#projection)
        }
        this.#ready(batch.connection)
      }
    } finally {
      if (this.#subscription === id) this.#subscription = null
      await this.host.unsubscribeConversation(id).catch(() => {})
    }
  }

  async #run(): Promise<void> {
    this.changed({ phase: "loading", pages: 0 })
    try {
      const detail = await this.host.getConversation(this.scope.workspaceId, this.scope.conversationId)
      if (!this.#active) return
      if (!detail.ok) throw new HistoryFailure(detail.error.code, detail.error.message)
      if (detail.value.conversation.workspaceId !== this.scope.workspaceId || detail.value.conversation.conversationId !== this.scope.conversationId) throw new Error("会话范围不一致")
      this.#conversation = detail.value.conversation
      await this.#history(true)
      if (!this.#active) return
      this.#ready("connecting")
      while (this.#active) {
        try { await this.#consume() }
        catch (error) {
          if (!this.#active) return
          if (error instanceof HistoryFailure && ["AUTHENTICATION_REQUIRED", "RESOURCE_NOT_FOUND", "REQUEST_SOURCE_REJECTED", "PROTOCOL_VERSION_UNSUPPORTED"].includes(error.code)) throw error
          if (error instanceof DeliveryInterrupted && error.cursorAhead) {
            this.cache.delete(this.#key); this.#projection = undefined
            this.changed({ phase: "loading", pages: 0 })
          } else this.#ready("recovering")
          // 受控间隔避免服务持续返回异常时反复创建连接。
          await new Promise(resolve => setTimeout(resolve, 500))
          if (!this.#active) return
          await this.#history(false)
          if (!this.#active) return
          this.#ready("connecting")
        }
      }
    } catch (error) {
      if (!this.#active) return
      if (error instanceof HistoryFailure && ["AUTHENTICATION_REQUIRED", "RESOURCE_NOT_FOUND", "REQUEST_SOURCE_REJECTED"].includes(error.code)) this.cache.delete(this.#key)
      this.changed({ phase: "error", message: error instanceof HistoryFailure ? error.message : "历史数据无法连续读取，请重试。" })
    }
  }
}
