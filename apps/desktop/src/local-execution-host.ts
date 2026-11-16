/** Electron 主进程与 renderer 之间的文本执行端口。目录仅用于核对原生选择，命令由主进程配置。 */
import type { CollaborationResult } from "@workbench/contracts"
export type LocalExecutionScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly deviceId: string
  readonly conversationId: string
}
export type LocalExecutionAvailability = { readonly available: boolean; readonly reason?: string }
export type LocalExecutionBinding = LocalExecutionAvailability & { readonly bindingId: string }
export type LocalExecutionReceipt =
  | { readonly status: "accepted"; readonly turnId: string }
  | { readonly status: "rejected"; readonly reason: string }

export type LocalExecutionNotice = {
  readonly scope: LocalExecutionScope
  readonly bindingId: string
  readonly turnId: string
} & (
  | { readonly kind: "accepted"; readonly requestId: string; readonly text: string }
  | { readonly kind: "text"; readonly sequence: number; readonly text: string }
  | { readonly kind: "finished"; readonly sequence: number; readonly failure?: string; readonly availability: LocalExecutionAvailability }
)

export interface DesktopLocalExecutionHost {
  prepare(scope: LocalExecutionScope, directory: string): Promise<CollaborationResult<LocalExecutionBinding>>
  send(scope: LocalExecutionScope, bindingId: string, requestId: string, text: string): Promise<CollaborationResult<LocalExecutionReceipt>>
  onNotice(listener: (notice: LocalExecutionNotice) => void): () => void
}

export function localExecutionKey(scope: LocalExecutionScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId, scope.deviceId, scope.conversationId])
}
