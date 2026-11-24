/**
 * 【功能定义】跨团队收件箱、用户级轻通知流与外部通知偏好 IPC 装配入口：
 * 统一来源/参数守卫 → 账号代次隔离（`withAccount`） → 驱动 `UserUpdatesService` 多工作区 SSE 续读与游标持久化。
 *
 * 【协作边界】
 * - 依赖 `@workbench/collaboration-client` 与 `ipc-guard.ts`，严格拒绝非受信页面来源、越界参数与控制字符。
 * - 登录态退出、导航跳转或渲染进程退出时立即停止后台 SSE 订阅，窗口销毁前返回解绑句柄供主进程清理。
 */
import type { BrowserWindow } from "electron"
import { app } from "electron"
import { join } from "node:path"
import {
  UserUpdatesService,
  isNotificationCursor,
  type CollaborationState,
  type UserUpdatesNetwork,
} from "@workbench/collaboration-client"
import type {
  ExternalNotificationEventType,
  InboxBucket,
  InboxQuery,
  NotificationPreferencesUpdateRequest,
} from "@workbench/collaboration-client/types"
import { inboxChannels } from "../shared/index.js"
import {
  createCollaborationIpcRegistrar,
  formatIpcError,
  isNonControlString,
  isNonNegativeSafeInteger,
  isPlainObject,
  isPositiveSafeInteger,
  isUuid,
} from "./ipc-guard.js"

const INBOX_BUCKETS = new Set<InboxBucket>(["action_required", "sent", "resolved"])
const EXTERNAL_EVENT_TYPES = new Set<ExternalNotificationEventType>([
  "task.assigned",
  "task.review_requested",
  "task.returned",
])
const INBOX_QUERY_KEYS = new Set(["bucket", "category", "workspaceId", "limit"])
const LIST_NOTIFICATION_KEYS = new Set(["afterId", "limit"])
const PREF_REQUEST_KEYS = new Set([
  "externalEnabled",
  "subscribedEvents",
  "dndEnabled",
  "dndStartMinute",
  "dndEndMinute",
  "dndTimezone",
  "mergeWindowSec",
  "expectedVersion",
])

function isMinuteOfDay(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1439
}

function isInboxQuery(value: unknown): value is InboxQuery | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key => !INBOX_QUERY_KEYS.has(key))) return false
  if (value.bucket !== undefined && (typeof value.bucket !== "string" || !INBOX_BUCKETS.has(value.bucket as InboxBucket))) {
    return false
  }
  if (value.category !== undefined && !isNonControlString(value.category, 64)) {
    return false
  }
  if (value.workspaceId !== undefined && !isUuid(value.workspaceId)) {
    return false
  }
  if (value.limit !== undefined && (!isPositiveSafeInteger(value.limit) || value.limit > 200)) {
    return false
  }
  return true
}

function isUserNotificationsQuery(value: unknown): value is { afterId?: number; limit?: number } | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key => !LIST_NOTIFICATION_KEYS.has(key))) return false
  if (value.afterId !== undefined && !isNonNegativeSafeInteger(value.afterId)) return false
  if (value.limit !== undefined && (!isPositiveSafeInteger(value.limit) || value.limit > 100)) return false
  return true
}

function isPreferencesUpdateRequest(value: unknown): value is NotificationPreferencesUpdateRequest {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key => !PREF_REQUEST_KEYS.has(key))) return false
  if (typeof value.externalEnabled !== "boolean" || typeof value.dndEnabled !== "boolean") return false
  if (!Array.isArray(value.subscribedEvents)
    || !value.subscribedEvents.every(item => typeof item === "string" && EXTERNAL_EVENT_TYPES.has(item as ExternalNotificationEventType))) {
    return false
  }
  if (!isMinuteOfDay(value.dndStartMinute) || !isMinuteOfDay(value.dndEndMinute)) return false
  if (!isNonControlString(value.dndTimezone, 64)) return false
  if (typeof value.mergeWindowSec !== "number" || !Number.isSafeInteger(value.mergeWindowSec) || value.mergeWindowSec < 0 || value.mergeWindowSec > 3600) {
    return false
  }
  if (!isNonNegativeSafeInteger(value.expectedVersion)) return false
  return true
}

/** 与桌面窗口同一 `CollaborationState` 共用账号认证与连接生命周期；返回解绑函数供窗口关闭时清理。 */
export function bindInboxIpc(
  window: BrowserWindow,
  trustedUrl: string,
  identity: CollaborationState,
  origin: string,
): () => void {
  const contents = window.webContents
  const network: UserUpdatesNetwork = {
    getInbox: query => identity.withAccount(client => client.getInbox(query), { publishConnectionError: false }),
    streamUserNotifications: (afterId, signal, onConnected, onEvent) =>
      identity.withAccount(
        client => client.streamUserNotifications(afterId, signal, onConnected, onEvent),
        { publishConnectionError: false },
      ),
  }
  const updates = new UserUpdatesService(join(app.getPath("userData"), "notification-cursors"), origin)
  const unsubscribeIdentity = identity.onStateChanged(state => {
    if (state.status !== "signedIn") updates.stop()
  })
  const stopForNavigation = (details: Electron.WebContentsDidStartNavigationEventParams) => {
    if (details.isMainFrame && !details.isSameDocument) updates.stop()
  }
  contents.on("did-start-navigation", stopForNavigation)
  const stopForRendererExit = () => updates.stop()
  contents.on("render-process-gone", stopForRendererExit)

  const ipc = createCollaborationIpcRegistrar({
    window,
    trustedUrl,
    messages: {
      sourceRejected: "不允许的收件箱请求来源。",
      invalidRequest: "收件箱请求参数无效。",
      internalError: "收件箱与通知服务暂时不可用。",
    },
  })

  ipc.handle(inboxChannels.getInbox, [0, 1], query => {
    if (!isInboxQuery(query)) return formatIpcError("INVALID_REQUEST", "收件箱筛选参数无效。")
    return network.getInbox(query)
  })

  ipc.handle(inboxChannels.listNotifications, [0, 1], query => {
    if (!isUserNotificationsQuery(query)) return formatIpcError("INVALID_REQUEST", "通知历史查询参数无效。")
    return identity.withAccount(
      client => client.listUserNotifications(query?.afterId, query?.limit),
      { publishConnectionError: false },
    )
  })

  ipc.handle(inboxChannels.getPreferences, 0, () =>
    identity.withAccount(client => client.getNotificationPreferences(), { publishConnectionError: false }),
  )

  ipc.handle(inboxChannels.updatePreferences, 1, input => {
    if (!isPreferencesUpdateRequest(input)) return formatIpcError("INVALID_REQUEST", "通知偏好参数无效。")
    return identity.withAccount(client => client.updateNotificationPreferences(input), { publishConnectionError: false })
  })

  ipc.handle(inboxChannels.subscribe, [1, 2], (subscriptionId, initialCursor) => {
    if (!isUuid(subscriptionId)) return formatIpcError("INVALID_REQUEST", "收件箱订阅标识无效。")
    if (initialCursor !== undefined && !isNotificationCursor(initialCursor)) {
      return formatIpcError("INVALID_REQUEST", "收件箱通知游标无效。")
    }
    const authorized = identity.personalIdentity()
    if (!authorized || authorized.offline) {
      return formatIpcError("AUTHENTICATION_REQUIRED", "请先在线登录协作账号。")
    }
    updates.subscribe({
      subscriptionId,
      accountId: authorized.accountId,
      ...(initialCursor !== undefined ? { initialCursor } : {}),
      network,
      isCurrent: () => {
        const current = identity.personalIdentity()
        return current?.generation === authorized.generation
          && !current.offline
          && !window.isDestroyed()
          && !contents.isDestroyed()
          && contents.mainFrame.url === trustedUrl
      },
      publish: notice => {
        if (
          (notice.kind === "event" && notice.event.type === "workspace.member_changed")
          || (notice.kind === "status" && (notice.status === "connected" || notice.status === "unavailable"))
        ) {
          void identity.refreshIdentity()
        }
        try {
          contents.send(inboxChannels.notice, notice)
        } catch {
          updates.stop(subscriptionId)
        }
      },
    })
    return { ok: true, value: null }
  })

  ipc.handle(inboxChannels.acknowledge, 2, (subscriptionId, id) => {
    if (isUuid(subscriptionId) && isNotificationCursor(id) && id > 0) updates.acknowledge(subscriptionId, id)
  })

  ipc.handle(inboxChannels.unsubscribe, 1, subscriptionId => {
    if (isUuid(subscriptionId)) updates.stop(subscriptionId)
  })

  return () => {
    updates.stop()
    unsubscribeIdentity()
    if (!contents.isDestroyed()) {
      contents.removeListener("did-start-navigation", stopForNavigation)
      contents.removeListener("render-process-gone", stopForRendererExit)
    }
    ipc.dispose()
  }
}
