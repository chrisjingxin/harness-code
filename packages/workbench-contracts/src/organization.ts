/**
 * 组织层契约：业务项目、项目成员、团队仓库目录与设备本机仓库登记。
 * Java 侧按同名记录序列化，两边字段必须逐一对齐。
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
  name: string
  remoteUrl: string
  defaultBranch?: string
  requestId: string
}

export interface RepositoryPatchRequest {
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

export interface ClonedDeviceSummary {
  deviceId: string
  boundAt: string
}

export interface ProjectRepositoryItem {
  repositoryId: string
  name: string
  remoteUrl: string
  defaultBranch: string
  status: RepositoryStatus
  referencedAt: string
  /** 调用者名下未吊销设备中已登记本机仓库的设备 */
  clonedDevices: ClonedDeviceSummary[]
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

/** 会话运行状态（由主人 Runner 随同步批次上送） */
export type ConversationStatus = "idle" | "running" | "waiting_approval" | "error"
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
  deviceId: string
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
  /** 登记时的仓库快照，不随项目引用变化 */
  repositories: ConversationRepositoryItem[]
}

export interface ConversationRegisterRequest {
  /** 必须是调用者本人未吊销设备 */
  deviceId: string
  title?: string
  /** 必须是项目已引用仓库的子集，否则 400 */
  repositoryIds?: string[]
  taskId?: string
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

/** 设备上传通道：序号必须从水位+1 起连续；整批 ≤ 水位时幂等回执 */
export interface DeviceSyncRequest {
  messages: SyncMessage[]
  brief?: SyncBrief
}

export interface DeviceSyncResponse {
  syncedSequence: number
}
