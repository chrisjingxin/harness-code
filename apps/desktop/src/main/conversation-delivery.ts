/**
 * 一个窗口只保留当前会话的实时交付。
 * SSE 接收 → 有界队列 → 页面按序应用 → 下一次读取确认 → 释放事件。
 * 网络收到的位置和页面确认的位置分别保存；队列无法继续交付时，页面从自己的位置补历史。
 */
import { randomUUID } from "node:crypto"
import type {
  CollaborationError, CollaborationResult, ConversationConnection, ConversationEvent,
  ConversationEventBatch, ConversationSubscription,
} from "@workbench/contracts"
import type { CollaborationClient } from "./collaboration-client.js"

type Failure = (code: CollaborationError["code"], message: string) => { ok: false; error: CollaborationError }
type Item = { event: ConversationEvent; bytes: number }
type Waiter = { resolve(result: CollaborationResult<ConversationEventBatch>): void; timer: ReturnType<typeof setTimeout> }
type Subscription = {
  id: string
  workspaceId: string
  conversationId: string
  valid(): boolean
  connection: ConversationConnection
  recoveryReason?: ConversationEventBatch["recoveryReason"]
  statusRevision: number
  deliveredStatusRevision: number
  received: string
  acknowledged: string
  delivered: string
  queue: Item[]
  bytes: number
  waiter?: Waiter
  error?: CollaborationError
  stream?: { close(): void }
  closed: boolean
}

const MAX_EVENTS = 256
const MAX_BYTES = 1_048_576
const BATCH_EVENTS = 50
const BATCH_BYTES = 262_144
const WAIT_MS = 10_000

/** 管理范围绑定和内存限额，不持久保存历史或消费位置。 */
export class ConversationDelivery {
  #active: Subscription | null = null

  constructor(
    private readonly client: CollaborationClient,
    private readonly failure: Failure,
    private readonly authenticationExpired: () => void,
  ) {}

  open(workspaceId: string, conversationId: string, afterSequence: string, valid: () => boolean): CollaborationResult<ConversationSubscription> {
    this.closeAll()
    const subscription: Subscription = {
      id: randomUUID(), workspaceId, conversationId, valid, connection: "connecting",
      statusRevision: 1, deliveredStatusRevision: 0,
      received: afterSequence, acknowledged: afterSequence, delivered: afterSequence,
      queue: [], bytes: 0, closed: false,
    }
    this.#active = subscription
    subscription.stream = this.client.subscribeConversation(workspaceId, conversationId, afterSequence,
      event => this.#received(subscription, event),
      problem => this.#problem(subscription, problem.code, problem.rebuildProjection),
      status => {
        if (status !== "stopped") this.#setConnection(subscription, status)
      })
    return { ok: true, value: { subscriptionId: subscription.id } }
  }

  #live(subscription: Subscription): boolean {
    return this.#active === subscription && !subscription.closed && subscription.valid()
  }

  #setConnection(subscription: Subscription, connection: ConversationConnection): void {
    if (!this.#live(subscription) || subscription.connection === "recovering" || subscription.connection === connection) return
    subscription.connection = connection
    subscription.statusRevision++
    this.#wake(subscription)
  }

  #recover(subscription: Subscription, reason: NonNullable<ConversationEventBatch["recoveryReason"]>): void {
    if (!this.#live(subscription) || subscription.connection === "recovering") return
    subscription.connection = "recovering"
    subscription.recoveryReason = reason
    subscription.statusRevision++
    // 不能交付的事件仍在云端；关闭网络流，等待页面从已应用位置补读。
    subscription.stream?.close()
    this.#wake(subscription)
  }

  #received(subscription: Subscription, event: ConversationEvent): void {
    if (!this.#live(subscription) || subscription.connection === "recovering") return
    if (event.workspaceId !== subscription.workspaceId || event.conversationId !== subscription.conversationId
      || BigInt(event.sequence) !== BigInt(subscription.received) + 1n) {
      this.#recover(subscription, "deliveryInterrupted")
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (subscription.queue.length >= MAX_EVENTS || subscription.bytes + bytes > MAX_BYTES) {
      this.#recover(subscription, "deliveryInterrupted")
      return
    }
    subscription.queue.push({ event, bytes })
    subscription.bytes += bytes
    subscription.received = event.sequence
    this.#wake(subscription)
  }

  #problem(subscription: Subscription, code: string, rebuildProjection = false): void {
    if (!this.#live(subscription)) return
    if (code === "NETWORK_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE") {
      this.#setConnection(subscription, "reconnecting")
      return
    }
    if (code === "CURSOR_AHEAD" || code === "INVALID_SERVER_RESPONSE") {
      this.#recover(subscription, code === "CURSOR_AHEAD" ? "cursorAhead" : rebuildProjection ? "projectionUnverified" : "deliveryInterrupted")
      return
    }
    const safeCode: CollaborationError["code"] = code === "AUTHENTICATION_REQUIRED" || code === "RESOURCE_NOT_FOUND"
      || code === "REQUEST_SOURCE_REJECTED" || code === "PROTOCOL_VERSION_UNSUPPORTED" || code === "INVALID_REQUEST"
      ? code : "INTERNAL_ERROR"
    subscription.error = this.failure(safeCode, safeCode === "AUTHENTICATION_REQUIRED" ? "登录已失效，请重新登录。"
      : safeCode === "RESOURCE_NOT_FOUND" || safeCode === "REQUEST_SOURCE_REJECTED" ? "当前账号无法读取此会话。" : "实时连接无法继续，请重试。").error
    subscription.queue = []; subscription.bytes = 0
    this.#wake(subscription)
    if (safeCode === "AUTHENTICATION_REQUIRED") this.authenticationExpired()
  }

  /** 只接受已交付范围内的确认；尚未确认的批次仍计入队列限额。 */
  async read(id: string, afterSequence: string): Promise<CollaborationResult<ConversationEventBatch>> {
    const subscription = this.#active
    if (!subscription || subscription.id !== id || !this.#live(subscription)) return this.failure("AUTHENTICATION_REQUIRED", "订阅已结束。")
    if (subscription.waiter) return this.failure("INVALID_REQUEST", "当前订阅已有等待读取。")
    const acknowledged = BigInt(afterSequence)
    if (acknowledged < BigInt(subscription.acknowledged) || acknowledged > BigInt(subscription.delivered)) {
      return this.failure("INVALID_REQUEST", "只能确认已交付的事件。")
    }
    while (subscription.queue.length && BigInt(subscription.queue[0]!.event.sequence) <= acknowledged) {
      subscription.bytes -= subscription.queue.shift()!.bytes
    }
    subscription.acknowledged = afterSequence
    if (subscription.error || subscription.queue.length || subscription.statusRevision !== subscription.deliveredStatusRevision) {
      return this.#batch(subscription)
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        subscription.waiter = undefined
        resolve(this.#batch(subscription))
      }, WAIT_MS)
      subscription.waiter = { resolve, timer }
    })
  }

  #batch(subscription: Subscription): CollaborationResult<ConversationEventBatch> {
    if (!this.#live(subscription)) return this.failure("AUTHENTICATION_REQUIRED", "订阅已结束。")
    if (subscription.error) return { ok: false, error: subscription.error }
    const events: ConversationEvent[] = []
    let bytes = 0
    if (subscription.connection !== "recovering") {
      for (const item of subscription.queue) {
        if (events.length >= BATCH_EVENTS || (events.length > 0 && bytes + item.bytes > BATCH_BYTES)) break
        events.push(item.event); bytes += item.bytes
      }
    }
    if (events.length) subscription.delivered = events[events.length - 1]!.sequence
    subscription.deliveredStatusRevision = subscription.statusRevision
    return { ok: true, value: {
      subscriptionId: subscription.id, workspaceId: subscription.workspaceId, conversationId: subscription.conversationId,
      connection: subscription.connection, events,
      ...(subscription.recoveryReason ? { recoveryReason: subscription.recoveryReason } : {}),
    } }
  }

  #wake(subscription: Subscription): void {
    const waiter = subscription.waiter
    if (!waiter) return
    subscription.waiter = undefined
    clearTimeout(waiter.timer)
    waiter.resolve(this.#batch(subscription))
  }

  close(id: string): CollaborationResult<null> {
    if (this.#active?.id === id) this.closeAll()
    return { ok: true, value: null }
  }

  /** 退出、范围切换或关窗时解除网络和等待，旧结果不能进入新范围。 */
  closeAll(): void {
    const subscription = this.#active
    if (!subscription) return
    this.#active = null
    subscription.closed = true
    subscription.stream?.close()
    subscription.queue = []; subscription.bytes = 0
    this.#wake(subscription)
  }
}
