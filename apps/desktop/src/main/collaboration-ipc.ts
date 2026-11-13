/** 身份/设备 IPC 只接受固定方法；来源/数量/参数 → 窗口独有状态 → 不含凭据的结果。 */
import { app, dialog, ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import { CollaborationState, identityError } from "./collaboration-state.js"
import { DeviceHost } from "./device-host.js"
import { bindDeviceIpc } from "./device-ipc.js"
import { bindOrganizationIpc } from "./organization-ipc.js"
import type { RunnerSupervisor } from "./runner-supervisor.js"
import { verifyDesktopSource } from "./trusted-source.js"
import type { ConversationHistoryPage, ConversationPageCursor, ProjectReadAction } from "@workbench/contracts"
import { randomUUID } from "node:crypto"
import { PersonalStore } from "./personal-store.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SEQUENCE = /^(?:0|[1-9][0-9]{0,18})$/
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value)
const isSequence = (value: unknown): value is string => typeof value === "string" && SEQUENCE.test(value) && BigInt(value) <= MAX_SEQUENCE
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function isCursor(value: unknown): value is ConversationPageCursor | null {
  if (value === null) return true
  if (!isObject(value) || Object.keys(value).length !== 2 || !isId(value.beforeId) || typeof value.beforeCreatedAt !== "string" || !UTC.test(value.beforeCreatedAt)) return false
  const timestamp = new Date(value.beforeCreatedAt)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value.beforeCreatedAt
}

function isHistoryPage(value: unknown): value is ConversationHistoryPage {
  if (!isObject(value) || Object.keys(value).some(key => !["afterSequence", "throughSequence", "limit"].includes(key)) || !isSequence(value.afterSequence)) return false
  if (value.throughSequence !== undefined && (!isSequence(value.throughSequence) || BigInt(value.afterSequence) > BigInt(value.throughSequence))) return false
  return value.limit === undefined || typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200
}

export function bindCollaborationIpc(window: BrowserWindow, trustedUrl: string, supervisor: RunnerSupervisor, onCloseAborted: () => void): void {
  const identity = new CollaborationState(process.env.WORKBENCH_SERVICE_ORIGIN)
  const client = identity.network()
  const personal = new PersonalStore(identity, client ? process.env.WORKBENCH_SERVICE_ORIGIN! : "", app.getPath("userData"))
  if (client) bindDeviceIpc(window, trustedUrl, new DeviceHost(client, supervisor, () => window.isDestroyed() ? null : window, identity))
  const unbindOrganization = bindOrganizationIpc(window, trustedUrl, identity)
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
  handle("conversations", 2, (workspaceId, cursor) => isId(workspaceId) && isCursor(cursor)
    ? identity.listConversations(workspaceId, cursor) : identityError("INVALID_REQUEST", "会话列表参数无效。"))
  handle("conversation", 2, (workspaceId, conversationId) => isId(workspaceId) && isId(conversationId)
    ? identity.getConversation(workspaceId, conversationId) : identityError("INVALID_REQUEST", "会话标识无效。"))
  handle("history", 3, (workspaceId, conversationId, page) => isId(workspaceId) && isId(conversationId) && isHistoryPage(page)
    ? identity.readHistory(workspaceId, conversationId, page) : identityError("INVALID_REQUEST", "历史分页参数无效。"))
  handle("project-read", 3, (workspaceId, conversationId, action) => isId(workspaceId) && isId(conversationId) && isObject(action)
    ? identity.readProject(workspaceId, conversationId, action as ProjectReadAction) : identityError("INVALID_REQUEST", "项目读取参数无效。"))
  handle("subscribe-conversation", 3, (workspaceId, conversationId, afterSequence) => isId(workspaceId) && isId(conversationId) && isSequence(afterSequence)
    ? identity.subscribeConversation(workspaceId, conversationId, afterSequence) : identityError("INVALID_REQUEST", "会话订阅参数无效。"))
  handle("conversation-events", 2, (subscriptionId, afterSequence) => isId(subscriptionId) && isSequence(afterSequence)
    ? identity.readConversationEvents(subscriptionId, afterSequence) : identityError("INVALID_REQUEST", "会话事件读取参数无效。"))
  handle("unsubscribe-conversation", 1, subscriptionId => isId(subscriptionId)
    ? identity.unsubscribeConversation(subscriptionId) : identityError("INVALID_REQUEST", "会话订阅标识无效。"))
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
