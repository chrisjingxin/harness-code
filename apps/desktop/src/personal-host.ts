/** 桌面个人视图的窄契约：只包含个人输入和选择，不包含共享正文、项目内容或凭据。 */
import type { ConversationPersonalState, ProjectPersonalView } from "@workbench/ui"

export type PersonalKey =
  | { kind: "account" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "conversation"; workspaceId: string; conversationId: string }
  | { kind: "project"; workspaceId: string; conversationId: string }

export type AccountPersonal = { workspaceId: string | null }
export type WorkspacePersonal = {
  expandedDevices: readonly string[]
  expandedProjects: readonly string[]
  selectedConversationId: string | null
  panels: Record<"left" | "right", { open: boolean; width: number }>
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
export type PersonalValue = AccountPersonal | WorkspacePersonal | ConversationPersonal | ProjectPersonalRecord
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
