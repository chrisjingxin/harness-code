/**
 * 【功能定义】桌面工作台主进程、预加载与渲染层共用的宿主窄端口契约。
 * 【协作边界】仅使用 `@workbench/contracts` 内部纯数据契约，不依赖 Node、Electron 或 `@workbench/ui`。
 */
import type {
  BoardResponse,
  KnowledgeCreateRequest,
  KnowledgeDetail,
  KnowledgeListResponse,
  KnowledgeUpdateRequest,
  KnowledgeVersion,
  KnowledgeVersionListResponse,
  NotificationEvent,
  TaskConversationRequest,
  TaskCreateRequest,
  TaskDetail,
  TaskListResponse,
  TaskPatchRequest,
  TaskTransitionRequest,
} from "./collaboration.js"
import type { CollaborationResult } from "./identity.js"
import type {
  ProjectCreateRequest,
  ProjectDetailResponse,
  ProjectListResponse,
  ProjectMemberAddRequest,
  ProjectMemberChangeResponse,
  ProjectPatchRequest,
  ProjectResponse,
  RepositoryListResponse,
  SnapshotCreateRequest,
  SnapshotResponse,
} from "./organization.js"

/** 页面可见的组织层窄端口：项目、成员与仓库目录。凭据、服务地址和请求细节只在主进程。 */
export interface OrganizationHost {
  listProjects(workspaceId: string): Promise<CollaborationResult<ProjectListResponse>>
  createProject(workspaceId: string, request: ProjectCreateRequest): Promise<CollaborationResult<ProjectResponse>>
  getProject(workspaceId: string, projectId: string): Promise<CollaborationResult<ProjectDetailResponse>>
  updateProject(workspaceId: string, projectId: string, request: ProjectPatchRequest): Promise<CollaborationResult<ProjectResponse>>
  addMember(workspaceId: string, projectId: string, request: ProjectMemberAddRequest): Promise<CollaborationResult<ProjectMemberChangeResponse>>
  removeMember(workspaceId: string, projectId: string, userId: string): Promise<CollaborationResult<ProjectMemberChangeResponse>>
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
  listKnowledge(workspaceId: string, query: string, afterId: string | null): Promise<CollaborationResult<KnowledgeListResponse>>
  readKnowledge(workspaceId: string, knowledgeId: string): Promise<CollaborationResult<KnowledgeDetail>>
  createKnowledge(workspaceId: string, request: KnowledgeCreateRequest): Promise<CollaborationResult<KnowledgeDetail>>
  editKnowledge(workspaceId: string, knowledgeId: string, request: KnowledgeUpdateRequest): Promise<CollaborationResult<KnowledgeDetail>>
  archiveKnowledge(workspaceId: string, knowledgeId: string, expectedVersion: number): Promise<CollaborationResult<KnowledgeDetail>>
  listKnowledgeVersions(workspaceId: string, knowledgeId: string, afterId: string | null): Promise<CollaborationResult<KnowledgeVersionListResponse>>
  readKnowledgeVersion(workspaceId: string, knowledgeId: string, versionId: string): Promise<CollaborationResult<KnowledgeVersion>>
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
