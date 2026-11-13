/**
 * Project 外壳与各业务页面的装配契约（只在桌面内部使用，不是线上协议）。
 * 由 HC-217 导出，供 HC-218（会话）、HC-219（任务/知识）、HC-220（看板）分别实现并由主装配接入。
 */
import type { ReactNode } from "react"
import type { CollaborationContextView, NavigationSessionEntry, WorkbenchRightSlot } from "@workbench/ui"
import type { ProjectPage } from "../../../personal-host.js"

export type { NavigationSessionEntry, ProjectPage }

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
}

/** 每个页面提供者导出的渲染入口；外壳负责挂载和隐藏，不了解页面内部状态。 */
export type ProjectPageProvider = {
  render(context: { scope: ProjectNavigationScope; page: ProjectPage; navigator: ProjectNavigator; visible: boolean }): ReactNode
  /** 可选：页面需要右栏时返回右栏内容，否则返回 null 令右栏自动收起。 */
  right?(context: { scope: ProjectNavigationScope; page: ProjectPage; slot: WorkbenchRightSlot }): ReactNode | null
  /** 可选：会话等页面覆盖顶栏上下文；返回 null 时使用外壳默认标题。 */
  context?(context: { scope: ProjectNavigationScope; page: ProjectPage }): CollaborationContextView | null
}

/** 由装配层按实际已交付模块提供的页面提供者集合；未提供的页面显示“尚未接入”。 */
export type ProjectPageProviders = {
  session?: ProjectPageProvider
  board?: ProjectPageProvider
  tasks?: ProjectPageProvider
  knowledge?: ProjectPageProvider
}
