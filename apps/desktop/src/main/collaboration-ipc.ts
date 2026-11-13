/** 身份/设备/项目会话 IPC 只接受固定方法；来源/数量/参数 → 窗口独有状态 → 不含凭据的结果。 */
import { app, dialog, ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import { CollaborationState, identityError } from "./collaboration-state.js"
import { DeviceHost } from "./device-host.js"
import { bindDeviceIpc } from "./device-ipc.js"
import { bindOrganizationIpc } from "./organization-ipc.js"
import type { RunnerSupervisor } from "./runner-supervisor.js"
import { verifyDesktopSource } from "./trusted-source.js"
import type { ConversationRegisterRequest, ConversationStatus, ProjectReadAction } from "@workbench/contracts"
import { randomUUID } from "node:crypto"
import { LocalDirectoryService } from "./local-directory-host.js"
import { PersonalStore } from "./personal-store.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USER_ID = /^[0-9a-f]{32}$/
const CONVERSATION_STATUSES = new Set(["idle", "running", "waiting_approval", "error"])
const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value)
const isUserId = (value: unknown): value is string => typeof value === "string" && USER_ID.test(value)
const isNonEmptyString = (value: unknown, maxLength = 4096): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function isProjectReadAction(value: unknown): value is ProjectReadAction {
  if (!isObject(value) || typeof value.kind !== "string") return false
  switch (value.kind) {
    case "listDirectory":
      return typeof value.directory === "string" && (value.cursor === undefined || typeof value.cursor === "string")
    case "searchCandidates":
      return typeof value.directory === "string" && typeof value.query === "string"
        && (value.limit === undefined || (typeof value.limit === "number" && Number.isSafeInteger(value.limit) && value.limit > 0))
    case "readPreview":
      return typeof value.path === "string"
    case "gitStatus":
      return true
    case "gitDiff":
      return typeof value.snapshot === "string" && typeof value.path === "string"
    default:
      return false
  }
}

function isConversationQuery(value: unknown): value is { ownerId?: string; status?: ConversationStatus } | undefined {
  if (value === undefined) return true
  if (!isObject(value) || Object.keys(value).some(key => key !== "ownerId" && key !== "status")) return false
  if (value.ownerId !== undefined && !isUserId(value.ownerId)) return false
  return value.status === undefined || (typeof value.status === "string" && CONVERSATION_STATUSES.has(value.status))
}

function isHistoryLimit(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 500)
}

export function bindCollaborationIpc(window: BrowserWindow, trustedUrl: string, supervisor: RunnerSupervisor, onCloseAborted: () => void): void {
  const identity = new CollaborationState(process.env.WORKBENCH_SERVICE_ORIGIN)
  const client = identity.network()
  const personal = new PersonalStore(identity, client ? process.env.WORKBENCH_SERVICE_ORIGIN! : "", app.getPath("userData"))
  const localDirectory = new LocalDirectoryService(() => identity.personalIdentity()?.accountId ?? null)
  if (client) bindDeviceIpc(window, trustedUrl, new DeviceHost(client, supervisor, () => window.isDestroyed() ? null : window, identity))
  const unbindOrganization = bindOrganizationIpc(window, trustedUrl, identity)
  const channels: string[] = []
  const unsubscribe = identity.onStateChanged(state => {
    if (!window.isDestroyed()) window.webContents.send("collaboration:state", state)
  })
  function handle(channel: string, count: number, action: (...args: unknown[]) => unknown) {
    channels.push(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try { verifyDesktopSource(window, trustedUrl, event) }
      catch { return identityError("REQUEST_SOURCE_REJECTED", "不允许的身份请求来源。") }
      if (args.length !== count) return identityError("INVALID_REQUEST", "请求参数无效。")
      try { return await action(...args) }
      catch { return identityError("INTERNAL_ERROR", "操作暂时无法完成。") }
    })
  }
  handle("collaboration:get-state", 0, () => identity.getState())
  handle("collaboration:demo-users", 0, () => identity.listDemoUsers())
  handle("collaboration:sign-in", 1, userNo => typeof userNo === "string" && /^[0-9a-z][0-9a-z_-]{0,31}$/.test(userNo) ? identity.signIn(userNo) : identityError("INVALID_REQUEST", "员工工号无效。"))
  handle("collaboration:sign-out", 0, () => identity.signOut())
  handle("collaboration:members", 1, id => isId(id) ? identity.listMembers(id) : identityError("INVALID_REQUEST", "工作区标识无效。"))

  handle("workbench:project-conversations:list", 3, (workspaceId, projectId, query) =>
    isId(workspaceId) && isId(projectId) && isConversationQuery(query)
      ? identity.listProjectConversations(workspaceId, projectId, query)
      : identityError("INVALID_REQUEST", "项目会话列表参数无效。"))
  handle("workbench:project-conversations:register", 3, (workspaceId, projectId, request) =>
    isId(workspaceId) && isId(projectId) && isObject(request)
      ? identity.registerProjectConversation(workspaceId, projectId, request as unknown as ConversationRegisterRequest)
      : identityError("INVALID_REQUEST", "项目会话登记参数无效。"))
  handle("workbench:project-conversations:get", 3, (workspaceId, projectId, conversationId) =>
    isId(workspaceId) && isId(projectId) && isId(conversationId)
      ? identity.getProjectConversation(workspaceId, projectId, conversationId)
      : identityError("INVALID_REQUEST", "项目会话标识无效。"))
  handle("workbench:project-conversations:history", 5, (workspaceId, projectId, conversationId, afterSequence, limit) =>
    isId(workspaceId) && isId(projectId) && isId(conversationId)
    && typeof afterSequence === "number" && Number.isSafeInteger(afterSequence) && afterSequence >= 0
    && isHistoryLimit(limit)
      ? identity.readProjectConversationHistory(workspaceId, projectId, conversationId, afterSequence, limit)
      : identityError("INVALID_REQUEST", "项目会话历史参数无效。"))

  handle("workbench:local-directory:bind", 4, (workspaceId, projectId, conversationKey, directoryPath) =>
    isId(workspaceId) && isId(projectId) && isNonEmptyString(conversationKey, 128) && isNonEmptyString(directoryPath, 4096)
      ? localDirectory.bindDirectory(workspaceId, projectId, conversationKey, directoryPath)
      : identityError("INVALID_REQUEST", "本机工作目录绑定参数无效。"))
  handle("workbench:local-directory:read", 4, (workspaceId, projectId, conversationKey, action) =>
    isId(workspaceId) && isId(projectId) && isNonEmptyString(conversationKey, 128) && isProjectReadAction(action)
      ? localDirectory.readDirectory(workspaceId, projectId, conversationKey, action)
      : identityError("INVALID_REQUEST", "本机工作目录读取参数无效。"))

  const personalChannels = ["personal:load", "personal:save", "personal:close-ready"]
  ipcMain.handle("personal:load", async (event, key: unknown) => {
    try { verifyDesktopSource(window, trustedUrl, event); return await personal.load(key) }
    catch { return { ok: false, message: "无法读取个人视图。" } }
  })
  ipcMain.handle("personal:save", async (event, key: unknown, revision: unknown, value: unknown) => {
    try { verifyDesktopSource(window, trustedUrl, event); return await personal.save(key, revision, value) }
    catch { return { ok: false, message: "无法保存个人视图。" } }
  })
  let allowedToClose = false
  let closeRequest: string | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  const closeFailed = () => {
    closeRequest = null
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    onCloseAborted()
    if (!window.isDestroyed()) dialog.showErrorBox("个人视图未保存", "请检查应用数据目录，然后再次关闭窗口。")
  }
  window.on("close", event => {
    if (allowedToClose) return
    event.preventDefault()
    if (closeRequest) return
    closeRequest = randomUUID()
    closeTimer = setTimeout(closeFailed, 10000)
    window.webContents.send("personal:prepare-close", closeRequest)
  })
  ipcMain.handle("personal:close-ready", async (event, request: unknown, ready: unknown) => {
    try { verifyDesktopSource(window, trustedUrl, event) } catch { return }
    if (typeof request !== "string" || request !== closeRequest || typeof ready !== "boolean") return
    if (!ready) { closeFailed(); return }
    const flushed = await personal.flush()
    // 超时后的旧结果不能取消用户发起的下一次关窗。
    if (request !== closeRequest) return
    if (!flushed) { closeFailed(); return }
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null; closeRequest = null; allowedToClose = true
    if (!window.isDestroyed()) window.close()
  })
  window.once("closed", () => {
    if (closeTimer) clearTimeout(closeTimer)
    unsubscribe(); unbindOrganization(); identity.dispose()
    for (const channel of [...channels, ...personalChannels]) ipcMain.removeHandler(channel)
  })
}
