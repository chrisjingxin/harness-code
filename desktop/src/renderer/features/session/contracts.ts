/**
 * HC-218 / HC-229 会话模块公开与内部协作契约。
 *
 * 【功能定义】
 * 统一复用 `@workbench/contracts` 的会话与历史消息 DTO，定义本人本机 / 只读会话分类、
 * 本地主动同步五态机、HC-219 / HC-220 协作用集成接点，以及完整 ACP 执行端口。
 */
import type { ReactNode } from "react"
import type {
  ConversationBriefSource,
  ConversationMessageType,
  ConversationRepositoryItem,
  ConversationStatus,
  ConversationSummary,
  HistoryMessage,
} from "@workbench/collaboration-client/types"
import type { AcpAgentList, LocalAcpElicitationAnswer } from "@workbench/acp-runtime/types"
import type {
  CodeCheckpointAction,
  CodeCheckpointReply,
  LocalExecutionAvailability,
  PersonalDraftImage,
  PromptQueueAction,
  PromptQueueView,
  ReadLocalImageResult,
  StageLocalImageInput,
} from "../../../shared/index.js"
import type { ConversationActions, ConversationMentionOrigin, ConversationReferenceView, ConversationTimelineEntry } from "../../../ui/index.js"
import type { LocalExecutionView } from "./local-execution-view.js"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"

/** 直接复用公共契约 DTO，消除与 organization.ts 重复的手写定义。 */
export type ProjectConversationStatus = ConversationStatus
export type ProjectConversationBriefSource = ConversationBriefSource
export type ProjectConversationMessageType = ConversationMessageType
export type ProjectConversationRepositoryItem = ConversationRepositoryItem
export type ProjectConversationSummary = ConversationSummary
export type ProjectHistoryMessage = HistoryMessage

/** 本机执行与本地目录端口消费的作用域：个人会话在未入团或未发布时允许 `workspaceId` / `projectId` 为 null。 */
export type SessionExecutionScope = {
  readonly namespace: string
  readonly accountId: string
  readonly workspaceId: string | null
  readonly projectId: string | null
}

/** 本机对单条会话的身份归属判定结果。 */
export type SessionKind = "local" | "remote_self" | "remote_other"

/**
 * 跨机器会话在本机的五种主动同步状态：
 * - unsynced: 本地从未拉取过正文
 * - syncing: 正在按序主动拉取正文
 * - synced: 本地水位已追平服务端
 * - has_update: 本地有旧正文，服务端已有更大 sequence，等待用户手动同步更新
 * - sync_failed: 主动同步出错（保留原有已下载正文）
 */
export type SessionSyncStatus = "unsynced" | "syncing" | "synced" | "has_update" | "sync_failed"

/** 跨机器会话在本机持久化的增量正文缓存。 */
export type SessionSyncCache = {
  readonly syncedSequence: number
  readonly syncedAtMs: number
  readonly messages: readonly ProjectHistoryMessage[]
  readonly cacheTruncated?: boolean
}

/** 本机对某条会话的运行时与本地状态组合视图。 */
export type SessionSyncState = {
  readonly localSyncedSequence: number
  readonly lastSyncedAtMs: number | null
  readonly syncing: boolean
  readonly syncError: string | null
  readonly messages: readonly ProjectHistoryMessage[]
  readonly cacheTruncated?: boolean
}

/** 新会话准备页在当前项目下保留的个人草稿与待选目录。 */
export type NewSessionDraft = {
  readonly directoryPath: string | null
  readonly draftText: string
  readonly referenceIds: readonly string[]
  readonly revision: number
  readonly selectionStart: number
  readonly selectionEnd: number
}

/** 输入区用于标记尚未登记的项目草稿，仅用于本机 UI。 */
export const NEW_SESSION_DRAFT_ID = "new-session-draft"
export type NewSessionReferenceChange =
  | { readonly kind: "add"; readonly referenceIds: readonly string[]; readonly mention?: ConversationMentionOrigin }
  | { readonly kind: "replace"; readonly referenceId: string; readonly replacementId: string }
  | { readonly kind: "remove"; readonly referenceId: string }

/** 页面只消费执行视图与用户动作。正式装配负责按原范围提交已受理的草稿修订。 */
export interface LocalSessionExecutionPort {
  getAvailability(conversationId: string): LocalExecutionAvailability
  codeCheckpoint?(conversationId: string, action: CodeCheckpointAction): Promise<CodeCheckpointReply>
  confirmDirectory?(conversationId: string): Promise<void>
  readonly textOnly?: boolean
  readonly commitsAcceptedDraft?: boolean
  getView?(conversationId: string): LocalExecutionView | undefined
  getPromptQueue?(conversationId: string): PromptQueueView | undefined
  promptQueue?(conversationId: string, action: Exclude<PromptQueueAction, { kind: "add" | "resume" }> | { kind: "resume" }): Promise<void>
  steerQueued?(conversationId: string, requestId: string): Promise<void>
  getProviders?(): AcpAgentList | undefined
  refreshProviders?(): Promise<AcpAgentList | undefined>
  clearEntries?(conversationId: string): void
  getSelectedProviderId?(conversationId: string): string | undefined
  selectProvider?(conversationId: string, providerId: string): Promise<void>
  setMode?(conversationId: string, modeId: string): Promise<void>
  setConfigOption?(conversationId: string, configId: string, value: string | boolean): Promise<void>
  answerElicitation?(conversationId: string, requestId: string, answer: LocalAcpElicitationAnswer): Promise<void>
  send?(input: {
    readonly scope: SessionExecutionScope
    readonly conversationId: string
    readonly directoryPath: string | null
    readonly draftRevision: number
    readonly text: string
    readonly referenceIds: readonly string[]
    readonly attachmentIds: readonly string[]
    readonly images?: readonly PersonalDraftImage[]
    readonly queue?: boolean
    readonly steer?: boolean
  }): Promise<{ readonly status: "accepted" } | { readonly status: "rejected" | "unknown"; readonly message: string }>
  stageImage?(input: StageLocalImageInput): Promise<PersonalDraftImage>
  readImage?(imageId: string): Promise<ReadLocalImageResult | null>
  removeStagedImage?(imageId: string): Promise<void>
  cancel?(scope: SessionExecutionScope, conversationId: string): Promise<void>
  answerPermission?(conversationId: string, id: string, optionId: string): Promise<void>
}

/** 草稿变更绑定发起会话和本机设备，目标另由用户选择。 */
export type SessionDraftScope = ProjectNavigationScope & {
  readonly deviceId: string
  readonly conversationId: string | null
}

export type SessionDraftTarget =
  | { readonly kind: "existing"; readonly conversationId: string }
  | { readonly kind: "new"; readonly directory: string; readonly requestId: string; readonly preparedConversationId?: string }

/** 草稿只持有引用标识。快照和预览由调用方管理。 */
export type SessionReferenceDraftChange =
  | {
      readonly kind: "add"
      readonly target: SessionDraftTarget
      readonly referenceIds: readonly string[]
      readonly initialText?: string
      readonly mention?: ConversationMentionOrigin
    }
  | { readonly kind: "replace"; readonly referenceId: string; readonly replacementId: string }
  | { readonly kind: "remove"; readonly referenceId: string }

/** 成功表示个人草稿已更新。保存反馈由 PersonalPersistence 处理。 */
export type SessionReferenceDraftResult =
  | { readonly ok: true; readonly value: { readonly conversationId: string; readonly draftRevision: number } }
  | { readonly ok: false; readonly message: string; readonly preparedConversationId?: string }

/** 供 HC-219 / HC-220 消费的桌面前端内部集成能力。 */
export type SessionIntegrationApi = {
  /** 仅刷新项目会话列表元数据并对比生成“有更新”标记，绝不下载正文。 */
  refreshMetadata(scope: ProjectNavigationScope): Promise<void>
  /** 返回当前范围内已经取得的会话简报，供选择和定位。 */
  listProjectConversations(scope: ProjectNavigationScope): readonly ProjectConversationSummary[]
  /** 返回当前项目内归属本人且处于当前设备的会话列表。 */
  listMyLocalConversations(scope: ProjectNavigationScope): readonly ProjectConversationSummary[]
  /** 合并到本人本机会话的最新草稿，登记后失败时带回已创建会话以供重试。 */
  applyReferenceDraft(scope: SessionDraftScope, change: SessionReferenceDraftChange): Promise<SessionReferenceDraftResult>
  /** 仅更新当前项目的未创建草稿，绝不登记会话或发送。 */
  applyNewSessionReference(scope: SessionDraftScope, change: NewSessionReferenceChange): Promise<
    { readonly ok: true; readonly value: { readonly draftRevision: number } } | { readonly ok: false; readonly message: string }
  >
  /** 定位成功后显示目标会话输入区，保留它已打开的文件页签。 */
  revealReferenceDraft(scope: SessionDraftScope, conversationId: string): void
}

/** 允许由 HC-219 等后续卡片注入的外部动作与输入扩展槽。 */
export type SessionExternalHooks = {
  onCreateTaskFromConversation?(conversation: ProjectConversationSummary): void
  onQuoteConversation?(conversation: ProjectConversationSummary): void
  readonly onRequestCollaborationCandidates?: ConversationActions["onRequestCollaborationCandidates"]
  readonly onSelectCollaborationCandidate?: ConversationActions["onSelectCollaborationCandidate"]
  readonly onReferenceAction?: ConversationActions["onReferenceAction"]
  readonly renderHistoryReferences?: (entries: readonly ConversationTimelineEntry[]) => readonly ConversationTimelineEntry[]
  readonly references?: readonly ConversationReferenceView[]
  readonly composerExtra?: ReactNode
}
