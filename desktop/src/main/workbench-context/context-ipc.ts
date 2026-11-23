/** 用户确认/纠正目录的受限入口：真实会话归属核对 → 原生选择/确认 → 复核登录代次 → 立即保存。 */
import { dialog, type BrowserWindow } from "electron"
import type { CollaborationState } from "@workbench/collaboration-client"
import type { LocalExecutionScope } from "../../shared/local-execution-host.js"
import { createCollaborationIpcRegistrar, formatIpcError, isPlainObject, isUserId, isUuid } from "../ipc-guard.js"
import type { WorkbenchContextService } from "./service.js"

const validScope = (value: unknown): value is LocalExecutionScope => isPlainObject(value)
  && Object.keys(value).every(k => ["accountId", "workspaceId", "projectId", "conversationId"].includes(k))
  && isUserId(value.accountId) && isUuid(value.workspaceId) && (value.projectId === null || isUuid(value.projectId)) && isUuid(value.conversationId)
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

/** 不改变会话cwd，也不发放文件访问权限；窗口关闭时由组合入口解除全部处理器。 */
export function bindWorkbenchContextIpc(window: BrowserWindow, trustedUrl: string, identity: CollaborationState, context: WorkbenchContextService): () => void {
  const ipc = createCollaborationIpcRegistrar({ window, trustedUrl, messages: { sourceRejected: "不允许的项目记忆请求来源。", invalidRequest: "项目记忆参数无效。", internalError: "项目记忆操作失败。" } })
  const invalid = () => formatIpcError("INVALID_REQUEST", "项目记忆参数无效。")
  const current = (snapshot: ReturnType<CollaborationState["personalIdentity"]>) => {
    const now = identity.personalIdentity()
    return snapshot && now?.generation === snapshot.generation && now.accountId === snapshot.accountId && !window.isDestroyed()
  }
  ipc.handle("workbench:context:list-directories", 1, async scope => {
    if (!validScope(scope)) return invalid()
    return { ok: true, value: await context.listDirectories(scope) }
  })
  ipc.handle("workbench:context:confirm-directory", 2, async (scope, input) => {
    if (!validScope(scope) || !isPlainObject(input) || Object.keys(input).some(k => !["name", "entryId", "baseEntryRevision"].includes(k))
      || typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 || /[\p{Cc}]/u.test(input.name)
      || input.entryId !== undefined && !isUuid(input.entryId) || !revision(input.baseEntryRevision)) return invalid()
    await context.listDirectories(scope)
    const snapshot = identity.personalIdentity()
    const selected = await dialog.showOpenDialog(window, { title: "关联本机工程目录（保留当前会话起始目录）", properties: ["openDirectory"] })
    if (!current(snapshot)) return formatIpcError("AUTHENTICATION_REQUIRED", "发起选择的账号已变化，未保存。")
    if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: { status: "cancelled", message: "已取消，目录映射未变。" } }
    const result = await context.confirmDirectory(scope, { path: selected.filePaths[0], fields: { name: input.name.trim(), summary: "本人明确选择的工程副本。", ...(scope.projectId ? { projectIds: [scope.projectId] } : {}) }, entryId: input.entryId as string | undefined, baseEntryRevision: input.baseEntryRevision })
    return { ok: true, value: result }
  })
  ipc.handle("workbench:context:remove-directory", 3, async (scope, entryId, baseEntryRevision) => {
    if (!validScope(scope) || !isUuid(entryId) || !revision(baseEntryRevision)) return invalid()
    const entries = await context.listDirectories(scope)
    const entry = entries.find(item => item.entryId === entryId)
    if (!entry) return formatIpcError("RESOURCE_NOT_FOUND", "目录记录已不可读。")
    const snapshot = identity.personalIdentity()
    const confirmed = await dialog.showMessageBox(window, { type: "question", message: `移除“${entry.name}”的目录映射？`, detail: "只移除本机记忆记录，磁盘文件和会话起始目录保持原状。", buttons: ["取消", "移除记录"], defaultId: 0, cancelId: 0, noLink: true })
    if (!current(snapshot)) return formatIpcError("AUTHENTICATION_REQUIRED", "账号已变化，未移除。")
    if (confirmed.response !== 1) return { ok: true, value: { status: "cancelled", message: "已取消，目录映射未变。" } }
    return { ok: true, value: await context.removeConfirmedEntry(scope, { kind: "personal_directory", entryId, baseEntryRevision }) }
  })
  return () => ipc.dispose()
}
