/**
 * 【功能定义】全局收件箱纯数据投影与方案 A 本机等待确认归约模型：
 * 1. 从本机执行实时通知与个人会话持久化状态归并非当前查看的 `waiting_approval` / `error` 会话（绝不上云、绝不计入云端红点）；
 * 2. 提供云端 Inbox 条目分类/状态中文文案、时间格式化、以及免打扰分钟数 ↔ `HH:mm` 双向换算工具。
 *
 * 【协作边界】零 React/Electron/Node 运行时依赖，仅供桌面端渲染层 Hook 与 `desktop/tests/inbox-model.test.ts` 调用。
 */
import type {
  ExternalNotificationEventType,
  InboxBucket,
  InboxItem,
  InboxUrgency,
  TaskDetail,
  TaskStatus,
} from "@workbench/collaboration-client/types"
import type {
  LocalConversationRecord,
  LocalExecutionNotice,
  LocalExecutionPermission,
  LocalExecutionScope,
  WorkbenchDeepLinkTarget,
} from "../../../shared/index.js"
import { directoryBasename } from "../session/session-model.js"

export type LocalAttentionKind = "permission" | "plan" | "goal" | "elicitation" | "error"

/** 单个会话在本机内存中的实时等待确认/异常信号。 */
export type LocalAttentionSignal = {
  readonly scope: LocalExecutionScope
  readonly permission?: LocalExecutionPermission
  readonly elicitationTitle?: string
  readonly error?: string
  readonly sessionTitle?: string
  readonly updatedAtMs: number
  /** 最近一次正常终结或新轮开始时间，用于在持久化索引尚未刷新前抑制陈旧状态回影。 */
  readonly clearedAtMs?: number
}

/** 收件箱顶部「本机等待你确认」提醒条的单条投影数据。 */
export type LocalAttentionItem = {
  readonly conversationId: string
  readonly workspaceId: string | null
  readonly projectId: string | null
  readonly title: string
  readonly locationLabel: string
  readonly kind: LocalAttentionKind
  readonly kindLabel: string
  readonly summary: string
  readonly status: "waiting_approval" | "error"
  readonly updatedAtMs: number
}

export const LOCAL_ATTENTION_LABELS: Record<LocalAttentionKind, string> = {
  permission: "权限审批",
  plan: "计划确认",
  goal: "目标确认",
  elicitation: "问题待答",
  error: "执行出错",
}

export const INBOX_BUCKETS: ReadonlyArray<{ readonly id: InboxBucket; readonly label: string }> = [
  { id: "action_required", label: "待我处理" },
  { id: "sent", label: "我发起的" },
  { id: "resolved", label: "已处理" },
]

export const EXTERNAL_EVENT_OPTIONS: ReadonlyArray<{
  readonly id: ExternalNotificationEventType
  readonly label: string
  readonly help: string
}> = [
  { id: "task.assigned", label: "新任务指派给我", help: "团队成员指派或交接任务给你，需要确认接收时提醒" },
  { id: "task.review_requested", label: "提交待我验收", help: "负责人或协作者将任务提交验收时提醒你拍板" },
  { id: "task.returned", label: "验收退回修订", help: "你承接的任务被退回待修订时提醒" },
]

export const MERGE_WINDOW_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 0, label: "不合并（立即通知）" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "60 秒（默认）" },
  { value: 300, label: "5 分钟" },
]

/** 将多行/控制字符摘要清洗为单行并截断，保持卡片紧凑可读。 */
export function sanitizeSingleLineSummary(raw: string | undefined | null, maxChars = 80): string {
  if (!raw) return ""
  const collapsed = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars - 1)}…`
}

/** 识别权限请求属于权限审批、计划确认（Plan）还是目标确认（Goal）。 */
export function classifyPermissionKind(permission: LocalExecutionPermission): "permission" | "plan" | "goal" {
  const haystack = [
    permission.tool?.kind,
    permission.tool?.title,
    permission.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  if (/\bplan\b|exit_plan|计划/.test(haystack)) return "plan"
  if (/\bgoal\b|目标/.test(haystack)) return "goal"
  return "permission"
}

/** 纯归约函数：将 `LocalExecutionNotice` 增量折入本机各会话等待状态表。 */
export function applyLocalExecutionNoticeToSignals(
  signals: Readonly<Record<string, LocalAttentionSignal>>,
  notice: LocalExecutionNotice,
  nowMs: number,
): Readonly<Record<string, LocalAttentionSignal>> {
  const id = notice.scope.conversationId
  const prev = signals[id]

  if (notice.kind === "permission") {
    if (notice.request) {
      return {
        ...signals,
        [id]: {
          scope: notice.scope,
          ...(prev?.elicitationTitle ? { elicitationTitle: prev.elicitationTitle } : {}),
          ...(prev?.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
          permission: notice.request,
          updatedAtMs: nowMs,
        },
      }
    }
    if (!prev?.permission) return signals
    if (!prev.elicitationTitle && !prev.error) {
      return {
        ...signals,
        [id]: {
          scope: notice.scope,
          ...(prev.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
          updatedAtMs: prev.updatedAtMs,
          clearedAtMs: nowMs,
        },
      }
    }
    const { permission: _cleared, ...rest } = prev
    return { ...signals, [id]: { ...rest, scope: notice.scope } }
  }

  if (notice.kind === "elicitation") {
    if (notice.request) {
      const title = sanitizeSingleLineSummary(notice.request.message || "等待你的进一步答复")
      return {
        ...signals,
        [id]: {
          scope: notice.scope,
          ...(prev?.permission ? { permission: prev.permission } : {}),
          ...(prev?.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
          elicitationTitle: title || "等待你的进一步答复",
          updatedAtMs: nowMs,
        },
      }
    }
    if (!prev?.elicitationTitle) return signals
    if (!prev.permission && !prev.error) {
      return {
        ...signals,
        [id]: {
          scope: notice.scope,
          ...(prev.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
          updatedAtMs: prev.updatedAtMs,
          clearedAtMs: nowMs,
        },
      }
    }
    const { elicitationTitle: _cleared, ...rest } = prev
    return { ...signals, [id]: { ...rest, scope: notice.scope } }
  }

  if (notice.kind === "session-state") {
    const title = notice.state.sessionTitle?.trim()
    if (!title || prev?.sessionTitle === title) return signals
    return {
      ...signals,
      [id]: {
        ...(prev ?? { scope: notice.scope, updatedAtMs: nowMs }),
        scope: notice.scope,
        sessionTitle: title,
      },
    }
  }

  if (notice.kind === "accepted" || notice.kind === "text" || notice.kind === "tool") {
    if (!prev?.error) return signals
    return {
      ...signals,
      [id]: {
        scope: notice.scope,
        ...(prev.permission ? { permission: prev.permission } : {}),
        ...(prev.elicitationTitle ? { elicitationTitle: prev.elicitationTitle } : {}),
        ...(prev.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
        updatedAtMs: prev.updatedAtMs,
        clearedAtMs: nowMs,
      },
    }
  }

  if (notice.kind === "finished") {
    if (notice.failure) {
      return {
        ...signals,
        [id]: {
          scope: notice.scope,
          ...(prev?.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
          error: sanitizeSingleLineSummary(notice.failure) || "执行未正常完成",
          updatedAtMs: nowMs,
        },
      }
    }
    return {
      ...signals,
      [id]: {
        scope: notice.scope,
        ...(prev?.sessionTitle ? { sessionTitle: prev.sessionTitle } : {}),
        updatedAtMs: prev?.updatedAtMs ?? nowMs,
        clearedAtMs: nowMs,
      },
    }
  }

  return signals
}

/**
 * 按方案 A 汇总本机非当前查看且等待确认/出错的会话（绝不混入云端待办计数）。
 * 优先级：实时执行内存信号 > 个人会话索引持久化状态。
 */
export function collectLocalAttentionItems(input: {
  readonly signals: Readonly<Record<string, LocalAttentionSignal>>
  readonly personalRecords: readonly LocalConversationRecord[]
  readonly activeViewedConversationId: string | null
  readonly projectNamesById?: Readonly<Record<string, string>>
}): readonly LocalAttentionItem[] {
  const { signals, personalRecords, activeViewedConversationId, projectNamesById = {} } = input
  const recordsById = new Map(personalRecords.map(rec => [rec.conversationId, rec]))
  const items: LocalAttentionItem[] = []
  const handled = new Set<string>()

  const resolveLocation = (
    workspaceId: string | null,
    projectId: string | null,
    directoryPath: string | null | undefined,
  ): string => {
    if (projectId && projectNamesById[projectId]) return `项目 · ${projectNamesById[projectId]}`
    if (directoryPath) return directoryBasename(directoryPath) || directoryPath
    if (workspaceId && projectId) return "团队协作会话"
    return "本机会话"
  }

  for (const [conversationId, signal] of Object.entries(signals)) {
    handled.add(conversationId)
    if (conversationId === activeViewedConversationId) continue

    const rec = recordsById.get(conversationId)
    const workspaceId = rec?.shareStatus === "active"
      ? (rec.workspaceId ?? signal.scope.workspaceId)
      : signal.scope.workspaceId
    const projectId = rec?.shareStatus === "active"
      ? (rec.projectId ?? signal.scope.projectId)
      : signal.scope.projectId
    const title = rec?.title?.trim() || signal.sessionTitle?.trim() || "本地会话"
    const locationLabel = resolveLocation(workspaceId, projectId, rec?.directoryPath)

    if (signal.permission) {
      const kind = classifyPermissionKind(signal.permission)
      const summary = sanitizeSingleLineSummary(
        signal.permission.title || signal.permission.tool?.title,
      ) || "等待你确认授权后继续执行"
      items.push({
        conversationId,
        workspaceId,
        projectId,
        title,
        locationLabel,
        kind,
        kindLabel: LOCAL_ATTENTION_LABELS[kind],
        summary,
        status: "waiting_approval",
        updatedAtMs: signal.updatedAtMs,
      })
      continue
    }

    if (signal.elicitationTitle) {
      items.push({
        conversationId,
        workspaceId,
        projectId,
        title,
        locationLabel,
        kind: "elicitation",
        kindLabel: LOCAL_ATTENTION_LABELS.elicitation,
        summary: signal.elicitationTitle,
        status: "waiting_approval",
        updatedAtMs: signal.updatedAtMs,
      })
      continue
    }

    if (signal.error) {
      items.push({
        conversationId,
        workspaceId,
        projectId,
        title,
        locationLabel,
        kind: "error",
        kindLabel: LOCAL_ATTENTION_LABELS.error,
        summary: signal.error,
        status: "error",
        updatedAtMs: signal.updatedAtMs,
      })
    }
  }

  for (const rec of personalRecords) {
    if (handled.has(rec.conversationId)) continue
    if (rec.conversationId === activeViewedConversationId) continue
    if (rec.status !== "waiting_approval" && rec.status !== "error") continue
    const workspaceId = rec.shareStatus === "active" ? rec.workspaceId : null
    const projectId = rec.shareStatus === "active" ? rec.projectId : null
    const kind: LocalAttentionKind = rec.status === "error" ? "error" : "permission"
    items.push({
      conversationId: rec.conversationId,
      workspaceId,
      projectId,
      title: rec.title?.trim() || "本地会话",
      locationLabel: resolveLocation(workspaceId, projectId, rec.directoryPath),
      kind,
      kindLabel: rec.status === "error" ? LOCAL_ATTENTION_LABELS.error : "等待确认",
      summary: rec.status === "error" ? "上一轮执行未完成，点击回到会话查看详情" : "当前会话正等待你的确认",
      status: rec.status,
      updatedAtMs: rec.updatedAtMs,
    })
  }

  items.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  return items
}

export function formatInboxCategoryLabel(category: string): string {
  switch (category) {
    case "task_review":
      return "待我验收"
    case "task_assigned":
      return "任务指派"
    case "task_in_progress":
      return "推进中任务"
    case "task_resolved":
      return "已处理任务"
    case "knowledge_review":
      return "知识审核"
    case "system_map_proposal":
      return "系统地图变更"
    case "member_joined":
      return "新成员待交接"
    default:
      return category
  }
}

export function formatInboxTaskStatusLabel(status: TaskStatus | string): string {
  switch (status) {
    case "todo":
      return "待接收"
    case "doing":
      return "进行中"
    case "review":
      return "待验收"
    case "done":
      return "已完成"
    case "cancelled":
      return "已取消"
    default:
      return status
  }
}

export function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (diffSec < 60) return "刚刚"
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours} 小时前`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays} 天前`
  const date = new Date(timestampMs)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** 将当天分钟数 [0..1439] 格式化为 `HH:mm`。 */
export function minutesToTimeString(minute: number): string {
  const normalized = Math.max(0, Math.min(1439, Math.floor(minute)))
  const hours = String(Math.floor(normalized / 60)).padStart(2, "0")
  const mins = String(normalized % 60).padStart(2, "0")
  return `${hours}:${mins}`
}

/** 解析 `HH:mm` 文本为分钟数 [0..1439]；格式非法时返回 null。 */
export function timeStringToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** 返回免打扰区间文案；若结束分钟 ≤ 开始分钟则自动标注次日。 */
export function formatDndWindow(startMinute: number, endMinute: number): string {
  const start = minutesToTimeString(startMinute)
  const end = minutesToTimeString(endMinute)
  return endMinute <= startMinute ? `${start} ~ 次日 ${end}` : `${start} ~ ${end}`
}

/** 统一 `.hui-badge` 语义色调（对齐 LoopForge 原型）。 */
export type InboxBadgeTone = "accent" | "info" | "success" | "warn" | "danger" | "muted"

export function badgeToneForCategory(category: string, urgency?: InboxUrgency): InboxBadgeTone {
  switch (category) {
    case "task_review":
      return "warn"
    case "task_assigned":
      return "accent"
    case "task_in_progress":
      return "info"
    case "task_resolved":
      return "muted"
    case "knowledge_review":
    case "system_map_proposal":
      return "info"
    case "member_joined":
      return "warn"
    default:
      return urgency === "urgent" ? "warn" : "muted"
  }
}

export function badgeToneForTaskStatus(status: TaskStatus | string): InboxBadgeTone {
  switch (status) {
    case "todo":
      return "warn"
    case "doing":
      return "info"
    case "review":
      return "accent"
    case "done":
      return "success"
    case "cancelled":
      return "muted"
    default:
      return "muted"
  }
}

/**
 * 解析双栏主从列表当前应选中的条目：
 * 列表为空返回 null；若原选中项仍在列表中则保持不变，否则自动选中首项。
 */
export function resolveSelectedInboxItemKey(items: readonly InboxItem[], currentKey: string | null): string | null {
  if (items.length === 0) return null
  if (currentKey && items.some(item => item.itemKey === currentKey)) return currentKey
  return items[0]!.itemKey
}

export type InboxTaskActionPermissions = {
  readonly canAccept: boolean
  readonly canReview: boolean
  readonly canCancel: boolean
}

/**
 * 结合 Task 详情与代管标志推导当前登录者在收件箱右栏可执行的状态流转按钮。
 * 保持与服务端 `TaskAppService` 一致的权限判定：受让人可接收 `todo`；创建人或离职代管项目负责人可验收/退回 `review` 及取消未完结任务。
 */
export function resolveInboxTaskActions(input: {
  readonly item: InboxItem
  readonly detail: TaskDetail | null
  readonly currentUserId: string
}): InboxTaskActionPermissions {
  const { item, detail, currentUserId } = input
  if (item.sourceType !== "task" || !detail) {
    return { canAccept: false, canReview: false, canCancel: false }
  }
  const { status, assigneeId, creatorId } = detail.task
  const isAssignee = assigneeId === currentUserId
  const isEffectiveCreator = creatorId === currentUserId || item.delegated
  return {
    canAccept: isAssignee && status === "todo",
    canReview: isEffectiveCreator && status === "review",
    canCancel: isEffectiveCreator && (status === "todo" || status === "doing" || status === "review"),
  }
}

export type DeepLinkNavigationDecision =
  | { readonly action: "open_inbox"; readonly shouldRefreshInbox: boolean }
  | { readonly action: "deny"; readonly message: string }
  | {
      readonly action: "reveal_task"
      readonly workspaceId: string
      readonly projectId: string
      readonly taskId: string
    }

/**
 * 校验并归约收到的深链接只读跳转意图：
 * - `workbench://open/inbox`：切换至收件箱，在线时刷新；
 * - 离线状态下拒绝跳往远端 Task；
 * - 目标 Workspace 不在当前账号所属列表中时拦截并提示无权访问（绝不暴露额外任务信息）；
 * - 校验通过仅返回只读定位意图，绝不自动发起任何写操作或 Agent 执行。
 */
export function resolveDeepLinkNavigation(input: {
  readonly target: WorkbenchDeepLinkTarget
  readonly offline: boolean
  readonly workspaceIds: readonly string[]
}): DeepLinkNavigationDecision {
  if (input.target.kind === "inbox") {
    return { action: "open_inbox", shouldRefreshInbox: !input.offline }
  }
  if (input.offline) {
    return { action: "deny", message: "当前处于离线状态，重连协作服务后可查看该任务。" }
  }
  if (!input.workspaceIds.includes(input.target.workspaceId)) {
    return { action: "deny", message: "当前账号无权访问该任务或已不在对应项目。" }
  }
  return {
    action: "reveal_task",
    workspaceId: input.target.workspaceId,
    projectId: input.target.projectId,
    taskId: input.target.taskId,
  }
}
