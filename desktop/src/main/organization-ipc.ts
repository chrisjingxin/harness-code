/**
 * 组织层 IPC：统一 IPC 守卫校验来源与参数数量 → 标识与请求体类型守卫 → 窗口工作区守卫发请求 → 返回不含凭据的结果。
 * 请求体的字段细节由网络客户端按组织层 Schema 再校验，这里只做零强转的形状守卫。
 */
import type { BrowserWindow } from "electron"
import type {
  ProjectCreateRequest, ProjectMemberAddRequest, ProjectPatchRequest,
} from "@workbench/collaboration-client/types"
import type { CollaborationState } from "@workbench/collaboration-client"
import {
  createCollaborationIpcRegistrar, formatIpcError, isPlainObject, isPositiveSafeInteger, isUserId, isUuid,
} from "./ipc-guard.js"

const invalid = () => formatIpcError("INVALID_REQUEST", "项目请求参数无效。")

function isProjectCreateRequest(value: unknown): value is ProjectCreateRequest {
  return isPlainObject(value)
    && typeof value.name === "string"
    && typeof value.description === "string"
    && typeof value.requestId === "string"
}

function isProjectPatchRequest(value: unknown): value is ProjectPatchRequest {
  return isPlainObject(value)
    && isPositiveSafeInteger(value.expectedVersion)
    && (value.name === undefined || typeof value.name === "string")
    && (value.description === undefined || typeof value.description === "string")
    && (value.status === undefined || value.status === "archived")
}

function isProjectMemberAddRequest(value: unknown): value is ProjectMemberAddRequest {
  return isPlainObject(value)
    && typeof value.userId === "string"
    && typeof value.requestId === "string"
}

/** 通道随窗口关闭一起注销，不能被其他窗口复用。 */
export function bindOrganizationIpc(window: BrowserWindow, trustedUrl: string, identity: CollaborationState): () => void {
  const ipc = createCollaborationIpcRegistrar({
    window,
    trustedUrl,
    messages: {
      sourceRejected: "不允许的项目请求来源。",
      invalidRequest: "项目请求参数无效。",
      internalError: "项目操作暂时无法完成。",
    },
  })

  ipc.handle("organization:list-projects", 1, workspace =>
    isUuid(workspace)
      ? identity.withWorkspace(workspace, client => client.listProjects(workspace), { publishConnectionError: false })
      : invalid())
  ipc.handle("organization:create-project", 2, (workspace, request) =>
    isUuid(workspace) && isProjectCreateRequest(request)
      ? identity.withWorkspace(workspace, client => client.createProject(workspace, request))
      : invalid())
  ipc.handle("organization:get-project", 2, (workspace, project) =>
    isUuid(workspace) && isUuid(project)
      ? identity.withWorkspace(workspace, client => client.getProject(workspace, project), { publishConnectionError: false })
      : invalid())
  ipc.handle("organization:update-project", 3, (workspace, project, request) =>
    isUuid(workspace) && isUuid(project) && isProjectPatchRequest(request)
      ? identity.withWorkspace(workspace, client => client.updateProject(workspace, project, request))
      : invalid())
  ipc.handle("organization:add-member", 3, (workspace, project, request) =>
    isUuid(workspace) && isUuid(project) && isProjectMemberAddRequest(request)
      ? identity.withWorkspace(workspace, client => client.addProjectMember(workspace, project, request))
      : invalid())
  ipc.handle("organization:remove-member", 3, (workspace, project, user) =>
    isUuid(workspace) && isUuid(project) && isUserId(user)
      ? identity.withWorkspace(workspace, client => client.removeProjectMember(workspace, project, user))
      : invalid())
  ipc.handle("organization:list-repositories", 1, workspace =>
    isUuid(workspace)
      ? identity.withWorkspace(workspace, client => client.listRepositories(workspace))
      : invalid())
  ipc.handle("organization:link-repository", 3, (workspace, project, repository) =>
    isUuid(workspace) && isUuid(project) && isUuid(repository)
      ? identity.withWorkspace(workspace, client => client.linkRepository(workspace, project, repository))
      : invalid())
  ipc.handle("organization:unlink-repository", 3, (workspace, project, repository) =>
    isUuid(workspace) && isUuid(project) && isUuid(repository)
      ? identity.withWorkspace(workspace, client => client.unlinkRepository(workspace, project, repository))
      : invalid())

  return () => ipc.dispose()
}
