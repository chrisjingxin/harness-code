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
/** 团队知识的结构化内容、固定发布版本、提议审核及保鲜契约；与同名 JSON Schema 对齐。 */
/** 团队知识的结构化内容、固定发布版本、提议审核及保鲜契约；与同名 JSON Schema 对齐。 */
export type KnowledgeCreateRequest = { termKey: string; category: string; title: string; text: string; level: KnowledgeLevel; scope: KnowledgeScope; contentType: "article"; requestId: string }
export type KnowledgeUpdateRequest = { category: string; title: string; text: string; expectedVersion: number; level: KnowledgeLevel; scope: KnowledgeScope; contentType: "article"; requestId: string }
export type KnowledgeSummary = { knowledgeId: string; termKey: string; category: string; title: string; currentVersionId: string; version: number; archived: boolean; updatedAtMs: number; level: KnowledgeLevel; scope: KnowledgeScope; contentType: "article"; health: KnowledgeHealth }
export type KnowledgeVersionSummary = { versionId: string; version: number; category: string; title: string; authorId: string; createdAtMs: number; level: KnowledgeLevel; scope: KnowledgeScope; contentType: "article"; contributors: Array<string>; proposalId: string | null; reviewerId: string | null; reviewedAtMs: number | null }
export type KnowledgeVersion = { knowledgeId: string; termKey: string; archived: boolean; version: KnowledgeVersionSummary; text: string }
export type KnowledgeDetail = { item: KnowledgeSummary; current: KnowledgeVersion }
export type KnowledgeListResponse = { items: Array<KnowledgeSummary>; nextAfterId: string | null }
export type KnowledgeVersionListResponse = { versions: Array<KnowledgeVersionSummary>; nextAfterId: string | null }
export type KnowledgeLevel = "rule" | "experience" | "term"
export type KnowledgeScope = { kind: "workspace" | "repositories"; repositoryIds: Array<string> }
export type KnowledgeHealth = { readCount: number; usefulCount: number; expiredCount: number; needsReview: boolean; lastReviewedAtMs: number | null; feedbackWatermark: number }
export type KnowledgeCandidate = { termKey: string; category: string; title: string; text: string; level: KnowledgeLevel; scope: KnowledgeScope; contentType: "article" }
export type KnowledgeSource = { revision?:number|null; kind: "local_conversation" | "conversation" | "snapshot" | "knowledge" | "proposal"; referenceId: string; projectId: string | null }
export type KnowledgeProposalContent = { intent: "new" | "supplement" | "conflict" | "archive"; targetKnowledgeId: string | null; baseVersionId: string | null; baseItemVersion: number | null; candidate: KnowledgeCandidate; relatedReferences: Array<KnowledgeRef>; sourceSummary: string; sourceRefs: Array<KnowledgeSource>; generationKind: "agent" | "manual" }
export type KnowledgeProposalCreateRequest = { content: KnowledgeProposalContent; submit: boolean; requestId: string }
export type KnowledgeProposalUpdateRequest = { content: KnowledgeProposalContent; expectedRevision: number; requestId: string }
export type KnowledgeProposalActionRequest = { expectedRevision: number; requestId: string; confirmShare: boolean }
export type KnowledgeProposalReviewRequest = { decision: "approve" | "return"; expectedRevision: number; requestId: string; baseVersionId: string | null; expectedItemVersion: number | null; finalCandidate: KnowledgeCandidate | null; note: string }
export type KnowledgeProposal = { proposalId: string; workspaceId: string; proposerId: string; content: KnowledgeProposalContent; revision: number; status: "draft" | "submitted" | "returned" | "published" | "withdrawn"; createdAtMs: number; updatedAtMs: number; submittedAtMs: number | null; lastReason: string; publishedKnowledgeId: string | null; publishedVersionId: string | null; reviewerId: string | null; outcome: "" | "published" | "archived"; proposerActive: boolean }
export type KnowledgeProposalSummary = { proposalId: string; proposerId: string; title: string; level: KnowledgeLevel; status: "draft" | "submitted" | "returned" | "published" | "withdrawn"; revision: number; updatedAtMs: number; proposerActive: boolean }
export type KnowledgeProposalListResponse = { items: Array<KnowledgeProposalSummary>; nextAfterId: string | null }
export type KnowledgeProposalEvent = { eventId: string; kind: string; actorId: string; note: string; content: KnowledgeProposalContent; occurredAtMs: number }
export type KnowledgeProposalDetail = { proposal: KnowledgeProposal; events: Array<KnowledgeProposalEvent>; nextAfterId: string | null }
export type KnowledgeReadRequest = { readId: string }
export type KnowledgeUsageResponse = { versionReadCount: number; totalReadCount: number }
export type KnowledgeFeedbackRequest = { value: "useful" | "expired" | null; note: string; requestId: string }
export type KnowledgeFeedbackResponse = { value: "useful" | "expired" | null; note: string; usefulCount: number; expiredCount: number; versionReadCount: number }
export type KnowledgeReviewRequest = { expectedItemVersion: number; currentVersionId: string; feedbackWatermark: number; action: "confirmed_valid"; note: string; requestId: string }
export type KnowledgeReviewEvent = { eventId: string; actorId: string; kind: "feedback" | "confirmed_valid"; versionId: string; note: string; value: "useful" | "expired" | null; occurredAtMs: number }
export type KnowledgeReviewDetail = { item: KnowledgeSummary; events: Array<KnowledgeReviewEvent>; nextAfterId: string | null }

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

/** 已发布知识查询条件，范围筛选在服务端分页之前执行。 */
export type KnowledgeQuery = {level?:KnowledgeLevel; scopeMode?:"all"|"applicable"; repositoryIds?:string[]; limit?:number}
