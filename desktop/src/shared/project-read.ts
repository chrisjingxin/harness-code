/**
 * 【功能定义】本机授权目录只读请求、响应结构与失败码定义，路径始终相对已确认目录根。
 * 【协作边界】纯数据类型定义，由桌面主进程 `project-service` 实现、经 IPC 返回给渲染层。
 */

export type ProjectReadAction =
  | { kind: "listDirectory"; directory: string; cursor?: string }
  | { kind: "searchCandidates"; directory: string; query: string; limit?: number }
  | { kind: "readPreview"; path: string }
  | { kind: "gitStatus" }
  | { kind: "gitDiff"; snapshot: string; path: string }

export type ProjectReadEntry = {
  path: string
  name: string
  kind: "directory" | "file" | "symlink"
  expandable: boolean
}

export type ProjectDirectoryValue = {
  entries: readonly ProjectReadEntry[]
  truncated: boolean
  nextCursor?: string
}

export type ProjectCandidatesValue = {
  items: readonly (ProjectReadEntry & { matchRanges: readonly { start: number; end: number }[] })[]
  total?: number
  truncated: boolean
}

export type ProjectPreviewValue = {
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

export type ProjectGitStatusValue = {
  branch: string | null
  head: string | null
  files: readonly ProjectGitFile[]
  snapshot: string
  upstream: { remote: string; branch: string; ahead: number; behind: number } | null
  blockedReason: string | null
}

export type ProjectGitDiffValue = {
  snapshot: string
  path: string
  text: string
  truncated: boolean
}

export type ProjectReadResponse =
  | { kind: "listDirectory"; value: ProjectDirectoryValue }
  | { kind: "searchCandidates"; value: ProjectCandidatesValue }
  | { kind: "readPreview"; value: ProjectPreviewValue }
  | { kind: "gitStatus"; value: ProjectGitStatusValue }
  | { kind: "gitDiff"; value: ProjectGitDiffValue }

export type ProjectReadFailureCode =
  | "PROJECT_NOT_SHARED" | "SHARE_VERSION_CONFLICT" | "PROJECT_ROOT_CHANGED"
  | "PROJECT_BUSY" | "PROJECT_PATH_INVALID" | "PROJECT_FILE_NOT_FOUND" | "PROJECT_FILE_DENIED"
  | "PROJECT_FILE_UNSUPPORTED" | "PROJECT_FILE_CHANGED" | "PROJECT_CURSOR_EXPIRED"
  | "PROJECT_LIMIT_EXCEEDED" | "PROJECT_GIT_UNAVAILABLE" | "PROJECT_GIT_ROOT_REQUIRED"
  | "PROJECT_GIT_STALE" | "PROJECT_READ_FAILED"
