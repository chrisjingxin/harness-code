import type * as K from "@workbench/collaboration-client/types"
/**
 * 【功能定义】桌面工作台主进程、预加载与渲染层共用的组织/协作/看板宿主窄端口契约。
 * 【协作边界】仅消费 `@workbench/collaboration-client/types` 纯数据 DTO，零 Node/Electron 依赖。
 */
import type {
  BoardResponse,
  CollaborationResult,
  InboxQuery,
  InboxResponse,
  KnowledgeCreateRequest,
  KnowledgeDetail,
  KnowledgeListResponse,
  KnowledgeUpdateRequest,
  KnowledgeVersion,
  KnowledgeVersionListResponse,
  NotificationEvent,
  NotificationPreferences,
  NotificationPreferencesUpdateRequest,
  ProjectCreateRequest,
  ProjectDetailResponse,
  ProjectListResponse,
  ProjectMemberAddRequest,
  ProjectMemberChangeResponse,
  ProjectPatchRequest,
  ProjectResponse,
  RepositoryListResponse, RepositorySummary, RepositoryPatchRequest, RepositoryCreateRequest,
  SnapshotCreateRequest,
  SnapshotResponse,
  TaskConversationRequest,
  TaskCreateRequest,
  TaskDetail,
  TaskListResponse,
  TaskPatchRequest,
  TaskTransitionRequest,
  UserNotificationPage,
  UserUpdatesNotice,
} from "@workbench/collaboration-client/types"

/** 页面可见的组织层窄端口：项目、成员与仓库目录。凭据、服务地址和请求细节只在主进程。 */
export interface OrganizationHost {
  listProjects(workspaceId: string): Promise<CollaborationResult<ProjectListResponse>>
  createProject(workspaceId: string, request: ProjectCreateRequest): Promise<CollaborationResult<ProjectResponse>>
  getProject(workspaceId: string, projectId: string): Promise<CollaborationResult<ProjectDetailResponse>>
  updateProject(workspaceId: string, projectId: string, request: ProjectPatchRequest): Promise<CollaborationResult<ProjectResponse>>
  addMember(workspaceId: string, projectId: string, request: ProjectMemberAddRequest): Promise<CollaborationResult<ProjectMemberChangeResponse>>
  removeMember(workspaceId: string, projectId: string, userId: string): Promise<CollaborationResult<ProjectMemberChangeResponse>>
  createRepository(workspaceId: string, request: RepositoryCreateRequest): Promise<CollaborationResult<RepositorySummary>>
  updateRepository(workspaceId: string, repositoryId: string, request: RepositoryPatchRequest): Promise<CollaborationResult<RepositorySummary>>
  listRepositories(workspaceId: string): Promise<CollaborationResult<RepositoryListResponse>>
  linkRepository(workspaceId: string, projectId: string, repositoryId: string): Promise<CollaborationResult<null>>
  unlinkRepository(workspaceId: string, projectId: string, repositoryId: string): Promise<CollaborationResult<null>>
}

/** 桌面具名协作应用端口：固定快照、项目任务与团队知识读写。 */
export interface CollaborationAppsHost {
  createSnapshot(workspaceId: string, projectId: string, request: SnapshotCreateRequest): Promise<CollaborationResult<SnapshotResponse>>
  readSnapshot(workspaceId: string, projectId: string, snapshotId: string): Promise<CollaborationResult<SnapshotResponse>>
  listTasks(workspaceId: string, projectId: string, afterId: string | null): Promise<CollaborationResult<TaskListResponse>>
  readTask(workspaceId: string, projectId: string, taskId: string): Promise<CollaborationResult<TaskDetail>>
  createTask(workspaceId: string, projectId: string, request: TaskCreateRequest): Promise<CollaborationResult<TaskDetail>>
  editTask(workspaceId: string, projectId: string, taskId: string, request: TaskPatchRequest): Promise<CollaborationResult<TaskDetail>>
  transitionTask(workspaceId: string, projectId: string, taskId: string, request: TaskTransitionRequest): Promise<CollaborationResult<TaskDetail>>
  linkTaskConversation(workspaceId: string, projectId: string, taskId: string, request: TaskConversationRequest): Promise<CollaborationResult<TaskDetail>>
  listKnowledge(workspaceId: string, query: string, afterId: string | null, options?: K.KnowledgeQuery): Promise<CollaborationResult<KnowledgeListResponse>>
  readKnowledge(workspaceId: string, knowledgeId: string): Promise<CollaborationResult<KnowledgeDetail>>
  createKnowledge(workspaceId: string, request: KnowledgeCreateRequest): Promise<CollaborationResult<KnowledgeDetail>>
  editKnowledge(workspaceId: string, knowledgeId: string, request: KnowledgeUpdateRequest): Promise<CollaborationResult<KnowledgeDetail>>
  archiveKnowledge(workspaceId: string, knowledgeId: string, expectedVersion: number, requestId: string): Promise<CollaborationResult<KnowledgeDetail>>
  listKnowledgeVersions(workspaceId: string, knowledgeId: string, afterId: string | null): Promise<CollaborationResult<KnowledgeVersionListResponse>>
  readKnowledgeVersion(workspaceId: string, knowledgeId: string, versionId: string): Promise<CollaborationResult<KnowledgeVersion>>
  createKnowledgeProposal(workspaceId: string, request: K.KnowledgeProposalCreateRequest): Promise<CollaborationResult<K.KnowledgeProposalDetail>>
  listKnowledgeProposals(workspaceId: string, view: "mine" | "review", status: string | null, afterId: string | null): Promise<CollaborationResult<K.KnowledgeProposalListResponse>>
  readKnowledgeProposal(workspaceId: string, proposalId: string, afterId: string | null): Promise<CollaborationResult<K.KnowledgeProposalDetail>>
  editKnowledgeProposal(workspaceId: string, proposalId: string, request: K.KnowledgeProposalUpdateRequest): Promise<CollaborationResult<K.KnowledgeProposalDetail>>
  submitKnowledgeProposal(workspaceId: string, proposalId: string, request: K.KnowledgeProposalActionRequest): Promise<CollaborationResult<K.KnowledgeProposalDetail>>
  withdrawKnowledgeProposal(workspaceId: string, proposalId: string, request: K.KnowledgeProposalActionRequest): Promise<CollaborationResult<K.KnowledgeProposalDetail>>
  reviewKnowledgeProposal(workspaceId: string, proposalId: string, request: K.KnowledgeProposalReviewRequest): Promise<CollaborationResult<K.KnowledgeProposalDetail>>
  readKnowledgeFeedback(workspaceId: string, knowledgeId: string, versionId: string): Promise<CollaborationResult<K.KnowledgeFeedbackResponse>>
  setKnowledgeFeedback(workspaceId: string, knowledgeId: string, versionId: string, request: K.KnowledgeFeedbackRequest): Promise<CollaborationResult<K.KnowledgeFeedbackResponse>>
  listKnowledgeReviews(workspaceId: string, afterId: string | null): Promise<CollaborationResult<K.KnowledgeListResponse>>
  readKnowledgeReview(workspaceId: string, knowledgeId: string, afterId: string | null): Promise<CollaborationResult<K.KnowledgeReviewDetail>>
  confirmKnowledgeReview(workspaceId: string, knowledgeId: string, request: K.KnowledgeReviewRequest): Promise<CollaborationResult<K.KnowledgeReviewDetail>>
}

export type ProjectUpdatesStatus = "connecting" | "connected" | "retrying" | "unavailable"

export type ProjectUpdatesNotice = { readonly subscriptionId: string } & (
  | { readonly kind: "status"; readonly status: ProjectUpdatesStatus }
  | { readonly kind: "event"; readonly event: NotificationEvent }
)

/** 看板与轻量通知的固定 IPC 通道名，供主进程与预加载桥统一引用。 */
export const projectUpdatesChannels = {
  board: "workbench:project-updates:board",
  subscribe: "workbench:project-updates:subscribe",
  acknowledge: "workbench:project-updates:acknowledge",
  unsubscribe: "workbench:project-updates:unsubscribe",
  notice: "workbench:project-updates:notice",
} as const

/** 桌面端具名看板与团队轻量通知生命周期端口。 */
export interface ProjectUpdatesHost {
  readBoard(workspaceId: string, projectId: string): Promise<CollaborationResult<BoardResponse>>
  subscribe(workspaceId: string, subscriptionId: string): Promise<CollaborationResult<null>>
  acknowledge(subscriptionId: string, eventId: number): Promise<void>
  unsubscribe(subscriptionId: string): Promise<void>
  onNotice(listener: (notice: ProjectUpdatesNotice) => void): () => void
}

/** 跨团队全局收件箱、用户级通知流与通知偏好的固定 IPC 通道名，供主进程与预加载桥统一引用。 */
export const inboxChannels = {
  getInbox: "workbench:inbox:get",
  listNotifications: "workbench:inbox:list-notifications",
  getPreferences: "workbench:inbox:get-preferences",
  updatePreferences: "workbench:inbox:update-preferences",
  subscribe: "workbench:inbox:subscribe",
  acknowledge: "workbench:inbox:acknowledge",
  unsubscribe: "workbench:inbox:unsubscribe",
  notice: "workbench:inbox:notice",
} as const

/** 桌面端跨团队收件箱、用户级通知流与偏好设置窄端口。 */
export interface InboxHost {
  getInbox(query?: InboxQuery): Promise<CollaborationResult<InboxResponse>>
  listUserNotifications(query?: { afterId?: number; limit?: number }): Promise<CollaborationResult<UserNotificationPage>>
  getNotificationPreferences(): Promise<CollaborationResult<NotificationPreferences>>
  updateNotificationPreferences(input: NotificationPreferencesUpdateRequest): Promise<CollaborationResult<NotificationPreferences>>
  subscribe(subscriptionId: string, initialCursor?: number): Promise<CollaborationResult<null>>
  acknowledge(subscriptionId: string, id: number): Promise<void>
  unsubscribe(subscriptionId: string): Promise<void>
  onNotice(listener: (notice: UserUpdatesNotice) => void): () => void
}
