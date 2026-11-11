/** 原设备项目只读请求与设备回包，路径仅表示登记项目内的相对位置。 */
import type { ShareVersion, UtcTimestamp, Uuid } from "./conversation.js"

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
export type ProjectDirectoryValue = { entries: ProjectReadEntry[]; truncated: boolean; nextCursor?: string }
export type ProjectCandidatesValue = {
  items: (ProjectReadEntry & { matchRanges: { start: number; end: number }[] })[]
  total?: number
  truncated: boolean
}
export type ProjectPreviewValue = {
  path: string; content: string; language: string | null
  sizeBytes: number; displayedBytes: number; lineCount: number; truncated: boolean
}
export type ProjectGitStatusValue = {
  branch: string | null; head: string | null
  files: { path: string; oldPath?: string; status: string; version: string }[]
  snapshot: string
  upstream: { remote: string; branch: string; ahead: number; behind: number } | null
  blockedReason: string | null
}
export type ProjectGitDiffValue = { snapshot: string; path: string; text: string; truncated: boolean }
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

export interface ProjectReadCommand {
  protocolVersion: 1
  messageId: Uuid
  type: "project.read"
  occurredAt: UtcTimestamp
  payload: { workspaceId: Uuid; deviceId: Uuid; projectId: Uuid; shareVersion: ShareVersion; action: ProjectReadAction }
}
export interface ProjectReadReply {
  protocolVersion: 1
  messageId: Uuid
  type: "project.read.result"
  occurredAt: UtcTimestamp
  payload: {
    requestMessageId: Uuid
    workspaceId: Uuid
    deviceId: Uuid
    projectId: Uuid
    shareVersion: ShareVersion
    kind: ProjectReadAction["kind"]
    result: { status: "ok"; response: ProjectReadResponse } | { status: "error"; code: ProjectReadFailureCode }
  }
}
