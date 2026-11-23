/** 项目记忆的用户动作端口；目录由主进程原生选择器返回，页面不能提交任意磁盘路径。 */
import type { CollaborationResult } from "@workbench/collaboration-client/types"
import type { LocalExecutionScope } from "./local-execution-host.js"
export type ProjectMemoryDirectory = { entryId: string; entryRevision: number; name: string; directory: string }
export type ProjectMemoryDirectoryInput = { name: string; entryId?: string; baseEntryRevision: number }
export type ProjectMemoryActionResult = { status: "saved" | "no_change" | "conflict" | "needs_confirmation" | "error" | "cancelled"; message: string }
export interface WorkbenchContextHost {
  listDirectories(scope: LocalExecutionScope): Promise<CollaborationResult<readonly ProjectMemoryDirectory[]>>
  confirmDirectory(scope: LocalExecutionScope, input: ProjectMemoryDirectoryInput): Promise<CollaborationResult<ProjectMemoryActionResult>>
  removeDirectory(scope: LocalExecutionScope, entryId: string, baseEntryRevision: number): Promise<CollaborationResult<ProjectMemoryActionResult>>
}
