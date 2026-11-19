/**
 * 【功能定义】本机授权目录只读宿主适配层（HC-218 / HC-228）：
 * 按账号、工作区、项目与会话键隔离保存用户主动选定的本机工作目录，并将目录浏览、
 * `@` 文件候选检索、文本预览及 Git 只读状态/差异统一委托给 `./project-service`。
 *
 * 【协作边界】
 * - 运行于 Electron 主进程，通过 `collaboration-ipc.ts` 暴露为 `LocalDirectoryHost`。
 * - 所有路径合法性、防逃逸、符号链接校验、二进制拦截及非 Git 目录平静降级均由 `project-service` 统一承担。
 */
import { isAbsolute } from "node:path"
import type { CollaborationResult } from "@workbench/collaboration-client/types"
import { identityError } from "@workbench/collaboration-client"
import type {
  LocalDirectoryHost,
  ProjectReadAction,
  ProjectReadFailureCode,
  ProjectReadResponse,
} from "../shared/index.js"
import { createProjectService, ProjectServiceError } from "./project-service/index.js"
import type { ProjectErrorCode, ProjectService } from "./project-service/index.js"

const ERROR_CODE_MAP: Record<ProjectErrorCode, ProjectReadFailureCode> = {
  "root-changed": "PROJECT_ROOT_CHANGED",
  "invalid-path": "PROJECT_PATH_INVALID",
  "outside-project": "PROJECT_FILE_DENIED",
  "not-found": "PROJECT_FILE_NOT_FOUND",
  "permission-denied": "PROJECT_FILE_DENIED",
  "unsupported": "PROJECT_FILE_UNSUPPORTED",
  "binary-file": "PROJECT_FILE_UNSUPPORTED",
  "unsupported-encoding": "PROJECT_FILE_UNSUPPORTED",
  "file-changed": "PROJECT_FILE_CHANGED",
  "cursor-expired": "PROJECT_CURSOR_EXPIRED",
  "limit-exceeded": "PROJECT_LIMIT_EXCEEDED",
  "git-unavailable": "PROJECT_GIT_UNAVAILABLE",
  "git-root-required": "PROJECT_GIT_ROOT_REQUIRED",
  "git-busy": "PROJECT_BUSY",
  "git-blocked": "PROJECT_BUSY",
  "git-stale": "PROJECT_GIT_STALE",
  "invalid-selection": "PROJECT_FILE_NOT_FOUND",
  "git-failed": "PROJECT_READ_FAILED",
  "io-error": "PROJECT_READ_FAILED",
}

function bindingKey(accountId: string, workspaceId: string, projectId: string, conversationKey: string): string {
  return `${accountId}\0${workspaceId}\0${projectId}\0${conversationKey}`
}

function toDirectoryError(error: unknown): CollaborationResult<never> {
  if (error instanceof ProjectServiceError) {
    return identityError(ERROR_CODE_MAP[error.code] ?? "PROJECT_READ_FAILED", error.message)
  }
  return identityError("PROJECT_READ_FAILED", "本机工作目录读取失败。")
}

/**
 * 本机工作目录只读宿主适配器：
 * 绑定阶段通过 `createProjectService` 锁定真实目录实体与 Git 根属性，读取阶段按账号隔离路由。
 */
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
    if (!accountId) {
      return identityError("AUTHENTICATION_REQUIRED", "请先登录后再选择本机工作目录。")
    }
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
      return {
        ok: true,
        value: {
          directoryPath: service.rootPath,
          isGitRepository: service.isGitRepository,
        },
      }
    } catch (error) {
      return toDirectoryError(error)
    }
  }

  async readDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    action: ProjectReadAction,
  ): Promise<CollaborationResult<ProjectReadResponse>> {
    const accountId = this.#getAccountId()
    if (!accountId) {
      return identityError("AUTHENTICATION_REQUIRED", "请先登录后再读取本机工作目录。")
    }
    const key = bindingKey(accountId, workspaceId, projectId, conversationKey)
    const service = this.#bindings.get(key)
    if (!service) {
      return identityError("RESOURCE_NOT_FOUND", "当前会话尚未绑定本机工作目录。")
    }

    try {
      let response: ProjectReadResponse
      switch (action.kind) {
        case "listDirectory":
          response = { kind: "listDirectory", value: await service.listDirectory(action.directory, action.cursor) }
          break
        case "searchCandidates":
          response = {
            kind: "searchCandidates",
            value: await service.searchCandidates({
              directory: action.directory,
              query: action.query,
              limit: action.limit ?? 200,
            }),
          }
          break
        case "readPreview":
          response = { kind: "readPreview", value: await service.readPreview(action.path) }
          break
        case "gitStatus":
          response = { kind: "gitStatus", value: await service.gitStatus() }
          break
        case "gitDiff":
          response = { kind: "gitDiff", value: await service.gitDiff({ snapshot: action.snapshot, path: action.path }) }
          break
      }
      // 读取期间切换账号或重选目录后，旧结果不再交给当前页面。
      if (accountId !== this.#getAccountId() || this.#bindings.get(key) !== service) {
        return identityError("RESOURCE_NOT_FOUND", "当前会话的本机工作目录绑定已变化，请刷新。")
      }
      return { ok: true, value: response }
    } catch (error) {
      return toDirectoryError(error)
    }
  }
}
