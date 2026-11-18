/** 原型协作部件的显示类型和成员标签。正式业务数据与写入由 HC-219/220 的宿主提供。 */
export type CollabTaskStatus = "open" | "claimed" | "running" | "done"
export type CollabTaskPrio = "high" | "mid" | "low"

export type CollabTask = {
  readonly id: string
  readonly projId: string
  readonly title: string
  readonly fromUserId: string
  readonly toUserId: string
  readonly status: CollabTaskStatus
  readonly prio: CollabTaskPrio
  readonly time: string
  readonly desc: string
  readonly sessionId: string | null
}

export type CollabKnowledgeScope = "workspace" | "project"

export type CollabKnowledge = {
  readonly id: string
  readonly scope: CollabKnowledgeScope
  readonly wsId: string
  readonly projId: string | null
  readonly title: string
  readonly authorUserId: string
  readonly version: string
  readonly updated: string
  readonly sum: string
  readonly body: string
}

export const TASK_STATUS_LABEL: Record<CollabTaskStatus, string> = {
  open: "待认领",
  claimed: "已认领",
  running: "进行中",
  done: "已完成",
}

export const TASK_PRIO_LABEL: Record<CollabTaskPrio, string> = {
  high: "高",
  mid: "中",
  low: "低",
}

const KNOWN_ROLES: Record<string, string> = {
  "张景新": "后端开发 · 组长",
  "沈北辰": "前端开发",
  "王大林": "后端开发",
  "明方鹏": "后端开发",
  "杨康": "后端开发",
  "冯学茗": "前端开发",
}

export function memberRoleLabel(member?: { readonly userName?: string | null; readonly orgName?: string | null } | null): string {
  if (!member) return "研发成员"
  return (member.userName && KNOWN_ROLES[member.userName]) || member.orgName || "研发成员"
}
