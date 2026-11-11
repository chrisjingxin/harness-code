/** 隔离桥只转发固定桌面/身份/设备方法；不向页面暴露 Electron 事件、IPC 对象或 Node。 */
import { contextBridge, ipcRenderer } from "electron"
import type { CollaborationHost, ConversationReadHost, DesktopHost, DeviceHost, DeviceState, IdentityState, WindowState } from "@workbench/contracts"
import type { ProjectReadHost } from "../project-read-host.js"
import type { PersonalHost } from "../personal-host.js"

const host: DesktopHost = {
  chooseDirectory: () => ipcRenderer.invoke("workbench:choose-directory"),
  getWindowState: () => ipcRenderer.invoke("workbench:get-window-state"),
  setThemeMode: mode => ipcRenderer.invoke("workbench:set-theme-mode", mode),
  adjustZoom: action => ipcRenderer.invoke("workbench:adjust-zoom", action),
  copyText: text => ipcRenderer.invoke("workbench:copy-text", text),
  openExternal: href => ipcRenderer.invoke("workbench:open-external", href),
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

const conversations: ConversationReadHost = {
  listConversations: (workspaceId, cursor) => ipcRenderer.invoke("collaboration:conversations", workspaceId, cursor),
  getConversation: (workspaceId, conversationId) => ipcRenderer.invoke("collaboration:conversation", workspaceId, conversationId),
  readHistory: (workspaceId, conversationId, page) => ipcRenderer.invoke("collaboration:history", workspaceId, conversationId, page),
  subscribeConversation: (workspaceId, conversationId, afterSequence) => ipcRenderer.invoke("collaboration:subscribe-conversation", workspaceId, conversationId, afterSequence),
  readConversationEvents: (subscriptionId, afterSequence) => ipcRenderer.invoke("collaboration:conversation-events", subscriptionId, afterSequence),
  unsubscribeConversation: subscriptionId => ipcRenderer.invoke("collaboration:unsubscribe-conversation", subscriptionId),
}
contextBridge.exposeInMainWorld("conversations", conversations)

const projects: ProjectReadHost = {
  readProject: (workspaceId, conversationId, action) => ipcRenderer.invoke("collaboration:project-read", workspaceId, conversationId, action),
}
contextBridge.exposeInMainWorld("projects", projects)

let closeListener: (() => Promise<boolean>) | null = null
ipcRenderer.on("personal:prepare-close", (_event: unknown, request: string) => {
  void (async () => {
    let ready = true
    try { if (closeListener) ready = await closeListener() } catch { ready = false }
    await ipcRenderer.invoke("personal:close-ready", request, ready)
  })()
})
const personal: PersonalHost = {
  load: key => ipcRenderer.invoke("personal:load", key),
  save: (key, revision, value) => ipcRenderer.invoke("personal:save", key, revision, value),
  onCloseRequested: listener => {
    closeListener = listener
    return () => { if (closeListener === listener) closeListener = null }
  },
}
contextBridge.exposeInMainWorld("personal", personal)

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
