/**
 * 【功能定义】桌面个人视图存储与恢复的纯数据契约。
 * 【协作边界】只包含个人输入、阅读位置、目录选择与按需缓存的正文；零 Node/Electron 依赖，不含共享凭据。
 */
import type { HistoryMessage } from "@workbench/collaboration-client/types"

export type PersonalKey =
  | { kind: "account" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "projectNavigation"; workspaceId: string; projectId: string }
  | { kind: "projectDraft"; workspaceId: string; projectId: string }
  | { kind: "conversation"; workspaceId: string | null; projectId: string | null; conversationId: string }
  | { kind: "sessionWorkspace"; workspaceId: string | null; projectId: string | null; conversationId: string }

export type AccountPersonal = { workspaceId: string | null; activeView?: "workspace" | "solo" }

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
  /** 旧个人记录可只有文字和目录，恢复时补齐引用、选区和修订。 */
  referenceIds?: readonly string[]
  revision?: number
  selectionStart?: number
  selectionEnd?: number
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

/** 单条草稿划选注释的数量、正文长度、批注长度与来源长度上限。 */
export const MAX_DRAFT_ANNOTATIONS = 20
export const MAX_DRAFT_ANNOTATION_TEXT_CHARS = 4000
export const MAX_DRAFT_ANNOTATION_COMMENT_CHARS = 2000
export const MAX_DRAFT_ANNOTATION_SOURCE_CHARS = 512

/** 输入区粘贴图片的数量、字节上限与支持的 MIME 白名单。 */
export const MAX_DRAFT_IMAGES = 6
export const MAX_SINGLE_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_TOTAL_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_SENT_IMAGE_RECORDS = 50
export const SUPPORTED_DRAFT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const
export type DraftImageMimeType = (typeof SUPPORTED_DRAFT_IMAGE_MIME_TYPES)[number]

/** 会话草稿或已发送消息在 PersonalStore 中保存的轻量图片引用（字节存放在本机隔离目录）。 */
export interface PersonalDraftImage {
  readonly id: string
  readonly name: string
  readonly mimeType: DraftImageMimeType
  readonly sizeBytes: number
  readonly width?: number
  readonly height?: number
}

/** 会话草稿中保存的一条划选摘录注释。 */
export interface PersonalDraftAnnotation {
  readonly id: string
  readonly selectedText: string
  readonly comment?: string
  readonly sourceLabel?: string
}

/** 会话输入草稿（纯数据形状）。 */
export interface PersonalConversationDraft {
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly revision: number
  readonly referenceIds: readonly string[]
  readonly attachmentIds: readonly string[]
  readonly annotations?: readonly PersonalDraftAnnotation[]
  readonly images?: readonly PersonalDraftImage[]
}

/** 单条会话的个人阅读态、草稿、工作目录与主动拉取缓存。 */
export type ConversationPersonal = {
  readonly scroll: PersonalTimelineScroll
  readonly expandedTools: readonly string[]
  readonly expandedOutputs: readonly string[]
  readonly draft: PersonalConversationDraft
  localDirectoryPath: string | null
  providerId?: string | null
  /** 由主进程确认归属后保存的本机手动标题。 */
  readonly customTitle?: string
  /** 本机已发送轮次在服务端序号对应的图片元数据（仅供本机重开后缩略图预览）。 */
  readonly sentImages?: Readonly<Record<string, readonly PersonalDraftImage[]>>
  syncCache: ConversationSyncCache | null
}

export const EMPTY_CONVERSATION_PERSONAL: ConversationPersonal = {
  scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
  expandedTools: [],
  expandedOutputs: [],
  draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [], annotations: [], images: [] },
  localDirectoryPath: null,
  syncCache: null,
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
  renameConversation(key: Extract<PersonalKey, { kind: "conversation" }>, title: string): Promise<PersonalResult<string>>
  onCloseRequested(listener: () => Promise<boolean>): () => void
}
