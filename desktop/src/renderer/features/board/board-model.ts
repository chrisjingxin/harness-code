/** 看板按同一份服务响应的 ID 组织成员和任务，复用 HC-218 的本机同步规则。 */
import type { BoardConversation, BoardResponse, TaskStatus, TaskSummary } from "@workbench/collaboration-client/types"
import type { ProjectPage } from "../../../shared/index.js"
import type { SessionSyncState } from "../session/contracts.js"
import { classifyConversation, deriveSyncStatus, emptySyncState } from "../session/session-model.js"

export type BoardViewMode = "status" | "members"
export type BoardTaskScope = "all" | "assigned" | "published"

export const BOARD_PRIMARY_STATUSES: readonly TaskStatus[] = ["todo", "doing", "review", "done"]

/** 判定当前项目子页是否归属于融合看板家族（原 tasks/task 一并映射到看板主视图）。 */
export function isBoardRoutePage(page: Pick<ProjectPage, "kind">): boolean {
  return page.kind === "board" || page.kind === "tasks" || page.kind === "task"
}

/** 仅当路由指向具体任务时返回对应 taskId 以展开右侧 `.t-drawer` 抽屉；其余返回 null。 */
export function resolveBoardDrawerTaskId(page: ProjectPage): string | null {
  return page.kind === "task" ? page.taskId : null
}

/** 从收件箱/深链接跳转进入任务抽屉时保留顶栏「返回收件箱」按钮；关闭抽屉或切离时自动隐藏。 */
export function shouldShowReturnToInbox(returnToInbox: boolean, page: Pick<ProjectPage, "kind">): boolean {
  return Boolean(returnToInbox && page.kind === "task")
}

export const boardTaskStatuses = {
  todo: "待接收", doing: "进行中", review: "待验收", done: "已完成", cancelled: "已取消",
} satisfies Record<TaskStatus, string>

export type BoardTaskColumn = {
  readonly status: TaskStatus
  readonly label: string
  readonly tasks: readonly TaskSummary[]
}

export type BoardTaskColumnsModel = {
  readonly columns: readonly BoardTaskColumn[]
  readonly cancelledTasks: readonly TaskSummary[]
  readonly counts: {
    readonly total: number
    readonly active: number
    readonly done: number
    readonly cancelled: number
  }
}

/** 将任务状态映射到全局统一 `.hui-badge[data-tone]` 语义色。 */
export function boardTaskStatusTone(status: TaskStatus): "muted" | "info" | "warn" | "success" | "danger" {
  switch (status) {
    case "todo":
      return "muted"
    case "doing":
      return "info"
    case "review":
      return "warn"
    case "done":
      return "success"
    case "cancelled":
      return "danger"
  }
}

/** 按范围筛选并将任务稳定分配到「待接收 / 进行中 / 待验收 / 已完成」四列及已取消归档列表。 */
export function buildBoardTaskColumns({
  tasks,
  scope,
  accountId,
}: {
  readonly tasks: readonly TaskSummary[]
  readonly scope: BoardTaskScope
  readonly accountId: string
}): BoardTaskColumnsModel {
  const filtered = tasks
    .filter(task => {
      if (scope === "assigned") return task.assigneeId === accountId
      if (scope === "published") return task.creatorId === accountId
      return true
    })
    .slice()
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.taskId.localeCompare(b.taskId))

  const grouped = new Map<TaskStatus, TaskSummary[]>([
    ["todo", []],
    ["doing", []],
    ["review", []],
    ["done", []],
    ["cancelled", []],
  ])
  for (const task of filtered) {
    grouped.get(task.status)?.push(task)
  }

  const columns = BOARD_PRIMARY_STATUSES.map(status => ({
    status,
    label: boardTaskStatuses[status],
    tasks: grouped.get(status) ?? [],
  }))
  const cancelledTasks = grouped.get("cancelled") ?? []
  const doneCount = grouped.get("done")?.length ?? 0

  return {
    columns,
    cancelledTasks,
    counts: {
      total: filtered.length,
      active: filtered.length - doneCount - cancelledTasks.length,
      done: doneCount,
      cancelled: cancelledTasks.length,
    },
  }
}

export function buildBoardModel(board: BoardResponse) {
  const conversations = new Map(board.conversations.map(row => [row.conversation.conversationId, row]))
  const tasks = new Map(board.tasks.map(task => [task.taskId, task]))
  const names = new Map(board.members.map(member => [member.userId, member.name]))
  const members = board.members.map(member => ({
    ...member,
    conversations: member.conversationIds.flatMap(id => {
      const row = conversations.get(id)
      return row ? [row] : []
    }),
    received: member.receivedTaskIds.filter(id => tasks.has(id)).length,
    sent: member.sentTaskIds.filter(id => tasks.has(id)).length,
  }))
  // HC-212 聚合只取未结束的任务。完成和取消仍可在项目任务页查看。
  const statuses: TaskStatus[] = ["todo", "doing", "review"]
  for (const status of ["done", "cancelled"] as const) {
    if (board.tasks.some(task => task.status === status)) statuses.push(status)
  }
  return {
    members,
    names,
    activeMembers: members.filter(member => member.status === "active").length,
    columns: statuses.map(status => ({ status, tasks: board.tasks.filter(task => task.status === status) })),
  }
}

export function getBoardSyncLabel(
  row: BoardConversation,
  accountId: string,
  localDeviceId: string | null,
  state: SessionSyncState = emptySyncState(),
): string {
  const isStopped = row.conversation.shareStatus === "stopped"
  if (row.conversation.shareMode === "summary_only") {
    return isStopped ? "已停止同步 · 仅共享摘要" : "仅共享摘要"
  }
  const kind = classifyConversation(row.conversation, accountId)
  if (kind === "local") return isStopped ? "已停止同步 · 本机保留" : "本机会话"
  const status = deriveSyncStatus({
    kind,
    remoteSyncedSequence: row.conversation.syncedSequence,
    localSyncedSequence: state.localSyncedSequence,
    syncing: state.syncing,
    syncError: state.syncError,
  })
  const prefix = isStopped ? "已停止同步 · " : ""
  switch (status) {
    case "unsynced": return `${prefix}${row.conversation.syncedSequence ? "本机未同步正文" : "仅有简报"}`
    case "syncing": return `${prefix}本机同步中`
    case "synced": return `${prefix}本机已同步正文`
    case "has_update": return `${prefix}正文有更新`
    case "sync_failed": return `${prefix}本机同步失败`
  }
}
