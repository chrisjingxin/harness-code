/**
 * 会话领域纯模型：归类判定、同步五态推导、左栏条目投影与历史消息防御解码。
 *
 * 【功能定义】
 * 把服务端的 ConversationSummary / HistoryMessage 与本地缓存水位组合成可供左栏和中央页展示的
 * 确定性数据结构，不持有网络、React 状态或磁盘读写。
 */
import type { ConversationTimelineEntry, NavigationSessionEntry } from "@workbench/ui"
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
 * 判定一条会话在本机应按“本人本机”还是“跨机器只读”处理：
 * 只有 ownerUserId 与当前登录用户一致、且 deviceId 与本机已登记未吊销设备一致时，才是本人本机会话；
 * 同账号其他设备（或本机未登记时）一律只读。
 */
export function classifyConversation(
  conversation: Pick<ProjectConversationSummary, "ownerUserId" | "deviceId">,
  currentUserId: string,
  localDeviceId: string | null,
): SessionKind {
  if (conversation.ownerUserId !== currentUserId) return "remote_other"
  if (localDeviceId !== null && conversation.deviceId === localDeviceId) return "local"
  return "remote_self"
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
  localDeviceId: string | null,
  syncStates: Readonly<Record<string, SessionSyncState>>,
  nowMs = Date.now(),
): NavigationSessionEntry[] {
  return conversations.map(item => {
    const kind = classifyConversation(item, currentUserId, localDeviceId)
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
): ConversationTimelineEntry[] {
  return messages.map(message => {
    const parsed = parsePayloadObject(message.payload)
    const id = `seq-${message.sequence}`
    if (message.type === "user") {
      return {
        kind: "message",
        id,
        role: "user",
        author: { id: owner.userId, displayName: owner.displayName },
        createdAtMs: message.occurredAtMs,
        text: pickString(parsed, ["text", "content", "message"]) ?? message.payload,
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

export function shortDeviceLabel(deviceId: string, knownName: string | undefined, isLocal: boolean): string {
  if (isLocal) return knownName ? `${knownName}（当前设备）` : "当前设备"
  if (knownName) return knownName
  return `其他设备 (${deviceId.slice(0, 6)})`
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
