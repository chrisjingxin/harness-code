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
  kind: "created" | "edited" | "transition" | "conversation_linked"
  actorId: string
  fromStatus: TaskStatus | null
  toStatus: TaskStatus
  version: number
  note: string
  commitSha: string
  occurredAtMs: number
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
    "knowledge.updated" | "project.member_changed"
  objectId: string
  projectId: string | null
  occurredAtMs: number
}

export interface NotificationPage {
  events: NotificationEvent[]
  nextAfterId: number
  hasMore: boolean
}
