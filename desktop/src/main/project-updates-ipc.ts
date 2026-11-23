/** 具名看板和通知 IPC。每次请求经统一守卫校验来源与参数，在登录代次或顶层页面改变时销毁旧订阅。 */
import { app } from "electron"
import type { BrowserWindow } from "electron"
import { join } from "node:path"
import { projectUpdatesChannels } from "../shared/index.js"
import {
  isNotificationCursor,
  ProjectUpdatesService,
  type CollaborationState,
  type ProjectUpdatesNetwork,
} from "@workbench/collaboration-client"
import { createCollaborationIpcRegistrar, formatIpcError, isUuid } from "./ipc-guard.js"

/** 与正式 Collaboration IPC 共用同一窗口身份和客户端；调用方在销毁身份前解绑。 */
export function bindProjectUpdatesIpc(
  window: BrowserWindow,
  trustedUrl: string,
  identity: CollaborationState,
  origin: string,
  onKnowledgeUpdated?: (workspaceId: string) => void,
): () => void {
  // 窗口关闭回调运行时已不能从窗口取 webContents；清理时只检查绑定时持有的引用。
  const contents = window.webContents
  const network: ProjectUpdatesNetwork = {
    readProjectBoard: (workspaceId, projectId) => identity.withWorkspace(
      workspaceId,
      client => client.readProjectBoard(workspaceId, projectId),
      { publishConnectionError: false },
    ),
    streamProjectNotifications: (workspaceId, afterId, signal, onConnected, onEvent) => identity.withWorkspace(
      workspaceId,
      client => client.streamProjectNotifications(workspaceId, afterId, signal, onConnected, onEvent),
      { publishConnectionError: false },
    ),
  }
  const updates = new ProjectUpdatesService(join(app.getPath("userData"), "notification-cursors"), origin)
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
      sourceRejected: "不允许的看板或通知请求来源。",
      invalidRequest: "看板或通知请求参数无效。",
      internalError: "看板或通知暂时不可用。",
    },
  })

  function checkWorkspace(workspaceId: unknown) {
    const current = identity.personalIdentity()
    if (!current) return formatIpcError("AUTHENTICATION_REQUIRED", "请先登录。")
    if (!isUuid(workspaceId) || !current.workspaces.includes(workspaceId)) {
      return formatIpcError("RESOURCE_NOT_FOUND", "团队不可用。")
    }
    return { ok: true as const, value: current }
  }

  ipc.handle(projectUpdatesChannels.board, 2, async (workspaceId, projectId) => {
    if (!isUuid(workspaceId) || !isUuid(projectId)) return formatIpcError("INVALID_REQUEST", "看板范围无效。")
    const result = await network.readProjectBoard(workspaceId, projectId)
    if (result.ok && result.value.projectId !== projectId) {
      return formatIpcError("INVALID_SERVER_RESPONSE", "看板响应所属项目不符。")
    }
    return result
  })

  ipc.handle(projectUpdatesChannels.subscribe, 2, (workspaceId, subscriptionId) => {
    if (!isUuid(workspaceId) || !isUuid(subscriptionId)) return formatIpcError("INVALID_REQUEST", "通知范围无效。")
    const authorized = checkWorkspace(workspaceId)
    if (!authorized.ok) return authorized
    updates.subscribe({
      subscriptionId, workspaceId, accountId: authorized.value.accountId, network,
      isCurrent: () => {
        const current = identity.personalIdentity()
        return current?.generation === authorized.value.generation && current.workspaces.includes(workspaceId)
          && !window.isDestroyed() && !contents.isDestroyed()
          && contents.mainFrame.url === trustedUrl
      },
      publish: notice => {
        if (notice.kind === "event" && notice.event.type === "knowledge.updated") onKnowledgeUpdated?.(workspaceId)
        try { contents.send(projectUpdatesChannels.notice, notice) }
        catch { updates.stop(subscriptionId) }
      },
    })
    return { ok: true, value: null }
  })

  ipc.handle(projectUpdatesChannels.acknowledge, 2, (subscriptionId, id) => {
    if (isUuid(subscriptionId) && isNotificationCursor(id) && id > 0) updates.acknowledge(subscriptionId, id)
  })
  ipc.handle(projectUpdatesChannels.unsubscribe, 1, subscriptionId => {
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
