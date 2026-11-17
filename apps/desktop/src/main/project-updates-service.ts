/**
 * 窗口通知生命周期：
 * 同一认证团队 → 读已确认游标 → 拉取事件 → 等渲染进程接受 → 保存游标 → 重连续读。
 * 退出或团队变化时取消读取、确认等待和退避计时。
 */
import { setTimeout as delay } from "node:timers/promises"
import type { BoardResponse, CollaborationResult, NotificationEvent } from "@workbench/contracts"
import type { ProjectUpdatesNotice, ProjectUpdatesStatus } from "../project-updates-host.js"
import { notificationCursor } from "./project-notification-cursor.js"

export interface ProjectUpdatesNetwork {
  readProjectBoard(workspaceId: string, projectId: string): Promise<CollaborationResult<BoardResponse>>
  streamProjectNotifications(
    workspaceId: string,
    afterId: number,
    signal: AbortSignal,
    onConnected: () => void,
    onEvent: (event: NotificationEvent) => Promise<void>,
  ): Promise<CollaborationResult<null>>
}

type Subscription = {
  id: string
  abort: AbortController
  pending: { id: number; accept: () => void } | null
}

const terminalErrors = new Set(["AUTHENTICATION_REQUIRED", "WORKSPACE_MEMBER_REQUIRED",
  "RESOURCE_NOT_FOUND", "PROTOCOL_VERSION_UNSUPPORTED", "REQUEST_SOURCE_REJECTED", "INVALID_REQUEST", "TLS_ERROR"])

export class ProjectUpdatesService {
  #subscription: Subscription | null = null

  constructor(private readonly cursorDirectory: string, private readonly origin: string) {}

  /** 一个窗口只能有一个团队订阅。同一订阅的重复请求直接合并。 */
  subscribe(options: {
    subscriptionId: string
    accountId: string
    workspaceId: string
    network: ProjectUpdatesNetwork
    isCurrent: () => boolean
    publish: (notice: ProjectUpdatesNotice) => void
  }): void {
    if (this.#subscription?.id === options.subscriptionId) return
    this.stop()
    const subscription: Subscription = { id: options.subscriptionId, abort: new AbortController(), pending: null }
    this.#subscription = subscription
    const signal = subscription.abort.signal
    const current = () => !signal.aborted && options.isCurrent()
    const publish = (notice: Omit<Extract<ProjectUpdatesNotice, { kind: "status" }>, "subscriptionId">
      | Omit<Extract<ProjectUpdatesNotice, { kind: "event" }>, "subscriptionId">) => {
      if (current()) options.publish({ subscriptionId: subscription.id, ...notice })
    }
    const status = (status: ProjectUpdatesStatus) => publish({ kind: "status", status })

    void (async () => {
      const cursor = notificationCursor(this.cursorDirectory, this.origin, options.accountId, options.workspaceId)
      status("connecting")
      let lastId = await cursor.read()
      let retryMs = 750
      while (current()) {
        let connectedAt = 0
        const attempt = new AbortController()
        const result = await options.network.streamProjectNotifications(
          options.workspaceId, lastId, AbortSignal.any([signal, attempt.signal]),
          () => { connectedAt = Date.now(); status("connected") },
          async event => {
            if (!current() || event.id <= lastId) return
            const accepted = await this.#deliver(subscription, event.id, () => publish({ kind: "event", event }))
            if (!accepted) {
              // 关闭旧流并从已确认位置重连，避免跳过渲染端未接受的事件。
              attempt.abort()
              return
            }
            try {
              await cursor.save(event.id)
              lastId = event.id
            } catch {
              attempt.abort()
            }
          },
        )
        if (!current()) return
        if (!result.ok && terminalErrors.has(result.error.code)) { status("unavailable"); return }
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
