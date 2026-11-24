/**
 * 【功能定义】协作应用契约：项目任务、团队知识、项目看板与轻量 SSE 通知的线上 DTO。
 * 【协作边界】纯前端安全纯类型定义，与 `contracts/schema/collaboration.schema.json` 对齐。
 */
import type { ConversationSummary } from "./organization.js"

/** Project 内的五态 Task 由发起人和一位受让人操作。 */
export type TaskStatus = "todo" | "doing" | "review" | "done" | "cancelled"

export interface KnowledgeRef {
  knowledgeId: string
  versionId: string
}

export interface TaskCreateRequest {
  title: string
  description: string
  assigneeId: string
  requestId: string
  snapshotIds?: string[]
  knowledgeRefs?: KnowledgeRef[]
}

export interface TaskPatchRequest {
  description: string
  expectedVersion: number
  requestId: string
}

export interface TaskTransitionRequest {
  targetStatus: TaskStatus
  expectedVersion: number
  requestId: string
  note?: string
  commitSha?: string
}

export interface TaskConversationRequest {
  conversationId: string
  expectedVersion: number
  requestId: string
}

export interface TaskSummary {
  taskId: string
  projectId: string
  title: string
  creatorId: string
  assigneeId: string
  status: TaskStatus
  version: number
  conversationId: string | null
  createdAtMs: number
  updatedAtMs: number
}

export interface TaskTransition {
  kind: "created" | "edited" | "transition" | "conversation_linked" | "reassigned"
  actorId: string
  fromStatus: TaskStatus | null
  toStatus: TaskStatus
  version: number
  note: string
  commitSha: string
  occurredAtMs: number
  handoff: { fromAssigneeId: string; toAssigneeId: string; previousConversationId: string | null } | null
}

export interface TaskDetail {
  task: TaskSummary
  description: string
  snapshotIds: string[]
  knowledgeRefs: KnowledgeRef[]
  transitions: TaskTransition[]
}

export interface TaskListResponse {
  tasks: TaskSummary[]
  nextAfterId: string | null
}

/** 团队知识编辑创建固定版本，条目版本号用于并发核对。 */
export interface KnowledgeCreateRequest {
  termKey: string
  category: string
  title: string
  text: string
}

export interface KnowledgeUpdateRequest {
  category: string
  title: string
  text: string
  expectedVersion: number
}

export interface KnowledgeSummary {
  knowledgeId: string
  termKey: string
  category: string
  title: string
  currentVersionId: string
  version: number
  archived: boolean
  updatedAtMs: number
}

export interface KnowledgeVersionSummary {
  versionId: string
  version: number
  category: string
  title: string
  authorId: string
  createdAtMs: number
}

export interface KnowledgeVersion {
  knowledgeId: string
  termKey: string
  archived: boolean
  version: KnowledgeVersionSummary
  text: string
}

export interface KnowledgeDetail {
  item: KnowledgeSummary
  current: KnowledgeVersion
}

export interface KnowledgeListResponse {
  items: KnowledgeSummary[]
  nextAfterId: string | null
}

export interface KnowledgeVersionListResponse {
  versions: KnowledgeVersionSummary[]
  nextAfterId: string | null
}

/** 看板中的成员行按 ID 指向返回内的会话与任务列表。 */
export interface BoardMember {
  userId: string
  name: string
  status: "active" | "removed"
  deviceOnline: boolean
  conversationIds: string[]
  receivedTaskIds: string[]
  sentTaskIds: string[]
}

export interface BoardConversation {
  conversation: ConversationSummary
  deviceOnline: boolean
}

export interface BoardResponse {
  projectId: string
  members: BoardMember[]
  conversations: BoardConversation[]
  tasks: TaskSummary[]
  conversationsTruncated: boolean
  tasksTruncated: boolean
}

/** id 用于续读，objectId 用于主动拉取对应资源。 */
export interface NotificationEvent {
  id: number
  eventId: string
  type: "task.assigned" | "task.changed" | "conversation.brief_updated" | "snapshot.created" |
    "knowledge.updated" | "project.member_changed" | "workspace.member_changed"
  objectId: string
  projectId: string | null
  occurredAtMs: number
}

export interface NotificationPage {
  events: NotificationEvent[]
  nextAfterId: number
  hasMore: boolean
}

export type ProjectUpdatesStatus = "connecting" | "connected" | "retrying" | "unavailable"

export type ProjectUpdatesNotice = { readonly subscriptionId: string } & (
  | { readonly kind: "status"; readonly status: ProjectUpdatesStatus }
  | { readonly kind: "event"; readonly event: NotificationEvent }
)

export type InboxBucket = "action_required" | "sent" | "resolved"
export type InboxUrgency = "urgent" | "normal"

export interface InboxItem {
  itemKey: string
  sourceType: string
  category: string
  urgency: InboxUrgency
  workspaceId: string
  projectId: string | null
  projectName: string
  objectId: string
  title: string
  status: string
  actorId: string
  delegated: boolean
  updatedAtMs: number
}

export interface InboxCounts {
  actionRequired: number
  urgent: number
  sent: number
}

export interface InboxWorkspaceSummary {
  workspaceId: string
  name: string
  slug: string
}

export interface InboxActorSummary {
  userId: string
  userNo: string
  name: string
  active: boolean
}

export interface InboxResponse {
  bucket: InboxBucket
  items: InboxItem[]
  counts: InboxCounts
  notificationCursor: number
  workspaces: InboxWorkspaceSummary[]
  actors: InboxActorSummary[]
  truncated: boolean
}

export interface InboxQuery {
  bucket?: InboxBucket
  category?: string
  workspaceId?: string
  limit?: number
}

/** 跨团队用户级轻量通知事件，附带 workspaceId 以便桌面全局收件箱精准更新。 */
export interface UserNotificationEvent extends NotificationEvent {
  workspaceId: string
}

export interface UserNotificationPage {
  events: UserNotificationEvent[]
  nextAfterId: number
  hasMore: boolean
}

export type ExternalNotificationEventType = "task.assigned" | "task.review_requested" | "task.returned"

export interface NotificationPreferences {
  externalEnabled: boolean
  subscribedEvents: ExternalNotificationEventType[]
  dndEnabled: boolean
  dndStartMinute: number
  dndEndMinute: number
  dndTimezone: string
  mergeWindowSec: number
  version: number
}

export interface NotificationPreferencesUpdateRequest {
  externalEnabled: boolean
  subscribedEvents: ExternalNotificationEventType[]
  dndEnabled: boolean
  dndStartMinute: number
  dndEndMinute: number
  dndTimezone: string
  mergeWindowSec: number
  expectedVersion: number
}

export type UserUpdatesNotice = { readonly subscriptionId: string } & (
  | { readonly kind: "status"; readonly status: ProjectUpdatesStatus }
  | { readonly kind: "event"; readonly event: UserNotificationEvent }
)
