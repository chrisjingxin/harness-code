/** 只在独立预览中提供已交付桌面端口的示例数据，个人记录保存在当前页面内存。 */
import type {
  CollaborationResult, DeviceState, DeviceSummary, ProjectDetailResponse, ProjectReadEntry, ProjectSummary, UserSummary, WindowState,
} from "@workbench/contracts"
import type { ComponentProps } from "react"
import type { DesktopWorkbench } from "../../../../apps/desktop/src/renderer/desktop-workbench.js"
import type {
  ConversationPersonal, PersonalKey, PersonalRead, ProjectPersonalRecord, WorkspacePersonal,
} from "../../../../apps/desktop/src/personal-host.js"
import { EMPTY_PERSONAL_STATE } from "../../../../apps/desktop/src/renderer/features/session/index.js"
import type { ConversationSnapshot } from "../../../../apps/desktop/src/renderer/features/collaboration/references/conversation-references.js"

export const workspace = { id: "demo-team", slug: "demo-team", name: "研发协作组" }
export const user: UserSummary = {
  id: "demo-zhang", userNo: "demo-zhang", userName: "张三", photo: "",
  orgId: "", orgNo: "", orgName: workspace.name, orgPathName: workspace.name,
}
export const colleague = { ...user, id: "demo-li", userNo: "demo-li", userName: "李四" }
export const members = [{ user }, { user: colleague }]
const timestamp = "2026-11-14T02:30:00Z"
export const project: ProjectSummary = {
  projectId: "demo-payments", workspaceId: workspace.id, name: "支付体验优化", description: "核对支付重试边界。",
  ownerUserId: user.id, status: "active", role: "owner", memberCount: members.length,
  version: 1, createdAt: timestamp, updatedAt: timestamp,
}
const detail: ProjectDetailResponse = {
  project,
  members: members.map(({ user }) => ({ userId: user.id, status: "active", joinedAt: timestamp, leftAt: null })),
  repositories: [],
}
export const device: DeviceSummary = {
  deviceId: "demo-device", ownerUserId: user.id, name: "示例设备",
  createdAt: timestamp, revokedAt: null, connectionState: "offline", lastSeenAt: null,
}
export const conversation = {
  conversationId: "demo-conversation", projectId: project.projectId, deviceId: device.deviceId, ownerUserId: user.id,
  title: "支付回调实现", status: "idle" as const, briefText: "", briefSource: "rule" as const,
  briefUpdatedAtMs: Date.parse(timestamp), syncedSequence: 0, updatedAt: timestamp, repositories: [],
}
const deviceState: DeviceState = { status: "registered", deviceId: device.deviceId, projectId: null, connection: "offline" }
const windowState: WindowState = { themeMode: "light", colorScheme: "light", zoomPercent: 100 }
const directoryPath = "/示例/订单服务"
const filename = "接口约定.md"
const nestedDirectory = "资料"
const nestedFile = `${nestedDirectory}/回调清单.md`
const fileText = "核对超时查询顺序。"
const rootFiles: ProjectReadEntry[] = [
  { path: filename, name: filename, kind: "file", expandable: false },
  { path: nestedDirectory, name: nestedDirectory, kind: "directory", expandable: true },
]
const nestedFiles: ProjectReadEntry[] = [
  { path: nestedFile, name: "回调清单.md", kind: "file", expandable: false },
]
const draftText = "帮我梳理支付回调的重试边界。"
const conversationRecord: ConversationPersonal = {
  scroll: EMPTY_PERSONAL_STATE.scroll,
  expandedTools: [],
  expandedOutputs: [],
  draft: { ...EMPTY_PERSONAL_STATE.draft, text: draftText, selectionStart: draftText.length, selectionEnd: draftText.length },
  localDirectoryPath: directoryPath,
  syncCache: null,
}
const fileRecord: ProjectPersonalRecord = {
  personal: {
    view: {
      dockOpen: true, dockWidthPx: 340, panel: "files", selectedPath: filename,
      fileTabs: [{ path: filename, name: filename }], activeFilePath: null, selectedChanges: [], commitMessage: "",
    },
    expanded: [], centralPaths: [filename], activeCentral: null, diffPath: null,
  },
  positions: [],
}
export const workspaceRecord: WorkspacePersonal = {
  projectId: project.projectId, panels: { left: { open: true, width: 280 }, right: { open: true, width: 340 } },
}
const records = new Map<string, PersonalRead>()

function initialRecord(key: PersonalKey): PersonalRead["data"] {
  switch (key.kind) {
    case "account": return { workspaceId: workspace.id }
    case "workspace": return workspaceRecord
    case "projectNavigation": return {
      page: { kind: "conversation", conversationId: conversation.conversationId }, expandedMembers: [], selfCollapsed: false,
    }
    case "projectDraft": return null
    case "conversation": return key.conversationId === conversation.conversationId ? conversationRecord : null
    case "sessionWorkspace": return key.conversationId === conversation.conversationId ? fileRecord : null
  }
}

const ok = <T,>(value: T): CollaborationResult<T> => ({ ok: true, value })
const unavailable = async (): Promise<CollaborationResult<never>> => ({
  ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "此操作在独立预览中不可用。", requestId: "preview", retryable: false },
})
const unsubscribe = () => () => {}

export const hosts: ComponentProps<typeof DesktopWorkbench> = {
  host: {
    async chooseDirectory() { return null },
    async getWindowState() { return windowState },
    async setThemeMode() { return windowState },
    async adjustZoom() { return windowState },
    async copyText() {},
    async openExternal() {},
    onWindowStateChanged: unsubscribe,
  },
  collaboration: {
    async getState() { return ok({ status: "signedIn", user, workspaces: [workspace] }) },
    async listDemoUsers() { return ok({ users: [user] }) },
    signIn: unavailable,
    signOut: unavailable,
    async listMembers() { return ok({ workspaceId: workspace.id, members }) },
    onStateChanged: unsubscribe,
  },
  organization: {
    async listProjects() { return ok({ workspaceId: workspace.id, projects: [project] }) },
    async getProject() { return ok(detail) },
    async listRepositories() { return ok({ workspaceId: workspace.id, repositories: [] }) },
    createProject: unavailable, updateProject: unavailable, addMember: unavailable,
    removeMember: unavailable, linkRepository: unavailable, unlinkRepository: unavailable,
  },
  devices: {
    async getState() { return ok(deviceState) },
    async listDevices() { return ok({ workspaceId: workspace.id, devices: [device], nextPage: null }) },
    registerDevice: unavailable, revokeDevice: unavailable, shareProject: unavailable,
    startRunner: unavailable, stopRunner: unavailable, onStateChanged: unsubscribe,
  },
  projectConversations: {
    async listConversations() { return ok({ projectId: project.projectId, conversations: [conversation] }) },
    async getConversation() { return ok({ conversation }) },
    registerConversation: unavailable,
    readHistory: unavailable,
  },
  localDirectory: {
    async bindDirectory(_workspaceId, _projectId, _conversationId, path) { return ok({ directoryPath: path, isGitRepository: false }) },
    async readDirectory(_workspaceId, _projectId, _conversationId, action) {
      const entries = "directory" in action && action.directory === nestedDirectory ? nestedFiles : rootFiles
      if (action.kind === "listDirectory") return ok({
        kind: "listDirectory", value: { entries, truncated: false },
      })
      if (action.kind === "searchCandidates") {
        const term = action.query.trim().toLocaleLowerCase()
        const source = term && !action.directory ? [...rootFiles, ...nestedFiles] : entries
        const items = source.flatMap(item => {
          const start = item.path.toLocaleLowerCase().indexOf(term)
          if (term && (start < 0 || item.kind === "directory")) return []
          return [{ ...item, matchRanges: term ? [{ start, end: start + term.length }] : [] }]
        })
        return ok({ kind: "searchCandidates", value: { items, total: items.length, truncated: false } })
      }
      if (action.kind === "readPreview" && (action.path === filename || action.path === nestedFile)) {
        const bytes = new TextEncoder().encode(fileText).length
        return ok({
          kind: "readPreview",
          value: { path: action.path, content: fileText, language: null, sizeBytes: bytes, displayedBytes: bytes, lineCount: 1, truncated: false },
        })
      }
      return unavailable()
    },
  },
  personalHost: {
    async load(key) {
      const value = records.get(JSON.stringify(key)) ?? { revision: 0, data: initialRecord(key) }
      return { ok: true, value }
    },
    async save(key, revision, data) {
      records.set(JSON.stringify(key), { revision, data })
      return { ok: true, value: null }
    },
    onCloseRequested: unsubscribe,
  },
}

const sourceConversation = {
  ...conversation, conversationId: "callback-review", ownerUserId: colleague.id, deviceId: "demo-remote-device",
  title: "回调复核会话", syncedSequence: 4,
}
const firstSnapshot: ConversationSnapshot = {
  id: "callback-review-v1", title: sourceConversation.title, owner: colleague.userName,
  version: "v1", uploadedAt: "2026-11-16 10:30", rangeLabel: "已上传消息 1–3",
  text: "超时后先查订单状态，再决定是否重试。重复回调沿用原请求号。",
}
const secondSnapshot: ConversationSnapshot = {
  ...firstSnapshot, id: "callback-review-v2", version: "v2", uploadedAt: "2026-11-16 10:45",
  rangeLabel: "已上传消息 1–4", text: `${firstSnapshot.text}\n\n状态已完成时，直接返回原结果。`,
}
const registrations = new Map<string, typeof conversation>()

/** 引用模式使用工作台的正常入口，只有快照、宿主回包和发送计数使用固定样例。 */
export const referenceHosts: ComponentProps<typeof DesktopWorkbench> = {
  ...hosts,
  host: {
    ...hosts.host,
    async chooseDirectory() { return "/示例/协作补充资料" },
  },
  projectConversations: {
    ...hosts.projectConversations,
    async listConversations(workspaceId, projectId) {
      if (workspaceId !== workspace.id || projectId !== project.projectId) return unavailable()
      return ok({ projectId, conversations: [conversation, sourceConversation, ...registrations.values()] })
    },
    async registerConversation(workspaceId, projectId, request) {
      if (workspaceId !== workspace.id || projectId !== project.projectId || request.deviceId !== device.deviceId) return unavailable()
      const prior = registrations.get(request.requestId)
      if (prior) return ok({ conversation: prior })
      const created = { ...conversation, title: request.title ?? "新会话", conversationId: `created-${registrations.size + 1}` }
      registrations.set(request.requestId, created)
      return ok({ conversation: created })
    },
  },
  async referenceSnapshots(scope, request) {
    const data = document.documentElement.dataset
    data.hc219SnapshotReads = String(Number(data.hc219SnapshotReads) + 1)
    if (scope.workspaceId === workspace.id && scope.projectId === project.projectId) {
      if (request.kind === "preview" && request.conversationId === sourceConversation.conversationId) {
        return { ok: true, value: firstSnapshot }
      }
      if (request.kind === "refresh" && [firstSnapshot.id, secondSnapshot.id].includes(request.referenceId)) {
        return { ok: true, value: secondSnapshot }
      }
    }
    return { ok: false, message: "当前会话没有可引用的示例快照。" }
  },
  execution: {
    getAvailability: () => ({ available: true }),
    async send() {
      const data = document.documentElement.dataset
      data.hc219SendCalls = String(Number(data.hc219SendCalls) + 1)
      return { status: "rejected", message: "此预览只记录发送调用。" }
    },
  },
}
