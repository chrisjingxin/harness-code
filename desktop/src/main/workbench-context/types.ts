/** 本机项目记忆的业务记录；身份、来源和轮次只由主进程补全，工具输入不能覆盖。 */
export type MemoryKind = "team_project" | "team_repository" | "personal_directory"
export type MemoryFile = "team.md" | "personal.md"
export type MemoryScope = { origin: string; accountId: string; workspaceId: string }
/** sourceId 为已实际读取材料的稳定引用，Project 来源随条目保留以便逐次复核权限。 */
export type MemorySource = {
  sourceId: string
  kind: "project" | "repository" | "conversation" | "snapshot" | "knowledge" | "user_confirmation"
  projectId?: string
  /** 只有用户选择器或实际本机检查才可生成，其他成员引用中的路径不算本机确认。 */
  confirmedDirectory?: string
  repositoryId?: string
  remoteUrl?: string
  upstreamUrl?: string
}
export type MemoryFields = {
  name: string
  summary: string
  aliases?: string[]
  projectIds?: string[]
  repositoryId?: string
  repositoryIds?: string[]
  relatedProjectIds?: string[]
  remoteUrl?: string
  upstreamUrl?: string
  rootPath?: string
  relativePath?: string
}
export type MemoryEntry = MemoryFields & {
  entryId: string
  entryRevision: number
  kind: MemoryKind
  sources: MemorySource[]
  confirmedAt: string
}
export type MemoryDocument = { formatVersion: 1; documentRevision: number; updatedAt: string; entries: MemoryEntry[] }
export type MemoryPair = Record<MemoryFile, MemoryDocument>
export type MemoryProposal = {
  operation: "upsert" | "remove"
  kind: MemoryKind
  entryId?: string
  baseEntryRevision: number
  fields?: Partial<MemoryFields>
  sourceIds: string[]
}
export type MemoryUpdateResult = {
  status: "pending" | "saved" | "no_change" | "conflict" | "needs_confirmation" | "error" | "cancelled"
  message: string
  entryId?: string
  file?: MemoryFile
  entry?: MemoryEntry
}
export const MEMORY_BODY_LIMIT = 8 * 1024
export const MEMORY_ENTRY_LIMIT = 4 * 1024
export const memoryFile = (kind: MemoryKind): MemoryFile => kind === "personal_directory" ? "personal.md" : "team.md"
