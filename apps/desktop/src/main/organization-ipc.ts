/**
 * 组织层 IPC：来源校验 → 参数个数与 UUID 校验 → 窗口身份状态发请求 → 返回不含凭据的结果。
 * 请求体的字段与长度由网络客户端按组织层 Schema 再校验，这里只拦截形状明显错误的调用。
 */
import { ipcMain } from "electron"
import type { BrowserWindow } from "electron"
import type { CollaborationState } from "./collaboration-state.js"
import { identityError } from "./collaboration-state.js"
import { verifyDesktopSource } from "./trusted-source.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ids = (...values: unknown[]): boolean => values.every(value => typeof value === "string" && UUID.test(value))
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const invalid = () => identityError("INVALID_REQUEST", "项目请求参数无效。")

/** 通道随窗口关闭一起注销，不能被其他窗口复用。 */
export function bindOrganizationIpc(window: BrowserWindow, trustedUrl: string, identity: CollaborationState): () => void {
  const channels: string[] = []
  function handle(name: string, count: number, action: (...args: unknown[]) => unknown) {
    const channel = `organization:${name}`
    channels.push(channel)
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try { verifyDesktopSource(window, trustedUrl, event) }
      catch { return identityError("REQUEST_SOURCE_REJECTED", "不允许的项目请求来源。") }
      if (args.length !== count) return invalid()
      try { return await action(...args) }
      catch { return identityError("INTERNAL_ERROR", "项目操作暂时无法完成。") }
    })
  }
  handle("list-projects", 1, workspace => ids(workspace) ? identity.listProjects(workspace as string) : invalid())
  handle("create-project", 2, (workspace, request) => ids(workspace) && isObject(request)
    ? identity.createProject(workspace as string, request as never) : invalid())
  handle("get-project", 2, (workspace, project) => ids(workspace, project) ? identity.getProject(workspace as string, project as string) : invalid())
  handle("update-project", 3, (workspace, project, request) => ids(workspace, project) && isObject(request)
    ? identity.updateProject(workspace as string, project as string, request as never) : invalid())
  handle("add-member", 3, (workspace, project, request) => ids(workspace, project) && isObject(request)
    ? identity.addProjectMember(workspace as string, project as string, request as never) : invalid())
  handle("remove-member", 3, (workspace, project, user) => ids(workspace, project, user)
    ? identity.removeProjectMember(workspace as string, project as string, user as string) : invalid())
  handle("list-repositories", 1, workspace => ids(workspace) ? identity.listRepositories(workspace as string) : invalid())
  handle("link-repository", 3, (workspace, project, repository) => ids(workspace, project, repository)
    ? identity.linkRepository(workspace as string, project as string, repository as string) : invalid())
  handle("unlink-repository", 3, (workspace, project, repository) => ids(workspace, project, repository)
    ? identity.unlinkRepository(workspace as string, project as string, repository as string) : invalid())
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
