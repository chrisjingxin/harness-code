/** 隔离桥只转发固定桌面/身份方法；不向页面暴露 Electron 事件、IPC 对象或 Node。 */
import { contextBridge, ipcRenderer } from "electron"
import type { CollaborationHost, IdentityState } from "@workbench/collaboration-client/types"
import type {
  CollaborationAppsHost, DesktopHost, LocalDirectoryHost,
  OrganizationHost, PersonalHost, ProjectConversationHost, WindowState,
} from "../shared/index.js"
import { createLocalExecutionHost } from "./local-execution-api.js"
import { createProjectUpdatesHost } from "./project-updates-api.js"

const host: DesktopHost = {
  chooseDirectory: () => ipcRenderer.invoke("workbench:choose-directory"),
  chooseFiles: () => ipcRenderer.invoke("workbench:choose-files"),
  chooseContextDirectories: () => ipcRenderer.invoke("workbench:choose-context-directories"),
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

const collaborationApps: CollaborationAppsHost = {
  createSnapshot: (workspaceId, projectId, request) => ipcRenderer.invoke("workbench:collaboration-apps:createSnapshot", workspaceId, projectId, request),
  readSnapshot: (workspaceId, projectId, snapshotId) => ipcRenderer.invoke("workbench:collaboration-apps:readSnapshot", workspaceId, projectId, snapshotId),
  listTasks: (workspaceId, projectId, afterId) => ipcRenderer.invoke("workbench:collaboration-apps:listTasks", workspaceId, projectId, afterId),
  readTask: (workspaceId, projectId, taskId) => ipcRenderer.invoke("workbench:collaboration-apps:readTask", workspaceId, projectId, taskId),
  createTask: (workspaceId, projectId, request) => ipcRenderer.invoke("workbench:collaboration-apps:createTask", workspaceId, projectId, request),
  editTask: (workspaceId, projectId, taskId, request) => ipcRenderer.invoke("workbench:collaboration-apps:editTask", workspaceId, projectId, taskId, request),
  transitionTask: (workspaceId, projectId, taskId, request) => ipcRenderer.invoke("workbench:collaboration-apps:transitionTask", workspaceId, projectId, taskId, request),
  linkTaskConversation: (workspaceId, projectId, taskId, request) => ipcRenderer.invoke("workbench:collaboration-apps:linkTaskConversation", workspaceId, projectId, taskId, request),
  listKnowledge: (workspaceId, query, afterId) => ipcRenderer.invoke("workbench:collaboration-apps:listKnowledge", workspaceId, query, afterId),
  readKnowledge: (workspaceId, knowledgeId) => ipcRenderer.invoke("workbench:collaboration-apps:readKnowledge", workspaceId, knowledgeId),
  createKnowledge: (workspaceId, request) => ipcRenderer.invoke("workbench:collaboration-apps:createKnowledge", workspaceId, request),
  editKnowledge: (workspaceId, knowledgeId, request) => ipcRenderer.invoke("workbench:collaboration-apps:editKnowledge", workspaceId, knowledgeId, request),
  archiveKnowledge: (workspaceId, knowledgeId, expectedVersion) => ipcRenderer.invoke("workbench:collaboration-apps:archiveKnowledge", workspaceId, knowledgeId, expectedVersion),
  listKnowledgeVersions: (workspaceId, knowledgeId, afterId) => ipcRenderer.invoke("workbench:collaboration-apps:listKnowledgeVersions", workspaceId, knowledgeId, afterId),
  readKnowledgeVersion: (workspaceId, knowledgeId, versionId) => ipcRenderer.invoke("workbench:collaboration-apps:readKnowledgeVersion", workspaceId, knowledgeId, versionId),
}
contextBridge.exposeInMainWorld("collaborationApps", collaborationApps)
contextBridge.exposeInMainWorld("projectUpdates", createProjectUpdatesHost(ipcRenderer))

const localDirectory: LocalDirectoryHost = {
  bindDirectory: (workspaceId, projectId, conversationKey, directoryPath) =>
    ipcRenderer.invoke("workbench:local-directory:bind", workspaceId, projectId, conversationKey, directoryPath),
  readDirectory: (workspaceId, projectId, conversationKey, action) =>
    ipcRenderer.invoke("workbench:local-directory:read", workspaceId, projectId, conversationKey, action),
}
contextBridge.exposeInMainWorld("localDirectory", localDirectory)
contextBridge.exposeInMainWorld("localExecution", createLocalExecutionHost(ipcRenderer))

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
  renameConversation: (key, title) => ipcRenderer.invoke("personal:rename-conversation", key, title),
  onCloseRequested: listener => {
    closeListener = listener
    return () => { if (closeListener === listener) closeListener = null }
  },
}
contextBridge.exposeInMainWorld("personal", personal)
