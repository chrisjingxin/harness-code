/**
 * 本机个人会话独立存储与宿主 IPC 端口契约。
 *
 * 【功能定义】声明个人会话列表记录（`LocalConversationRecord`）、单会话完整历史详情（`LocalConversationDetail`）
 * 以及前后端交互的 `LocalConversationsHost` 具名接口，支撑个人会话先于云端在本机独立持久化、
 * 按团队上下文隔离过滤、以及在发布到 Project 与停止共享之间无缝迁移。
 *
 * 【协作边界】仅依赖纯数据 DTO（`@workbench/collaboration-client/types`、`./personal.js`、`./local-execution-host.js`），
 * 严禁引入 Node 或 Electron 模块，供 `desktop/src/main`、`preload` 与 `renderer` 安全共用。
 */
import type {
  CollaborationResult,
  ConversationShareMode,
  ConversationStatus,
} from "@workbench/collaboration-client/types"
import type { LocalExecutionAttachment } from "./local-execution-host.js"
import type { PersonalDraftImage } from "./personal.js"

/** 本机会话的团队发布生命周期状态。 */
export type LocalConversationShareStatus = "local_only" | "active" | "stopped"

/** 持久化在单轮记录中的已终态工具调用摘要（不含完整长输出）。 */
export type LocalConversationToolSummary = {
  readonly label: string
  readonly name?: string
  readonly summary?: string
  readonly status: "completed" | "failed"
  readonly tone: "read" | "write" | "neutral"
  readonly occurredAtMs: number
}

/** `index.json` 中的单条个人/本机会话元数据索引。 */
export type LocalConversationRecord = {
  readonly conversationId: string
  /** 新建时锁定的团队上下文；无团队个人会话为 null。 */
  readonly workspaceId: string | null
  /** 已发布或曾发布关联的 Project ID；未发布过为 null。 */
  readonly projectId: string | null
  /** 发布时选择的团队共享档位；仅本地未发布时为 null。 */
  readonly shareMode: ConversationShareMode | null
  readonly shareStatus: LocalConversationShareStatus
  readonly title: string
  readonly directoryPath: string | null
  readonly providerId: string | null
  readonly status: ConversationStatus
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly publishedAtMs: number | null
  readonly stoppedAtMs: number | null
  readonly syncedSequence: number
}

/** 保存在 `conversations/<conversationId>.json` 中的单轮定稿记录。 */
export type LocalConversationTurn = {
  readonly turnId: string
  readonly sequenceStart: number
  readonly sequenceEnd: number
  readonly userText: string
  readonly referenceIds?: readonly string[]
  readonly attachments?: readonly LocalExecutionAttachment[]
  readonly images?: readonly PersonalDraftImage[]
  readonly followUps?: readonly { readonly text: string; readonly occurredAtMs: number }[]
  readonly tools?: readonly LocalConversationToolSummary[]
  readonly reply: string
  readonly status: "completed" | "cancelled" | "failed"
  readonly failure?: string
  readonly acceptedAtMs: number
  readonly completedAtMs: number
}

/** 单会话完整本机读取详情（含超限裁剪提示标志）。 */
export type LocalConversationDetail = {
  readonly record: LocalConversationRecord
  readonly nextSequence: number
  readonly historyTrimmed?: boolean
  readonly turns: readonly LocalConversationTurn[]
}

/** 按当前团队上下文筛选本机会话列表的查询条件。 */
export type LocalConversationsListFilter = {
  readonly workspaceId?: string | null
  readonly includePublished?: boolean
}

/** 新建本机个人会话的请求载体。 */
export type CreateLocalConversationInput = {
  readonly conversationId?: string
  readonly workspaceId: string | null
  readonly title?: string
  readonly directoryPath?: string | null
  readonly providerId?: string | null
}

/** 更新本机执行目录或 Agent 类型等绑定的增量字段。 */
export type UpdateLocalConversationBindingPatch = {
  readonly directoryPath?: string | null
  readonly providerId?: string | null
  readonly status?: ConversationStatus
}

/** 将个人会话标记为已发布到云端 Project 时需落盘的绑定信息。 */
export type MarkLocalConversationPublishedInput = {
  readonly workspaceId: string
  readonly projectId: string
  readonly shareMode: ConversationShareMode
  readonly syncedSequence?: number
  /** 当选择完整正文且需要同步发布前已定稿轮次时，指定起始轮次下标（0 表示全部历史）。 */
  readonly historyFromTurnIndex?: number
}

/** 渲染进程访问主进程 `LocalConversationStore` 的具名安全端口。 */
export interface LocalConversationsHost {
  list(filter?: LocalConversationsListFilter): Promise<CollaborationResult<readonly LocalConversationRecord[]>>
  get(conversationId: string): Promise<CollaborationResult<LocalConversationDetail>>
  create(input: CreateLocalConversationInput): Promise<CollaborationResult<LocalConversationRecord>>
  rename(conversationId: string, title: string): Promise<CollaborationResult<LocalConversationRecord>>
  updateWorkspace(conversationId: string, workspaceId: string | null): Promise<CollaborationResult<LocalConversationRecord>>
  updateBinding(
    conversationId: string,
    patch: UpdateLocalConversationBindingPatch,
  ): Promise<CollaborationResult<LocalConversationRecord>>
  markPublished(
    conversationId: string,
    binding: MarkLocalConversationPublishedInput,
  ): Promise<CollaborationResult<LocalConversationRecord>>
  markSharingStopped(conversationId: string, stoppedAtMs?: number): Promise<CollaborationResult<LocalConversationRecord>>
  remove(conversationId: string): Promise<CollaborationResult<null>>
  /** 监听主进程落盘完成（如一轮定稿写入）后的会话索引与轮次变更事件。 */
  onChanged?(listener: (event: { readonly conversationId: string }) => void): () => void
}
