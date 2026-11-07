/** 身份IPC只接受固定方法；来源/数量/参数 → 窗口独有状态 → 不含凭据的结果。 */
import { ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import { CollaborationState, identityError } from "./collaboration-state.js"
import { verifyDesktopSource } from "./trusted-source.js"

export function bindCollaborationIpc(window: BrowserWindow, trustedUrl: string): void {
  const identity = new CollaborationState(process.env.WORKBENCH_SERVICE_ORIGIN)
  const channels: string[] = []
  const unsubscribe = identity.onStateChanged(state => {
    if (!window.isDestroyed()) window.webContents.send("collaboration:state", state)
  })
  function handle(name: string, count: number, action: (...args: unknown[]) => unknown) {
    const channel = `collaboration:${name}`
    channels.push(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try { verifyDesktopSource(window, trustedUrl, event) }
      catch { return identityError("REQUEST_SOURCE_REJECTED", "不允许的身份请求来源。") }
      if (args.length !== count) return identityError("INVALID_REQUEST", "身份请求参数无效。")
      try { return await action(...args) }
      catch { return identityError("INTERNAL_ERROR", "身份操作暂时无法完成。") }
    })
  }
  handle("get-state", 0, () => identity.getState())
  handle("demo-users", 0, () => identity.listDemoUsers())
  handle("sign-in", 1, username => typeof username === "string" && /^[a-z][a-z0-9]{0,31}$/.test(username) ? identity.signIn(username) : identityError("INVALID_REQUEST", "用户名无效。"))
  handle("sign-out", 0, () => identity.signOut())
  handle("members", 1, id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? identity.listMembers(id) : identityError("INVALID_REQUEST", "工作区标识无效。"))
  window.once("closed", () => {
    unsubscribe(); identity.dispose()
    for (const channel of channels) ipcMain.removeHandler(channel)
  })
}
