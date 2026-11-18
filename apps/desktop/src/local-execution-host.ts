/**
 * Electron 主进程与渲染进程之间的本机执行端口契约。
 *
 * 【功能定义】定义本机多代理列表、会话准备/切换、附件/引用发送、控制方法（模式/配置）
 * 与实时事件通知（轮次流事件、会话级能力快照与表单交互请求）。
 * 【协作边界】只使用纯 TypeScript 类型与 `@workbench/contracts`，严禁引入 Electron、Node 或 `@workbench/acp-runtime`。
 */
import type { CollaborationResult } from "@workbench/contracts"

export type LocalExecutionScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
}

export type LocalExecutionAvailability = { readonly available: boolean; readonly reason?: string }
export type LocalExecutionBinding = LocalExecutionAvailability & {
  readonly bindingId: string
  readonly providerId?: string
}

export type LocalExecutionProviderInfo = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly available: boolean
  readonly reason?: string
}

export type LocalExecutionProviderList = {
  readonly providers: readonly LocalExecutionProviderInfo[]
  readonly defaultProviderId: string | null
}

export type LocalExecutionToolLocation = {
  readonly path: string
  readonly line?: number
}

export type LocalExecutionTool = {
  readonly id: string
  readonly title?: string
  readonly status?: "pending" | "in_progress" | "completed" | "failed"
  readonly kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
  readonly input?: string
  readonly output?: string
  readonly diffs?: readonly { readonly path: string; readonly oldText?: string; readonly newText: string }[]
  readonly locations?: readonly LocalExecutionToolLocation[]
  readonly terminalId?: string
}

export type LocalExecutionPermission = {
  readonly id: string
  readonly title: string
  readonly tool?: LocalExecutionTool
  readonly options: readonly { readonly id: string; readonly label: string; readonly allows: boolean }[]
}

export type LocalExecutionMode = {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export type LocalExecutionModesState = {
  readonly currentModeId: string
  readonly availableModes: readonly LocalExecutionMode[]
}

export type LocalExecutionModelInfo = {
  readonly modelId: string
  readonly name: string
  readonly description?: string
}

export type LocalExecutionModelsState = {
  readonly currentModelId?: string
  readonly availableModels: readonly LocalExecutionModelInfo[]
}

export type LocalExecutionConfigSelectOption = {
  readonly value: string
  readonly name: string
  readonly description?: string
  readonly group?: string
  readonly groupName?: string
}

export type LocalExecutionConfigOption =
  | {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly category?: string
      readonly type: "select"
      readonly currentValue: string
      readonly options: readonly LocalExecutionConfigSelectOption[]
    }
  | {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly category?: string
      readonly type: "boolean"
      readonly currentValue: boolean
    }

export type LocalExecutionCommand = {
  readonly name: string
  readonly description: string
  readonly inputHint?: string
  readonly meta?: Readonly<Record<string, unknown>>
}

export type LocalExecutionPlanEntry = {
  readonly content: string
  readonly priority: "high" | "medium" | "low"
  readonly status: "pending" | "in_progress" | "completed"
}

export type LocalExecutionPlanState =
  | { readonly kind: "entries"; readonly id?: string; readonly entries: readonly LocalExecutionPlanEntry[] }
  | { readonly kind: "markdown"; readonly id: string; readonly content: string }
  | { readonly kind: "file"; readonly id: string; readonly uri: string }

export type LocalExecutionUsage = {
  readonly used: number
  readonly size: number
  readonly cost?: { readonly amount: number; readonly currency: string }
}

export type LocalExecutionRestoreStatus =
  | { readonly kind: "none" }
  | { readonly kind: "restored"; readonly sessionId: string }
  | { readonly kind: "new"; readonly sessionId: string }
  | {
      readonly kind: "reset"
      readonly reason: "session-restore-unsupported" | "session-restore-failed"
      readonly previousSessionId: string
      readonly sessionId: string
    }

export type LocalExecutionSessionState = {
  readonly providerId: string
  readonly connected: boolean
  readonly modes?: LocalExecutionModesState
  readonly currentModeId?: string
  readonly models?: LocalExecutionModelsState
  readonly configOptions: readonly LocalExecutionConfigOption[]
  readonly availableCommands: readonly LocalExecutionCommand[]
  readonly plans: readonly LocalExecutionPlanState[]
  readonly usage?: LocalExecutionUsage
  readonly restoreStatus: LocalExecutionRestoreStatus
  readonly sessionTitle?: string | null
}

export type LocalExecutionElicitationValue = string | number | boolean | readonly string[]

export type LocalExecutionElicitationRequest = {
  readonly id: string
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly requestId?: string | number | null
  readonly message: string
  readonly requestedSchema: Readonly<Record<string, unknown>>
}

export type LocalExecutionElicitationAnswer =
  | { readonly action: "accept"; readonly content?: Readonly<Record<string, LocalExecutionElicitationValue>> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" }

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
  readonly request: LocalExecutionElicitationRequest | null
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
      | { readonly kind: "tool"; readonly sequence: number; readonly tool: LocalExecutionTool }
      | { readonly kind: "permission"; readonly sequence: number; readonly request: LocalExecutionPermission | null }
      | { readonly kind: "finished"; readonly sequence: number; readonly failure?: string; readonly availability: LocalExecutionAvailability }
    ))

export interface DesktopLocalExecutionHost {
  listProviders(): Promise<CollaborationResult<LocalExecutionProviderList>>
  prepare(scope: LocalExecutionScope, directory: string, providerId?: string): Promise<CollaborationResult<LocalExecutionBinding>>
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
  answerElicitation(scope: LocalExecutionScope, bindingId: string, requestId: string, answer: LocalExecutionElicitationAnswer): Promise<CollaborationResult<null>>
  onNotice(listener: (notice: LocalExecutionNotice) => void): () => void
}

export function localExecutionKey(scope: LocalExecutionScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId])
}
