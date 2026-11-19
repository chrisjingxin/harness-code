/**
 * Electron 主进程与渲染进程之间的本机执行 IPC 端口契约。
 *
 * 【功能定义】定义本机多代理会话准备/切换、附件/引用发送、控制动作与 IPC 通知事件形状；
 * ACP 协议显示 DTO（工具、权限、表单、Agent 列表、会话能力）直接复用 `@workbench/acp-runtime/types`。
 * 【协作边界】仅使用纯 TypeScript 类型与 `@workbench/collaboration-client/types`、`@workbench/acp-runtime/types`，
 * 严禁引入 Electron、Node 或 `@workbench/acp-runtime` 主运行入口。
 */
import type {
  AcpAgentList,
  LocalAcpElicitationAnswer,
  LocalAcpElicitationRequest,
  LocalAcpPermission,
  LocalAcpSessionState,
  LocalAcpTool,
} from "@workbench/acp-runtime/types"
import type { CollaborationResult } from "@workbench/collaboration-client/types"

export type LocalExecutionScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
}

export type LocalDirectoryStatus = "checking" | "ready" | "confirmation-required" | "invalid" | "unavailable"
export type LocalExecutionAvailability = {
  readonly available: boolean
  readonly reason?: string
  readonly directoryStatus?: LocalDirectoryStatus
}
export type LocalExecutionBinding = LocalExecutionAvailability & {
  readonly bindingId: string
  readonly providerId?: string
}
export type LocalExecutionPreparation = CollaborationResult<LocalExecutionBinding> & {
  readonly directoryStatus: LocalDirectoryStatus
}

/** 经桌面 IPC 传递的会话能力快照：仅保留可序列化的展示字段并补充所选 Provider 与会话标题。 */
export type LocalExecutionSessionState = Pick<
  LocalAcpSessionState,
  | "connected"
  | "modes"
  | "currentModeId"
  | "models"
  | "configOptions"
  | "availableCommands"
  | "plans"
  | "usage"
  | "restoreStatus"
> & {
  readonly providerId: string
  readonly sessionTitle?: string | null
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
  /** 上传确认后附带服务器写入的最小/最大 sequence，供渲染端去重已同步记录。 */
  readonly firstSequence?: number
  readonly syncedSequence?: number
}

export type LocalExecutionSessionStateNotice = {
  readonly scope: LocalExecutionScope
  readonly bindingId: string
  readonly kind: "session-state"
  readonly state: LocalExecutionSessionState
}

export type LocalExecutionElicitationNotice = {
  readonly scope: LocalExecutionScope
  readonly bindingId: string
  readonly kind: "elicitation"
  readonly request: LocalAcpElicitationRequest | null
}

export type LocalExecutionNotice =
  | LocalExecutionUploadNotice
  | LocalExecutionSessionStateNotice
  | LocalExecutionElicitationNotice
  | ({
      readonly scope: LocalExecutionScope
      readonly bindingId: string
      readonly turnId: string
    } & (
      | { readonly kind: "accepted"; readonly requestId: string; readonly text: string }
      | { readonly kind: "text"; readonly sequence: number; readonly text: string; readonly messageId?: string }
      | { readonly kind: "thought"; readonly sequence: number; readonly text: string }
      | { readonly kind: "tool"; readonly sequence: number; readonly tool: LocalAcpTool }
      | { readonly kind: "permission"; readonly sequence: number; readonly request: LocalAcpPermission | null }
      | { readonly kind: "finished"; readonly sequence: number; readonly failure?: string; readonly availability: LocalExecutionAvailability }
    ))

export interface DesktopLocalExecutionHost {
  listProviders(): Promise<CollaborationResult<AcpAgentList>>
  prepare(scope: LocalExecutionScope, directory: string, providerId?: string): Promise<LocalExecutionPreparation>
  /** 从该会话的本机个人记录取路径，经原生确认窗口记住旧目录。 */
  confirmDirectory(scope: LocalExecutionScope): Promise<CollaborationResult<boolean>>
  /** 主进程按固定 ID 读取引用材料，并按工作区沙箱路径生成 resource_link。发送端始终传用户原文。 */
  send(
    scope: LocalExecutionScope,
    bindingId: string,
    requestId: string,
    text: string,
    referenceIds?: readonly string[],
    attachments?: readonly string[],
  ): Promise<CollaborationResult<LocalExecutionReceipt>>
  cancel(scope: LocalExecutionScope, bindingId: string, turnId: string): Promise<CollaborationResult<null>>
  answerPermission(scope: LocalExecutionScope, bindingId: string, turnId: string, requestId: string, optionId: string): Promise<CollaborationResult<null>>
  setMode(scope: LocalExecutionScope, bindingId: string, modeId: string): Promise<CollaborationResult<null>>
  setConfigOption(scope: LocalExecutionScope, bindingId: string, configId: string, value: string | boolean): Promise<CollaborationResult<null>>
  answerElicitation(scope: LocalExecutionScope, bindingId: string, requestId: string, answer: LocalAcpElicitationAnswer): Promise<CollaborationResult<null>>
  onNotice(listener: (notice: LocalExecutionNotice) => void): () => void
}

export function localExecutionKey(scope: LocalExecutionScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId])
}
