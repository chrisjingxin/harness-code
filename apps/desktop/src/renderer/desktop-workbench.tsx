/**
 * 正式窗口装配：宿主确认的身份 → 恢复账号记录并确定团队 → Project 外壳与会话协调器。
 * 个人记录按身份重新创建，退出前先保存；业务读取只走 preload 暴露的具名端口。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type {
  CollaborationHost,
  DesktopHost,
  DeviceHost,
  LocalDirectoryHost,
  ProjectConversationHost,
  ThemeMode,
  UserSummary,
  WindowState,
  ZoomAction,
} from "@workbench/contracts"
import type { AccountPersonal, PersonalHost } from "../personal-host.js"
import type { OrganizationHost } from "../organization-host.js"
import { DeviceRegistrationPanel, IdentityPanel, ProjectNavigation, WorkbenchLayout, useCollaborationIdentity } from "@workbench/ui"
import { ProjectWorkbench, useProjectShell } from "./features/project-navigation/index.js"
import type { ProjectPageProviders } from "./features/project-navigation/index.js"
import { useProjectSessions } from "./features/session/index.js"
import { useLocalDevice } from "./local-device.js"
import { PersonalPersistence } from "./personal-persistence.js"
import { resolveUserPhoto } from "./demo-avatars.js"
import "@workbench/ui/layout.css"
import "@workbench/ui/navigation.css"
import "@workbench/ui/conversation.css"
import "./desktop-workbench.css"

type Hosts = {
  host: DesktopHost
  collaboration: CollaborationHost
  devices: DeviceHost
  organization: OrganizationHost
  projectConversations: ProjectConversationHost
  localDirectory?: LocalDirectoryHost
  personalHost: PersonalHost
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

  const baseSettings = <>
    <h2>设置</h2>
    <WindowPreferences {...props.preferences} />
    <IdentityPanel host={props.collaboration} identity={identity} workspaceId={workspace?.id ?? null} />
  </>

  if (signedIn && account === "ready" && workspace) {
    return <WorkspaceProjectWorkbench
      key={workspace.id}
      host={props.host}
      organization={props.organization}
      collaboration={props.collaboration}
      devices={props.devices}
      projectConversations={props.projectConversations}
      localDirectory={props.localDirectory}
      persistence={persistence}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
      user={signedIn.user}
      titleBarClassName={titleBarClassName}
      baseSettings={baseSettings}
      settingsOpen={settingsOpen}
      setSettingsOpen={setSettingsOpen}
      personalError={props.personalError}
    />
  }

  const settings = <div className="desktop-settings">
    {baseSettings}
    <DeviceRegistrationPanel host={props.devices} workspaceId={null} device={null} />
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
    navigation={<div className="desktop-navigation">
      <ProjectNavigation view={{
        accountName: signedIn?.user.userName ?? null, accountPhoto: resolveUserPhoto(signedIn?.user), workspaceName: null, projects: [],
        projectsAvailability: { state: status === "loading" ? "loading" : "unavailable", message },
        currentProjectId: null, groups: [], membersAvailability: { state: "unavailable" }, sessionsAvailability: { state: "unavailable" },
        search: "", activePage: null, selectedConversationId: null, taskCount: null,
      }} actions={{
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
        {workspaces.map(item => <button key={item.id} className="wb-button wb-button-secondary" onClick={() => {
          setChosen(item.id)
          persistence.save({ kind: "account" }, { workspaceId: item.id })
        }}>{item.name}</button>)}
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
  devices: DeviceHost
  projectConversations: ProjectConversationHost
  localDirectory?: LocalDirectoryHost
  persistence: PersonalPersistence
  workspaceId: string
  workspaceName: string
  user: UserSummary
  titleBarClassName: string
  baseSettings: React.ReactNode
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
  const localDevice = useLocalDevice(props.devices, props.workspaceId, props.user.id)
  const validLocalDevice = localDevice.device?.deviceId
    ? localDevice.devices.find(
        item => item.deviceId === localDevice.device?.deviceId && item.ownerUserId === props.user.id && item.revokedAt === null,
      ) ?? null
    : null
  const currentProject = shell.projects.projects.find(item => item.projectId === shell.projectId)
  const selectedConversationId = shell.personal.page.kind === "conversation"
    ? shell.personal.page.conversationId
    : null

  const projectSessions = useProjectSessions({
    host: props.host,
    projectConversations: props.projectConversations,
    localDirectory: props.localDirectory,
    persistence: props.persistence,
    scope: shell.scope,
    projectName: currentProject?.name ?? "当前项目",
    userId: props.user.id,
    localDeviceId: validLocalDevice?.deviceId ?? null,
    ...(validLocalDevice?.name ? { localDeviceName: validLocalDevice.name } : {}),
    ...(localDevice.blockedReason ? { localDeviceBlockedReason: localDevice.blockedReason } : {}),
    members: shell.team.members,
    devices: localDevice.devices,
    selectedConversationId,
    onOpenConversation: conversation => {
      shell.locateConversation(conversation.conversationId, [
        {
          conversationId: conversation.conversationId,
          ownerUserId: conversation.ownerUserId,
          title: conversation.title,
          timeLabel: "刚刚",
          badge: { text: "本机", tone: "neutral" },
        },
      ])
    },
    onOpenNewSessionPage: () => {
      shell.openPage({ kind: "new" })
    },
  })

  // HC-219～220 交付后在此接入任务、引用与看板页面提供者，并消费 `projectSessions.integration`；未交付模块保持未接入。
  void projectSessions.integration
  const taskCount: number | null = null
  const providers: ProjectPageProviders = {
    session: projectSessions.provider,
  }

  const settings = <div className="desktop-settings">
    {props.baseSettings}
    <DeviceRegistrationPanel
      host={props.devices}
      workspaceId={props.workspaceId}
      device={localDevice.device}
      devices={localDevice.devices}
      blockedReason={localDevice.blockedReason}
      onChanged={localDevice.refresh}
    />
  </div>

  return <ProjectWorkbench
    shell={shell}
    organization={props.organization}
    persistence={props.persistence}
    workspaceId={props.workspaceId}
    workspaceName={props.workspaceName}
    user={props.user}
    titleBarClassName={props.titleBarClassName}
    settings={settings}
    settingsOpen={props.settingsOpen}
    setSettingsOpen={props.setSettingsOpen}
    personalError={props.personalError}
    sessions={projectSessions.navigationSource}
    taskCount={taskCount}
    providers={providers}
  />
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

function WindowPreferences({ state, error, setThemeMode, adjustZoom }: Preferences) {
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
