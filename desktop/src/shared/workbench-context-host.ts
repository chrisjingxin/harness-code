/** 项目记忆的用户动作端口；目录由主进程原生选择器返回，页面不能提交任意磁盘路径。 */
import type { CollaborationResult } from "@workbench/collaboration-client/types"
import type { LocalExecutionScope } from "./local-execution-host.js"
/** 主进程实际读取的固定知识正文；仅本轮传递，不进入队列、用户消息或云端原文。 */
export type FixedKnowledgeMaterial = { readonly title: string; readonly referenceId: string; readonly version: number; readonly text: string }
/** 准备资料的真实结果；ready 只表示已准备，不能据此声称 Agent 已收到。 */
export type KnowledgeContextStatus = { readonly code: string; readonly message: string }
export type ProjectMemoryDirectory = { entryId: string; entryRevision: number; name: string; directory: string }
export type ProjectMemoryDirectoryInput = { name: string; entryId?: string; baseEntryRevision: number }
export type ProjectMemoryActionResult = { status: "saved" | "no_change" | "conflict" | "needs_confirmation" | "error" | "cancelled"; message: string }
export interface WorkbenchContextHost {
  listDirectories(scope: LocalExecutionScope): Promise<CollaborationResult<readonly ProjectMemoryDirectory[]>>
  confirmDirectory(scope: LocalExecutionScope, input: ProjectMemoryDirectoryInput): Promise<CollaborationResult<ProjectMemoryActionResult>>
  removeDirectory(scope: LocalExecutionScope, entryId: string, baseEntryRevision: number): Promise<CollaborationResult<ProjectMemoryActionResult>>
}
