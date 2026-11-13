/** 设备 IPC：固定具名方法 + 窗口来源校验；不暴露任意路径、URL、headers 或子进程句柄。 */
import { ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import type { DeviceState } from "@workbench/contracts"
import type { DeviceHost } from "./device-host.js"
import { identityError } from "./collaboration-state.js"
import { verifyDesktopSource } from "./trusted-source.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function bindDeviceIpc(window: BrowserWindow, trustedUrl: string, host: DeviceHost): void {
  const channels: string[] = []
  const unsubscribe = host.onStateChanged(state => {
    if (!window.isDestroyed()) window.webContents.send("devices:state", state)
  })
  function handle(name: string, count: number, action: (...args: unknown[]) => unknown) {
    const channel = `devices:${name}`
    channels.push(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try { verifyDesktopSource(window, trustedUrl, event) }
      catch { return identityError("REQUEST_SOURCE_REJECTED", "不允许的设备请求来源。") }
      if (args.length !== count) return identityError("INVALID_REQUEST", "设备请求参数无效。")
      try { return await action(...args) }
      catch { return identityError("INTERNAL_ERROR", "设备操作暂时无法完成。") }
    })
  }
  handle("get-state", 0, () => host.getState())
  handle("list-devices", 1, workspaceId => UUID.test(String(workspaceId)) ? host.listDevices(String(workspaceId)) : identityError("INVALID_REQUEST", "工作区标识无效。"))
  handle("register", 2, (workspaceId, name) => UUID.test(String(workspaceId)) && typeof name === "string"
    ? host.registerDevice(String(workspaceId), name) : identityError("INVALID_REQUEST", "登记参数无效。"))
  handle("revoke", 3, (workspaceId, deviceId, requestId) => [workspaceId, deviceId, requestId].every(value => UUID.test(String(value)))
    ? host.revokeDevice(String(workspaceId), String(deviceId), String(requestId)) : identityError("INVALID_REQUEST", "撤销参数无效。"))
  handle("share", 0, () => host.shareProject())
  handle("start", 0, () => host.startRunner())
  handle("stop", 0, () => host.stopRunner())
  window.once("closed", () => {
    unsubscribe()
    host.dispose()
    for (const channel of channels) ipcMain.removeHandler(channel)
  })
}

export type { DeviceState }
