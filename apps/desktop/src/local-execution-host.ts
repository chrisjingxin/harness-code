/** Electron 主进程与 renderer 之间的文本执行端口。目录仅用于核对原生选择，命令由主进程配置。 */
import type { CollaborationResult } from "@workbench/contracts"
export type LocalExecutionScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
}
export type LocalExecutionAvailability = { readonly available: boolean; readonly reason?: string }
export type LocalExecutionBinding = LocalExecutionAvailability & { readonly bindingId: string }
export type LocalExecutionTool = {
  readonly id: string
  readonly title?: string
  readonly status?: "pending" | "in_progress" | "completed" | "failed"
  readonly kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
  readonly input?: string
  readonly output?: string
  readonly diffs?: readonly { readonly path: string; readonly oldText?: string; readonly newText: string }[]
}
export type LocalExecutionPermission = {
  readonly id: string
  readonly title: string
  readonly options: readonly { readonly id: string; readonly label: string; readonly allows: boolean }[]
}
export type LocalExecutionReceipt =
  | { readonly status: "accepted"; readonly turnId: string }
  | { readonly status: "rejected"; readonly reason: string; readonly unavailableReferenceId?: string }

/** 共享结果独立于执行终态。重试成功只清除同一轮的上传失败。 */
export type LocalExecutionUploadNotice = {
  readonly scope: LocalExecutionScope
  readonly turnId: string
  readonly kind: "upload"
  readonly failure?: string
}

export type LocalExecutionNotice = LocalExecutionUploadNotice | ({
  readonly scope: LocalExecutionScope
  readonly bindingId: string
  readonly turnId: string
} & (
  | { readonly kind: "accepted"; readonly requestId: string; readonly text: string }
  | { readonly kind: "text"; readonly sequence: number; readonly text: string }
  | { readonly kind: "thought"; readonly sequence: number; readonly text: string }
  | { readonly kind: "tool"; readonly sequence: number; readonly tool: LocalExecutionTool }
  | { readonly kind: "permission"; readonly sequence: number; readonly request: LocalExecutionPermission | null }
  | { readonly kind: "finished"; readonly sequence: number; readonly failure?: string; readonly availability: LocalExecutionAvailability }
))

export interface DesktopLocalExecutionHost {
  prepare(scope: LocalExecutionScope, directory: string): Promise<CollaborationResult<LocalExecutionBinding>>
  /** 主进程按固定 ID 自行读取材料。发送端始终传用户原文。 */
  send(scope: LocalExecutionScope, bindingId: string, requestId: string, text: string, referenceIds?: readonly string[]): Promise<CollaborationResult<LocalExecutionReceipt>>
  cancel(scope: LocalExecutionScope, bindingId: string, turnId: string): Promise<CollaborationResult<null>>
  answerPermission(scope: LocalExecutionScope, bindingId: string, turnId: string, requestId: string, optionId: string): Promise<CollaborationResult<null>>
  onNotice(listener: (notice: LocalExecutionNotice) => void): () => void
}

export function localExecutionKey(scope: LocalExecutionScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId])
}
