/**
 * Project 外壳与各业务页面的装配契约（只在桌面内部使用，不是线上协议）。
 * 由 HC-217 导出，供 HC-218（会话）、HC-219（任务/知识）、HC-220（看板）分别实现并由主装配接入。
 */
import type { ReactNode } from "react"
import type { ProjectPage } from "../../../shared/index.js"
import type {
  CollaborationContextView,
  NavigationSessionEntry,
  NavigationSpaceKind,
  WorkbenchNavId,
  WorkbenchRightSlot,
} from "../../../ui/index.js"

export type { NavigationSessionEntry, ProjectPage }

/** 项目内部子页切回顶层工作台时的导航目标；`info` 与团队会话必须切到团队空间并保留目标子页。 */
export type ProjectPageNavTarget = {
  readonly nav: WorkbenchNavId
  readonly targetSpace?: NavigationSpaceKind
  readonly preserveTeamPage?: boolean
}

/** 将项目子页映射到工作台顶层导航目标；项目资料与团队会话必须落入团队空间并保留目标子页。 */
export function resolveProjectPageNavTarget(kind: ProjectPage["kind"]): ProjectPageNavTarget {
  if (kind === "board" || kind === "tasks" || kind === "task") return { nav: "board" }
  if (kind === "knowledge") return { nav: "knowledge" }
  return { nav: "chat", targetSpace: "team", preserveTeamPage: true }
}

/**
 * 顶层导航切换时决定是否保留「返回收件箱」标记：
 * 只有切回 `inbox` 或由收件箱/深链任务定位显式声明保留时才维持原值，其余主动切栏一律清除。
 */
export function resolveReturnToInboxOnNav(
  current: boolean,
  next: WorkbenchNavId,
  options?: { readonly preserveReturnToInbox?: boolean },
): boolean {
  if (next === "inbox" || options?.preserveReturnToInbox) return current
  return false
}

/**
 * 当顶层导航停留在看板或团队知识且当前团队子页尚未对齐时，决定是否补跳兜底子页。
 * 存在待消费的任务定位（`pendingRevealKind === "task"`）时禁止回落到普通 `"board"`，
 * 避免同帧 `useEffect` 覆盖刚打开的 `{ kind: "task", taskId }` 抽屉。
 */
export function resolveFallbackTeamPageForTopNav(input: {
  readonly topNav: WorkbenchNavId
  readonly page: ProjectPage
  readonly pendingRevealKind?: "task" | "conversation" | null
}): ProjectPage | null {
  if (input.topNav === "board") {
    if (input.pendingRevealKind === "task") return null
    if (input.page.kind !== "board" && input.page.kind !== "tasks" && input.page.kind !== "task") {
      return { kind: "board" }
    }
    return null
  }
  if (input.topNav === "knowledge" && input.page.kind !== "knowledge") {
    return { kind: "knowledge" }
  }
  return null
}

/** 当前导航范围；各模块按它隔离自己的状态，异步结果返回时须核对仍属于当前范围。 */
export type ProjectNavigationScope = {
  namespace: string
  accountId: string
  workspaceId: string
  projectId: string
}

/** 页面模块可调用的导航动作。 */
export interface ProjectNavigator {
  openPage(page: ProjectPage): void
  /** 展开会话所属成员组并选中；会话不在当前项目时返回 false。 */
  locateConversation(conversationId: string): boolean
}

/** HC-218 提供的左栏会话条目与状态；外壳只按 ownerUserId 归组和渲染，不解释同步含义。 */
export type NavigationSessionSource = {
  entries: readonly NavigationSessionEntry[]
  availability: { state: "ready" | "loading" | "failed" | "unavailable"; message?: string }
  retry(): void
  /** 保存成功返回空值，失败返回可向用户展示的信息。 */
  renameConversation?(conversationId: string, title: string): Promise<string | null>
}

/** 每个页面提供者导出的渲染入口；外壳负责挂载和隐藏，不了解页面内部状态。 */
export type ProjectPageProvider = {
  render(context: { scope: ProjectNavigationScope; page: ProjectPage; navigator: ProjectNavigator; visible: boolean }): ReactNode
  /** 可选：页面需要右栏时返回右栏内容，否则返回 null 令右栏自动收起。 */
  right?(context: { scope: ProjectNavigationScope; page: ProjectPage; slot: WorkbenchRightSlot }): ReactNode | null
  /** 可选：会话等页面覆盖顶栏上下文；返回 null 时使用外壳默认标题。 */
  context?(context: { scope: ProjectNavigationScope; page: ProjectPage }): CollaborationContextView | null
  /** 可选：渲染单行顶栏左侧上下文标题区；返回 null 或未实现时由工作台默认标题逻辑接管。 */
  headerTitle?(context: { scope: ProjectNavigationScope; page: ProjectPage; leftCollapsed: boolean }): ReactNode | null
}

/** 由装配层按实际已交付模块提供的页面提供者集合；未提供的页面显示“尚未接入”。 */
export type ProjectPageProviders = {
  session?: ProjectPageProvider
  board?: ProjectPageProvider
  tasks?: ProjectPageProvider
  knowledge?: ProjectPageProvider
}
