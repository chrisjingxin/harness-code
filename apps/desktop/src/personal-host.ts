/** 桌面个人视图的窄契约：只包含个人输入和选择，不包含共享正文、项目内容或凭据。 */
import type { ConversationPersonalState, ProjectPersonalView } from "@workbench/ui"

export type PersonalKey =
  | { kind: "account" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "projectNavigation"; workspaceId: string; projectId: string }
  | { kind: "conversation"; workspaceId: string; conversationId: string }
  | { kind: "project"; workspaceId: string; conversationId: string }

export type AccountPersonal = { workspaceId: string | null }
/** 团队范围：当前项目与左右栏布局偏好。 */
export type WorkspacePersonal = {
  projectId: string | null
  panels: Record<"left" | "right", { open: boolean; width: number }>
}
/** 项目内的中央页面；会话与任务只保存标识，打开时由各自模块重新授权读取。 */
export type ProjectPage =
  | { kind: "new" | "board" | "tasks" | "info" | "knowledge" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "task"; taskId: string }
/** 项目范围：上次页面、展开的他人成员组和本人组是否被手动收起。 */
export type ProjectNavigationPersonal = {
  page: ProjectPage
  expandedMembers: readonly string[]
  selfCollapsed: boolean
}
export type ConversationPersonal = Omit<ConversationPersonalState, "interactions">
export type ProjectPersonal = {
  view: ProjectPersonalView
  expanded: readonly string[]
  centralPaths: readonly string[]
  activeCentral: string | null
  diffPath: string | null
}
export type ProjectPersonalRecord = {
  personal: ProjectPersonal
  positions: readonly { area: "central" | "dock" | "tree"; path: string; top: number; left: number }[]
}
export type PersonalValue = AccountPersonal | WorkspacePersonal | ProjectNavigationPersonal | ConversationPersonal | ProjectPersonalRecord
export type PersonalRead = {
  revision: number
  data: PersonalValue | null
  project?: { deviceId: string; projectId: string }
}
export type PersonalResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** 服务域、账号与存储位置由主进程确定，页面只能选择已确认资源。 */
export interface PersonalHost {
  load(key: PersonalKey): Promise<PersonalResult<PersonalRead>>
  save(key: PersonalKey, revision: number, value: PersonalValue): Promise<PersonalResult<null>>
  onCloseRequested(listener: () => Promise<boolean>): () => void
}
