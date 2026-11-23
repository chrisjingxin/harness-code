/** 团队管理的具名 IPC；来源/参数先检查，完整请求字段仍由客户端封闭 Schema 验证。 */
import type { BrowserWindow } from "electron"
import type { CollaborationState } from "@workbench/collaboration-client"
import type { WorkspaceMemberAddRequest, WorkspaceRoleChangeRequest, WorkspaceMemberRemovalRequest, RepositoryPatchRequest, RepositoryCreateRequest } from "@workbench/collaboration-client/types"
import { createCollaborationIpcRegistrar, formatIpcError, isPlainObject, isPositiveSafeInteger, isUserId, isUuid } from "./ipc-guard.js"
const invalid = () => formatIpcError("INVALID_REQUEST", "团队请求参数无效。")
const add = (v: unknown): v is WorkspaceMemberAddRequest => isPlainObject(v) && typeof v.userNo === "string" && isUuid(v.requestId)
const role = (v: unknown): v is WorkspaceRoleChangeRequest => isPlainObject(v) && ["admin", "developer"].includes(String(v.role)) && isUuid(v.requestId) && isPositiveSafeInteger(v.expectedVersion)
const remove = (v: unknown): v is WorkspaceMemberRemovalRequest => isPlainObject(v) && isUuid(v.requestId) && isPositiveSafeInteger(v.expectedMemberVersion) && typeof v.previewVersion === "string" && (v.defaultSuccessorUserId === null || isUserId(v.defaultSuccessorUserId)) && [v.projectSuccessors, v.taskSuccessors, v.repositorySuccessors, v.addToProjects].every(Array.isArray) && v.confirmResetTasks === true && v.confirmRetainHistory === true
const repository = (v: unknown): v is RepositoryPatchRequest => isPlainObject(v) && isPositiveSafeInteger(v.expectedVersion)
const createRepository = (v: unknown): v is RepositoryCreateRequest => isPlainObject(v) && typeof v.name === "string" && typeof v.remoteUrl === "string" && isUuid(v.requestId)
/** 端口随窗口释放；角色撤销不等同于退出账号，不取消其他团队的本机轮次。 */
export function bindWorkspaceIpc(window: BrowserWindow, trustedUrl: string, identity: CollaborationState): () => void {
  const ipc = createCollaborationIpcRegistrar({ window, trustedUrl, messages: { sourceRejected: "不允许的团队请求来源。", invalidRequest: "团队请求无效。", internalError: "团队操作未能完成。" } })
  ipc.handle("collaboration:refresh-identity", 0, () => identity.refreshIdentity())
  ipc.handle("workspace:access", 1, ws => isUuid(ws) ? identity.applicationWorkspace(ws, c => c.getWorkspaceAccess(ws)) : invalid())
  ipc.handle("workspace:add-member", 2, async (ws, request) => {
    if (!isUuid(ws) || !add(request)) return invalid()
    const result = await identity.applicationWorkspace(ws, c => c.addWorkspaceMember(ws, request))
    if (result.ok) await identity.refreshIdentity()
    return result
  })
  ipc.handle("workspace:role", 3, async (ws, user, request) => {
    if (!isUuid(ws) || !isUserId(user) || !role(request)) return invalid()
    const result = await identity.applicationWorkspace(ws, c => c.changeWorkspaceRole(ws, user, request))
    if (result.ok) await identity.refreshIdentity()
    return result
  })
  ipc.handle("workspace:removal-preview", 4, (ws, user, after, version) => isUuid(ws) && isUserId(user) && (after === null || typeof after === "string") && (version === undefined || typeof version === "string") ? identity.applicationWorkspace(ws, c => c.previewWorkspaceRemoval(ws, user, after, version)) : invalid())
  ipc.handle("workspace:remove", 3, async (ws, user, request) => {
    if (!isUuid(ws) || !isUserId(user) || !remove(request)) return invalid()
    const result = await identity.applicationWorkspace(ws, c => c.removeWorkspaceMember(ws, user, request))
    if (result.ok) await identity.refreshIdentity()
    return result
  })
  ipc.handle("workspace:update-repository", 3, (ws, id, request) => isUuid(ws) && isUuid(id) && repository(request) ? identity.applicationWorkspace(ws, c => c.updateRepository(ws, id, request)) : invalid())
  ipc.handle("workspace:create-repository", 2, (ws, request) => isUuid(ws) && createRepository(request) ? identity.applicationWorkspace(ws, c => c.createRepository(ws, request)) : invalid())
  const refresh = () => { if (identity.personalIdentity()) void identity.refreshIdentity() }
  window.on("focus", refresh)
  return () => { window.removeListener("focus", refresh); ipc.dispose() }
}
