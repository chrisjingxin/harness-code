/**
 * HC-218 会话模块公开与内部协作契约。
 *
 * 【功能定义】
 * 定义本人本机 / 本人其他设备 / 他人会话的三态归类、本地主动同步五态机、
 * HC-219 / HC-220 协作用集成接点，以及向本机 Agent 执行器的可注入边界。
 */
import type { ReactNode } from "react"
import type { ConversationReferenceView } from "@workbench/ui"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"

/** 服务端项目会话状态枚举，对齐 organization.schema.json。 */
export type ProjectConversationStatus = "idle" | "running" | "waiting_approval" | "error"

/** 简报生成来源枚举。 */
export type ProjectConversationBriefSource = "rule" | "agent"

/** 历史定稿消息类型枚举。 */
export type ProjectConversationMessageType = "user" | "assistant" | "tool_summary" | "status"

export type ProjectConversationRepositoryItem = {
  readonly repositoryId: string
  readonly name: string
}

/** 项目内单条会话摘要（与组织层 ConversationSummary 字段一致）。 */
export type ProjectConversationSummary = {
  readonly conversationId: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly deviceId: string
  readonly title: string
  readonly status: ProjectConversationStatus
  readonly briefText: string
  readonly briefSource: ProjectConversationBriefSource
  readonly briefUpdatedAtMs: number
  readonly syncedSequence: number
  readonly updatedAt: string
  readonly repositories: readonly ProjectConversationRepositoryItem[]
}

/** 服务端增量历史消息项。 */
export type ProjectHistoryMessage = {
  readonly sequence: number
  readonly type: ProjectConversationMessageType
  readonly occurredAtMs: number
  readonly payload: string
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
}

/** 向本机 Agent / ACP 执行内核预留的窄适配端口，未交付前如实返回不可用。 */
export interface LocalSessionExecutionPort {
  getAvailability(conversationId: string): { readonly available: boolean; readonly reason?: string }
  send?(input: {
    readonly scope: ProjectNavigationScope
    readonly conversationId: string
    readonly directoryPath: string | null
    readonly text: string
    readonly referenceIds: readonly string[]
    readonly attachmentIds: readonly string[]
  }): Promise<{ readonly status: "accepted" } | { readonly status: "rejected" | "unknown"; readonly message: string }>
  cancel?(scope: ProjectNavigationScope, conversationId: string): Promise<void>
}

/** 供 HC-219 / HC-220 消费的桌面前端内部集成能力。 */
export type SessionIntegrationApi = {
  /** 仅刷新项目会话列表元数据并对比生成“有更新”标记，绝不下载正文。 */
  refreshMetadata(scope: ProjectNavigationScope): Promise<void>
  /** 由“引用到我的会话”或“在本机开始任务”触发：切换到指定本机会话或准备页并带入草稿，不自动发送。 */
  prepareMySession(options: {
    readonly scope: ProjectNavigationScope
    readonly targetConversationId?: string | null
    readonly initialText?: string
    readonly referenceId?: string
  }): void
  /** 返回当前项目内归属本人且处于当前设备的会话列表。 */
  listMyLocalConversations(scope: ProjectNavigationScope): readonly ProjectConversationSummary[]
}

/** 允许由 HC-219 等后续卡片注入的外部动作与输入扩展槽。 */
export type SessionExternalHooks = {
  onCreateTaskFromConversation?(conversation: ProjectConversationSummary): void
  onQuoteConversation?(conversation: ProjectConversationSummary): void
  readonly references?: readonly ConversationReferenceView[]
  readonly composerExtra?: ReactNode
}
