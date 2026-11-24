/**
 * ⌘K 全局命令面板纯分组检索模型：
 * 统一索引个人本机会话、我的团队会话、队友只读会话、任务、未归档知识与工作台直达入口。
 * 零 React / DOM 依赖，供 UI 组件与单元测试共享同一过滤与排序契约。
 */
import type { KnowledgeSummary, TaskStatus, TaskSummary } from "@workbench/collaboration-client/types"
import type { NavigationMember, NavigationSessionEntry } from "../../../ui/index.js"

export const PALETTE_TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待接收",
  doing: "进行中",
  review: "待验收",
  done: "已完成",
  cancelled: "已取消",
}

export type PalettePersonalSessionItem = {
  readonly conversationId: string
  readonly title: string
  readonly directoryLabel: string
  readonly timeLabel: string
}

export type PaletteQuickActionItem = {
  readonly id: string
  readonly title: string
  readonly sub: string
  readonly onSelect: () => void
}

export type PaletteItem =
  | { kind: "personal-session"; id: string; title: string; sub: string }
  | { kind: "session"; id: string; title: string; sub: string; user?: NavigationMember; self?: boolean }
  | { kind: "task"; id: string; title: string; sub: string; user?: NavigationMember }
  | { kind: "knowledge"; id: string; title: string; sub: string; user?: NavigationMember }
  | { kind: "action"; id: string; title: string; sub: string; onSelect: () => void }

export type PaletteGroup = {
  readonly label: string
  readonly items: readonly PaletteItem[]
}

export type BuildCommandPaletteGroupsInput = {
  readonly query: string
  readonly projectName?: string | undefined
  readonly personalSessions?: readonly PalettePersonalSessionItem[] | undefined
  readonly members?: readonly NavigationMember[] | undefined
  readonly mySessions?: readonly NavigationSessionEntry[] | undefined
  readonly peerSessions?: readonly NavigationSessionEntry[] | undefined
  readonly tasks?: readonly TaskSummary[] | undefined
  readonly knowledge?: readonly KnowledgeSummary[] | undefined
  readonly quickActions?: readonly PaletteQuickActionItem[] | undefined
}

/** 根据关键词构建全局命令面板分组；无关键词时展示最近预览条数上限，输入关键词后扩展到 20 条。 */
export function buildCommandPaletteGroups({
  query,
  projectName,
  personalSessions = [],
  members = [],
  mySessions = [],
  peerSessions = [],
  tasks = [],
  knowledge = [],
  quickActions = [],
}: BuildCommandPaletteGroupsInput): readonly PaletteGroup[] {
  const q = query.trim().toLowerCase()
  const cap = q ? 20 : 3
  const hit = (txt: string | null | undefined) => !q || (txt ?? "").toLowerCase().includes(q)
  const memberById = new Map(members.map(m => [m.userId, m]))
  const out: PaletteGroup[] = []

  const personal = personalSessions
    .filter(s => hit(s.title) || hit(s.directoryLabel))
    .slice(0, cap)
  if (personal.length) {
    out.push({
      label: "个人本机会话",
      items: personal.map(s => ({
        kind: "personal-session",
        id: s.conversationId,
        title: s.title,
        sub: `${s.directoryLabel || "未选目录"} · ${s.timeLabel}`,
      })),
    })
  }

  const mine = mySessions.filter(s => hit(s.title)).slice(0, cap)
  if (mine.length) {
    out.push({
      label: q ? "我的团队会话" : "当前 Project 会话",
      items: mine.map(s => ({
        kind: "session",
        id: s.conversationId,
        title: s.title,
        sub: `${projectName || "Project"} · ${s.timeLabel}`,
        user: memberById.get(s.ownerUserId),
        self: true,
      })),
    })
  }

  const peers = peerSessions.filter(s => {
    const ownerName = memberById.get(s.ownerUserId)?.userName ?? ""
    return hit(s.title) || hit(ownerName)
  }).slice(0, cap)
  if (peers.length) {
    out.push({
      label: "队友会话（只读）",
      items: peers.map(s => {
        const owner = memberById.get(s.ownerUserId)
        return {
          kind: "session",
          id: s.conversationId,
          title: s.title,
          sub: `${owner?.userName ?? "成员"} · ${projectName || "Project"}`,
          user: owner,
        }
      }),
    })
  }

  const tks = tasks.filter(t => {
    const assigneeName = memberById.get(t.assigneeId)?.userName ?? ""
    return hit(t.title) || hit(assigneeName)
  }).slice(0, cap)
  if (tks.length) {
    out.push({
      label: "任务",
      items: tks.map(t => ({
        kind: "task",
        id: t.taskId,
        title: t.title,
        sub: `${projectName || "Project"} · ${PALETTE_TASK_STATUS_LABEL[t.status]}`,
        user: memberById.get(t.assigneeId),
      })),
    })
  }

  const kbs = knowledge
    .filter(k => !k.archived && (hit(k.title) || hit(k.category) || hit(k.termKey)))
    .slice(0, cap)
  if (kbs.length) {
    out.push({
      label: "知识",
      items: kbs.map(k => ({
        kind: "knowledge",
        id: k.knowledgeId,
        title: k.title,
        sub: `${k.category ? `${k.category} · ` : ""}v${k.version}`,
      })),
    })
  }

  const actions = quickActions.filter(a => hit(a.title) || hit(a.sub)).slice(0, q ? 10 : 5)
  if (actions.length) {
    out.push({
      label: "工作台直达",
      items: actions.map(a => ({
        kind: "action",
        id: a.id,
        title: a.title,
        sub: a.sub,
        onSelect: a.onSelect,
      })),
    })
  }

  return out
}
