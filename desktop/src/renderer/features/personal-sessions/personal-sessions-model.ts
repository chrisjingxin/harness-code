/**
 * 个人优先会话纯模型：个人/已发布分区、目录折叠分组、本机轮次投影、两档发布目标解析与历史大小检查。
 *
 * 【功能定义】封装个人空间与发布/停止共享弹窗所需的确定性领域计算，不持有 React 状态或 IPC 调用，
 * 便于渲染层复用并直接在 Vitest/Bun 下独立单元测试。
 * 【协作边界】仅依赖 `../../../shared/` 与 `../../../ui/` 纯类型及 `@workbench/collaboration-client/types`。
 */
import type { ProjectSummary } from "@workbench/collaboration-client/types"
import type {
  LocalConversationRecord,
  LocalConversationTurn,
} from "../../../shared/index.js"
import type { ConversationTimelineEntry } from "../../../ui/index.js"
import type { ProjectConversationSummary } from "../session/contracts.js"
import { directoryBasename } from "../session/session-model.js"

/** 与服务端及待传账本一致的单条共享消息 UTF-8 字节上限（32 KiB）。 */
export const SYNC_MESSAGE_LIMIT_BYTES = 32 * 1024

const textEncoder = new TextEncoder()

export type PersonalDirectoryGroup = {
  readonly directoryKey: string
  readonly directoryPath: string | null
  readonly label: string
  readonly records: readonly LocalConversationRecord[]
}

export type PublishTargetOption = {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly project: ProjectSummary
}

export type PublishHistoryInspection = {
  readonly completedTurns: readonly { readonly turnIndex: number; readonly displayIndex: number; readonly turn: LocalConversationTurn; readonly oversized: boolean }[]
  readonly selectedCount: number
  readonly oversizedDisplayIndices: readonly number[]
}

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length
}

/**
 * 拆分个人栏位待展示会话与已发布协作会话：
 * - 个人栏位展示所有未发布（`local_only`）和已停止共享（`stopped`）的个人会话，不按团队筛选；
 * - 处于 `active` 共享中的会话只在「团队」空间按 Project 组织展示，统计其数量用于底部提示。
 */
export function partitionPersonalRecords(
  records: readonly LocalConversationRecord[],
): {
  readonly personal: readonly LocalConversationRecord[]
  readonly publishedCount: number
} {
  const personal: LocalConversationRecord[] = []
  let publishedCount = 0
  for (const record of records) {
    if (record.shareStatus === "active") {
      publishedCount += 1
    } else {
      personal.push(record)
    }
  }
  return { personal, publishedCount }
}

/** 将本机个人会话按工程目录分组并按最近更新时间倒序排列。 */
export function groupPersonalRecordsByDirectory(
  records: readonly LocalConversationRecord[],
): readonly PersonalDirectoryGroup[] {
  const sorted = [...records].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || b.conversationId.localeCompare(a.conversationId),
  )
  const groups = new Map<string, { directoryPath: string | null; label: string; records: LocalConversationRecord[] }>()
  for (const record of sorted) {
    const dir = record.directoryPath?.trim() || null
    const key = dir ?? "__unset__"
    const existing = groups.get(key)
    if (existing) {
      existing.records.push(record)
    } else {
      groups.set(key, {
        directoryPath: dir,
        label: dir ? directoryBasename(dir) || dir : "未设置目录",
        records: [record],
      })
    }
  }
  return [...groups.entries()].map(([directoryKey, value]) => ({
    directoryKey,
    directoryPath: value.directoryPath,
    label: value.label,
    records: value.records,
  }))
}

/** 将本机独立存储 `LocalConversationTurn[]` 投影为通用对话时间线条目。 */
export function localTurnsToTimelineEntries(
  turns: readonly LocalConversationTurn[],
  owner: { readonly userId: string; readonly displayName: string },
): readonly ConversationTimelineEntry[] {
  const entries: ConversationTimelineEntry[] = []
  for (const turn of turns) {
    const baseId = `local-turn:${turn.turnId}`
    entries.push({
      kind: "message",
      id: `${baseId}:user`,
      role: "user",
      author: { id: owner.userId, displayName: owner.displayName },
      text: turn.userText,
      createdAtMs: turn.acceptedAtMs,
      ...(turn.referenceIds?.length ? { referenceIds: turn.referenceIds } : {}),
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      ...(turn.images?.length ? { images: turn.images } : {}),
    })
    for (const [idx, followUp] of (turn.followUps ?? []).entries()) {
      entries.push({
        kind: "message",
        id: `${baseId}:followup:${idx}`,
        role: "user",
        author: { id: owner.userId, displayName: owner.displayName },
        text: followUp.text,
        createdAtMs: followUp.occurredAtMs,
      })
    }
    for (const [idx, tool] of (turn.tools ?? []).entries()) {
      entries.push({
        kind: "tool",
        id: `${baseId}:tool:${idx}`,
        label: tool.label,
        ...(tool.name ? { originalName: tool.name } : {}),
        ...(tool.summary ? { summary: tool.summary } : {}),
        status: tool.status,
        tone: tool.tone,
        ...(tool.summary
          ? {
              detail: {
                outputText: tool.summary,
                copyText: tool.summary,
              },
            }
          : {}),
      })
    }
    const assistantText = turn.reply
      || (turn.status === "cancelled" ? "本轮已停止。" : turn.failure || "本轮未能生成回复。")
    entries.push({
      kind: "message",
      id: `${baseId}:assistant`,
      role: "assistant",
      text: assistantText,
      createdAtMs: turn.completedAtMs,
    })
  }
  return entries
}

/** 将本机个人会话记录映射为 `LocalSessionPage` 所需的只读摘要外壳。 */
export function localRecordToConversationSummary(
  record: LocalConversationRecord,
  accountId: string,
): ProjectConversationSummary {
  return {
    conversationId: record.conversationId,
    projectId: record.projectId ?? "__personal__",
    ownerUserId: accountId,
    title: record.title || "新会话",
    status: record.status,
    briefText: "",
    briefSource: "rule",
    briefUpdatedAtMs: record.updatedAtMs,
    syncedSequence: record.syncedSequence,
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    shareMode: record.shareMode ?? "full",
    shareStatus: record.shareStatus === "active" ? "active" : "stopped",
    stoppedAt: record.stoppedAtMs !== null ? new Date(record.stoppedAtMs).toISOString() : null,
    repositories: [],
  }
}

/**
 * 解析个人会话「发布到 Project…」时可选的目标 Project 列表：
 * 汇总当前账号所属全部团队下所有活跃 Project，支持任意个人会话直接发布到任意项目。
 */
export function resolvePublishTargets(
  workspacesWithProjects: ReadonlyArray<{
    readonly workspaceId: string
    readonly workspaceName: string
    readonly projects: readonly ProjectSummary[]
  }>,
): readonly PublishTargetOption[] {
  const options: PublishTargetOption[] = []
  for (const ws of workspacesWithProjects) {
    for (const project of ws.projects) {
      if (project.status !== "active") continue
      options.push({
        workspaceId: ws.workspaceId,
        workspaceName: ws.workspaceName,
        project,
      })
    }
  }
  return options
}

function isTurnOversizedForSync(turn: LocalConversationTurn): boolean {
  const userText = turn.images?.length
    ? (turn.userText.trim()
        ? `${turn.userText}\n\n[附 ${turn.images.length} 张本机图片]`
        : `[附 ${turn.images.length} 张本机图片]`)
    : turn.userText
  const userPayload = JSON.stringify({
    text: userText,
    ...(turn.referenceIds?.length ? { referenceIds: turn.referenceIds } : {}),
    ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
  })
  const assistantPayload = JSON.stringify({ text: turn.reply })
  if (utf8ByteLength(userPayload) > SYNC_MESSAGE_LIMIT_BYTES) return true
  if (utf8ByteLength(assistantPayload) > SYNC_MESSAGE_LIMIT_BYTES) return true
  return (turn.followUps ?? []).some(
    followUp => utf8ByteLength(JSON.stringify({ text: followUp.text })) > SYNC_MESSAGE_LIMIT_BYTES,
  )
}

/**
 * 检查“带入发布前历史轮次”时选中范围内的已完成轮次与超 32 KiB 限制情况，
 * 让弹窗在发布前给出明确预警。
 */
export function inspectPublishHistory(
  turns: readonly LocalConversationTurn[],
  fromTurnIndex = 0,
): PublishHistoryInspection {
  const completedTurns: {
    readonly turnIndex: number
    readonly displayIndex: number
    readonly turn: LocalConversationTurn
    readonly oversized: boolean
  }[] = []
  let completedNumber = 0
  turns.forEach((turn, idx) => {
    if (turn.status !== "completed") return
    completedNumber += 1
    completedTurns.push({
      turnIndex: idx,
      displayIndex: completedNumber,
      turn,
      oversized: isTurnOversizedForSync(turn),
    })
  })
  const selected = completedTurns.filter(item => item.turnIndex >= fromTurnIndex)
  return {
    completedTurns,
    selectedCount: selected.length,
    oversizedDisplayIndices: selected.filter(item => item.oversized).map(item => item.displayIndex),
  }
}

/** 根据个人会话标题与最近已完成轮次生成发布摘要初始文本。 */
export function buildDefaultPublishBrief(
  record: LocalConversationRecord,
  turns: readonly LocalConversationTurn[],
): string {
  const latestCompleted = [...turns].reverse().find(turn => turn.status === "completed")
  if (!latestCompleted) {
    return `${record.title || "个人会话"}：当前暂无已完成对话轮次。`.slice(0, 240)
  }
  const req = latestCompleted.userText.replace(/\s+/g, " ").trim().slice(0, 90)
  const ans = latestCompleted.reply.replace(/\s+/g, " ").trim().slice(0, 120)
  if (!req && !ans) return (record.title || "个人会话").slice(0, 240)
  return `诉求：${req}\n结果：${ans}`.slice(0, 240)
}
