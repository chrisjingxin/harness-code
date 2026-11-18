/**
 * 【功能定义】桌面个人视图存储与恢复的纯数据契约。
 * 【协作边界】只包含个人输入、阅读位置、目录选择与按需缓存的正文；不依赖 `@workbench/ui` 或宿主运行时，也不含共享凭据。
 */
import type { HistoryMessage } from "./organization.js"

export type PersonalKey =
  | { kind: "account" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "projectNavigation"; workspaceId: string; projectId: string }
  | { kind: "projectDraft"; workspaceId: string; projectId: string }
  | { kind: "conversation"; workspaceId: string; projectId: string; conversationId: string }
  | { kind: "sessionWorkspace"; workspaceId: string; projectId: string; conversationId: string }

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

/** 新会话准备页的个人待选工作目录与草稿内容。 */
export type ProjectDraftPersonal = {
  directoryPath: string | null
  draftText: string
}

/** 跨机器会话在本机主动拉取后保存的定稿正文缓存与水位；超限裁剪后置 cacheTruncated。 */
export type ConversationSyncCache = {
  syncedSequence: number
  syncedAtMs: number
  messages: readonly HistoryMessage[]
  cacheTruncated?: boolean
}

/** 会话时间线阅读锚点（纯数据形状，与 UI 展示层结构对齐但不反向依赖 UI）。 */
export interface PersonalTimelineScroll {
  readonly anchorEntryId: string | null
  readonly offsetPx: number
  readonly following: boolean
  readonly seenContentRevision: number | null
}

/** 会话输入草稿（纯数据形状）。 */
export interface PersonalConversationDraft {
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly revision: number
  readonly referenceIds: readonly string[]
  readonly attachmentIds: readonly string[]
}

/** 单条会话的个人阅读态、草稿、工作目录与主动拉取缓存。 */
export type ConversationPersonal = {
  readonly scroll: PersonalTimelineScroll
  readonly expandedTools: readonly string[]
  readonly expandedOutputs: readonly string[]
  readonly draft: PersonalConversationDraft
  localDirectoryPath: string | null
  syncCache: ConversationSyncCache | null
}

/** 右侧项目文件/变更栏的纯数据布局与选中状态。 */
export type PersonalProjectView = {
  dockOpen: boolean
  dockWidthPx: number
  panel: "files" | "changes"
  selectedPath: string | null
  fileTabs: readonly { path: string; name: string }[]
  activeFilePath: string | null
  selectedChanges: readonly { path: string; version: string }[]
  commitMessage: string
}

export type ProjectPersonal = {
  view: PersonalProjectView
  expanded: readonly string[]
  centralPaths: readonly string[]
  activeCentral: string | null
  diffPath: string | null
}

export type ProjectPersonalRecord = {
  personal: ProjectPersonal
  positions: readonly { area: "central" | "dock" | "tree"; path: string; top: number; left: number }[]
}

export type PersonalValue =
  | AccountPersonal
  | WorkspacePersonal
  | ProjectNavigationPersonal
  | ProjectDraftPersonal
  | ConversationPersonal
  | ProjectPersonalRecord

export type PersonalRead = {
  revision: number
  data: PersonalValue | null
}

export type PersonalResult<T> = { ok: true; value: T } | { ok: false; message: string }

/** 服务域、账号与存储位置由主进程确定，页面只能选择已确认资源。 */
export interface PersonalHost {
  load(key: PersonalKey): Promise<PersonalResult<PersonalRead>>
  save(key: PersonalKey, revision: number, value: PersonalValue): Promise<PersonalResult<null>>
  onCloseRequested(listener: () => Promise<boolean>): () => void
}
