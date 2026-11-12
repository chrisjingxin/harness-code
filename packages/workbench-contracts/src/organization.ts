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
