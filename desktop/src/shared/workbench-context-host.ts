/** 本机项目记忆的轻量读写端口；正文由当前 Agent 或用户维护，范围由主进程复核。 */
import type { CollaborationResult } from "@workbench/collaboration-client/types"
import type { LocalExecutionScope } from "./local-execution-host.js"

/** 主进程实际读取的固定知识正文，仅本轮传递，不进入队列或云端原文。 */
export type FixedKnowledgeMaterial = { readonly title: string; readonly referenceId: string; readonly version: number; readonly text: string }
/** ready 只表示材料已准备，不能据此声称 Agent 已收到。 */
export type KnowledgeContextStatus = { readonly code: string; readonly message: string }
export type ProjectMemoryDocument = "team" | "personal"
/** 合计 8 KiB 仅为整理建议；另一份不可读时不猜测总大小。 */
export type ProjectMemorySize = { documentBytes: number; pairBytes: number | null; targetBytes: number; overTarget: boolean | null }
export type ProjectMemoryInput = { document: ProjectMemoryDocument; content: string; expectedRevision: string }
/** 可恢复失败作为普通结果返回，冲突后需重读合并，不能盲目覆盖旧版本。 */
export type ProjectMemoryResult =
  | { status: "ready"; document: ProjectMemoryDocument; content: string; revision: string; size: ProjectMemorySize }
  | { status: "saved" | "no_change"; document: ProjectMemoryDocument; revision: string; size: ProjectMemorySize; message: string }
  | { status: "conflict"; document: ProjectMemoryDocument; currentRevision: string | null; message: string; retry: "read_then_merge" }
  | { status: "unavailable" | "error"; document: ProjectMemoryDocument; reason: string; message: string }

export interface WorkbenchContextHost {
  readMemory(scope: LocalExecutionScope, document: ProjectMemoryDocument): Promise<CollaborationResult<ProjectMemoryResult>>
  updateMemory(scope: LocalExecutionScope, input: ProjectMemoryInput): Promise<CollaborationResult<ProjectMemoryResult>>
}
