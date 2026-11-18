/**
 * 【功能定义】本机项目只读服务公开端口的数据结构与失败语义定义。
 * 【协作边界】文件路径始终相对受信宿主注入的项目根；跨机器 Git 写入（commit/push）已按设计暂缓，不纳入本端口。
 */

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

export type ProjectEntry = {
  path: string
  name: string
  kind: "directory" | "file" | "symlink"
  expandable: boolean
}

export type ProjectDirectory = {
  entries: readonly ProjectEntry[]
  truncated: boolean
  nextCursor?: string
}

export type ProjectCandidates = {
  items: readonly (ProjectEntry & { matchRanges: readonly { start: number; end: number }[] })[]
  total?: number
  truncated: boolean
}

export type ProjectPreview = {
  path: string
  content: string
  language: string | null
  sizeBytes: number
  displayedBytes: number
  lineCount: number
  truncated: boolean
}

export type ProjectGitFile = {
  path: string
  oldPath?: string
  status: string
  version: string
}

export type ProjectGitStatus = {
  branch: string | null
  head: string | null
  files: readonly ProjectGitFile[]
  snapshot: string
  upstream: { remote: string; branch: string; ahead: number; behind: number } | null
  blockedReason: string | null
}

export type ProjectGitDiff = {
  snapshot: string
  path: string
  text: string
  truncated: boolean
}

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
