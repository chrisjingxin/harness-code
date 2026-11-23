/**
 * 【功能定义】组织层契约：业务项目、项目成员、团队仓库目录、项目会话及快照的线上 DTO。
 * 【协作边界】纯前端安全纯类型定义，与 `contracts/schema/organization.schema.json` 及 Java 侧 DTO 逐一对齐。
 */

export type ProjectStatus = "active" | "archived"
export type MemberStatus = "active" | "removed"
export type ProjectRole = "owner" | "member"
export type RepositoryStatus = "active" | "archived"

export interface ProjectCreateRequest {
  name: string
  description: string
  requestId: string
}

export interface ProjectPatchRequest {
  name?: string
  description?: string
  /** 归档只允许置 archived，单向不可逆 */
  status?: "archived"
  expectedVersion: number
}

export interface ProjectMemberAddRequest {
  userId: string
  requestId: string
}

export interface RepositoryCreateRequest {
  ownerUserId?: string | null
  name: string
  remoteUrl: string
  defaultBranch?: string
  requestId: string
}

export interface RepositoryPatchRequest {
  ownerUserId?: string | null
  expectedVersion: number
  name?: string
  defaultBranch?: string
  /** 归档只允许置 archived，单向不可逆 */
  status?: "archived"
}

export interface ProjectSummary {
  projectId: string
  workspaceId: string
  name: string
  description: string
  ownerUserId: string
  status: ProjectStatus
  role: ProjectRole
  memberCount: number
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProjectResponse {
  projectId: string
  workspaceId: string
  name: string
  description: string
  ownerUserId: string
  status: ProjectStatus
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProjectListResponse {
  workspaceId: string
  projects: ProjectSummary[]
}

export interface ProjectMemberSummary {
  userId: string
  status: MemberStatus
  joinedAt: string
  /** removed 时给出移出时间，供"已离开项目"标注 */
  leftAt: string | null
}

export interface ProjectMemberListResponse {
  projectId: string
  members: ProjectMemberSummary[]
}

export interface ProjectMemberChangeResponse {
  member: ProjectMemberSummary
}

export interface RepositorySummary {
  repositoryId: string
  workspaceId: string
  name: string
  remoteUrl: string
  defaultBranch: string
  status: RepositoryStatus
  createdByUserId: string
  ownerUserId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface RepositoryListResponse {
  workspaceId: string
  repositories: RepositorySummary[]
}

export interface ReferencingProjectSummary {
  projectId: string
  name: string
}

export interface RepositoryDetailResponse {
  repository: RepositorySummary
  /** 仅返回调用者以活跃成员身份可见的项目，避免项目存在性泄露 */
  projects: ReferencingProjectSummary[]
}

export interface ProjectRepositoryItem {
  repositoryId: string
  name: string
  remoteUrl: string
  defaultBranch: string
  status: RepositoryStatus
  referencedAt: string
}

export interface ProjectRepositoryListResponse {
  projectId: string
  repositories: ProjectRepositoryItem[]
}

export interface ProjectDetailResponse {
  project: ProjectSummary
  members: ProjectMemberSummary[]
  repositories: RepositorySummary[]
}

/** 会话运行状态（由主人本机随同步批次上送） */
export type ConversationStatus = "idle" | "running" | "waiting_approval" | "error"
/** 团队共享档位：full=完整正文，summary_only=仅状态与成果摘要 */
export type ConversationShareMode = "full" | "summary_only"
/** 会话共享生命周期状态：active=持续同步，stopped=已停止共享（保留只读快照） */
export type ConversationShareStatus = "active" | "stopped"
/** 简报来源：rule 规则生成；agent 预留给后续 Agent 摘要 */
export type ConversationBriefSource = "rule" | "agent"
/** 定稿消息类型；tool_summary 只含摘要字段，不含完整输出 */
export type ConversationMessageType = "user" | "assistant" | "tool_summary" | "status"

export interface ConversationRepositoryItem {
  repositoryId: string
  name: string
}

export interface ConversationSummary {
  conversationId: string
  projectId: string
  ownerUserId: string
  title: string
  status: ConversationStatus
  /** 最近简报正文；空串表示无简报 */
  briefText: string
  briefSource: ConversationBriefSource
  /** 简报最近更新时间(epoch ms)；登记时取创建时间作基线 */
  briefUpdatedAtMs: number
  /** 服务端已确认的最大已上传消息序号（单调水位） */
  syncedSequence: number
  updatedAt: string
  shareMode: ConversationShareMode
  shareStatus: ConversationShareStatus
  stoppedAt: string | null
  /** 登记时的仓库快照，不随项目引用变化 */
  repositories: ConversationRepositoryItem[]
}

export interface ConversationRegisterRequest {
  title?: string
  /** 必须是项目已引用仓库的子集，否则 400 */
  repositoryIds?: string[]
  /** 可选指定本机既有个人会话 UUID，便于原会话直接发布到 Project 且保持标识连续 */
  conversationId?: string
  /** 团队共享档位（省略时服务端默认为 full） */
  shareMode?: ConversationShareMode
  /** 发布时可随会话头一并写入初始状态与成果摘要 */
  initialBrief?: SyncBrief
  requestId: string
}

export interface ConversationListResponse {
  projectId: string
  conversations: ConversationSummary[]
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary
}

export interface HistoryMessage {
  sequence: number
  type: ConversationMessageType
  occurredAtMs: number
  payload: string
}

export interface ConversationHistoryResponse {
  conversationId: string
  syncedSequence: number
  messages: HistoryMessage[]
}

export interface SyncMessage {
  sequence: number
  type: ConversationMessageType
  occurredAtMs: number
  payload: string
}

export interface SyncBrief {
  status?: ConversationStatus
  briefText?: string | null
  briefSource?: ConversationBriefSource
}

/** 会话定稿上传通道：序号必须从水位+1 起连续；整批 ≤ 水位时幂等回执 */
export interface ConversationSyncRequest {
  messages: SyncMessage[]
  brief?: SyncBrief
}

export interface ConversationSyncResponse {
  syncedSequence: number
}

/** 仅使用请求时服务端已确认的同步内容，序号区间包含两端。 */
export type SnapshotRequestedRange =
  | { type: "latest"; count?: number }
  | { type: "through"; toSequence: number }
  | { type: "range"; fromSequence: number; toSequence: number }
  | { type: "brief" }

export interface SnapshotCreateRequest {
  sourceConversationId: string
  /** 省略时取最新最多 20 条。 */
  range?: SnapshotRequestedRange
}

/** 创建预览和按 ID 读取共用的固定材料。 */
export interface SnapshotResponse {
  snapshotId: string
  projectId: string
  sourceConversationId: string
  sourceOwnerUserId: string
  sourceTitle: string
  sourceSyncedSequence: number
  sourceSyncedAtMs: number
  /** 简报快照的起止序号为 null，消息数为 0。 */
  fromSequence: number | null
  toSequence: number | null
  messageCount: number
  text: string
  /** 完整正文的 UTF-8 字节 SHA-256，使用小写十六进制。 */
  sha256: string
  createdByUserId: string
  ownerUserId: string | null
  version: number
  createdAtMs: number
}
