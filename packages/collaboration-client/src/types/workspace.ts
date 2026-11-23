/** 团队角色与交接；Project owner/member 和本人 Agent 执行权不随团队角色转交。 */
import type { MemberSummary } from "./identity.js"
export type WorkspaceRole = "admin" | "developer"
export interface WorkspaceAccess { workspaceId: string; role: WorkspaceRole; memberVersion: number; accessVersion: number }
export interface WorkspaceMemberAddRequest { userNo: string; requestId: string }
export interface WorkspaceRoleChangeRequest { role: WorkspaceRole; expectedVersion: number; requestId: string }
export interface WorkspaceMemberChangeResponse { member: MemberSummary; accessVersion: number }
export interface WorkspaceRemovalTask { kind: "task"; taskId: string; projectId: string; title: string; status: "todo" | "doing" | "review"; version: number; creatorId: string; assigneeId: string; conversationId: string | null; duties: ("assignee" | "creator")[]; archived: boolean }
export interface WorkspaceRemovalProject { kind: "project"; projectId: string; name: string; status: "active" | "archived"; version: number; ownerUserId: string; targetIsOwner: boolean; targetIsMember: boolean }
export interface WorkspaceRemovalRepository { kind: "repository"; repositoryId: string; name: string; status: "active" | "archived"; version: number; ownerUserId: string | null }
export type WorkspaceRemovalItem = WorkspaceRemovalTask | WorkspaceRemovalProject | WorkspaceRemovalRepository
export interface ProjectSuccessor { projectId: string; userId: string }
export interface WorkspaceMemberRemovalRequest {
  requestId: string; expectedMemberVersion: number; previewVersion: string; defaultSuccessorUserId: string | null
  projectSuccessors: ProjectSuccessor[]; taskSuccessors: { taskId: string; userId: string }[]
  repositorySuccessors: { repositoryId: string; userId: string | null }[]; addToProjects: ProjectSuccessor[]
  confirmResetTasks: true; confirmRetainHistory: true
}
export interface WorkspaceRemovalPreview {
  workspaceId: string; targetMember: MemberSummary; accessVersion: number; effectiveAdminCount: number
  previewVersion: string; items: WorkspaceRemovalItem[]; nextAfterId: string | null
  counts: { tasks: number; projects: number; repositories: number; archived: number; sharedConversations: number }
  projectEligibility: { projectId: string; activeSuccessorUserIds: string[] }[]
}
export interface WorkspaceMemberRemovalResponse {
  workspaceId: string; member: MemberSummary; accessVersion: number; requestId: string
  transferredTaskCount: number; transferredProjectCount: number; transferredRepositoryCount: number
  unclaimedRepositoryCount: number; stoppedConversationCount: number
}
