/**
 * 【功能定义】跨团队用户级轻量通知生命周期服务：
 * 同一登录账号 → 读已确认游标 → 拉取跨 Workspace SSE 事件（按各团队独立去重） → 等消费端确认 → 持久化游标 → 退避重连续读。
 * 【协作边界】零 Electron 依赖；退出登录或发生终端不可恢复错误时立即中止计时与连接。
 */
import { setTimeout as delay } from "node:timers/promises"
import type {
  CollaborationResult,
  InboxQuery,
  InboxResponse,
  ProjectUpdatesStatus,
  UserNotificationEvent,
  UserUpdatesNotice,
} from "./types/index.js"
import { isNotificationCursor, notificationCursor } from "./project-notification-cursor.js"

export interface UserUpdatesNetwork {
  getInbox(query?: InboxQuery): Promise<CollaborationResult<InboxResponse>>
  streamUserNotifications(
    afterId: number,
    signal: AbortSignal,
    onConnected: () => void,
    onEvent: (event: UserNotificationEvent) => Promise<void>,
  ): Promise<CollaborationResult<null>>
}

type Subscription = {
  id: string
  abort: AbortController
  pending: { id: number; accept: () => void } | null
}

const terminalErrors = new Set([
  "AUTHENTICATION_REQUIRED",
  "RESOURCE_NOT_FOUND",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "REQUEST_SOURCE_REJECTED",
  "INVALID_REQUEST",
  "TLS_ERROR",
])

export class UserUpdatesService {
  #subscription: Subscription | null = null

  constructor(private readonly cursorDirectory: string, private readonly origin: string) {}

  /** 同一账号同一时刻只维持一条跨团队通知订阅；重复订阅同 ID 直接合并。 */
  subscribe(options: {
    subscriptionId: string
    accountId: string
    initialCursor?: number
    network: UserUpdatesNetwork
    isCurrent: () => boolean
    publish: (notice: UserUpdatesNotice) => void
  }): void {
    if (this.#subscription?.id === options.subscriptionId) return
    this.stop()
    const subscription: Subscription = { id: options.subscriptionId, abort: new AbortController(), pending: null }
    this.#subscription = subscription
    const signal = subscription.abort.signal
    const current = () => !signal.aborted && options.isCurrent()
    const publish = (
      notice:
        | Omit<Extract<UserUpdatesNotice, { kind: "status" }>, "subscriptionId">
        | Omit<Extract<UserUpdatesNotice, { kind: "event" }>, "subscriptionId">,
    ) => {
      if (current()) options.publish({ subscriptionId: subscription.id, ...notice })
    }
    const status = (nextStatus: ProjectUpdatesStatus) => publish({ kind: "status", status: nextStatus })

    void (async () => {
      const cursor = notificationCursor(this.cursorDirectory, this.origin, options.accountId, "__me__")
      status("connecting")
      const storedCursor = await cursor.read()
      const seeded = isNotificationCursor(options.initialCursor) ? options.initialCursor : 0
      let maxCursor = Math.max(storedCursor, seeded)
      if (maxCursor > storedCursor) {
        try {
          await cursor.save(maxCursor)
        } catch {
          // 初始基线落盘失败不阻断实时流，后续收到事件仍会继续尝试持久化。
        }
      }
      // 按团队各自记录已消费事件最大 ID，避免不同团队事务提交顺序交错导致低 ID 事件被误丢弃。
      const seenByWorkspace = new Map<string, number>()
      let retryMs = 750

      while (current()) {
        let connectedAt = 0
        const attempt = new AbortController()
        const result = await options.network.streamUserNotifications(
          maxCursor,
          AbortSignal.any([signal, attempt.signal]),
          () => {
            connectedAt = Date.now()
            status("connected")
          },
          async event => {
            if (!current()) return
            const seenInWorkspace = seenByWorkspace.get(event.workspaceId) ?? 0
            if (event.id <= seenInWorkspace) return
            const accepted = await this.#deliver(subscription, event.id, () => publish({ kind: "event", event }))
            if (!accepted) {
              attempt.abort()
              return
            }
            seenByWorkspace.set(event.workspaceId, event.id)
            if (event.id > maxCursor) {
              try {
                await cursor.save(event.id)
                maxCursor = event.id
              } catch {
                attempt.abort()
              }
            }
          },
        )
        if (!current()) return
        if (!result.ok && terminalErrors.has(result.error.code)) {
          status("unavailable")
          return
        }
        status("retrying")
        if (connectedAt > 0 && Date.now() - connectedAt >= 20_000) retryMs = 750
        await delay(retryMs, undefined, { signal })
        retryMs = Math.min(30_000, retryMs * 2)
      }
    })().catch(() => status("unavailable")).finally(() => {
      if (this.#subscription === subscription) this.stop()
    })
  }

  acknowledge(subscriptionId: string, eventId: number): void {
    const subscription = this.#subscription
    if (subscription?.id === subscriptionId && subscription.pending?.id === eventId) subscription.pending.accept()
  }

  stop(subscriptionId?: string): void {
    if (subscriptionId !== undefined && this.#subscription?.id !== subscriptionId) return
    this.#subscription?.abort.abort()
    this.#subscription = null
  }

  async #deliver(subscription: Subscription, id: number, publish: () => void): Promise<boolean> {
    const signal = subscription.abort.signal
    if (signal.aborted) return false
    return new Promise(resolve => {
      const finish = (accepted: boolean) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", cancel)
        subscription.pending = null
        resolve(accepted)
      }
      const cancel = () => finish(false)
      const timeout = setTimeout(cancel, 10_000)
      signal.addEventListener("abort", cancel, { once: true })
      subscription.pending = { id, accept: () => finish(true) }
      publish()
    })
  }
}
