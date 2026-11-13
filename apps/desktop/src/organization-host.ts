/** 页面可见的组织层窄端口：项目、成员与仓库目录。凭据、服务地址和请求细节只在主进程。 */
import type {
  CollaborationResult, ProjectCreateRequest, ProjectDetailResponse, ProjectListResponse, ProjectMemberAddRequest,
  ProjectMemberChangeResponse, ProjectPatchRequest, ProjectResponse, RepositoryListResponse,
} from "@workbench/contracts"

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
