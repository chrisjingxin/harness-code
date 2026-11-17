/** 具名看板和通知 IPC。每次请求校验来源，在登录代次或顶层页面改变时销毁旧订阅。 */
import { app, ipcMain } from "electron"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { join } from "node:path"
import { projectUpdatesChannels } from "../project-updates-host.js"
import { identityError } from "./collaboration-state.js"
import type { CollaborationState } from "./collaboration-state.js"
import { isNotificationCursor } from "./project-notification-cursor.js"
import { ProjectUpdatesService } from "./project-updates-service.js"
import type { ProjectUpdatesNetwork } from "./project-updates-service.js"
import { verifyDesktopSource } from "./trusted-source.js"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value)

/** 与正式 Collaboration IPC 共用同一窗口身份和客户端；调用方在销毁身份前解绑。 */
export function bindProjectUpdatesIpc(
  window: BrowserWindow,
  trustedUrl: string,
  identity: CollaborationState,
  origin: string,
): () => void {
  // 窗口关闭回调运行时已不能从窗口取 webContents；清理时只检查绑定时持有的引用。
  const contents = window.webContents
  const network: ProjectUpdatesNetwork = {
    readProjectBoard: (workspaceId, projectId) => identity.applicationWorkspace(
      workspaceId, client => client.readProjectBoard(workspaceId, projectId),
    ),
    streamProjectNotifications: (workspaceId, afterId, signal, onConnected, onEvent) => identity.applicationWorkspace(
      workspaceId, client => client.streamProjectNotifications(workspaceId, afterId, signal, onConnected, onEvent),
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

  function handle(channel: string, count: number, action: (...args: unknown[]) => unknown) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try { verifyDesktopSource(window, trustedUrl, event) }
      catch { return identityError("REQUEST_SOURCE_REJECTED", "不允许的看板或通知请求来源。") }
      if (args.length !== count) return identityError("INVALID_REQUEST", "看板或通知请求参数无效。")
      try { return await action(...args) }
      catch { return identityError("INTERNAL_ERROR", "看板或通知暂时不可用。") }
    })
  }

  function checkWorkspace(workspaceId: unknown) {
    const current = identity.personalIdentity()
    if (!current) return identityError("AUTHENTICATION_REQUIRED", "请先登录。")
    if (!isId(workspaceId) || !current.workspaces.includes(workspaceId)) {
      return identityError("RESOURCE_NOT_FOUND", "团队不可用。")
    }
    return { ok: true as const, value: current }
  }

  handle(projectUpdatesChannels.board, 2, async (workspaceId, projectId) => {
    if (!isId(workspaceId) || !isId(projectId)) return identityError("INVALID_REQUEST", "看板范围无效。")
    const result = await network.readProjectBoard(workspaceId, projectId)
    if (result.ok && result.value.projectId !== projectId) {
      return identityError("INVALID_SERVER_RESPONSE", "看板响应所属项目不符。")
    }
    return result
  })

  handle(projectUpdatesChannels.subscribe, 2, (workspaceId, subscriptionId) => {
    if (!isId(workspaceId) || !isId(subscriptionId)) return identityError("INVALID_REQUEST", "通知范围无效。")
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
        try { contents.send(projectUpdatesChannels.notice, notice) }
        catch { updates.stop(subscriptionId) }
      },
    })
    return { ok: true, value: null }
  })

  handle(projectUpdatesChannels.acknowledge, 2, (subscriptionId, id) => {
    if (isId(subscriptionId) && isNotificationCursor(id) && id > 0) updates.acknowledge(subscriptionId, id)
  })
  handle(projectUpdatesChannels.unsubscribe, 1, subscriptionId => {
    if (isId(subscriptionId)) updates.stop(subscriptionId)
  })

  return () => {
    updates.stop()
    unsubscribeIdentity()
    if (!contents.isDestroyed()) {
      contents.removeListener("did-start-navigation", stopForNavigation)
      contents.removeListener("render-process-gone", stopForRendererExit)
    }
    for (const [name, channel] of Object.entries(projectUpdatesChannels)) {
      if (name !== "notice") ipcMain.removeHandler(channel)
    }
  }
}
