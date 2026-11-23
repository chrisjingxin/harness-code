/**
 * Project 外壳与页面装配：
 * 1. useProjectShell：恢复团队个人记录 → 读取项目列表确定当前项目与导航范围（scope）→ 读取项目详情与本项目导航记录。
 * 2. ProjectWorkbench：左栏 ProjectNavigation + 按 page.kind 选择提供者；会话提供者在项目范围内常驻挂载（切页只改 visible），右栏与顶栏上下文由当前提供者决定。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { IconArrowLeft } from "@tabler/icons-react"
import type {
  CollaborationHost,
  KnowledgeSummary,
  TaskSummary,
  UserSummary,
} from "@workbench/collaboration-client/types"
import type {
  OrganizationHost,
  ProjectNavigationPersonal,
  ProjectPage,
  WorkspacePersonal,
} from "../../../shared/index.js"
import { ProjectNavigation, WorkbenchLayout, buildMemberGroups } from "../../../ui/index.js"
import type {
  CollaborationContextView,
  NavigationPageKind,
  NavigationSpaceKind,
  NavigationWorkspaceItem,
  PersonalNavigationDirectoryGroup,
  ProjectNavigationActions,
} from "../../../ui/index.js"
import type { PersonalPersistence } from "../../personal-persistence.js"
import {
  CollabMembersPopover,
  CommandPaletteModal,
  TopbarCollabButton,
  memberRoleLabel,
} from "../collaboration-views/index.js"
import "../collaboration-views/collab-views.css"
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
  new: "新对话", conversation: "会话", board: "Project 看板", tasks: "任务", task: "任务详情", info: "Project 资料与成员", knowledge: "团队知识库",
}
const defaultSessions: NavigationSessionSource = {
  entries: [],
  availability: { state: "unavailable", message: "会话列表尚未接入。" },
  retry: () => {},
}

type NavigationEntry = { status: "loading" | "ready" | "failed"; value: ProjectNavigationPersonal }
type NavigationChange = (value: ProjectNavigationPersonal) => ProjectNavigationPersonal

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
  const pendingNavigation = useRef(new Map<string, NavigationChange[]>())

  function setNavigationEntry(id: string, entry: NavigationEntry) {
    const next = { ...navigationRef.current, [id]: entry }
    navigationRef.current = next
    setNavigation(next)
  }

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
    const key = { kind: "projectNavigation", workspaceId, projectId: target } as const
    setNavigationEntry(target, { status: "loading", value: navigationRef.current[target]?.value ?? navigationDefaults })
    void persistence.load(key).then(result => {
      if (!current) return
      const stored = result.ok ? result.value.data as ProjectNavigationPersonal | null : null
      let value = stored ?? navigationDefaults
      if (created === target) value = { ...value, page: { kind: "info" } }
      // 恢复期间也能切页。把这段时间的点击按顺序应用到旧记录，保留用户已保存的其余偏好。
      const pending = pendingNavigation.current.get(target)
      pendingNavigation.current.delete(target)
      if (pending) value = pending.reduce((state, change) => change(state), value)
      setNavigationEntry(target, { status: result.ok ? "ready" : "failed", value })
      if (result.ok && pending) persistence.save(key, value)
    })
    return () => { current = false }
  }, [projectId, persistence, workspaceId])

  const personal = (projectId ? navigation[projectId]?.value : undefined) ?? navigationDefaults
  function updateNavigation(change: NavigationChange) {
    if (!projectId) return
    const existing = navigationRef.current[projectId]
    const value = change(existing?.value ?? navigationDefaults)
    const status = existing?.status ?? "loading"
    if (status === "loading") {
      const pending = pendingNavigation.current.get(projectId) ?? []
      pending.push(change)
      pendingNavigation.current.set(projectId, pending)
    }
    setNavigationEntry(projectId, { status, value })
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

export type DualTrackNavigationProps = {
  readonly activeSpace: NavigationSpaceKind
  readonly hasTeamUpdates?: boolean
  readonly offline?: boolean
  readonly canPublishPersonal?: boolean
  readonly personalGroups?: readonly PersonalNavigationDirectoryGroup[]
  readonly personalSearch?: string
  readonly selectedPersonalConversationId?: string | null
  readonly publishedSessionCount?: number
  selectSpace(space: NavigationSpaceKind): void
  createPersonalSession(): void
  selectPersonalConversation(conversationId: string): void
  renamePersonalConversation(conversationId: string, title: string): Promise<string | null>
  publishPersonalConversation(conversationId: string): void
  stopSharingConversation(
    conversationId: string,
    fallback?: {
      readonly workspaceId?: string
      readonly projectId?: string
      readonly title?: string
      readonly projectName?: string | null
    },
  ): void
  setPersonalSearch(text: string): void
  reconnect(): void
}

export type ProjectWorkbenchProps = {
  shell: ProjectShellState
  organization: OrganizationHost
  persistence: PersonalPersistence
  workspaceId: string
  workspaceName: string
  workspaces?: readonly NavigationWorkspaceItem[]
  onSelectWorkspace?(workspaceId: string): void
  colorScheme?: "light" | "dark"
  onToggleTheme?(): void
  localDeviceName?: string | null
  user: UserSummary
  titleBarClassName: string
  settings: ReactNode
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  /** 个人记录保存失败时的提示，由上层持久化统一产生。 */
  personalError: string
  sessions?: NavigationSessionSource
  tasks?: readonly TaskSummary[]
  knowledge?: readonly KnowledgeSummary[]
  metadataMessage?: string
  taskCount?: number | null
  knowledgeCount?: number | null
  providers?: ProjectPageProviders
  dualTrack?: DualTrackNavigationProps
  onSelectKnowledge?(knowledgeId: string): void
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
  const members = useMemo(
    () => projectMembers(shell.detail.detail, shell.team.members),
    [shell.detail.detail, shell.team.members],
  )
  const [collabPopoverOpen, setCollabPopoverOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const pendingSettingsProjectIdRef = useRef<string | null>(null)

  // 项目切换后关闭旧结果浮层，避免用户在新项目点击旧任务或知识。
  useEffect(() => { setPaletteOpen(false); setCollabPopoverOpen(false) }, [shell.scope])

  // 当在团队空间点击未激活 Project 的齿轮时，切到该项目后自动打开其资料与成员设置页。
  useEffect(() => {
    const targetProjectId = pendingSettingsProjectIdRef.current
    if (!targetProjectId || shell.projectId !== targetProjectId) return
    pendingSettingsProjectIdRef.current = null
    shell.openPage({ kind: "info" })
  }, [shell.projectId, shell.openPage])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setCollabPopoverOpen(false)
        setPaletteOpen(prev => !prev)
      } else if ((event.metaKey || event.ctrlKey) && event.key === "\\" && shell.workspace.status === "ready") {
        event.preventDefault()
        const ws = shell.workspace.value
        shell.saveWorkspace({
          ...ws,
          panels: { ...ws.panels, left: { ...ws.panels.left, open: !ws.panels.left.open } },
        })
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [shell.workspace.status, shell.workspace.value, shell.saveWorkspace])

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

  const groups = buildMemberGroups({
    members,
    entries: sessions.entries,
    selfUserId: user.id,
    expandedMembers: personal.expandedMembers,
    selfCollapsed: personal.selfCollapsed,
    search: shell.search,
  })
  const myEntries = sessions.entries.filter(item => item.ownerUserId === user.id)
  const peerEntries = sessions.entries.filter(item => item.ownerUserId !== user.id)
  const myLocalEntries = sessions.entries.filter(item => item.ownerUserId === user.id && item.badge?.text === "本机")

  const activePage: NavigationPageKind | null = !projectId ? null : page.kind === "task" ? "tasks" : page.kind
  const current = shell.projects.projects.find(item => item.projectId === projectId)
  const currentRepoLabel = shell.detail.detail?.repositories?.length
    ? shell.detail.detail.repositories.map(r => r.name).join(" · ")
    : undefined

  const actions: ProjectNavigationActions = {
    ...(props.onSelectWorkspace ? { selectWorkspace: props.onSelectWorkspace } : {}),
    ...(props.dualTrack
      ? {
          selectSpace: props.dualTrack.selectSpace,
          createPersonalSession: props.dualTrack.createPersonalSession,
          selectPersonalConversation: props.dualTrack.selectPersonalConversation,
          renamePersonalConversation: props.dualTrack.renamePersonalConversation,
          publishPersonalConversation: props.dualTrack.publishPersonalConversation,
          stopSharingConversation: props.dualTrack.stopSharingConversation,
          setPersonalSearch: props.dualTrack.setPersonalSearch,
          reconnect: props.dualTrack.reconnect,
        }
      : {}),
    selectProject: id => {
      setCollabPopoverOpen(false)
      shell.selectProject(id)
    },
    createProject: shell.openCreateDialog,
    openProjectSettings: () => shell.openPage({ kind: "info" }),
    openProjectSettingsFor: targetProjectId => {
      setCollabPopoverOpen(false)
      if (targetProjectId === shell.projectId) {
        shell.openPage({ kind: "info" })
        return
      }
      pendingSettingsProjectIdRef.current = targetProjectId
      shell.selectProject(targetProjectId)
    },
    openPage: kind => {
      setCollabPopoverOpen(false)
      shell.openPage({ kind })
    },
    createSession: () => {
      setCollabPopoverOpen(false)
      shell.openPage({ kind: "new" })
    },
    selectConversation: conversationId => {
      setCollabPopoverOpen(false)
      shell.openPage({ kind: "conversation", conversationId })
    },
    renameConversation: sessions.renameConversation,
    toggleMember: shell.toggleMember,
    setSearch: shell.setSearch,
    openCommandPalette: () => {
      setCollabPopoverOpen(false)
      setPaletteOpen(true)
    },
    toggleLeftSidebar: () => shell.saveWorkspace({
      ...workspace,
      panels: { ...workspace.panels, left: { ...workspace.panels.left, open: !workspace.panels.left.open } },
    }),
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
      workspaceName={props.workspaceName}
      detail={shell.detail.detail}
      availability={shell.detail.availability}
      team={shell.team.members}
      selfUserId={user.id}
      justCreated={shell.created === projectId}
      sessionCount={myEntries.length}
      taskCount={props.tasks?.length}
      knowledgeCount={props.knowledge?.length ?? props.knowledgeCount ?? undefined}
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
  const selectedOwner = selectedEntry ? members.find(m => m.userId === selectedEntry.ownerUserId) : undefined
  const isRemoteSession = Boolean(
    page.kind === "conversation"
      && selectedEntry
      && !(selectedEntry.ownerUserId === user.id && selectedEntry.badge?.text === "本机"),
  )

  const headerContext: CollaborationContextView = !current
    ? { title: "协作工作台" }
    : page.kind === "knowledge"
      ? {
          title: "团队知识库",
          subtitle: `${props.workspaceName} · 双层沉淀`,
        }
      : {
          title: current.name,
          subtitle: isRemoteSession
            ? selectedEntry?.ownerUserId !== user.id
              ? `${props.workspaceName} · ${selectedOwner?.userName ?? "队友"} · 跨机只读同步`
              : `${props.workspaceName} · 本人其他设备 · 只读`
            : `${props.workspaceName}${currentRepoLabel ? ` · ${currentRepoLabel}` : ""}`,
        }

  const backButton = isRemoteSession ? (
    <button
      type="button"
      className="collab-back-btn"
      onClick={() => {
        const target = myLocalEntries[0]
        if (target) shell.openPage({ kind: "conversation", conversationId: target.conversationId })
        else shell.openPage({ kind: "new" })
      }}
    >
      <IconArrowLeft size={14} aria-hidden="true" />
      <span>返回我的会话</span>
    </button>
  ) : undefined

  const headerExtra = projectId && members.length > 0 ? (
    <TopbarCollabButton
      members={members}
      selfUserId={user.id}
      peerEntries={peerEntries}
      expanded={collabPopoverOpen}
      onClick={() => setCollabPopoverOpen(v => !v)}
    />
  ) : undefined

  const overlays = (
    <>
      {current && (
        <CollabMembersPopover
          open={collabPopoverOpen}
          projectName={current.name}
          members={members}
          selfUserId={user.id}
          peerEntries={peerEntries}
          onClose={() => setCollabPopoverOpen(false)}
          onOpenConversation={conversationId => {
            setCollabPopoverOpen(false)
            shell.openPage({ kind: "conversation", conversationId })
          }}
        />
      )}
      {current && (
        <CommandPaletteModal
          open={paletteOpen}
          projectName={current.name}
          members={members}
          mySessions={myEntries}
          peerSessions={peerEntries}
          tasks={props.tasks ?? []}
          knowledge={props.knowledge ?? []}
          metadataMessage={props.metadataMessage}
          onClose={() => setPaletteOpen(false)}
          onSelectSession={conversationId => shell.openPage({ kind: "conversation", conversationId })}
          onSelectTask={taskId => shell.openPage({ kind: "task", taskId })}
          onSelectKnowledge={knowledgeId => {
            if (props.onSelectKnowledge) props.onSelectKnowledge(knowledgeId)
            else shell.openPage({ kind: "knowledge" })
          }}
        />
      )}
    </>
  )

  const selfMember = members.find(m => m.userId === user.id) ?? shell.team.members.find(m => m.user.id === user.id)?.user ?? user
  const teamPhotos = shell.team.members.slice(0, 3).map(m => ({
    initial: (m.user.userName || "?").slice(0, 1),
    photo: resolveUserPhoto(m.user),
  }))
  const enrichedWorkspaces = (props.workspaces ?? [{ workspaceId, name: props.workspaceName }]).map(ws =>
    ws.workspaceId === workspaceId
      ? {
          ...ws,
          ...(shell.team.members.length ? { memberCount: shell.team.members.length } : {}),
          ...(teamPhotos.length ? { memberPhotos: teamPhotos } : {}),
        }
      : ws,
  )

  return <>
    <WorkbenchLayout
      titleBarClassName={props.titleBarClassName}
      context={headerContext}
      renderHeaderTitle={({ leftCollapsed }) => {
        if (scope && activeProvider?.headerTitle) {
          const custom = activeProvider.headerTitle({ scope, page, leftCollapsed })
          if (custom !== null && custom !== undefined) return custom
        }
        if (!current) return <span className="tb-name">协作工作台</span>
        const viewTitle = pageNames[page.kind]
        const effectiveTaskCount = props.taskCount !== null && props.taskCount !== undefined
          ? props.taskCount
          : props.tasks?.length ?? null
        const countLabel = page.kind === "info"
          ? `${members.length} 位成员`
          : page.kind === "board"
            ? effectiveTaskCount !== null
              ? `${effectiveTaskCount} 项待办 · ${members.length} 人`
              : `${members.length} 位成员`
            : page.kind === "tasks" || page.kind === "task"
              ? effectiveTaskCount !== null
                ? `${effectiveTaskCount} 项待办`
                : ""
              : page.kind === "knowledge"
                ? leftCollapsed
                  ? ""
                  : props.workspaceName
                : ""
        const crumbLabel = page.kind === "knowledge" ? props.workspaceName : current.name
        return (
          <>
            {leftCollapsed && crumbLabel ? (
              <span className="tb-crumb">
                <span className="tb-crumb-name">{crumbLabel}</span>
                <span className="tb-crumb-sep" aria-hidden="true">/</span>
              </span>
            ) : null}
            <span className="tb-name">{viewTitle}</span>
            {countLabel ? <span className="tb-count">{countLabel}</span> : null}
          </>
        )
      }}
      backButton={backButton}
      headerExtra={headerExtra}
      colorScheme={props.colorScheme}
      onToggleTheme={props.onToggleTheme}
      overlays={overlays}
      navigation={<div className="desktop-navigation">
        <ProjectNavigation view={{
          accountName: user.userName,
          accountPhoto: resolveUserPhoto(user),
          accountRole: memberRoleLabel(selfMember),
          workspaceName: props.workspaceName,
          workspaces: enrichedWorkspaces,
          currentWorkspaceId: workspaceId,
          projects: shell.projects.projects.map(item => ({
            projectId: item.projectId,
            name: item.name,
            archived: item.status === "archived",
            memberCount: item.memberCount,
            ...(item.projectId === projectId && currentRepoLabel ? { repo: currentRepoLabel } : {}),
          })),
          projectsAvailability: shell.projects.availability,
          currentProjectId: projectId,
          currentProjectRepo: currentRepoLabel,
          currentProjectMemberCount: members.length,
          localDeviceName: props.localDeviceName ?? undefined,
          groups,
          membersAvailability: shell.detail.availability.state === "ready" && shell.team.availability.state === "failed"
            ? shell.team.availability
            : shell.detail.availability,
          sessionsAvailability: sessions.availability,
          search: shell.search,
          activePage,
          selectedConversationId: page.kind === "conversation" ? page.conversationId : null,
          taskCount: !projectId
            ? null
            : props.taskCount !== undefined
              ? props.taskCount
              : props.tasks
                ? props.tasks.filter(t => t.assigneeId === user.id && t.status !== "done" && t.status !== "cancelled").length
                : null,
          knowledgeCount: !projectId
            ? null
            : props.knowledgeCount !== undefined
              ? props.knowledgeCount
              : props.knowledge
                ? props.knowledge.filter(k => !k.archived).length
                : null,
          ...(props.dualTrack
            ? {
                activeSpace: props.dualTrack.activeSpace,
                hasTeamUpdates: props.dualTrack.hasTeamUpdates,
                offline: props.dualTrack.offline,
                canPublishPersonal: props.dualTrack.canPublishPersonal,
                personalGroups: props.dualTrack.personalGroups,
                personalSearch: props.dualTrack.personalSearch,
                selectedPersonalConversationId: props.dualTrack.selectedPersonalConversationId,
                publishedSessionCount: props.dualTrack.publishedSessionCount,
              }
            : {}),
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
      workspaceName={props.workspaceName}
      teamMembers={shell.team.members}
      selfUserId={user.id}
      onClose={shell.closeCreateDialog}
      onCreated={shell.finishCreateProject}
    />}
  </>
}
