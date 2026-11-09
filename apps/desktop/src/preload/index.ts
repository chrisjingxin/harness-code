/** 隔离桥只转发固定桌面/身份/设备方法；不向页面暴露 Electron 事件、IPC 对象或 Node。 */
import { contextBridge, ipcRenderer } from "electron"
import type { CollaborationHost, DesktopHost, DeviceHost, DeviceState, IdentityState, WindowState } from "@workbench/contracts"

const host: DesktopHost = {
  chooseDirectory: () => ipcRenderer.invoke("workbench:choose-directory"),
  getWindowState: () => ipcRenderer.invoke("workbench:get-window-state"),
  setThemeMode: mode => ipcRenderer.invoke("workbench:set-theme-mode", mode),
  adjustZoom: action => ipcRenderer.invoke("workbench:adjust-zoom", action),
  onWindowStateChanged: listener => {
    const receive = (_event: unknown, state: WindowState) => listener(state)
    ipcRenderer.on("workbench:window-state", receive)
    return () => { ipcRenderer.removeListener("workbench:window-state", receive) }
  },
}
contextBridge.exposeInMainWorld("workbench", host)

const collaboration: CollaborationHost = {
  getState: () => ipcRenderer.invoke("collaboration:get-state"),
  listDemoUsers: () => ipcRenderer.invoke("collaboration:demo-users"),
  signIn: username => ipcRenderer.invoke("collaboration:sign-in", username),
  signOut: () => ipcRenderer.invoke("collaboration:sign-out"),
  listMembers: id => ipcRenderer.invoke("collaboration:members", id),
  onStateChanged: listener => {
    const receive = (_event: unknown, state: IdentityState) => listener(state)
    ipcRenderer.on("collaboration:state", receive)
    return () => { ipcRenderer.removeListener("collaboration:state", receive) }
  },
}
contextBridge.exposeInMainWorld("collaboration", collaboration)

const devices: DeviceHost = {
  getState: () => ipcRenderer.invoke("devices:get-state"),
  listDevices: workspaceId => ipcRenderer.invoke("devices:list-devices", workspaceId),
  registerDevice: (workspaceId, name) => ipcRenderer.invoke("devices:register", workspaceId, name),
  listProjects: (workspaceId, deviceId) => ipcRenderer.invoke("devices:list-projects", workspaceId, deviceId),
  revokeDevice: (workspaceId, deviceId, requestId) => ipcRenderer.invoke("devices:revoke", workspaceId, deviceId, requestId),
  stopSharing: (workspaceId, projectId, requestId, expectedShareVersion) => ipcRenderer.invoke("devices:stop-sharing", workspaceId, projectId, requestId, expectedShareVersion),
  shareProject: () => ipcRenderer.invoke("devices:share"),
  startRunner: () => ipcRenderer.invoke("devices:start"),
  stopRunner: () => ipcRenderer.invoke("devices:stop"),
  onStateChanged: listener => {
    const receive = (_event: unknown, state: DeviceState) => listener(state)
    ipcRenderer.on("devices:state", receive)
    return () => { ipcRenderer.removeListener("devices:state", receive) }
  },
}
contextBridge.exposeInMainWorld("devices", devices)
