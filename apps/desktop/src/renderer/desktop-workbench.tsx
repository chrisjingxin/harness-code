/**
 * 正式窗口装配。宿主确认的身份与工作区 → 设备/项目首页 → 三栏显示。
 * 页面保存本窗口的个人选择，业务读取及本机设备操作仍走原有具名端口。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { CollaborationHost, ConversationReadHost, DesktopHost, DeviceHost, ThemeMode, WindowState, ZoomAction } from "@workbench/contracts"
import type { ProjectReadHost } from "../project-read-host.js"
import type { AccountPersonal, ConversationPersonal, PersonalHost, PersonalKey, ProjectPersonalRecord, WorkspacePersonal } from "../personal-host.js"
import {
  CollaborationNavigation, DeviceRegistrationPanel, IdentityPanel, ProjectDock, WorkbenchLayout, useCollaborationIdentity,
} from "@workbench/ui"
import type { ConversationPersonalChange, ConversationPersonalState, ConversationScope, NavigationActions, NavigationAvailability, ProjectScope } from "@workbench/ui"
import { ConversationArea } from "./conversation-area.js"
import { conversationNavigation } from "./conversation-navigation.js"
import { emptyConversationPersonal, updateConversationPersonal } from "./conversation-personal.js"
import type { HistoryProjection } from "./conversation-history.js"
import { conversationScopeKey, useConversationHistory, useWorkspaceConversations } from "./workspace-conversations.js"
import { useWorkspaceDevices } from "./workspace-devices.js"
import { ProjectCenter, useProjectScroll, useProjectTreeScroll } from "./project-center.js"
import type { ProjectScrollPositions } from "./project-center.js"
import { emptyProjectPersonal, projectScopeKey, useProjectWorkspace } from "./project-workspace.js"
import type { ProjectPersonal, ProjectSession } from "./project-workspace.js"
import { PersonalPersistence } from "./personal-persistence.js"
import "@workbench/ui/layout.css"
import "@workbench/ui/navigation.css"
import "@workbench/ui/project.css"
import "./desktop-workbench.css"

type Hosts = { host: DesktopHost; collaboration: CollaborationHost; conversations: ConversationReadHost; devices: DeviceHost; projects: ProjectReadHost; personalHost: PersonalHost }
type Side = "left" | "right"
type PersonalView = {
  search: string
  expandedDevices: readonly string[]
  expandedProjects: readonly string[]
  selectedConversationId: string | null
  panels: Record<Side, { open: boolean; width: number }>
}
const defaults: PersonalView = {
  search: "",
  expandedDevices: [],
  expandedProjects: [],
  selectedConversationId: null,
  panels: { left: { open: true, width: 280 }, right: { open: true, width: 340 } },
}
// 这些动作由导航的不可用状态隐藏或禁用，留给对应业务停点接入。
const unavailableAction = () => {}

function toggle(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]
}

/** 窗口重开后重新登录；每次身份变化都重新创建个人视图会话。 */
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

function DesktopSession({ host, collaboration, conversations, devices, projects, personalHost, identity, preferences, persistence, personalError }: Hosts & {
  identity: ReturnType<typeof useCollaborationIdentity>
  preferences: ReturnType<typeof useWindowPreferences>
  persistence: PersonalPersistence
  personalError: string
}) {
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [views, setViews] = useState<Record<string, PersonalView>>({})
  const viewsRef = useRef(views)
  const [conversationPersonal, setConversationPersonal] = useState<Record<string, ConversationPersonalState>>({})
  const conversationRef = useRef(conversationPersonal)
  const conversationLoaded = useRef(new Set<string>())
  const [projectPersonal, setProjectPersonal] = useState<Record<string, ProjectPersonal>>({})
  const projectRef = useRef(projectPersonal)
  const projectLoaded = useRef(new Set<string>())
  const projectSaveKeys = useRef(new Map<string, PersonalKey>())
  const projectScroll = useRef<ProjectScrollPositions>(new Map())
  const historyCache = useRef(new Map<string, HistoryProjection>())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const user = identity.state.status === "signedIn" ? identity.state.user : null
  const workspaces = identity.state.status === "signedIn" ? identity.state.workspaces : []
  const savedWorkspace = user ? selected[user.id] : undefined
  const workspaceId = workspaces.find(workspace => workspace.id === savedWorkspace)?.id
    ?? (workspaces.length === 1 ? workspaces[0]!.id : null)
  const scope = JSON.stringify([user?.id ?? null, workspaceId])
  const [accountReady, setAccountReady] = useState(!user)
  const [accountFailed, setAccountFailed] = useState(false)
  const [accountAttempt, setAccountAttempt] = useState(0)
  const [workspaceReady, setWorkspaceReady] = useState<string | null>(null)
  const [workspaceFailed, setWorkspaceFailed] = useState(false)
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0)
  const loadedWorkspaces = useRef(new Set<string>())

  useEffect(() => {
    if (!user) { setAccountReady(true); return }
    let current = true
    setAccountFailed(false)
    void persistence.load({ kind: "account" }).then(result => {
      if (!current) return
      if (!result.ok) { setAccountFailed(true); return }
      const saved = result.value.data as AccountPersonal | null
      if (saved?.workspaceId && workspaces.some(item => item.id === saved.workspaceId)) setSelected({ [user.id]: saved.workspaceId })
      setAccountReady(true)
    })
    return () => { current = false }
  }, [user?.id, persistence, accountAttempt])

  useEffect(() => {
    if (!accountReady || !workspaceId) { setWorkspaceReady(null); return }
    if (loadedWorkspaces.current.has(scope)) { setWorkspaceReady(scope); return }
    let current = true
    setWorkspaceReady(null)
    setWorkspaceFailed(false)
    void persistence.load({ kind: "workspace", workspaceId }).then(result => {
      if (!current) return
      if (!result.ok) { setWorkspaceFailed(true); return }
      const saved = result.value.data as WorkspacePersonal | null
      if (saved) {
        viewsRef.current = { ...viewsRef.current, [scope]: { ...defaults, ...saved, search: "" } }
        setViews(viewsRef.current)
      }
      loadedWorkspaces.current.add(scope)
      setWorkspaceReady(scope)
    })
    return () => { current = false }
  }, [accountReady, workspaceId, scope, persistence, workspaceAttempt])

  useEffect(() => {
    if (identity.state.status !== "signedIn") historyCache.current.clear()
  }, [identity.state.status])

  function updateView(update: (value: PersonalView) => PersonalView) {
    const value = update(viewsRef.current[scope] ?? defaults)
    viewsRef.current = { ...viewsRef.current, [scope]: value }
    setViews(viewsRef.current)
    if (workspaceId) {
      const { search: _search, ...saved } = value
      persistence.save({ kind: "workspace", workspaceId }, saved)
    }
  }

  function onPersonalChange(conversationScope: ConversationScope, change: ConversationPersonalChange) {
    const key = conversationScopeKey(conversationScope)
    const value = updateConversationPersonal(conversationRef.current[key] ?? emptyConversationPersonal, change)
    conversationRef.current = { ...conversationRef.current, [key]: value }
    setConversationPersonal(conversationRef.current)
    const { interactions: _interactions, ...saved } = value
    persistence.save({ kind: "conversation", workspaceId: conversationScope.workspaceId, conversationId: conversationScope.conversationId }, saved)
  }

  function resetSeenRevision(conversationScope: ConversationScope) {
    const key = conversationScopeKey(conversationScope)
    const previous = conversationRef.current[key]
    if (!previous || previous.scroll.seenContentRevision === null) return
    conversationRef.current = { ...conversationRef.current, [key]: { ...previous, scroll: { ...previous.scroll, seenContentRevision: null } } }
    setConversationPersonal(conversationRef.current)
  }

  function updateProject(scope: ProjectScope, update: (value: ProjectPersonal) => ProjectPersonal) {
    const key = projectScopeKey(scope)
    projectRef.current = { ...projectRef.current, [key]: update(projectRef.current[key] ?? emptyProjectPersonal) }
    setProjectPersonal(projectRef.current)
    saveProject(scope)
  }

  function saveProject(scope: ProjectScope) {
    const key = projectScopeKey(scope), target = projectSaveKeys.current.get(key)
    const value = projectRef.current[key]
    if (!target || !value) return
    const positions: ProjectPersonalRecord["positions"][number][] = []
    for (const [raw, position] of projectScroll.current) {
      const [scopeKey, area, path] = JSON.parse(raw) as [string, "central" | "dock" | "tree", string]
      if (scopeKey === key) positions.push({ area, path, ...position })
    }
    persistence.save(target, { personal: value, positions })
  }

  function installConversation(scope: ConversationScope, saved: ConversationPersonal | null) {
    const key = conversationScopeKey(scope)
    if (!conversationLoaded.current.has(key) && saved) {
      conversationRef.current = { ...conversationRef.current, [key]: { ...saved, scroll: { ...saved.scroll, seenContentRevision: null }, interactions: {} } }
      setConversationPersonal(conversationRef.current)
    }
    conversationLoaded.current.add(key)
  }

  function installProject(scope: ProjectScope, target: PersonalKey, saved: ProjectPersonalRecord | null) {
    const key = projectScopeKey(scope)
    projectSaveKeys.current.set(key, target)
    if (!projectLoaded.current.has(key) && saved) {
      projectRef.current = { ...projectRef.current, [key]: saved.personal }
      for (const position of saved.positions) projectScroll.current.set(JSON.stringify([key, position.area, position.path]), { top: position.top, left: position.left })
      setProjectPersonal(projectRef.current)
    }
    projectLoaded.current.add(key)
  }

  if (user && (!accountReady || (workspaceId && workspaceReady !== scope))) {
    const failed = !accountReady ? accountFailed : workspaceFailed
    return <section className="desktop-empty desktop-conversation">
      <p role={failed ? "alert" : "status"}>{failed ? personalError || "无法恢复个人视图。" : "正在恢复个人视图…"}</p>
      {failed && <>
        <button className="wb-button wb-button-secondary" onClick={() => {
          if (!accountReady) setAccountAttempt(value => value + 1)
          else setWorkspaceAttempt(value => value + 1)
        }}>重试</button>
        <button className="wb-button wb-button-quiet" onClick={() => { void identity.signOut() }}>退出</button>
      </>}
    </section>
  }
  return <WorkspaceWorkbench
    key={scope}
    host={host}
    collaboration={collaboration}
    conversations={conversations}
    devices={devices}
    projects={projects}
    personalHost={personalHost}
    identity={identity}
    preferences={preferences}
    workspaceId={workspaceId}
    personal={views[scope] ?? defaults}
    conversationPersonal={conversationPersonal}
    projectPersonal={projectPersonal}
    projectScroll={projectScroll.current}
    updateProject={updateProject}
    saveProject={saveProject}
    persistence={persistence}
    personalError={personalError}
    conversationLoaded={conversationLoaded.current}
    installConversation={installConversation}
    installProject={installProject}
    historyCache={historyCache.current}
    onPersonalChange={onPersonalChange}
    resetSeenRevision={resetSeenRevision}
    updateView={updateView}
    selectWorkspace={id => {
      if (user && workspaces.some(workspace => workspace.id === id)) {
        setSelected(current => ({ ...current, [user.id]: id }))
        persistence.save({ kind: "account" }, { workspaceId: id })
      }
    }}
    settingsOpen={settingsOpen}
    setSettingsOpen={setSettingsOpen}
  />
}

type WorkspaceProps = Hosts & {
  identity: ReturnType<typeof useCollaborationIdentity>
  preferences: ReturnType<typeof useWindowPreferences>
  workspaceId: string | null
  personal: PersonalView
  conversationPersonal: Record<string, ConversationPersonalState>
  projectPersonal: Record<string, ProjectPersonal>
  projectScroll: ProjectScrollPositions
  updateProject(scope: ProjectScope, update: (value: ProjectPersonal) => ProjectPersonal): void
  saveProject(scope: ProjectScope): void
  persistence: PersonalPersistence
  personalError: string
  conversationLoaded: Set<string>
  installConversation(scope: ConversationScope, saved: ConversationPersonal | null): void
  installProject(scope: ProjectScope, target: PersonalKey, saved: ProjectPersonalRecord | null): void
  historyCache: Map<string, HistoryProjection>
  onPersonalChange(scope: ConversationScope, change: ConversationPersonalChange): void
  resetSeenRevision(scope: ConversationScope): void
  updateView(update: (value: PersonalView) => PersonalView): void
  selectWorkspace(id: string): void
  settingsOpen: boolean
  setSettingsOpen(open: boolean): void
}

function WorkspaceWorkbench(props: WorkspaceProps) {
  const { host, collaboration, conversations, devices, projects, identity, workspaceId, personal, updateView, settingsOpen, setSettingsOpen } = props
  const data = useWorkspaceDevices(devices, workspaceId, personal.expandedDevices)
  const shared = useWorkspaceConversations(conversations, workspaceId)
  const signedIn = identity.state.status === "signedIn" ? identity.state : null
  const conversationScope: ConversationScope | null = signedIn && workspaceId && personal.selectedConversationId && shared.availability.state !== "denied"
    ? { namespace: "desktop-window", accountId: signedIn.user.id, workspaceId, conversationId: personal.selectedConversationId }
    : null
  const history = useConversationHistory(conversations, conversationScope, props.historyCache, props.resetSeenRevision)
  useEffect(() => {
    if (shared.availability.state !== "denied" || !signedIn || !workspaceId) return
    for (const key of props.historyCache.keys()) {
      const [namespace, accountId, savedWorkspace] = JSON.parse(key) as string[]
      if (namespace === "desktop-window" && accountId === signedIn.user.id && savedWorkspace === workspaceId) props.historyCache.delete(key)
    }
  }, [shared.availability.state, signedIn?.user.id, workspaceId, props.historyCache])
  const selectedConversation = history.view.phase === "ready" ? history.view.conversation : null
  const projectSession: ProjectSession | null = signedIn && workspaceId && selectedConversation
    ? { scope: { namespace: "desktop-window", accountId: signedIn.user.id, workspaceId,
      deviceId: selectedConversation.deviceId, projectId: selectedConversation.projectId }, conversationId: selectedConversation.conversationId } : null
  const projectPersonal = projectSession ? props.projectPersonal[projectScopeKey(projectSession.scope)] ?? emptyProjectPersonal : emptyProjectPersonal
  const project = useProjectWorkspace(projects, projectSession, projectPersonal, props.updateProject)
  const propsRef = useRef(props); propsRef.current = props
  const [conversationRestore, setConversationRestore] = useState<{ key: string; ok: boolean } | null>(null)
  const [projectRestore, setProjectRestore] = useState<{ key: string; ok: boolean } | null>(null)
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const conversationKey = conversationScope ? conversationScopeKey(conversationScope) : null
  const projectKey = projectSession ? JSON.stringify([projectScopeKey(projectSession.scope), projectSession.conversationId]) : null
  useEffect(() => {
    if (!conversationScope || !conversationKey || history.view.phase !== "ready") return
    if (propsRef.current.conversationLoaded.has(conversationKey)) { setConversationRestore({ key: conversationKey, ok: true }); return }
    let current = true
    const scope = conversationScope
    void props.persistence.load({ kind: "conversation", workspaceId: scope.workspaceId, conversationId: scope.conversationId }).then(result => {
      if (!current) return
      if (result.ok) propsRef.current.installConversation(scope, result.value.data as ConversationPersonal | null)
      setConversationRestore({ key: conversationKey, ok: result.ok })
    })
    return () => { current = false }
  }, [conversationKey, history.view.phase, props.persistence, restoreAttempt])
  useEffect(() => {
    if (!projectSession || !projectKey) return
    let current = true
    const session = projectSession
    const target = { kind: "project" as const, workspaceId: session.scope.workspaceId, conversationId: session.conversationId }
    void props.persistence.load(target).then(result => {
      if (!current) return
      const matches = result.ok && result.value.project?.deviceId === session.scope.deviceId && result.value.project.projectId === session.scope.projectId
      if (matches && result.ok) propsRef.current.installProject(session.scope, target, result.value.data as ProjectPersonalRecord | null)
      setProjectRestore({ key: projectKey, ok: Boolean(matches) })
    })
    return () => { current = false }
  }, [projectKey, props.persistence, restoreAttempt])
  useEffect(() => {
    if (projectKey && projectRestore?.key === projectKey && projectRestore.ok) project.retry()
  }, [projectKey, projectRestore])
  const conversationRestored = !conversationKey || (conversationRestore?.key === conversationKey && conversationRestore.ok)
  const projectRestored = Boolean(projectKey && projectRestore?.key === projectKey && projectRestore.ok)
  const conversationRestoreFailed = conversationKey && conversationRestore?.key === conversationKey && !conversationRestore.ok
  const projectRestoreFailed = projectKey && projectRestore?.key === projectKey && !projectRestore.ok
  const selectedDeviceId = selectedConversation?.deviceId
  const selectedProjects = selectedDeviceId ? data.projects[selectedDeviceId] : undefined
  useEffect(() => {
    if (selectedDeviceId && !selectedProjects && data.devices.rows.some(device => device.deviceId === selectedDeviceId)) {
      void data.loadProjects(selectedDeviceId)
    }
  }, [selectedDeviceId, selectedProjects, data.devices.rows, data.loadProjects])
  const status = identity.state.status
  const waiting = status === "loading" ? "正在确认账号。"
    : status === "connectionError" ? identity.state.error.message
    : !signedIn ? "登录后查看工作区设备和项目。"
    : signedIn.workspaces.length ? "请先选择工作区。" : "当前账号未加入工作区。"
  let deviceAvailability: NavigationAvailability = workspaceId ? data.devices.availability
    : { state: status === "loading" ? "loading" as const : "unavailable" as const, message: waiting }
  const sharedAvailability: NavigationAvailability = workspaceId ? shared.availability
    : { state: status === "loading" ? "loading" : "unavailable", message: waiting }
  const visibleConversations = selectedConversation && !shared.rows.some(item => item.conversationId === selectedConversation.conversationId)
    ? [selectedConversation, ...shared.rows] : shared.rows
  // 即使设备列表不可读，会话摘要中已有的原目标仍可供导航定位。
  if (deviceAvailability.state === "denied" && visibleConversations.length) {
    deviceAvailability = { state: "unavailable", message: deviceAvailability.message }
  }
  const navigationDevices = conversationNavigation({
    devices: data.devices.rows,
    projects: data.projects,
    conversations: visibleConversations,
    availability: sharedAvailability,
    expandedDevices: personal.expandedDevices,
    expandedProjects: personal.expandedProjects,
  })
  const selectedDevice = selectedDeviceId ? navigationDevices.find(device => device.id === selectedDeviceId) : undefined
  const selectedProject = selectedConversation ? selectedDevice?.projects.find(project => project.id === selectedConversation.projectId) : undefined
  const actions: NavigationActions = {
    selectWorkspace: props.selectWorkspace,
    toggleDevice: id => updateView(value => ({ ...value, expandedDevices: toggle(value.expandedDevices, id) })),
    toggleProject: (deviceId, projectId) => updateView(value => ({
      ...value, expandedProjects: toggle(value.expandedProjects, JSON.stringify([deviceId, projectId])),
    })),
    setSearch: search => updateView(value => ({ ...value, search })),
    retry: scope => {
      if (scope.kind === "devices") void data.loadDevices()
      if (scope.kind === "projects" && scope.deviceId) void data.loadProjects(scope.deviceId)
      if (scope.kind === "shared" || scope.kind === "conversations") shared.refresh()
    },
    signIn: () => setSettingsOpen(true),
    signOut: () => { void identity.signOut() },
    openSettings: () => setSettingsOpen(true),
    createConversation: unavailableAction,
    selectConversation: id => {
      if (visibleConversations.some(conversation => conversation.conversationId === id)) {
        updateView(value => ({ ...value, selectedConversationId: id }))
      }
    },
    loadMore: scope => { if (scope.kind === "shared" || scope.kind === "conversations") shared.loadMore() },
    openPendingHandoffs: unavailableAction,
  }
  const local = data.local.state
  // 本机摘要没有工作区 ID。设备首页或项目列表都可确认当前账号的设备归属。
  const localProjects = local?.deviceId ? data.projects[local.deviceId] : undefined
  const localInWorkspace = !local?.deviceId || data.devices.rows.some(device =>
    device.deviceId === local.deviceId && device.ownerUserId === signedIn?.user.id)
    || localProjects?.availability.state === "ready"
  const localBlocked = data.local.message ?? (!local ? "正在确认本机设备状态。"
    : !localInWorkspace ? data.devices.availability.state === "offline"
      ? data.devices.availability.message ?? "无法确认本机设备，请重试。"
      : localProjects?.availability.state === "offline"
        ? localProjects.availability.message ?? "无法确认本机设备，请重试。"
        : data.devices.availability.state === "loading" || (data.devices.partial && (!localProjects || localProjects.availability.state === "loading"))
        ? "正在确认本机设备所属工作区。"
        : "当前工作区未确认本机设备登记。" : undefined)
  const partial = data.devices.partial || Object.values(data.projects).some(page => page?.partial)
  const nativeTitleBar = navigator.platform.startsWith("Mac") ? " desktop-titlebar-macos"
    : navigator.platform.startsWith("Win") ? " desktop-titlebar-windows" : ""

  function updatePanel(side: Side, patch: Partial<PersonalView["panels"][Side]>) {
    if (side === "right" && projectSession && projectRestored) {
      props.updateProject(projectSession.scope, value => ({ ...value, view: { ...value.view,
        ...(patch.open === undefined ? {} : { dockOpen: patch.open }),
        ...(patch.width === undefined ? {} : { dockWidthPx: patch.width }) } }))
      return
    }
    updateView(value => ({ ...value, panels: { ...value.panels, [side]: { ...value.panels[side], ...patch } } }))
  }

  return <WorkbenchLayout
    titleBarClassName={"desktop-titlebar" + nativeTitleBar}
    context={selectedConversation ? {
      title: selectedConversation.title,
      deviceName: selectedDevice?.name ?? `设备 ${selectedConversation.deviceId}`,
      projectName: selectedProject?.name ?? `项目 ${selectedConversation.projectId}`,
      connection: selectedDevice?.connection,
    } : { title: "协作工作台" }}
    navigation={<div className="desktop-navigation">
      <CollaborationNavigation view={{
        namespace: "desktop-window",
        accountId: signedIn?.user.id ?? "",
        accountName: signedIn?.user.displayName ?? null,
        workspaceId,
        workspaces: signedIn?.workspaces ?? [],
        devices: navigationDevices,
        devicesAvailability: deviceAvailability,
        shared: visibleConversations.map(item => ({
          id: item.conversationId, title: item.title, deviceId: item.deviceId, projectId: item.projectId,
        })),
        sharedAvailability,
        pending: { state: "unavailable", message: "待接手尚未接入。" },
        selectedConversationId: personal.selectedConversationId,
        search: personal.search,
        create: { enabled: false, reason: "新建会话尚未接入。" },
      }} actions={actions} />
      {partial && <p className="desktop-navigation-note" role="status">只显示已加载的首页，还有更多设备或项目。</p>}
      {props.personalError && <div className="desktop-navigation-note" role="alert">{props.personalError}{" "}
        <button className="wb-button wb-button-small wb-button-quiet" onClick={() => { void props.persistence.flush() }}>重试保存</button>
      </div>}
    </div>}
    center={workspaceId && shared.availability.state === "denied"
      ? <section className="desktop-empty desktop-conversation" aria-label="对话"><p role="alert">{shared.availability.message}</p></section>
      : workspaceId ? !conversationRestored && history.view.phase === "ready" ? <section className="desktop-empty desktop-conversation" aria-label="对话">
          <p role={conversationRestoreFailed ? "alert" : "status"}>{conversationRestoreFailed ? "无法恢复会话个人视图。" : "正在恢复会话个人视图…"}</p>
          {conversationRestoreFailed && <button className="wb-button wb-button-secondary" onClick={() => setRestoreAttempt(value => value + 1)}>重试</button>}
        </section> : projectSession && projectRestored ? <ProjectCenter scope={projectSession.scope} personal={projectPersonal} files={project.data.files}
          gates={project.gates} actions={project.actions} updatePersonal={props.updateProject} scrollPositions={props.projectScroll} onPositionChanged={props.saveProject}
          permitted={project.data.availability.state === "available" || project.data.availability.state === "offline"}>
          {visible => <ConversationArea scope={conversationScope} view={history.view} visible={visible}
            projectActions={{ onRequestFileCandidates: project.candidates, onOpenFile: (scope, target, path, destination) => {
              if (project.openFromConversation(scope, target, path, destination) && destination === "preview") updatePanel("right", { open: true })
            } }}
            personal={conversationScope ? props.conversationPersonal[conversationScopeKey(conversationScope)] ?? emptyConversationPersonal : emptyConversationPersonal}
            onPersonalChange={props.onPersonalChange} refresh={history.refresh} host={host} />}
        </ProjectCenter> : <ConversationArea scope={conversationScope} view={history.view} visible
          personal={conversationScope ? props.conversationPersonal[conversationScopeKey(conversationScope)] ?? emptyConversationPersonal : emptyConversationPersonal}
          onPersonalChange={props.onPersonalChange} refresh={history.refresh} host={host} />
      : <section className="desktop-empty desktop-conversation" aria-label="对话">
          <h1>对话</h1>
          <p>{waiting}</p>
          {!signedIn && status !== "loading" && <button className="wb-button wb-button-primary" onClick={actions.signIn}>{status === "connectionError" ? "查看连接" : "演示登录"}</button>}
          {!settingsOpen && identity.notice && <p className="error" role="alert">{identity.notice}</p>}
        </section>}
    right={slot => projectSession && projectRestored ? <ProjectDockArea scope={projectSession.scope} projectName={selectedProject?.name ?? `项目 ${projectSession.scope.projectId}`}
      project={project} personal={projectPersonal} slot={slot} scrollPositions={props.projectScroll} onPositionChanged={props.saveProject} /> : <section className="desktop-empty desktop-project" aria-label="项目">
      <header><h2>文件与变更</h2><button className="wb-button wb-button-small wb-button-quiet" aria-label="关闭项目面板" onClick={() => slot.setOpen(false)}>关闭</button></header>
      <p>{!projectSession ? "选定会话后可查看它绑定的项目。" : projectRestoreFailed ? "无法确认原项目或恢复个人视图。" : "正在确认原项目并恢复个人视图…"}</p>
      {projectRestoreFailed && <button className="wb-button wb-button-secondary" onClick={() => setRestoreAttempt(value => value + 1)}>重试</button>}
    </section>}
    leftOpen={personal.panels.left.open}
    leftWidthPx={personal.panels.left.width}
    rightOpen={projectSession && projectRestored ? projectPersonal.view.dockOpen : personal.panels.right.open}
    rightWidthPx={projectSession && projectRestored ? projectPersonal.view.dockWidthPx : personal.panels.right.width}
    setPanelOpen={(side, open) => updatePanel(side, { open })}
    setPanelWidth={(side, width) => updatePanel(side, { width })}
    settingsOpen={settingsOpen}
    closeSettings={() => setSettingsOpen(false)}
    settings={<div className="desktop-settings">
      <h2>设置</h2>
      <WindowPreferences {...props.preferences} />
      <IdentityPanel host={collaboration} identity={identity} workspaceId={workspaceId} />
      <DeviceRegistrationPanel host={devices} workspaceId={workspaceId} device={localInWorkspace ? local : null} blockedReason={localBlocked} onChanged={data.refresh} />
    </div>}
  />
}

function ProjectDockArea({ scope, projectName, project, personal, slot, scrollPositions, onPositionChanged }: {
  scope: ProjectScope
  projectName: string
  project: ReturnType<typeof useProjectWorkspace>
  personal: ProjectPersonal
  slot: { open: boolean; widthPx: number; setOpen(open: boolean): void; setWidth(width: number): void }
  scrollPositions: ProjectScrollPositions
  onPositionChanged(scope: ProjectScope): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const onScroll = useProjectScroll(root, scope, "dock", personal.view.activeFilePath, project.data.files, scrollPositions, onPositionChanged)
  const treeReady = project.tree.status === "ready" && personal.expanded.every(path => {
    const directory = project.data.directories[path]
    return directory && directory.status !== "loading"
  })
  const onTreeScroll = useProjectTreeScroll(root, scope, treeReady, scrollPositions, onPositionChanged)
  return <div className="desktop-project-dock" ref={root} onScrollCapture={event => { onScroll(event); onTreeScroll(event) }}>
    {project.data.availability.state !== "available" && <button className="wb-button wb-button-small wb-button-secondary desktop-project-retry"
      onClick={project.retry}>重新确认项目</button>}
    <ProjectDock scope={scope} projectName={projectName} availability={project.data.availability} tree={project.tree}
      files={project.data.files} changes={project.data.changes} gates={project.gates}
      personal={{ ...personal.view, dockOpen: slot.open, dockWidthPx: slot.widthPx }}
      actions={{ ...project.actions, setDockOpen: (_scope, open) => slot.setOpen(open), setDockWidth: (_scope, width) => slot.setWidth(width) }} />
  </div>
}

/** 宿主回传实际颜色和缩放；读取失败时可继续使用当前窗口。 */
function useWindowPreferences(host: DesktopHost) {
  const [state, setState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
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
    error,
    setThemeMode: (mode: ThemeMode) => update(() => host.setThemeMode(mode)),
    adjustZoom: (action: ZoomAction) => update(() => host.adjustZoom(action)),
  }
}

function WindowPreferences({ state, error, setThemeMode, adjustZoom }: ReturnType<typeof useWindowPreferences>) {
  return <section className="desktop-preferences" aria-label="窗口外观">
    <label>外观<select aria-label="外观" value={state.themeMode} onChange={event => {
      const mode = event.target.value as ThemeMode
      void setThemeMode(mode)
    }}>
      <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
    </select></label>
    <div className="desktop-zoom" aria-label="窗口缩放">
      <span>窗口缩放</span>
      <button className="wb-button wb-button-secondary wb-button-small" aria-label="缩小" disabled={state.zoomPercent <= 80} onClick={() => { void adjustZoom("out") }}>−</button>
      <button className="wb-button wb-button-secondary wb-button-small" aria-label="恢复缩放" onClick={() => { void adjustZoom("reset") }}>{state.zoomPercent}%</button>
      <button className="wb-button wb-button-secondary wb-button-small" aria-label="放大" disabled={state.zoomPercent >= 150} onClick={() => { void adjustZoom("in") }}>+</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </section>
}
