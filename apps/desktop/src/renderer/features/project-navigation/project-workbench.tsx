/**
 * Project 外壳与页面装配：
 * 1. useProjectShell：恢复团队个人记录 → 读取项目列表确定当前项目与导航范围（scope）→ 读取项目详情与本项目导航记录。
 * 2. ProjectWorkbench：左栏 ProjectNavigation + 按 page.kind 选择提供者；会话提供者在项目范围内常驻挂载（切页只改 visible），右栏与顶栏上下文由当前提供者决定。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { CollaborationHost, UserSummary } from "@workbench/contracts"
import { ProjectNavigation, WorkbenchLayout, buildMemberGroups } from "@workbench/ui"
import type { CollaborationContextView, NavigationPageKind, ProjectNavigationActions } from "@workbench/ui"
import type { OrganizationHost } from "../../../organization-host.js"
import type { ProjectNavigationPersonal, ProjectPage, WorkspacePersonal } from "../../../personal-host.js"
import type { PersonalPersistence } from "../../personal-persistence.js"
import type {
  NavigationSessionEntry,
  NavigationSessionSource,
  ProjectNavigationScope,
  ProjectNavigator,
  ProjectPageProvider,
  ProjectPageProviders,
} from "./contracts.js"
import { CreateProjectDialog } from "./create-project-dialog.js"
import { ProjectInfoPage } from "./project-info-page.js"
import { resolveUserPhoto } from "../../demo-avatars.js"
import { projectMembers, useProjectDetail, useProjects, useTeamMembers } from "./use-organization.js"
import "./project-navigation.css"

const DESKTOP_NAMESPACE = "desktop-window"
const workspaceDefaults: WorkspacePersonal = { projectId: null, panels: { left: { open: true, width: 280 }, right: { open: true, width: 340 } } }
const navigationDefaults: ProjectNavigationPersonal = { page: { kind: "new" }, expandedMembers: [], selfCollapsed: false }
const pageNames: Record<ProjectPage["kind"], string> = {
  new: "新对话", conversation: "会话", board: "项目看板", tasks: "项目任务", task: "任务详情", info: "项目资料", knowledge: "团队知识",
}
const defaultSessions: NavigationSessionSource = {
  entries: [],
  availability: { state: "unavailable", message: "会话列表尚未接入。" },
  retry: () => {},
}

type NavigationEntry = { status: "loading" | "ready" | "failed"; value: ProjectNavigationPersonal }

export type UseProjectShellOptions = {
  organization: OrganizationHost
  collaboration: CollaborationHost
  persistence: PersonalPersistence
  workspaceId: string
  user: UserSummary
  namespace?: string
}

/**
 * 维护当前团队下的项目选择、详情、成员与个人导航状态，并向外部页面提供统一的 scope 与导航动作。
 * 范围或项目切换后，旧范围迟到的异步回包一律丢弃。
 */
export function useProjectShell({
  organization,
  collaboration,
  persistence,
  workspaceId,
  user,
  namespace = DESKTOP_NAMESPACE,
}: UseProjectShellOptions) {
  const [workspace, setWorkspace] = useState<{ status: "loading" | "ready" | "failed"; value: WorkspacePersonal }>({
    status: "loading",
    value: workspaceDefaults,
  })
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setWorkspace(previous => ({ ...previous, status: "loading" }))
    void persistence.load({ kind: "workspace", workspaceId }).then(result => {
      if (!current) return
      if (!result.ok) { setWorkspace(previous => ({ ...previous, status: "failed" })); return }
      const saved = result.value.data as WorkspacePersonal | null
      setWorkspace({ status: "ready", value: saved ?? workspaceDefaults })
    })
    return () => { current = false }
  }, [persistence, workspaceId, workspaceAttempt])

  const workspaceReady = workspace.status === "ready"
  const projects = useProjects(organization, workspaceId, workspaceReady)
  const team = useTeamMembers(collaboration, workspaceId, workspaceReady)
  const [notice, setNotice] = useState("")
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [navigation, setNavigation] = useState<Record<string, NavigationEntry>>({})
  const navigationRef = useRef(navigation)
  navigationRef.current = navigation

  const saveWorkspace = (value: WorkspacePersonal) => {
    setWorkspace({ status: "ready", value })
    persistence.save({ kind: "workspace", workspaceId }, value)
  }

  // 当前项目只从已读取的列表中确定：上次的项目仍可访问就沿用，否则移出失效选择并选第一个进行中的项目。
  const ready = workspaceReady && projects.availability.state === "ready"
  const saved = workspace.value.projectId
  const savedVisible = saved !== null && projects.projects.some(item => item.projectId === saved)
  const projectId = !workspaceReady
    ? null
    : savedVisible
      ? saved
      : ready
        ? (projects.projects.find(item => item.status === "active") ?? projects.projects[0])?.projectId ?? null
        : null

  useEffect(() => {
    if (!ready || projectId === saved) return
    if (saved !== null) setNotice("上次的项目已不可访问，已切换到其他项目。")
    saveWorkspace({ ...workspace.value, projectId })
  }, [ready, projectId, saved])

  const detail = useProjectDetail(organization, workspaceId, projectId)
  // 项目已不可访问：重新读取列表，由上面的规则移出失效选择。
  useEffect(() => { if (detail.lost) void projects.reload() }, [detail.lost])

  useEffect(() => {
    if (!projectId || navigationRef.current[projectId]?.status === "ready") return
    let current = true
    const target = projectId
    setNavigation(previous => ({ ...previous, [target]: { status: "loading", value: previous[target]?.value ?? navigationDefaults } }))
    void persistence.load({ kind: "projectNavigation", workspaceId, projectId: target }).then(result => {
      if (!current) return
      const stored = result.ok ? result.value.data as ProjectNavigationPersonal | null : null
      let value = stored ?? navigationDefaults
      if (created === target) value = { ...value, page: { kind: "info" } }
      setNavigation(previous => ({ ...previous, [target]: { status: result.ok ? "ready" : "failed", value } }))
    })
    return () => { current = false }
  }, [projectId, persistence, workspaceId])

  const personal = (projectId ? navigation[projectId]?.value : undefined) ?? navigationDefaults
  function updateNavigation(change: (value: ProjectNavigationPersonal) => ProjectNavigationPersonal) {
    if (!projectId) return
    const existing = navigationRef.current[projectId]
    const value = change(existing?.value ?? navigationDefaults)
    const status = existing?.status ?? "loading"
    const next = { ...navigationRef.current, [projectId]: { status, value } }
    navigationRef.current = next
    setNavigation(next)
    // 只有读取成功的记录才写回，避免用默认值覆盖尚未读到的旧记录。
    if (status === "ready") persistence.save({ kind: "projectNavigation", workspaceId, projectId }, value)
  }

  const scope: ProjectNavigationScope | null = useMemo(
    () => (workspaceReady && projectId ? { namespace, accountId: user.id, workspaceId, projectId } : null),
    [workspaceReady, namespace, user.id, workspaceId, projectId],
  )

  return {
    workspace,
    retryWorkspace: () => setWorkspaceAttempt(value => value + 1),
    saveWorkspace,
    projects,
    team,
    detail,
    projectId,
    scope,
    personal,
    notice,
    creating,
    created,
    search,
    setSearch,
    openCreateDialog: () => setCreating(true),
    closeCreateDialog: () => setCreating(false),
    finishCreateProject: (id: string) => {
      setCreating(false)
      setCreated(id)
      setSearch("")
      setNotice("")
      saveWorkspace({ ...workspace.value, projectId: id })
      void projects.reload()
    },
    selectProject: (id: string) => {
      if (id === projectId || !projects.projects.some(item => item.projectId === id)) return
      setCreated(null)
      setSearch("")
      setNotice("")
      saveWorkspace({ ...workspace.value, projectId: id })
    },
    openPage: (page: ProjectPage) => {
      setNotice("")
      updateNavigation(value => ({ ...value, page }))
    },
    locateConversation: (conversationId: string, entries: readonly NavigationSessionEntry[]): boolean => {
      const target = entries.find(item => item.conversationId === conversationId)
      if (!target) return false
      setSearch("")
      setNotice("")
      updateNavigation(value => ({
        ...value,
        ...(target.ownerUserId === user.id
          ? { selfCollapsed: false }
          : { expandedMembers: value.expandedMembers.includes(target.ownerUserId) ? value.expandedMembers : [...value.expandedMembers, target.ownerUserId] }),
        page: { kind: "conversation", conversationId },
      }))
      return true
    },
    toggleMember: (userId: string) => updateNavigation(value => userId === user.id
      ? { ...value, selfCollapsed: !value.selfCollapsed }
      : {
          ...value,
          expandedMembers: value.expandedMembers.includes(userId)
            ? value.expandedMembers.filter(id => id !== userId)
            : [...value.expandedMembers, userId],
        }),
    reloadProject: () => { void detail.reload(); void projects.reload() },
  }
}

export type ProjectShellState = ReturnType<typeof useProjectShell>

export type ProjectWorkbenchProps = {
  shell: ProjectShellState
  organization: OrganizationHost
  persistence: PersonalPersistence
  workspaceId: string
  workspaceName: string
  user: UserSummary
  titleBarClassName: string
  settings: ReactNode
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  /** 个人记录保存失败时的提示，由上层持久化统一产生。 */
  personalError: string
  sessions?: NavigationSessionSource
  taskCount?: number | null
  providers?: ProjectPageProviders
}

function resolveProvider(page: ProjectPage, providers: ProjectPageProviders): ProjectPageProvider | undefined {
  switch (page.kind) {
    case "new":
    case "conversation":
      return providers.session
    case "board":
      return providers.board
    case "tasks":
    case "task":
      return providers.tasks
    case "knowledge":
      return providers.knowledge
    case "info":
      return undefined
  }
}

export function ProjectWorkbench(props: ProjectWorkbenchProps) {
  const { shell, organization, persistence, workspaceId, user } = props
  if (shell.workspace.status !== "ready") {
    const failed = shell.workspace.status === "failed"
    return <section className="desktop-empty desktop-conversation">
      <p role={failed ? "alert" : "status"}>{failed ? props.personalError || "无法恢复个人视图。" : "正在恢复个人视图…"}</p>
      {failed && <button className="wb-button wb-button-secondary" onClick={shell.retryWorkspace}>重试</button>}
    </section>
  }

  const sessions = props.sessions ?? defaultSessions
  const providers = props.providers ?? {}
  const workspace = shell.workspace.value
  const { projectId, scope, personal } = shell

  // 当会话列表已就绪且上次记录的会话已不在当前项目中时，自动回退到新对话准备页。
  const storedPage = personal.page
  const page: ProjectPage = storedPage.kind === "conversation"
    && sessions.availability.state === "ready"
    && !sessions.entries.some(item => item.conversationId === storedPage.conversationId)
    ? { kind: "new" }
    : storedPage

  const navigator: ProjectNavigator = {
    openPage: shell.openPage,
    locateConversation: conversationId => shell.locateConversation(conversationId, sessions.entries),
  }

  const members = projectMembers(shell.detail.detail, shell.team.members)
  const groups = buildMemberGroups({
    members,
    entries: sessions.entries,
    selfUserId: user.id,
    expandedMembers: personal.expandedMembers,
    selfCollapsed: personal.selfCollapsed,
    search: shell.search,
  })
  const activePage: NavigationPageKind | null = !projectId ? null : page.kind === "task" ? "tasks" : page.kind
  const current = shell.projects.projects.find(item => item.projectId === projectId)
  const actions: ProjectNavigationActions = {
    selectProject: shell.selectProject,
    createProject: shell.openCreateDialog,
    openProjectSettings: () => shell.openPage({ kind: "info" }),
    openPage: kind => shell.openPage({ kind }),
    selectConversation: conversationId => shell.openPage({ kind: "conversation", conversationId }),
    toggleMember: shell.toggleMember,
    setSearch: shell.setSearch,
    retry: area => {
      if (area === "projects") void shell.projects.reload()
      else if (area === "members") { void shell.detail.reload(); void shell.team.reload() }
      else if (area === "sessions") sessions.retry()
    },
    openSettings: () => props.setSettingsOpen(true),
  }

  const isSessionPage = page.kind === "new" || page.kind === "conversation"
  const activeProvider = resolveProvider(page, providers)

  // 会话提供者在整个项目范围内保持挂载，切到看板/任务/资料/知识时只隐藏，保证草稿与阅读位置不丢。
  const sessionSlot = projectId && scope && providers.session
    ? <div key={projectId} className="pnav-page-slot" hidden={!isSessionPage}>
        {providers.session.render({ scope, page, navigator, visible: isSessionPage })}
      </div>
    : null

  let pageView: ReactNode = null
  if (!projectId) {
    pageView = <section className="pnav-page" aria-label="项目">
      {shell.projects.availability.state === "failed" ? <>
        <p className="pnav-page-status" role="alert">{shell.projects.availability.message}</p>
        <button className="wb-button wb-button-secondary wb-button-small" onClick={() => { void shell.projects.reload() }}>重试</button>
      </> : shell.projects.availability.state === "ready" ? <>
        <h1>还没有项目</h1>
        <p className="pnav-page-status">创建一个协作事项，再邀请成员、关联仓库。</p>
        <button className="wb-button wb-button-primary" onClick={shell.openCreateDialog}>创建项目</button>
      </> : <p className="pnav-page-status" role="status">正在读取项目…</p>}
    </section>
  } else if (page.kind === "info") {
    pageView = <ProjectInfoPage
      key={projectId}
      host={organization}
      workspaceId={workspaceId}
      detail={shell.detail.detail}
      availability={shell.detail.availability}
      team={shell.team.members}
      selfUserId={user.id}
      justCreated={shell.created === projectId}
      onChanged={shell.reloadProject}
      onRetry={() => { void shell.detail.reload() }}
    />
  } else if (isSessionPage && providers.session) {
    pageView = null
  } else if (activeProvider && scope) {
    pageView = <div className="pnav-page-slot">
      {activeProvider.render({ scope, page, navigator, visible: true })}
    </div>
  } else {
    pageView = <section className="pnav-page" aria-label={pageNames[page.kind]}>
      <h1>{pageNames[page.kind]}</h1>
      <p className="pnav-page-status" role="status">该页面尚未接入。</p>
    </section>
  }

  const selectedEntry = page.kind === "conversation"
    ? sessions.entries.find(item => item.conversationId === page.conversationId)
    : undefined
  const headerContext: CollaborationContextView = current && scope
    ? activeProvider?.context?.({ scope, page }) ?? { title: selectedEntry?.title ?? pageNames[page.kind], projectName: current.name }
    : { title: "协作工作台" }

  return <>
    <WorkbenchLayout
      titleBarClassName={props.titleBarClassName}
      context={headerContext}
      navigation={<div className="desktop-navigation">
        <ProjectNavigation view={{
          accountName: user.userName,
          accountPhoto: resolveUserPhoto(user),
          workspaceName: props.workspaceName,
          projects: shell.projects.projects.map(item => ({ projectId: item.projectId, name: item.name, archived: item.status === "archived" })),
          projectsAvailability: shell.projects.availability,
          currentProjectId: projectId,
          groups,
          membersAvailability: shell.detail.availability.state === "ready" && shell.team.availability.state === "failed"
            ? shell.team.availability
            : shell.detail.availability,
          sessionsAvailability: sessions.availability,
          search: shell.search,
          activePage,
          selectedConversationId: page.kind === "conversation" ? page.conversationId : null,
          taskCount: props.taskCount ?? null,
        }} actions={actions} />
        {shell.notice && <p className="desktop-navigation-note" role="status">{shell.notice}</p>}
        {props.personalError && <p className="desktop-navigation-note" role="alert">{props.personalError}{" "}
          <button className="wb-button wb-button-small wb-button-quiet" onClick={() => { void persistence.flush() }}>重试保存</button>
        </p>}
      </div>}
      center={<>{sessionSlot}{pageView}</>}
      right={slot => (scope && activeProvider?.right ? activeProvider.right({ scope, page, slot }) : null)}
      leftOpen={workspace.panels.left.open}
      leftWidthPx={workspace.panels.left.width}
      rightOpen={Boolean(scope && activeProvider?.right) && workspace.panels.right.open}
      rightWidthPx={workspace.panels.right.width}
      setPanelOpen={(side, open) => shell.saveWorkspace({ ...workspace, panels: { ...workspace.panels, [side]: { ...workspace.panels[side], open } } })}
      setPanelWidth={(side, width) => shell.saveWorkspace({ ...workspace, panels: { ...workspace.panels, [side]: { ...workspace.panels[side], width } } })}
      settingsOpen={props.settingsOpen}
      closeSettings={() => props.setSettingsOpen(false)}
      settings={props.settings}
    />
    {shell.creating && <CreateProjectDialog
      host={organization}
      workspaceId={workspaceId}
      onClose={shell.closeCreateDialog}
      onCreated={shell.finishCreateProject}
    />}
  </>
}
