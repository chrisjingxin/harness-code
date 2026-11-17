/** HC-219 的桌面具名宿主端口，直接消费 HC-212 已交付的 HTTP 形状。 */
import type {
  CollaborationResult, KnowledgeCreateRequest, KnowledgeDetail, KnowledgeListResponse,
  KnowledgeUpdateRequest, KnowledgeVersion, KnowledgeVersionListResponse, SnapshotCreateRequest, SnapshotResponse,
  TaskConversationRequest, TaskCreateRequest, TaskDetail, TaskListResponse, TaskPatchRequest, TaskTransitionRequest,
} from "@workbench/contracts"

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
