/**
 * 本机目录授权宿主：按账号、团队、Project 和会话保存用户主动选择的目录。
 * 通用文件/Git 读取由 project-service 执行；本模块只管理绑定并映射既有桌面端口。
 *
 * 用户选目录 → 绑定独立服务实例 → 核对当前账号/会话 → 有界读取 → 桌面结果
 *
 * 非 Git 目录与仓库子目录继续提供文件阅读。宿主仅暴露五种只读动作，
 * 不把通用包的提交/推送能力暴露给 IPC，也不提供跨机器文件访问。
 */
import { isAbsolute } from "node:path"
import { createProjectService, ProjectServiceError } from "@workbench/project-service"
import type { ProjectErrorCode, ProjectService } from "@workbench/project-service"
import type {
  CollaborationResult,
  LocalDirectoryHost,
  ProjectGitStatusValue,
  ProjectReadAction,
  ProjectReadFailureCode,
  ProjectReadResponse,
} from "@workbench/contracts"
import { identityError } from "./collaboration-state.js"

/** 通用包的本机原因映射为现有 IPC 错误；未知故障不泄露路径和命令环境。 */
const READ_ERRORS: Partial<Record<ProjectErrorCode, ProjectReadFailureCode>> = {
  "root-changed": "PROJECT_ROOT_CHANGED",
  "invalid-path": "PROJECT_PATH_INVALID",
  "outside-project": "PROJECT_FILE_DENIED",
  "not-found": "PROJECT_FILE_NOT_FOUND",
  "permission-denied": "PROJECT_FILE_DENIED",
  unsupported: "PROJECT_FILE_UNSUPPORTED",
  "binary-file": "PROJECT_FILE_UNSUPPORTED",
  "unsupported-encoding": "PROJECT_FILE_UNSUPPORTED",
  "file-changed": "PROJECT_FILE_CHANGED",
  "cursor-expired": "PROJECT_CURSOR_EXPIRED",
  "limit-exceeded": "PROJECT_LIMIT_EXCEEDED",
  "git-unavailable": "PROJECT_GIT_UNAVAILABLE",
  "git-root-required": "PROJECT_GIT_ROOT_REQUIRED",
  "git-busy": "PROJECT_BUSY",
  "git-stale": "PROJECT_GIT_STALE",
  "invalid-selection": "PROJECT_FILE_NOT_FOUND",
}

function readFailure(error: unknown) {
  return error instanceof ProjectServiceError
    ? identityError(READ_ERRORS[error.code] ?? "PROJECT_READ_FAILED", error.message)
    : identityError("PROJECT_READ_FAILED", "本机工作目录读取失败。")
}

function bindingKey(accountId: string, workspaceId: string, projectId: string, conversationKey: string): string {
  return `${accountId}\0${workspaceId}\0${projectId}\0${conversationKey}`
}

function nonGitStatus(): ProjectGitStatusValue {
  return {
    branch: null,
    head: null,
    files: [],
    snapshot: "non-git",
    upstream: null,
    blockedReason: "当前目录不是 Git 仓库，仅提供本地文件浏览；Git 写操作已暂缓。",
  }
}

/** 每个会话绑定一个受信本机服务实例；切换账号后不能读取另一账号的绑定。 */
export class LocalDirectoryService implements LocalDirectoryHost {
  readonly #getAccountId: () => string | null
  readonly #bindings = new Map<string, ProjectService>()

  constructor(getAccountId: () => string | null) {
    this.#getAccountId = getAccountId
  }

  async bindDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    directoryPath: string,
  ): Promise<CollaborationResult<{ directoryPath: string; isGitRepository: boolean }>> {
    const accountId = this.#getAccountId()
    if (!accountId) return identityError("AUTHENTICATION_REQUIRED", "请先登录后再选择本机工作目录。")
    if (!workspaceId.trim() || !projectId.trim() || !conversationKey.trim()) {
      return identityError("INVALID_REQUEST", "缺少会话标识，无法绑定本机工作目录。")
    }
    if (!directoryPath || !isAbsolute(directoryPath) || directoryPath.includes("\0")) {
      return identityError("PROJECT_PATH_INVALID", "请选择有效的工作目录绝对路径。")
    }
    try {
      const service = await createProjectService(directoryPath)
      if (accountId !== this.#getAccountId()) {
        return identityError("AUTHENTICATION_REQUIRED", "登录账号已变化，请重新选择本机工作目录。")
      }
      this.#bindings.set(bindingKey(accountId, workspaceId, projectId, conversationKey), service)
      return { ok: true, value: { directoryPath: service.directoryPath, isGitRepository: service.isGitRepository } }
    } catch (error) {
      return readFailure(error)
    }
  }

  async readDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    action: ProjectReadAction,
  ): Promise<CollaborationResult<ProjectReadResponse>> {
    const accountId = this.#getAccountId()
    if (!accountId) return identityError("AUTHENTICATION_REQUIRED", "请先登录后再读取本机工作目录。")
    const key = bindingKey(accountId, workspaceId, projectId, conversationKey)
    const service = this.#bindings.get(key)
    if (!service) return identityError("RESOURCE_NOT_FOUND", "当前会话尚未绑定本机工作目录。")
    try {
      let response: ProjectReadResponse
      switch (action.kind) {
        case "listDirectory": {
          const value = await service.listDirectory(action.directory, action.cursor)
          response = { kind: action.kind, value: { ...value, entries: [...value.entries] } }
          break
        }
        case "searchCandidates": {
          const value = await service.searchCandidates({ ...action, limit: action.limit ?? 200 })
          response = { kind: action.kind, value: { ...value, items: value.items.map(item => ({ ...item, matchRanges: [...item.matchRanges] })) } }
          break
        }
        case "readPreview":
          response = { kind: action.kind, value: await service.readPreview(action.path) }
          break
        case "gitStatus": {
          try {
            const value = await service.gitStatus()
            response = { kind: action.kind, value: { ...value, files: [...value.files] } }
          } catch (error) {
            if (!(error instanceof ProjectServiceError)
              || !["git-unavailable", "git-root-required"].includes(error.code)) throw error
            response = { kind: action.kind, value: nonGitStatus() }
          }
          break
        }
        case "gitDiff":
          try {
            response = { kind: action.kind, value: await service.gitDiff(action) }
          } catch (error) {
            if (error instanceof ProjectServiceError && error.code === "git-root-required") {
              return identityError("PROJECT_GIT_UNAVAILABLE", "当前目录不是 Git 仓库，无差异可查看。")
            }
            throw error
          }
          break
      }
      // 读取期间切换账号或重选目录后，旧结果不再交给当前页面。
      if (accountId !== this.#getAccountId() || this.#bindings.get(key) !== service) {
        return identityError("RESOURCE_NOT_FOUND", "当前会话的本机工作目录绑定已变化，请刷新。")
      }
      return { ok: true, value: response }
    } catch (error) {
      return readFailure(error)
    }
  }
}
