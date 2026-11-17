/** 看板按同一份服务响应的 ID 组织成员和任务，复用 HC-218 的本机同步规则。 */
import type { BoardConversation, BoardResponse, TaskStatus } from "@workbench/contracts"
import type { SessionSyncState } from "../session/contracts.js"
import { classifyConversation, deriveSyncStatus, emptySyncState } from "../session/session-model.js"

export const boardTaskStatuses = {
  todo: "待处理", doing: "进行中", review: "待验收", done: "已完成", cancelled: "已取消",
} satisfies Record<TaskStatus, string>

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
  const kind = classifyConversation(row.conversation, accountId, localDeviceId)
  if (kind === "local") return "本机会话"
  const status = deriveSyncStatus({
    kind,
    remoteSyncedSequence: row.conversation.syncedSequence,
    localSyncedSequence: state.localSyncedSequence,
    syncing: state.syncing,
    syncError: state.syncError,
  })
  switch (status) {
    case "unsynced": return row.conversation.syncedSequence ? "本机未同步正文" : "仅有简报"
    case "syncing": return "本机同步中"
    case "synced": return "本机已同步正文"
    case "has_update": return "正文有更新"
    case "sync_failed": return "本机同步失败"
  }
}
