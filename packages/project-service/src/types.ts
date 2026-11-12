/** 项目公开端口的数据与拒绝原因。文件路径始终相对受信宿主注入的根。 */

export type ProjectErrorCode =
  | "root-changed" | "invalid-path" | "outside-project" | "not-found" | "permission-denied"
  | "unsupported" | "binary-file" | "unsupported-encoding" | "file-changed" | "cursor-expired" | "io-error" | "limit-exceeded"
  | "git-unavailable" | "git-root-required" | "git-busy" | "git-blocked" | "git-stale"
  | "invalid-selection" | "git-failed" | "upstream-unavailable" | "upstream-changed"
  | "result-unknown"

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

export type ProjectCommitInput = {
  snapshot: string
  paths: readonly string[]
  message: string
  alsoPush?: boolean
}

export type ProjectPushInput = { snapshot: string; commitSha: string }

export type ProjectPushResult =
  | { status: "not-requested" | "succeeded" }
  | { status: "not-started" | "failed" | "unknown"; code: ProjectErrorCode; message: string }

export type ProjectCommitResult =
  | { status: "succeeded"; commitSha: string; warning?: string; push: ProjectPushResult }
  | { status: "not-started" | "failed" | "unknown"; code: ProjectErrorCode; message: string; push: ProjectPushResult }

/** 本机服务。读取失败抛出稳定错误，写入分别返回未调用、确切失败、成功或待确认。 */
export interface ProjectService {
  listDirectory(directory?: string, cursor?: string): Promise<ProjectDirectory>
  searchCandidates(input: { directory: string; query: string; limit?: number }): Promise<ProjectCandidates>
  readPreview(path: string): Promise<ProjectPreview>
  gitStatus(): Promise<ProjectGitStatus>
  gitDiff(input: { snapshot: string; path: string }): Promise<ProjectGitDiff>
  commit(input: ProjectCommitInput): Promise<ProjectCommitResult>
  push(input: ProjectPushInput): Promise<ProjectPushResult>
}
