/**
 * 会话领域纯模型：归类判定、同步五态推导、左栏条目投影与历史消息防御解码。
 *
 * 【功能定义】
 * 把服务端的 ConversationSummary / HistoryMessage 与本地缓存水位组合成可供左栏和中央页展示的
 * 确定性数据结构，不持有网络、React 状态或磁盘读写。
 */
import {
  EMPTY_CONVERSATION_PERSONAL,
  MAX_DRAFT_ANNOTATIONS,
  MAX_DRAFT_IMAGES,
  parseFixedReference,
  type PersonalDraftImage,
} from "../../../shared/index.js"
import type {
  ConversationAvailability,
  ConversationContextActionItem,
  ConversationDirectoryContextView,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationTimelineEntry,
  NavigationSessionEntry,
} from "../../../ui/index.js"
import type {
  ProjectConversationSummary,
  ProjectHistoryMessage,
  SessionKind,
  SessionSyncState,
  SessionSyncStatus,
} from "./contracts.js"

/** 默认空的远端同步状态。 */
export function emptySyncState(): SessionSyncState {
  return { localSyncedSequence: 0, lastSyncedAtMs: null, syncing: false, syncError: null, messages: [] }
}

/**
 * 按人判定会话归属（基于人共享会话）：
 * ownerUserId 与当前登录用户一致即视为本人可执行会话 ("local")；其余成员会话为只读 ("remote_other")。
 */
export function classifyConversation(
  conversation: Pick<ProjectConversationSummary, "ownerUserId">,
  currentUserId: string,
): SessionKind {
  return conversation.ownerUserId === currentUserId ? "local" : "remote_other"
}

/** 根据云端水位、本地缓存水位与最近操作状态推导当前同步五态。 */
export function deriveSyncStatus(input: {
  readonly kind: SessionKind
  readonly remoteSyncedSequence: number
  readonly localSyncedSequence: number
  readonly syncing: boolean
  readonly syncError: string | null
}): SessionSyncStatus {
  if (input.kind === "local") return "synced"
  if (input.syncing) return "syncing"
  if (input.syncError) return "sync_failed"
  if (input.localSyncedSequence <= 0) return "unsynced"
  if (input.remoteSyncedSequence > input.localSyncedSequence) return "has_update"
  return "synced"
}

/** 为左栏 ProjectNavigation 生成规范的状态徽标。 */
export function buildSessionBadge(input: {
  readonly kind: SessionKind
  readonly syncStatus: SessionSyncStatus
  readonly remoteSyncedSequence: number
}): NavigationSessionEntry["badge"] {
  const { kind, syncStatus, remoteSyncedSequence } = input
  if (kind === "local") return { text: "本机", tone: "neutral" }
  if (kind === "remote_self") {
    switch (syncStatus) {
      case "syncing": return { text: "同步中", tone: "accent" }
      case "sync_failed": return { text: "同步失败", tone: "danger" }
      case "has_update": return { text: "有更新", tone: "warning" }
      case "unsynced": return remoteSyncedSequence > 0 ? { text: "未同步", tone: "accent" } : { text: "其他设备 · 只读", tone: "neutral" }
      case "synced": return { text: "其他设备 · 只读", tone: "neutral" }
    }
  }
  switch (syncStatus) {
    case "syncing": return { text: "同步中", tone: "accent" }
    case "sync_failed": return { text: "同步失败", tone: "danger" }
    case "has_update": return { text: "有更新", tone: "warning" }
    case "unsynced": return remoteSyncedSequence > 0 ? { text: "未同步", tone: "accent" } : { text: "仅简报", tone: "neutral" }
    case "synced": return { text: "已同步", tone: "neutral" }
  }
}

/** 将项目内会话列表投影为 HC-217 左栏所需的 NavigationSessionEntry 集合。 */
export function toNavigationSessionEntries(
  conversations: readonly ProjectConversationSummary[],
  currentUserId: string,
  syncStates: Readonly<Record<string, SessionSyncState>>,
  nowMs = Date.now(),
): NavigationSessionEntry[] {
  return conversations.map(item => {
    const kind = classifyConversation(item, currentUserId)
    const state = syncStates[item.conversationId] ?? emptySyncState()
    const syncStatus = deriveSyncStatus({
      kind,
      remoteSyncedSequence: item.syncedSequence,
      localSyncedSequence: state.localSyncedSequence,
      syncing: state.syncing,
      syncError: state.syncError,
    })
    return {
      conversationId: item.conversationId,
      ownerUserId: item.ownerUserId,
      title: item.title || "未命名会话",
      timeLabel: formatShortTime(item.updatedAt, nowMs),
      badge: buildSessionBadge({ kind, syncStatus, remoteSyncedSequence: item.syncedSequence }),
    }
  })
}

/**
 * 增量合并服务端拉取的新消息：
 * 1. 验证输入消息的 sequence 为正安全整数且严格单调递增；
 * 2. 过滤掉已小于等于本地缓存水位的重复消息；
 * 3. 返回合并后的有序历史与推进后的水位。
 */
export function mergeIncrementalHistory(
  existingMessages: readonly ProjectHistoryMessage[],
  existingSequence: number,
  incomingMessages: readonly ProjectHistoryMessage[],
  reportedSyncedSequence: number,
): { readonly messages: ProjectHistoryMessage[]; readonly syncedSequence: number } {
  const maxExisting = existingMessages.reduce((max, item) => Math.max(max, item.sequence), existingSequence)
  let previousSequence = maxExisting
  const appended: ProjectHistoryMessage[] = []
  for (const item of incomingMessages) {
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) {
      throw new Error("HISTORY_SEQUENCE_INVALID")
    }
    if (item.sequence <= maxExisting) continue
    if (item.sequence <= previousSequence) {
      throw new Error("HISTORY_SEQUENCE_INVALID")
    }
    previousSequence = item.sequence
    appended.push(item)
  }
  const merged = appended.length ? [...existingMessages, ...appended] : [...existingMessages]
  const highestMessage = merged.at(-1)?.sequence ?? 0
  const nextSequence = Math.max(existingSequence, highestMessage, reportedSyncedSequence)
  return { messages: merged, syncedSequence: nextSequence }
}

/**
 * 在写入 PersonalStore 前裁剪过大的历史正文缓存，防止超出 1MB 限制导致滚动位置与草稿丢存。
 */
export function boundCachedMessages(
  messages: readonly ProjectHistoryMessage[],
  maxBytes = 750_000,
): { readonly messages: ProjectHistoryMessage[]; readonly truncated: boolean } {
  const serialized = JSON.stringify(messages)
  if (serialized.length * 2 <= maxBytes) return { messages: [...messages], truncated: false }
  const kept: ProjectHistoryMessage[] = []
  let estimatedBytes = 2
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]
    const itemBytes = JSON.stringify(item).length * 2 + 1
    if (estimatedBytes + itemBytes > maxBytes && kept.length > 0) {
      return { messages: kept, truncated: true }
    }
    kept.unshift(item)
    estimatedBytes += itemBytes
  }
  return { messages: kept, truncated: kept.length < messages.length }
}

/**
 * 将后端定稿消息（user / assistant / tool_summary / status）防御性解码为公共对话时间线条目。
 * tool_summary 按 D2 规范仅展示摘要字段；遇到非法 JSON 时降级为纯文本展示而不抛出崩溃。
 */
export function decodeHistoryToTimelineEntries(
  messages: readonly ProjectHistoryMessage[],
  owner: { readonly userId: string; readonly displayName: string },
  sentImages?: Readonly<Record<string, readonly PersonalDraftImage[]>>,
): ConversationTimelineEntry[] {
  return messages.map(message => {
    const parsed = parsePayloadObject(message.payload)
    const id = `seq-${message.sequence}`
    if (message.type === "user") {
      const ids = parsed?.referenceIds
      const referenceIds = Array.isArray(ids) ? ids.filter((id): id is string => parseFixedReference(id) !== null) : []
      const images = sentImages?.[String(message.sequence)]
      return {
        kind: "message",
        id,
        role: "user",
        author: { id: owner.userId, displayName: owner.displayName },
        createdAtMs: message.occurredAtMs,
        text: pickString(parsed, ["text", "content", "message"]) ?? message.payload,
        ...(referenceIds.length ? { referenceIds } : {}),
        ...(images?.length ? { images } : {}),
      }
    }
    if (message.type === "assistant") {
      return {
        kind: "message",
        id,
        role: "assistant",
        createdAtMs: message.occurredAtMs,
        text: pickString(parsed, ["text", "content", "message"]) ?? message.payload,
      }
    }
    if (message.type === "tool_summary") {
      const label = pickString(parsed, ["label", "toolName", "name"]) ?? "工具摘要"
      const summary = pickString(parsed, ["summary", "detail", "text"]) ?? message.payload
      const rawStatus = pickString(parsed, ["status"])
      const status = rawStatus === "failed" ? "failed" : rawStatus === "running" ? "running" : "completed"
      const rawTone = pickString(parsed, ["tone"])
      const tone = rawTone === "read" || rawTone === "write" ? rawTone : "neutral"
      return {
        kind: "tool",
        id,
        label,
        ...(pickString(parsed, ["name", "toolName"]) ? { originalName: pickString(parsed, ["name", "toolName"])! } : {}),
        ...(summary ? { summary } : {}),
        status,
        tone,
        detail: {
          ...(summary ? { outputText: summary } : {}),
          copyText: summary || message.payload,
        },
      }
    }
    const statusText = pickString(parsed, ["text", "message", "status"]) ?? message.payload
    return {
      kind: "message",
      id,
      role: "assistant",
      createdAtMs: message.occurredAtMs,
      text: statusText ? `状态更新：${statusText}` : "状态已更新",
    }
  })
}

export function formatShortTime(timestamp: string | number | null | undefined, nowMs = Date.now()): string {
  if (timestamp === null || timestamp === undefined || timestamp === "") return "—"
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp)
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  const date = new Date(ms)
  const now = new Date(nowMs)
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return hhmm
  }
  const yesterday = new Date(nowMs - 86_400_000)
  if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) {
    return `昨天 ${hhmm}`
  }
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function directoryBasename(directoryPath: string | null): string {
  if (!directoryPath) return ""
  const trimmed = directoryPath.replace(/[\\/]+$/, "")
  if (!trimmed) return directoryPath
  const parts = trimmed.split(/[\\/]/)
  return parts.at(-1) || directoryPath
}

/** 本机手动标题优先于当前 Agent 建议与服务端登记标题。 */
export function resolveConversationTitle(conversationTitle: string, sessionTitle?: string | null, customTitle?: string): string {
  return customTitle?.trim() || sessionTitle?.trim() || conversationTitle.trim() || "未命名会话"
}

/** 摘要列表是左栏、顶栏、搜索和会话选择器共用的展示来源。 */
export function applyConversationTitleOverrides(
  conversations: readonly ProjectConversationSummary[],
  scope: { readonly accountId: string; readonly projectId: string } | null,
  localTitles: (conversationId: string) => { sessionTitle?: string; customTitle?: string } | undefined,
): readonly ProjectConversationSummary[] {
  if (!scope || conversations.length === 0) return conversations
  let changed = false
  const next = conversations.map(item => {
    const local = item.projectId === scope.projectId && item.ownerUserId === scope.accountId
      ? localTitles(item.conversationId)
      : undefined
    const title = resolveConversationTitle(item.title, local?.sessionTitle, local?.customTitle)
    if (title === item.title) return item
    changed = true
    return { ...item, title }
  })
  return changed ? next : conversations
}

function parsePayloadObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function pickString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

/** 构造输入框顶部的工作目录上下文视图及最近目录映射，供本机会话与新建会话页复用。 */
export function buildDirectoryContextView(input: {
  readonly directoryPath: string | null
  readonly recentDirectories?: readonly string[]
  readonly statusLabel?: string
  readonly statusTone?: "default" | "warning" | "danger"
  readonly quickAction?: ConversationDirectoryContextView["quickAction"]
  readonly switchingAvailability: ConversationAvailability
  readonly confirmItem?: { readonly label: string; readonly availability: ConversationAvailability }
  readonly canCopyPath?: boolean
}): {
  readonly directory: ConversationDirectoryContextView
  readonly recentById: Readonly<Record<string, string>>
} {
  const {
    directoryPath,
    recentDirectories = [],
    statusLabel,
    statusTone,
    quickAction,
    switchingAvailability,
    confirmItem,
    canCopyPath,
  } = input
  const items: ConversationContextActionItem[] = []
  const recentById: Record<string, string> = {}

  if (confirmItem) {
    items.push({
      id: "confirm",
      label: confirmItem.label,
      description: directoryPath ?? undefined,
      tone: "accent",
      availability: confirmItem.availability,
    })
  }

  const orderedDirs: string[] = []
  const pushUnique = (path: string | null | undefined) => {
    const trimmed = path?.trim()
    if (trimmed && !orderedDirs.includes(trimmed)) orderedDirs.push(trimmed)
  }
  pushUnique(directoryPath)
  for (const path of recentDirectories) pushUnique(path)

  orderedDirs.forEach((path, index) => {
    const id = `recent:${index}`
    recentById[id] = path
    items.push({
      id,
      label: directoryBasename(path) || path,
      description: path,
      active: path === directoryPath,
      availability: switchingAvailability,
    })
  })

  if (directoryPath && canCopyPath) {
    items.push({
      id: "copy-path",
      label: "复制完整路径",
      availability: { enabled: true },
    })
  }

  items.push({
    id: "choose",
    label: "选择本机文件夹…",
    tone: "accent",
    availability: switchingAvailability,
  })

  return {
    directory: {
      label: directoryBasename(directoryPath) || "选择工作目录",
      fullPath: directoryPath,
      ...(statusLabel ? { statusLabel } : {}),
      ...(statusTone ? { statusTone } : {}),
      ...(quickAction ? { quickAction } : {}),
      availability: { enabled: true },
      items,
    },
    recentById,
  }
}

/** 统一分发顶部工作目录浮层的条目点击动作。 */
export function handleDirectoryContextAction(input: {
  readonly itemId: string
  readonly directoryPath: string | null
  readonly recentById: Readonly<Record<string, string>>
  readonly onConfirmDirectory?: () => void
  readonly onChooseDirectory?: () => void
  readonly onSelectDirectory?: (directoryPath: string) => void
  readonly onCopyPath?: (directoryPath: string) => void
}): void {
  const { itemId, directoryPath, recentById, onConfirmDirectory, onChooseDirectory, onSelectDirectory, onCopyPath } = input
  if (itemId === "confirm") {
    onConfirmDirectory?.()
    return
  }
  if (itemId === "choose") {
    onChooseDirectory?.()
    return
  }
  if (itemId === "copy-path") {
    if (directoryPath) onCopyPath?.(directoryPath)
    return
  }
  const nextPath = recentById[itemId]
  if (nextPath && nextPath !== directoryPath) {
    onSelectDirectory?.(nextPath)
  }
}

export const EMPTY_PERSONAL_STATE: ConversationPersonalState = {
  scroll: EMPTY_CONVERSATION_PERSONAL.scroll,
  expandedTools: EMPTY_CONVERSATION_PERSONAL.expandedTools,
  expandedOutputs: EMPTY_CONVERSATION_PERSONAL.expandedOutputs,
  draft: EMPTY_CONVERSATION_PERSONAL.draft,
  interactions: {},
}

export function applyConversationPersonalChange(
  previous: ConversationPersonalState,
  change: ConversationPersonalChange,
): ConversationPersonalState {
  switch (change.kind) {
    case "scroll":
      return { ...previous, scroll: change.value }
    case "tool":
      return {
        ...previous,
        expandedTools: change.expanded
          ? (previous.expandedTools.includes(change.entryId) ? previous.expandedTools : [...previous.expandedTools, change.entryId])
          : previous.expandedTools.filter(id => id !== change.entryId),
      }
    case "output":
      return {
        ...previous,
        expandedOutputs: change.expanded
          ? (previous.expandedOutputs.includes(change.entryId) ? previous.expandedOutputs : [...previous.expandedOutputs, change.entryId])
          : previous.expandedOutputs.filter(id => id !== change.entryId),
      }
    case "draft-text":
      return {
        ...previous,
        draft: {
          ...previous.draft,
          text: change.text,
          selectionStart: change.selectionStart,
          selectionEnd: change.selectionEnd,
          revision: previous.draft.revision + 1,
        },
      }
    case "draft-references":
      return {
        ...previous,
        draft: { ...previous.draft, referenceIds: [...change.referenceIds], revision: previous.draft.revision + 1 },
      }
    case "draft-attachments":
      return {
        ...previous,
        draft: { ...previous.draft, attachmentIds: [...change.attachmentIds], revision: previous.draft.revision + 1 },
      }
    case "draft-annotations":
      return {
        ...previous,
        draft: {
          ...previous.draft,
          annotations: change.annotations.slice(0, MAX_DRAFT_ANNOTATIONS),
          revision: previous.draft.revision + 1,
        },
      }
    case "draft-images":
      return {
        ...previous,
        draft: {
          ...previous.draft,
          images: change.images.slice(0, MAX_DRAFT_IMAGES),
          revision: previous.draft.revision + 1,
        },
      }
    case "clear-draft":
      if (previous.draft.revision !== change.expectedRevision) return previous
      return {
        ...previous,
        draft: { ...EMPTY_PERSONAL_STATE.draft, annotations: [], images: [], revision: previous.draft.revision + 1 },
      }
    case "interaction": {
      const nextInteractions = { ...previous.interactions }
      if (change.answer === null) delete nextInteractions[change.interactionId]
      else nextInteractions[change.interactionId] = change.answer
      return { ...previous, interactions: nextInteractions }
    }
  }
}
