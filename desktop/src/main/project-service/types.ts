/**
 * 【功能定义】本机项目只读服务公开端口的数据结构与失败语义定义。
 * 【协作边界】直接复用 `desktop/src/shared/project-read.ts` 的唯一数据结构，避免双份类型映射。
 */
import type {
  ProjectCandidatesValue,
  ProjectDirectoryValue,
  ProjectGitDiffValue,
  ProjectGitFile,
  ProjectGitStatusValue,
  ProjectPreviewValue,
  ProjectReadEntry,
} from "../../shared/project-read.js"

export type ProjectErrorCode =
  | "root-changed" | "invalid-path" | "outside-project" | "not-found" | "permission-denied"
  | "unsupported" | "binary-file" | "unsupported-encoding" | "file-changed" | "cursor-expired" | "io-error" | "limit-exceeded"
  | "git-unavailable" | "git-root-required" | "git-busy" | "git-blocked" | "git-stale"
  | "invalid-selection" | "git-failed"

export class ProjectServiceError extends Error {
  constructor(readonly code: ProjectErrorCode, message: string) {
    super(message)
    this.name = "ProjectServiceError"
  }
}

export type ProjectEntry = ProjectReadEntry
export type ProjectDirectory = ProjectDirectoryValue
export type ProjectCandidates = ProjectCandidatesValue
export type ProjectPreview = ProjectPreviewValue
export type ProjectGitStatus = ProjectGitStatusValue
export type ProjectGitDiff = ProjectGitDiffValue
export type { ProjectGitFile }

/** 本机只读项目服务：提供目录浏览、@ 候选检索、正文预览与 Git 只读状态/差异。 */
export interface ProjectService {
  readonly rootPath: string
  readonly isGitRepository: boolean
  listDirectory(directory?: string, cursor?: string): Promise<ProjectDirectory>
  searchCandidates(input: { directory: string; query: string; limit?: number }): Promise<ProjectCandidates>
  readPreview(path: string): Promise<ProjectPreview>
  gitStatus(): Promise<ProjectGitStatus>
  gitDiff(input: { snapshot: string; path: string }): Promise<ProjectGitDiff>
}
