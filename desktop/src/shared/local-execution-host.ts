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
import type { PersonalDraftImage } from "./personal.js"
import type { KnowledgeContextStatus } from "./workbench-context-host.js"

export type LocalExecutionScope = {
  readonly accountId: string
  readonly workspaceId: string | null
  readonly projectId: string | null
  readonly conversationId: string
}

export type LocalDirectoryStatus = "checking" | "ready" | "confirmation-required" | "invalid" | "unavailable"
export type LocalExecutionAvailability = {
  readonly available: boolean
  readonly reason?: string
  readonly directoryStatus?: LocalDirectoryStatus
  readonly knowledgeStatus?: KnowledgeContextStatus
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
  | "setupDiagnostics"
> & {
  readonly providerId: string
  readonly sessionTitle?: string | null
  /** 从 AgentCapabilities.promptCapabilities.image 派生的图片提示支持标志。 */
  readonly supportsImagePrompt?: boolean
}

export type StageLocalImageInput = {
  readonly bytes: Uint8Array
  readonly mimeType: string
  readonly name?: string
  readonly width?: number
  readonly height?: number
}

export type ReadLocalImageResult = {
  readonly bytes: Uint8Array
  readonly mimeType: string
}

export type LocalExecutionAttachment = {
  readonly label: string
  readonly kind: "file" | "directory"
  readonly path?: string
}

export type LocalExecutionReceipt =
  | { readonly status: "accepted"; readonly turnId: string; readonly canSteer?: boolean; readonly attachments?: readonly LocalExecutionAttachment[]; readonly knowledgeStatus?: KnowledgeContextStatus }
  | { readonly status: "rejected"; readonly reason: string; readonly unavailableReferenceId?: string }

/** 待发项保存用户原文及引用标识，实际发送时重新解析材料。 */
export type QueuedPrompt = {
  readonly requestId: string
  readonly text: string
  readonly referenceIds: readonly string[]
  readonly attachments: readonly string[]
  readonly images?: readonly PersonalDraftImage[]
}

/** starting 表示已经开始提交，进程中断后需由用户核对，禁止自动重发。 */
export type PromptQueueRecord = { readonly items: readonly QueuedPrompt[]; readonly starting?: string }
export type PromptQueueView = PromptQueueRecord & { readonly revision: number; readonly paused: boolean; readonly pausedReason?: string }
export type PromptQueueAction =
  | { readonly kind: "read" }
  | { readonly kind: "add"; readonly bindingId: string; readonly item: QueuedPrompt }
  | { readonly kind: "edit"; readonly requestId: string; readonly text: string }
  | { readonly kind: "remove"; readonly requestId: string }
  | { readonly kind: "resume"; readonly bindingId: string }

/** 草稿或已排队的纯文本；绑定发起操作时的当前轮。 */
export type LocalSteerInput =
  | { readonly kind: "draft"; readonly requestId: string; readonly text: string }
  | { readonly kind: "queued"; readonly requestId: string }

/** 在运行轮次中追发普通文本，斜杠命令仍走完整的新轮次流程。 */
export function isSteerText(text: string): boolean {
  return Boolean(text.trim()) && !/^\/[a-z][\w-]*(?:\s|$)/i.test(text.trimStart())
}

export const MAX_QUEUED_PROMPTS = 20
export const MAX_PROMPT_QUEUE_BYTES = 256 * 1024

/** 共享结果独立于执行终态。重试成功只清除同一轮的上传失败。 */
export type LocalExecutionUploadNotice = {
  readonly scope: LocalExecutionScope
  readonly turnId: string
  readonly kind: "upload"
  readonly failure?: string
  /** 服务端返回 409 CONVERSATION_SHARING_STOPPED 时置为 true，提示界面收敛本地共享状态。 */
  readonly sharingStopped?: boolean
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

export type LocalExecutionTool = Omit<LocalAcpTool, "rawMeta"> & { readonly parentToolCallId?: string }
export type LocalExecutionPermission = Omit<LocalAcpPermission, "rawMeta" | "tool" | "options"> & {
  readonly tool?: LocalExecutionTool
  readonly options: readonly (Omit<LocalAcpPermission["options"][number], "rawMeta"> & {
    readonly scope?: "once" | "thread" | "project"
  })[]
}
export type LocalExecutionRunSummary = {
  readonly durationMs?: number
  readonly cachedTokens?: number
  readonly agentName?: string
  readonly completedAtMs?: number
}

export type LocalExecutionNotice =
  | LocalExecutionUploadNotice
  | LocalExecutionSessionStateNotice
  | LocalExecutionElicitationNotice
  /** 桌面记忆保存独立于 ACP 流序号，正常终态后仍可更新原工具卡。 */
  | { readonly scope: LocalExecutionScope; readonly bindingId: string; readonly kind: "context-tool"; readonly requestId: string; readonly tool: LocalExecutionTool }
  | { readonly scope: LocalExecutionScope; readonly kind: "prompt-queue"; readonly queue: PromptQueueView }
  | { readonly scope: LocalExecutionScope; readonly bindingId: string; readonly kind: "steered"; readonly turnId: string; readonly requestId: string; readonly text: string }
  | ({
      readonly scope: LocalExecutionScope
      readonly bindingId: string
      readonly turnId: string
    } & (
      | { readonly kind: "accepted"; readonly requestId: string; readonly text: string; readonly queued?: boolean; readonly canSteer?: boolean; readonly referenceIds?: readonly string[]; readonly attachments?: readonly LocalExecutionAttachment[]; readonly images?: readonly PersonalDraftImage[]; readonly knowledgeStatus?: KnowledgeContextStatus }
      | { readonly kind: "text"; readonly sequence: number; readonly text: string; readonly messageId?: string }
      | { readonly kind: "thought"; readonly sequence: number; readonly text: string }
      | { readonly kind: "tool"; readonly sequence: number; readonly tool: LocalExecutionTool }
      | { readonly kind: "permission"; readonly sequence: number; readonly request: LocalExecutionPermission | null }
      | { readonly kind: "finished"; readonly sequence: number; readonly failure?: string; readonly cancelled?: boolean; readonly availability: LocalExecutionAvailability; readonly ephemeral?: boolean; readonly runSummary?: LocalExecutionRunSummary }
    ))

/** 轮次快照只在本机解析，页面只提交轮次、文件或确认凭据。 */
export type CodeCheckpointAction =
  | { kind: "history" }
  | { kind: "changes"; turnId: string }
  | { kind: "diff"; turnId: string; path: string }
  | { kind: "preview"; turnId: string; target: "base" | "post" | "guard"; guardId?: string }
  | { kind: "restore"; token: string }

export type CodeCheckpointTurn = {
  turnId: string
  ordinal: number
  createdAtMs: number
  status: "completed" | "cancelled" | "failed"
  unavailable?: string
  guards: readonly { id: string; createdAtMs: number }[]
}

export type CodeCheckpointReply =
  | { kind: "history"; turns: readonly CodeCheckpointTurn[]; restoreBlocked?: string }
  | { kind: "changes"; files: readonly { path: string; oldPath?: string; added: number | null; removed: number | null }[] }
  | { kind: "diff"; text: string; truncated: boolean }
  | { kind: "preview"; token: string; paths: readonly string[] }
  | { kind: "restored"; paths: readonly string[]; failure?: string }

export interface DesktopLocalExecutionHost {
  listProviders(): Promise<CollaborationResult<AcpAgentList>>
  promptQueue(scope: LocalExecutionScope, action: PromptQueueAction): Promise<CollaborationResult<PromptQueueView>>
  steer(scope: LocalExecutionScope, bindingId: string, turnId: string, input: LocalSteerInput): Promise<CollaborationResult<null>>
  prepare(scope: LocalExecutionScope, directory: string, providerId?: string): Promise<LocalExecutionPreparation>
  /** 从该会话的本机个人记录取路径，经原生确认窗口记住旧目录。 */
  confirmDirectory(scope: LocalExecutionScope): Promise<CollaborationResult<boolean>>
  stageImage(scope: LocalExecutionScope, input: StageLocalImageInput): Promise<CollaborationResult<PersonalDraftImage>>
  readImage(scope: LocalExecutionScope, imageId: string): Promise<CollaborationResult<ReadLocalImageResult>>
  removeStagedImage(scope: LocalExecutionScope, imageId: string): Promise<CollaborationResult<null>>
  /** 主进程按固定 ID 读取引用材料，并按工作区沙箱路径生成 resource_link；图片读取后组装标准 ACP image 块。 */
  send(
    scope: LocalExecutionScope,
    bindingId: string,
    requestId: string,
    text: string,
    referenceIds?: readonly string[],
    attachments?: readonly string[],
    images?: readonly PersonalDraftImage[],
  ): Promise<CollaborationResult<LocalExecutionReceipt>>
  cancel(scope: LocalExecutionScope, bindingId: string, turnId: string): Promise<CollaborationResult<null>>
  answerPermission(scope: LocalExecutionScope, bindingId: string, turnId: string, requestId: string, optionId: string): Promise<CollaborationResult<null>>
  setMode(scope: LocalExecutionScope, bindingId: string, modeId: string): Promise<CollaborationResult<null>>
  setConfigOption(scope: LocalExecutionScope, bindingId: string, configId: string, value: string | boolean): Promise<CollaborationResult<null>>
  answerElicitation(scope: LocalExecutionScope, bindingId: string, requestId: string, answer: LocalAcpElicitationAnswer): Promise<CollaborationResult<null>>
  codeCheckpoint(scope: LocalExecutionScope, action: CodeCheckpointAction): Promise<CollaborationResult<CodeCheckpointReply>>
  onNotice(listener: (notice: LocalExecutionNotice) => void): () => void
}

export function localExecutionKey(scope: LocalExecutionScope): string {
  return JSON.stringify([scope.accountId, scope.conversationId])
}
