/**
 * 正式窗口装配：宿主确认的身份 → 恢复账号记录并确定团队 → Project 外壳与会话协调器。
 * 个人记录按身份重新创建，退出前先保存；业务读取只走 preload 暴露的具名端口。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type {
  CollaborationHost,
  DesktopHost,
  LocalDirectoryHost,
  ProjectConversationHost,
  ThemeMode,
  UserSummary,
  WindowState,
  ZoomAction,
} from "@workbench/contracts"
import type { AccountPersonal, PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"
import type { DesktopLocalExecutionHost } from "../local-execution-host.js"
import type { CollaborationAppsHost } from "../collaboration-apps-host.js"
import type { ProjectUpdatesHost } from "../project-updates-host.js"
import { ACCENT_OPTIONS, DEFAULT_ACCENT, IdentityPanel, ProjectNavigation, WorkbenchLayout, useCollaborationIdentity } from "@workbench/ui"
import type { AccentId, NavigationWorkspaceItem } from "@workbench/ui"
import { ProjectWorkbench, useProjectShell } from "./features/project-navigation/index.js"
import type { ProjectPageProviders } from "./features/project-navigation/index.js"
import { createSessionPageProvider, useProjectSessions } from "./features/session/index.js"
import type { LocalSessionExecutionPort, ProjectConversationSummary } from "./features/session/index.js"
import { createCollaborationPageProviders } from "./features/collaboration/collaboration-pages.js"
import { useCollaborationMetadata } from "./features/collaboration/metadata.js"
import { LiveProjectTasks, ProjectTaskPublication, useProjectTaskMetadata } from "./features/collaboration/tasks/live-project-tasks.js"
import type { TasksContext } from "./features/collaboration/tasks/live-project-tasks.js"
import { LiveTeamKnowledge } from "./features/collaboration/knowledge/live-team-knowledge.js"
import { createBoardPageProvider } from "./features/board/board-provider.js"
import { useProjectBoard } from "./features/board/use-project-board.js"
import { useProjectUpdates } from "./features/project-updates/use-project-updates.js"
import { useWorkbenchReferences } from "./features/collaboration/references/workbench-references.js"
import type { ReferenceActions } from "./features/collaboration/references/conversation-references.js"
import { PersonalPersistence } from "./personal-persistence.js"
import { resolveUserPhoto } from "./demo-avatars.js"
import "@workbench/ui/layout.css"
import "@workbench/ui/navigation.css"
import "@workbench/ui/conversation.css"
import "./desktop-workbench.css"

type Hosts = {
  host: DesktopHost
  collaboration: CollaborationHost
  collaborationApps?: CollaborationAppsHost
  projectUpdates?: ProjectUpdatesHost
  organization: OrganizationHost
  projectConversations: ProjectConversationHost
  localDirectory?: LocalDirectoryHost
  localExecution?: DesktopLocalExecutionHost
  personalHost: PersonalHost
  referenceSnapshots?: ReferenceActions["readSnapshot"]
  execution?: LocalSessionExecutionPort
}
type Identity = ReturnType<typeof useCollaborationIdentity>
type Preferences = ReturnType<typeof useWindowPreferences>
const noop = () => {}

/** 窗口重开后重新登录；每次身份变化都重新创建个人记录会话。 */
export function DesktopWorkbench(hosts: Hosts) {
  const { host, collaboration, personalHost } = hosts
  const identity = useCollaborationIdentity(collaboration)
  const preferences = useWindowPreferences(host)
  const [personalError, setPersonalError] = useState("")
  const identityKey = identity.state.status === "signedIn" ? `signed:${identity.state.user.id}`
    : identity.state.status === "connectionError" && identity.state.lastKnownUser ? `signed:${identity.state.lastKnownUser.id}` : identity.state.status
  const persistence = useMemo(() => new PersonalPersistence(personalHost, setPersonalError), [personalHost, identityKey])
  useEffect(() => { setPersonalError(""); return personalHost.onCloseRequested(() => persistence.flush()) }, [personalHost, persistence])
  const guardedIdentity = { ...identity, signOut: async () => { if (await persistence.flush()) await identity.signOut() } }
  return <DesktopSession key={identityKey} {...hosts} identity={guardedIdentity} preferences={preferences}
    persistence={persistence} personalError={personalError} />
}

function DesktopSession(props: Hosts & { identity: Identity; preferences: Preferences; persistence: PersonalPersistence; personalError: string }) {
  const { identity, persistence } = props
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [account, setAccount] = useState<"loading" | "ready" | "failed">("loading")
  const [attempt, setAttempt] = useState(0)
  const signedIn = identity.state.status === "signedIn" ? identity.state : null
  const workspaces = signedIn?.workspaces ?? []
  // 团队只取已保存且仍可访问的选择；只有一个团队时直接使用，多个且无记录时由用户选择，不按名称猜测。
  const workspace = workspaces.find(item => item.id === chosen) ?? (workspaces.length === 1 ? workspaces[0]! : null)

  useEffect(() => {
    if (!signedIn) return
    let current = true
    setAccount("loading")
    void persistence.load({ kind: "account" }).then(result => {
      if (!current) return
      if (!result.ok) { setAccount("failed"); return }
      const saved = result.value.data as AccountPersonal | null
      if (saved?.workspaceId) setChosen(saved.workspaceId)
      setAccount("ready")
    })
    return () => { current = false }
  }, [signedIn?.user.id, persistence, attempt])

  const titleBarClassName = "desktop-titlebar" + (navigator.platform.startsWith("Mac") ? " desktop-titlebar-macos"
    : navigator.platform.startsWith("Win") ? " desktop-titlebar-windows" : "")

  const workspaceItems: NavigationWorkspaceItem[] = workspaces.map(item => ({
    workspaceId: item.id,
    name: item.name,
  }))
  const selectWorkspace = (workspaceId: string) => {
    setChosen(workspaceId)
    persistence.save({ kind: "account" }, { workspaceId })
  }

  const settingsHead = (
    <div className="desktop-settings-head">
      <div>
        <h2>系统设置</h2>
        <p className="desktop-settings-sub">外观、强调色、界面密度、快捷键、账号与团队</p>
      </div>
    </div>
  )
  const settingsBody = <>
    <div className="desktop-set-section">外观与布局</div>
    <WindowPreferences {...props.preferences} />
    <div className="desktop-set-section">快捷键</div>
    <div className="kbd-grid" aria-label="快捷键一览">
      <div className="kbd-item"><span>命令面板</span><span className="kbd-combo"><kbd>⌘</kbd><kbd>K</kbd></span></div>
      <div className="kbd-item"><span>收起 / 展开左栏</span><span className="kbd-combo"><kbd>⌘</kbd><kbd>\</kbd></span></div>
      <div className="kbd-item"><span>发送消息</span><span className="kbd-combo"><kbd>Enter</kbd></span></div>
      <div className="kbd-item"><span>关闭弹窗 / 浮层</span><span className="kbd-combo"><kbd>Esc</kbd></span></div>
    </div>
    <div className="desktop-set-section">账号与团队</div>
    <IdentityPanel host={props.collaboration} identity={identity} workspaceId={workspace?.id ?? null} />
  </>

  if (signedIn && account === "ready" && workspace) {
    return <WorkspaceProjectWorkbench
      key={workspace.id}
      host={props.host}
      organization={props.organization}
      collaboration={props.collaboration}
      collaborationApps={props.collaborationApps}
      projectUpdates={props.projectUpdates}
      projectConversations={props.projectConversations}
      localDirectory={props.localDirectory}
      localExecution={props.localExecution}
      referenceSnapshots={props.referenceSnapshots}
      execution={props.execution}
      persistence={persistence}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      workspaces={workspaceItems}
      onSelectWorkspace={selectWorkspace}
      colorScheme={props.preferences.state.colorScheme}
      onToggleTheme={props.preferences.toggleTheme}
      user={signedIn.user}
      titleBarClassName={titleBarClassName}
      settingsHead={settingsHead}
      settingsBody={settingsBody}
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      personalError={props.personalError}
    />
  }

  const settings = <div className="desktop-settings">
    {settingsHead}
    <div className="desktop-settings-body">
      {settingsBody}
    </div>
  </div>

  const status = identity.state.status
  const message = status === "loading" ? "正在确认账号。"
    : status === "connectionError" ? identity.state.error.message
    : !signedIn ? "登录后查看团队项目。"
    : account === "loading" ? "正在恢复个人视图…"
    : account === "failed" ? props.personalError || "无法恢复个人视图。"
    : workspaces.length ? "请选择团队。" : "当前账号未加入团队。"
  return <WorkbenchLayout
    titleBarClassName={titleBarClassName}
    context={{ title: "协作工作台" }}
    colorScheme={props.preferences.state.colorScheme}
    onToggleTheme={props.preferences.toggleTheme}
    navigation={<div className="desktop-navigation">
      <ProjectNavigation view={{
        accountName: signedIn?.user.userName ?? null, accountPhoto: resolveUserPhoto(signedIn?.user),
        workspaceName: null, workspaces: workspaceItems, projects: [],
        projectsAvailability: { state: status === "loading" ? "loading" : "unavailable", message },
        currentProjectId: null, groups: [], membersAvailability: { state: "unavailable" }, sessionsAvailability: { state: "unavailable" },
        search: "", activePage: null, selectedConversationId: null, taskCount: null,
      }} actions={{
        selectWorkspace,
        selectProject: noop, createProject: noop, openProjectSettings: noop, openPage: noop, selectConversation: noop,
        toggleMember: noop, setSearch: noop, retry: noop, openSettings: () => setSettingsOpen(true),
      }} />
    </div>}
    center={<section className="desktop-empty desktop-conversation" aria-label="开始">
      <h1>协作工作台</h1>
      <p role={account === "failed" ? "alert" : "status"}>{message}</p>
      {!signedIn && status !== "loading" && <button className="wb-button wb-button-primary" onClick={() => setSettingsOpen(true)}>{status === "connectionError" ? "查看连接" : "演示登录"}</button>}
      {signedIn && account === "failed" && <button className="wb-button wb-button-secondary" onClick={() => setAttempt(value => value + 1)}>重试</button>}
      {signedIn && account === "ready" && workspaces.length > 1 && <div className="desktop-workspace-choice">
        {workspaces.map(item => <button key={item.id} className="wb-button wb-button-secondary" onClick={() => selectWorkspace(item.id)}>{item.name}</button>)}
      </div>}
      {!settingsOpen && identity.notice && <p className="error" role="alert">{identity.notice}</p>}
    </section>}
    right={() => null}
    leftOpen
    leftWidthPx={280}
    rightOpen={false}
    rightWidthPx={340}
    setPanelOpen={noop}
    setPanelWidth={noop}
    settingsOpen={settingsOpen}
    closeSettings={() => setSettingsOpen(false)}
    settings={settings}
  />
}

function WorkspaceProjectWorkbench(props: {
  host: DesktopHost
  organization: OrganizationHost
  collaboration: CollaborationHost
  collaborationApps?: CollaborationAppsHost
  projectUpdates?: ProjectUpdatesHost
  projectConversations: ProjectConversationHost
  localDirectory?: LocalDirectoryHost
  localExecution?: DesktopLocalExecutionHost
  referenceSnapshots?: ReferenceActions["readSnapshot"]
  execution?: LocalSessionExecutionPort
  persistence: PersonalPersistence
  workspaceId: string
  workspaceName: string
  workspaces?: readonly NavigationWorkspaceItem[]
  onSelectWorkspace?(workspaceId: string): void
  colorScheme?: "light" | "dark"
  onToggleTheme?(): void
  user: UserSummary
  titleBarClassName: string
  settingsHead: React.ReactNode
  settingsBody: React.ReactNode
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
  personalError: string
}) {
  const shell = useProjectShell({
    organization: props.organization,
    collaboration: props.collaboration,
    persistence: props.persistence,
    workspaceId: props.workspaceId,
    user: props.user,
  })
  const currentProject = shell.projects.projects.find(item => item.projectId === shell.projectId)
  const selectedConversationId = shell.personal.page.kind === "conversation"
    ? shell.personal.page.conversationId
    : null
  const currentPage = shell.personal.page
  const { taskRevision, knowledgeRevision, refreshTaskMetadata, refreshKnowledgeMetadata } = useCollaborationMetadata(shell.scope)
  const taskRows = useProjectTaskMetadata(props.collaborationApps, shell.scope, taskRevision)
  const taskCount = taskRows.status === "ready" ? taskRows.tasks.filter(task =>
    task.assigneeId === props.user.id && task.status !== "done" && task.status !== "cancelled").length : null
  const [publishing, setPublishing] = useState<{ scope: typeof shell.scope; page: typeof currentPage; assigneeId?: string; sourceId?: string } | null>(null)

  function locateConversation(conversation: ProjectConversationSummary): boolean {
    return shell.locateConversation(conversation.conversationId, [{
      conversationId: conversation.conversationId,
      ownerUserId: conversation.ownerUserId,
      title: conversation.title,
      timeLabel: "",
    }])
  }

  const projectSessions = useProjectSessions({
    host: props.host,
    projectConversations: props.projectConversations,
    localDirectory: props.localDirectory,
    localExecution: props.localExecution,
    persistence: props.persistence,
    scope: shell.scope,
    projectName: currentProject?.name ?? "当前项目",
    userId: props.user.id,
    members: shell.team.members,
    selectedConversationId,
    execution: props.execution,
    onOpenConversation: locateConversation,
  })
  const { pageController, integration } = projectSessions
  const scope = shell.scope
  const { refresh: refreshBoard, ...board } = useProjectBoard(props.projectUpdates, scope, currentPage.kind === "board")
  // 订阅跟随团队外壳。切页面、切项目时只替换刷新目标，正文读取仍在原页面动作内。
  const notification = useProjectUpdates(props.projectUpdates, props.user.id, props.workspaceId, {
    projectId: scope?.projectId ?? null,
    refreshProjectList: () => { void shell.projects.reload() },
    refreshProjectDetail: () => { void shell.detail.reload() },
    refreshConversations: () => {
      if (scope) void integration.refreshMetadata(scope).catch(() => {})
    },
    refreshBoard,
    refreshTasks: () => { if (scope) refreshTaskMetadata(scope) },
    refreshKnowledge: () => { if (scope) refreshKnowledgeMetadata(scope) },
  })
  const canPublish = Boolean(props.collaborationApps && currentProject?.status === "active")
  const taskMembers = shell.detail.detail?.project.projectId === shell.scope?.projectId
    ? (shell.detail.detail?.members ?? []).filter(member => member.status === "active")
      .map(member => ({ id: member.userId, name: pageController.resolveOwnerName(member.userId) }))
    : []
  const chooseDirectory = () => props.host.chooseDirectory()
  const taskContext: TasksContext | undefined = props.collaborationApps && shell.scope ? {
    host: props.collaborationApps, scope: shell.scope, projectName: currentProject?.name ?? "当前项目", projectActive: canPublish,
    ownerName: pageController.resolveOwnerName, localDeviceId: props.user.id,
    sessions: integration, directories: pageController.directories,
    chooseDirectory, locateConversation, refreshTaskMetadata,
  } : undefined
  const openTask = (taskId: string) => shell.openPage({ kind: "task", taskId })
  const references = useWorkbenchReferences({
    scope: shell.scope,
    selectedConversationId,
    pageKey: JSON.stringify(currentPage),
    pageController,
    integration,
    readSnapshot: props.referenceSnapshots,
    host: props.collaborationApps,
    members: taskMembers,
    tasks: taskRows.status === "ready" ? taskRows.tasks : undefined,
    onChooseMember: canPublish ? assigneeId => setPublishing({ scope: shell.scope, page: currentPage, assigneeId }) : undefined,
    onOpenTask: taskContext ? openTask : undefined,
    chooseDirectory,
    locateConversation,
  })

  const sourceId = publishing?.sourceId
  const sourceConversations = pageController.conversations.filter(item => item.projectId === shell.scope?.projectId)
  const publicationSources = sourceId ? [
    ...sourceConversations.filter(item => item.conversationId === sourceId),
    ...sourceConversations.filter(item => item.conversationId !== sourceId),
  ] : sourceConversations

  // 看板复用项目导航和任务发布表单，用会话模块已有的本机缓存水位显示同步状态。
  const providers: ProjectPageProviders = {
    ...(props.projectUpdates ? {
      board: createBoardPageProvider({
        ...board,
        projectName: currentProject?.name ?? "当前项目",
        description: currentProject?.description,
        accountId: props.user.id,
        localDeviceId: props.user.id,
        syncStates: pageController.syncStates,
        notification,
        onRefresh: refreshBoard,
        onCreateTask: canPublish ? () => setPublishing({ scope, page: currentPage }) : undefined,
      }),
    } : {}),
    session: createSessionPageProvider({
      ...pageController,
      hooks: {
        ...references.hooks,
        onCreateTaskFromConversation: canPublish ? conversation => setPublishing({
          scope: shell.scope, page: currentPage, sourceId: conversation.conversationId,
        }) : undefined,
      },
    }),
    ...createCollaborationPageProviders({
      projectName: currentProject?.name ?? "当前项目",
      workspaceName: props.workspaceName,
    }),
    ...(taskContext ? {
      tasks: {
        render({ scope, page, navigator, visible }) {
          if (!visible || (page.kind !== "tasks" && page.kind !== "task")) return null
          const id = page.kind === "task" ? page.taskId : undefined
          return <div className="collaboration-page-scroll" key={JSON.stringify([scope, id])}>
            <LiveProjectTasks context={taskContext} rows={taskRows} taskId={id} navigator={navigator}
              onCreate={() => setPublishing({ scope, page: currentPage })} />
          </div>
        },
      },
      knowledge: {
        render({ scope, page, visible }) {
          if (!visible || page.kind !== "knowledge") return null
          return <div className="collaboration-page-scroll" key={JSON.stringify(scope)}>
            <LiveTeamKnowledge host={taskContext.host} scope={scope} teamName={props.workspaceName}
              ownerName={pageController.resolveOwnerName} rendering={pageController.rendering}
              revision={knowledgeRevision} refreshMetadata={refreshKnowledgeMetadata}
              canReference={references.canReference} previewFixed={references.previewFixed} />
          </div>
        },
      },
    } : {}),
  }

  const settings = <div className="desktop-settings">
    {props.settingsHead}
    <div className="desktop-settings-body">
      {props.settingsBody}
    </div>
  </div>

  return <>
    <ProjectWorkbench
      shell={shell}
      organization={props.organization}
      persistence={props.persistence}
      workspaceId={props.workspaceId}
      workspaceName={props.workspaceName}
      workspaces={props.workspaces}
      onSelectWorkspace={props.onSelectWorkspace}
      colorScheme={props.colorScheme}
      onToggleTheme={props.onToggleTheme}
      user={props.user}
      titleBarClassName={props.titleBarClassName}
      settings={settings}
      settingsOpen={props.settingsOpen}
      setSettingsOpen={props.setSettingsOpen}
      personalError={props.personalError}
      taskCount={taskCount}
      sessions={projectSessions.navigationSource}
      sessionIntegration={projectSessions.integration}
      providers={providers}
    />
    {references.dialog}
    {publishing?.scope === shell.scope && publishing?.page === currentPage && taskContext?.projectActive && <ProjectTaskPublication
      context={taskContext} members={taskMembers} draftMaterials={references.draftMaterials} sources={publicationSources}
      assigneeId={publishing.assigneeId} onClose={() => setPublishing(null)} onPublished={taskId => {
        setPublishing(null)
        openTask(taskId)
      }} />}
  </>
}

type DensityOption = "compact" | "standard" | "wide"

const readStoredPref = <T extends string>(key: string, valid: readonly T[], fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key)
    return raw && (valid as readonly string[]).includes(raw) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

const writeStoredPref = (key: string, value: string) => {
  try { window.localStorage.setItem(key, value) } catch { /* 隔离环境无 localStorage 时忽略 */ }
}

/** 宿主回传实际颜色和缩放；读取失败时可继续使用当前窗口。 */
function useWindowPreferences(host: DesktopHost) {
  const [state, setState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  const [accent, setAccentState] = useState<AccentId>(() => readStoredPref("wb.ui.accent", ACCENT_OPTIONS.map(option => option.id), DEFAULT_ACCENT))
  const [density, setDensityState] = useState<DensityOption>(() => readStoredPref("wb.ui.density", ["compact", "standard", "wide"], "standard"))
  const [error, setError] = useState("")
  const revision = useRef(0)
  useEffect(() => {
    const unsubscribe = host.onWindowStateChanged(next => {
      revision.current++
      setState(next)
    })
    const initial = revision.current
    void host.getWindowState().then(next => {
      if (revision.current === initial) setState(next)
    }).catch(() => { if (revision.current === initial) setError("无法读取窗口外观。") })
    return () => { revision.current++; unsubscribe() }
  }, [host])
  useEffect(() => { document.documentElement.dataset.theme = state.colorScheme }, [state.colorScheme])
  useEffect(() => { document.documentElement.dataset.accent = accent }, [accent])
  useEffect(() => { document.documentElement.dataset.density = density }, [density])

  async function update(request: () => Promise<WindowState>) {
    const attempt = ++revision.current
    setError("")
    try {
      const next = await request()
      if (revision.current === attempt) setState(next)
    } catch {
      if (revision.current === attempt) setError("窗口设置未成功，请重试。")
    }
  }
  return {
    state,
    accent,
    density,
    error,
    setThemeMode: (mode: ThemeMode) => update(() => host.setThemeMode(mode)),
    toggleTheme: () => update(() => host.setThemeMode(state.colorScheme === "dark" ? "light" : "dark")),
    setAccent: (next: AccentId) => { setAccentState(next); writeStoredPref("wb.ui.accent", next) },
    setDensity: (next: DensityOption) => { setDensityState(next); writeStoredPref("wb.ui.density", next) },
    adjustZoom: (action: ZoomAction) => update(() => host.adjustZoom(action)),
  }
}

function WindowPreferences({ state, accent, density, error, setThemeMode, setAccent, setDensity, adjustZoom }: Preferences) {
  const themeModes: ReadonlyArray<{ id: ThemeMode; label: string }> = [
    { id: "system", label: "跟随系统" },
    { id: "light", label: "浅色" },
    { id: "dark", label: "深色" },
  ]
  const densities: ReadonlyArray<{ id: DensityOption; label: string }> = [
    { id: "compact", label: "紧凑" },
    { id: "standard", label: "标准" },
    { id: "wide", label: "宽松" },
  ]
  return <section className="desktop-preferences" aria-label="窗口外观">
    <div className="desktop-set-row">
      <div className="desktop-set-main">
        <span className="desktop-set-label">外观主题</span>
        <span className="desktop-set-help">浅色是默认；深色单独配色，不是简单反色。</span>
      </div>
      <div className="seg" role="radiogroup" aria-label="外观主题">
        {themeModes.map(mode => (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={state.themeMode === mode.id}
            className={state.themeMode === mode.id ? "is-active" : undefined}
            onClick={() => { void setThemeMode(mode.id) }}
          >
            {mode.label}
          </button>
        ))}
      </div>
    </div>
    <div className="desktop-set-row">
      <div className="desktop-set-main">
        <span className="desktop-set-label">强调色</span>
        <span className="desktop-set-help">用于高亮激活态、徽章与主要行动按钮。</span>
      </div>
      <div className="swatch-row" role="radiogroup" aria-label="强调色">
        {ACCENT_OPTIONS.map(opt => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={accent === opt.id}
            aria-label={opt.label}
            title={opt.label}
            className={`swatch${accent === opt.id ? " is-on" : ""}`}
            onClick={() => setAccent(opt.id)}
          >
            <span className="swatch-chip" style={{ background: opt.swatch[state.colorScheme] }} aria-hidden="true" />
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
    <div className="desktop-set-row">
      <div className="desktop-set-main">
        <span className="desktop-set-label">界面密度</span>
        <span className="desktop-set-help">调节阅读间距与页面内边距。</span>
      </div>
      <div className="seg" role="radiogroup" aria-label="界面密度">
        {densities.map(item => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={density === item.id}
            className={density === item.id ? "is-active" : undefined}
            onClick={() => setDensity(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
    <div className="desktop-set-row">
      <div className="desktop-set-main">
        <span className="desktop-set-label">窗口缩放</span>
        <span className="desktop-set-help">小窗口或高分屏可用，调整工作台整体比例。</span>
      </div>
      <div className="seg desktop-zoom" role="group" aria-label="窗口缩放">
        <button type="button" aria-label="缩小" disabled={state.zoomPercent <= 80} onClick={() => { void adjustZoom("out") }}>−</button>
        <button type="button" aria-label="恢复缩放" onClick={() => { void adjustZoom("reset") }}>{state.zoomPercent}%</button>
        <button type="button" aria-label="放大" disabled={state.zoomPercent >= 150} onClick={() => { void adjustZoom("in") }}>+</button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </section>
}
