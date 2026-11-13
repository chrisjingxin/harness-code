/** 隔离桥只转发固定桌面/身份/设备方法；不向页面暴露 Electron 事件、IPC 对象或 Node。 */
import { contextBridge, ipcRenderer } from "electron"
import type { CollaborationHost, DesktopHost, DeviceHost, DeviceState, IdentityState, ProjectConversationHost, WindowState } from "@workbench/contracts"
import type { PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"

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
  signIn: userNo => ipcRenderer.invoke("collaboration:sign-in", userNo),
  signOut: () => ipcRenderer.invoke("collaboration:sign-out"),
  listMembers: id => ipcRenderer.invoke("collaboration:members", id),
  onStateChanged: listener => {
    const receive = (_event: unknown, state: IdentityState) => listener(state)
    ipcRenderer.on("collaboration:state", receive)
    return () => { ipcRenderer.removeListener("collaboration:state", receive) }
  },
}
contextBridge.exposeInMainWorld("collaboration", collaboration)

const projectConversations: ProjectConversationHost = {
  listConversations: (workspaceId, projectId, query) => ipcRenderer.invoke("workbench:project-conversations:list", workspaceId, projectId, query),
  registerConversation: (workspaceId, projectId, request) => ipcRenderer.invoke("workbench:project-conversations:register", workspaceId, projectId, request),
  getConversation: (workspaceId, projectId, conversationId) => ipcRenderer.invoke("workbench:project-conversations:get", workspaceId, projectId, conversationId),
  readHistory: (workspaceId, projectId, conversationId, afterSequence, limit) => ipcRenderer.invoke("workbench:project-conversations:history", workspaceId, projectId, conversationId, afterSequence, limit),
}
contextBridge.exposeInMainWorld("projectConversations", projectConversations)

const organization: OrganizationHost = {
  listProjects: workspaceId => ipcRenderer.invoke("organization:list-projects", workspaceId),
  createProject: (workspaceId, request) => ipcRenderer.invoke("organization:create-project", workspaceId, request),
  getProject: (workspaceId, projectId) => ipcRenderer.invoke("organization:get-project", workspaceId, projectId),
  updateProject: (workspaceId, projectId, request) => ipcRenderer.invoke("organization:update-project", workspaceId, projectId, request),
  addMember: (workspaceId, projectId, request) => ipcRenderer.invoke("organization:add-member", workspaceId, projectId, request),
  removeMember: (workspaceId, projectId, userId) => ipcRenderer.invoke("organization:remove-member", workspaceId, projectId, userId),
  listRepositories: workspaceId => ipcRenderer.invoke("organization:list-repositories", workspaceId),
  linkRepository: (workspaceId, projectId, repositoryId) => ipcRenderer.invoke("organization:link-repository", workspaceId, projectId, repositoryId),
  unlinkRepository: (workspaceId, projectId, repositoryId) => ipcRenderer.invoke("organization:unlink-repository", workspaceId, projectId, repositoryId),
}
contextBridge.exposeInMainWorld("organization", organization)

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
  revokeDevice: (workspaceId, deviceId, requestId) => ipcRenderer.invoke("devices:revoke", workspaceId, deviceId, requestId),
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
