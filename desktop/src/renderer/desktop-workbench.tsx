/**
 * 正式窗口装配（HC-239 个人优先与双轨协同）：
 * 1. 登录即用与断网续用：已确认账号（含断网只读快照 `lastKnownUser`）立即进入双轨工作台，不再要求先入团或保持在线；
 * 2. 左栏遵循方案 B「个人 | 团队」双轨隔离导航，「个人」空间严格按当前选中团队过滤，绝不展示跨团队全部会话；
 * 3. 支持个人会话（含无团队会话）两档发布到 Project、发布/停止共享自动切轨且不断链、以及离线非阻塞重连提示。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { IconArrowLeft, IconRefresh, IconWifiOff } from "@tabler/icons-react"
import type { CollaborationHost, UserSummary } from "@workbench/collaboration-client/types"
import type {
  AccountPersonal,
  CollaborationAppsHost,
  DesktopHost,
  DesktopLocalExecutionHost,
  LocalConversationsHost,
  LocalDirectoryHost,
  OrganizationHost,
  PersonalHost,
  ProjectConversationHost,
  ProjectUpdatesHost,
  ThemeMode,
  WindowState,
  ZoomAction,
} from "../shared/index.js"
import { ACCENT_OPTIONS, DEFAULT_ACCENT, IdentityPanel, ProjectNavigation, WorkbenchLayout, useCollaborationIdentity } from "../ui/index.js"
import type { AccentId, NavigationSpaceKind, NavigationWorkspaceItem } from "../ui/index.js"
import { ProjectWorkbench, useProjectShell } from "./features/project-navigation/index.js"
import type { DualTrackNavigationProps, ProjectPageProviders } from "./features/project-navigation/index.js"
import { LocalSessionPage, createSessionPageProvider, useProjectSessions } from "./features/session/index.js"
import type { LocalSessionExecutionPort, ProjectConversationSummary } from "./features/session/index.js"
import {
  PersonalNewSessionPage,
  PublishConversationDialog,
  SessionMetaHeader,
  StopSharingDialog,
  usePersonalSessions,
} from "./features/personal-sessions/index.js"
import { directoryBasename, formatShortTime } from "./features/session/session-model.js"
import { createCollaborationPageProviders } from "./features/collaboration/collaboration-pages.js"
import { useCollaborationMetadata } from "./features/collaboration/metadata.js"
import { LiveProjectTasks, ProjectTaskPublication, useProjectTaskMetadata } from "./features/collaboration/tasks/live-project-tasks.js"
import type { TasksContext } from "./features/collaboration/tasks/live-project-tasks.js"
import { LiveTeamKnowledge, useWorkspaceKnowledgeMetadata } from "./features/collaboration/knowledge/live-team-knowledge.js"
import { createBoardPageProvider } from "./features/board/board-provider.js"
import { useProjectBoard } from "./features/board/use-project-board.js"
import { useProjectUpdates, shouldRefreshTaskDetail } from "./features/project-updates/use-project-updates.js"
import { useWorkbenchReferences } from "./features/collaboration/references/workbench-references.js"
import type { ReferenceActions } from "./features/collaboration/references/conversation-references.js"
import { PersonalPersistence } from "./personal-persistence.js"
import { resolveUserPhoto } from "./demo-avatars.js"
import "../ui/layout/layout.css"
import "../ui/navigation/navigation.css"
import "../ui/conversation/conversation.css"
import "./features/personal-sessions/personal-sessions.css"
import "./desktop-workbench.css"

type Hosts = {
  host: DesktopHost
  collaboration: CollaborationHost
  collaborationApps?: CollaborationAppsHost
  projectUpdates?: ProjectUpdatesHost
  organization: OrganizationHost
  projectConversations: ProjectConversationHost
  localConversations?: LocalConversationsHost
  localDirectory?: LocalDirectoryHost
  localExecution?: DesktopLocalExecutionHost
  personalHost: PersonalHost
  referenceSnapshots?: ReferenceActions["readSnapshot"]
  execution?: LocalSessionExecutionPort
}
type Identity = ReturnType<typeof useCollaborationIdentity>
type Preferences = ReturnType<typeof useWindowPreferences>

type PendingReveal = {
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
  readonly token: number
}

const noop = () => {}
const fallbackExecutionPort: LocalSessionExecutionPort = {
  getAvailability: () => ({ available: false, reason: "本机 Agent 运行宿主尚未就绪。" }),
}

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
  const guardedIdentity = {
    ...identity,
    signOut: async () => {
      try { await persistence.flush() } catch { /* 退出前尽力落盘，保存失败不阻断账号退出。 */ }
      persistence.reset()
      await identity.signOut()
    },
  }
  return <DesktopSession key={identityKey} {...hosts} identity={guardedIdentity} preferences={preferences}
    persistence={persistence} personalError={personalError} />
}

function DesktopSession(props: Hosts & { identity: Identity; preferences: Preferences; persistence: PersonalPersistence; personalError: string }) {
  const { identity, persistence } = props
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [activeSpace, setActiveSpace] = useState<NavigationSpaceKind>("personal")
  const [account, setAccount] = useState<"loading" | "ready" | "failed">("loading")
  const [attempt, setAttempt] = useState(0)
  const [knownWorkspaces, setKnownWorkspaces] = useState<readonly { id: string; name: string }[]>([])

  const signedIn = identity.state.status === "signedIn" ? identity.state : null
  const offlineUser = identity.state.status === "connectionError" ? identity.state.lastKnownUser ?? null : null
  const activeUser = signedIn?.user ?? offlineUser
  const isOffline = Boolean(offlineUser && !signedIn)

  useEffect(() => {
    if (signedIn?.workspaces) {
      setKnownWorkspaces(signedIn.workspaces)
    }
  }, [signedIn?.workspaces])

  const workspaces = signedIn?.workspaces ?? (offlineUser ? knownWorkspaces : [])
  const workspace = workspaces.find(item => item.id === chosen) ?? workspaces[0] ?? null

  useEffect(() => {
    if (!activeUser) return
    let current = true
    setAccount("loading")
    void persistence.load({ kind: "account" }).then(result => {
      if (!current) return
      if (!result.ok) { setAccount("failed"); return }
      const saved = result.value.data as AccountPersonal | null
      if (saved?.workspaceId) setChosen(saved.workspaceId)
      if (saved?.activeView === "workspace") setActiveSpace("team")
      else if (saved?.activeView === "solo") setActiveSpace("personal")
      setAccount("ready")
    })
    return () => { current = false }
  }, [activeUser?.id, persistence, attempt])

  const titleBarClassName = "desktop-titlebar" + (navigator.platform.startsWith("Mac") ? " desktop-titlebar-macos"
    : navigator.platform.startsWith("Win") ? " desktop-titlebar-windows" : "")

  const saveAccountPrefs = (workspaceId: string | null, space: NavigationSpaceKind) => {
    persistence.save({ kind: "account" }, {
      workspaceId,
      activeView: space === "team" ? "workspace" : "solo",
    })
  }

  const selectWorkspace = (workspaceId: string) => {
    setChosen(workspaceId)
    saveAccountPrefs(workspaceId, activeSpace)
  }

  const selectSpace = (space: NavigationSpaceKind) => {
    setActiveSpace(space)
    saveAccountPrefs(workspace?.id ?? chosen, space)
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

  if (activeUser && account === "ready") {
    return (
      <ConfirmedUserWorkbench
        {...props}
        user={activeUser}
        workspaces={workspaces}
        workspace={workspace}
        activeSpace={activeSpace}
        isOffline={isOffline}
        onSelectWorkspace={selectWorkspace}
        onSelectSpace={selectSpace}
        titleBarClassName={titleBarClassName}
        settingsHead={settingsHead}
        settingsBody={settingsBody}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
      />
    )
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
    : !activeUser ? "请先登录演示账号，立即在本机开始对话或协作。"
    : account === "failed" ? props.personalError || "无法恢复个人视图。"
    : "正在恢复个人视图…"

  return <WorkbenchLayout
    titleBarClassName={titleBarClassName}
    context={{ title: "协作工作台" }}
    colorScheme={props.preferences.state.colorScheme}
    onToggleTheme={props.preferences.toggleTheme}
    navigation={<div className="desktop-navigation">
      <ProjectNavigation view={{
        accountName: activeUser?.userName ?? null, accountPhoto: resolveUserPhoto(activeUser ?? undefined),
        workspaceName: null, workspaces: [], projects: [],
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
      {!activeUser && status !== "loading" && (
        <button className="wb-button wb-button-primary" onClick={() => setSettingsOpen(true)}>
          {status === "connectionError" ? "查看连接" : "演示登录"}
        </button>
      )}
      {activeUser && account === "failed" && (
        <button className="wb-button wb-button-secondary" onClick={() => setAttempt(value => value + 1)}>重试</button>
      )}
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

function ConfirmedUserWorkbench(props: Hosts & {
  identity: Identity
  preferences: Preferences
  persistence: PersonalPersistence
  personalError: string
  user: UserSummary
  workspaces: readonly { id: string; name: string }[]
  workspace: { id: string; name: string } | null
  activeSpace: NavigationSpaceKind
  isOffline: boolean
  onSelectWorkspace: (workspaceId: string) => void
  onSelectSpace: (space: NavigationSpaceKind) => void
  titleBarClassName: string
  settingsHead: ReactNode
  settingsBody: ReactNode
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}) {
  const { user, workspaces, workspace, activeSpace, isOffline } = props
  const [personalSearch, setPersonalSearch] = useState("")
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftWidthPx, setLeftWidthPx] = useState(280)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightWidthPx, setRightWidthPx] = useState(340)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (activeSpace === "team" && !isOffline && workspace) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault()
        setLeftOpen(prev => !prev)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [activeSpace, isOffline, workspace])

  const personalSessions = usePersonalSessions({
    host: props.host,
    localConversations: props.localConversations,
    localDirectory: props.localDirectory,
    localExecution: props.localExecution,
    projectConversations: props.projectConversations,
    persistence: props.persistence,
    user,
    activeSpace,
    offline: isOffline,
    onPublished: result => {
      props.onSelectWorkspace(result.workspaceId)
      props.onSelectSpace("team")
      setPendingReveal({
        workspaceId: result.workspaceId,
        projectId: result.projectId,
        conversationId: result.conversationId,
        token: Date.now(),
      })
    },
    onStoppedSharing: result => {
      if (result.workspaceId !== null) {
        props.onSelectWorkspace(result.workspaceId)
      }
      props.onSelectSpace("personal")
    },
    onOpenRightPanel: () => setRightOpen(true),
    onNotify: msg => setToast(msg),
  })

  const personalPartition = personalSessions.personalPartition

  const personalNavGroups = useMemo(
    () => personalPartition.groups.map(group => ({
      directoryKey: group.directoryKey,
      directoryPath: group.directoryPath,
      label: group.label,
      records: group.records.map(rec => ({
        conversationId: rec.conversationId,
        title: rec.title || "新会话",
        timeLabel: formatShortTime(rec.updatedAtMs),
        status: rec.status,
        shareStatus: rec.shareStatus,
      })),
    })),
    [personalPartition.groups],
  )

  const workspaceItems: NavigationWorkspaceItem[] = useMemo(
    () => workspaces.map(item => ({ workspaceId: item.id, name: item.name })),
    [workspaces],
  )

  const dualTrack: DualTrackNavigationProps = {
    activeSpace,
    offline: isOffline,
    canPublishPersonal: workspaces.length > 0,
    personalGroups: personalNavGroups,
    personalSearch,
    selectedPersonalConversationId: personalSessions.selectedConversationId,
    publishedSessionCount: personalPartition.publishedCount,
    selectSpace: space => props.onSelectSpace(space),
    createPersonalSession: () => {
      personalSessions.startNewDraft()
      props.onSelectSpace("personal")
    },
    selectPersonalConversation: id => {
      personalSessions.selectConversation(id)
      props.onSelectSpace("personal")
    },
    renamePersonalConversation: personalSessions.renameConversation,
    publishPersonalConversation: id => personalSessions.openPublishDialog(id),
    stopSharingConversation: (id, fallback) => personalSessions.openStopSharingDialog(id, fallback),
    setPersonalSearch: setPersonalSearch,
    reconnect: () => { void props.identity.refresh() },
  }

  const offlineBanner = isOffline ? (
    <div className="desktop-offline-pill" role="status">
      <IconWifiOff size={13} aria-hidden="true" />
      <span>协作服务暂不可达 · 本机个人会话可正常使用</span>
      <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => { void props.identity.refresh() }}>
        <IconRefresh size={12} aria-hidden="true" />
        <span>重连</span>
      </button>
    </div>
  ) : undefined

  const renderSessionHeaderForTeam = (conversation: ProjectConversationSummary, projectName: string | null): ReactNode => {
    const localRec = personalSessions.findRecord(conversation.conversationId)
    const wsId = localRec?.workspaceId ?? workspace?.id ?? null
    const shareStatus = localRec ? localRec.shareStatus : conversation.shareStatus === "active" ? "active" : "stopped"
    const shareMode = localRec ? localRec.shareMode : conversation.shareMode
    return (
      <SessionMetaHeader
        projectName={projectName}
        shareStatus={shareStatus}
        shareMode={shareMode}
        offline={isOffline}
        hasPublishableTeams={workspaces.length > 0}
        onOpenPublish={() => personalSessions.openPublishDialog(conversation.conversationId)}
        onOpenStopSharing={() => personalSessions.openStopSharingDialog(conversation.conversationId, {
          ...(wsId ? { workspaceId: wsId } : {}),
          projectId: conversation.projectId,
          title: conversation.title,
          projectName,
        })}
      />
    )
  }

  const overlays = <>
    {personalSessions.modalRecord && personalSessions.publishDialogConvId && (
      <PublishConversationDialog
        organization={props.organization}
        record={personalSessions.modalRecord}
        turns={personalSessions.modalTurns}
        workspaces={workspaces}
        onClose={personalSessions.closePublishDialog}
        onPublish={input => personalSessions.publishConversation(personalSessions.publishDialogConvId!, input)}
      />
    )}
    {personalSessions.stopSharingDialogConvId && (personalSessions.modalRecord || personalSessions.stopSharingTarget) && (
      <StopSharingDialog
        title={personalSessions.modalRecord?.title ?? personalSessions.stopSharingTarget?.title ?? "未命名会话"}
        projectName={personalSessions.stopSharingTarget?.projectName ?? null}
        onClose={personalSessions.closeStopSharingDialog}
        onConfirmStop={() => personalSessions.stopConversationSharing(personalSessions.stopSharingDialogConvId!)}
      />
    )}
    {toast && (
      <div className="desktop-toast" role="status" aria-live="polite">{toast}</div>
    )}
  </>

  if (activeSpace === "team" && !isOffline && workspace) {
    return <>
      <WorkspaceProjectWorkbench
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
        persistence={props.persistence}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        workspaces={workspaceItems}
        onSelectWorkspace={props.onSelectWorkspace}
        dualTrack={dualTrack}
        pendingReveal={pendingReveal?.workspaceId === workspace.id ? pendingReveal : null}
        onConsumeReveal={() => setPendingReveal(null)}
        onRenderSessionHeader={renderSessionHeaderForTeam}
        colorScheme={props.preferences.state.colorScheme}
        onToggleTheme={props.preferences.toggleTheme}
        user={user}
        titleBarClassName={props.titleBarClassName}
        settingsHead={props.settingsHead}
        settingsBody={props.settingsBody}
        settingsOpen={props.settingsOpen}
        setSettingsOpen={props.setSettingsOpen}
        personalError={props.personalError}
      />
      {overlays}
    </>
  }

  const settings = <div className="desktop-settings">
    {props.settingsHead}
    <div className="desktop-settings-body">
      {props.settingsBody}
    </div>
  </div>

  const selectedRecord = personalSessions.selectedRecord
  const selectedSummary = personalSessions.selectedSummary
  const showPersonalConversation = Boolean(activeSpace === "personal" && selectedRecord && selectedSummary)

  let centerContent: ReactNode
  if (activeSpace === "team" && isOffline) {
    centerContent = (
      <section className="desktop-empty desktop-conversation" aria-label="团队空间离线">
        <h1>团队空间暂不可达</h1>
        <p role="status">当前无法连接到协作服务端，但你的本机个人会话、工作目录与 ACP Agent 可继续使用。</p>
        <div className="desktop-workspace-choice">
          <button type="button" className="wb-button wb-button-secondary" onClick={() => { void props.identity.refresh() }}>
            <IconRefresh size={14} aria-hidden="true" />
            <span>重连服务</span>
          </button>
          <button type="button" className="wb-button wb-button-primary" onClick={() => props.onSelectSpace("personal")}>
            回到个人空间
          </button>
        </div>
      </section>
    )
  } else if (activeSpace === "team" && !workspace) {
    centerContent = (
      <section className="desktop-empty desktop-conversation" aria-label="尚未加入团队">
        <h1>当前账号尚未加入团队</h1>
        <p role="status">无需等待入团或开通团队空间，随时可以直接在「个人」空间创建并执行本机会话。</p>
        <div className="desktop-workspace-choice">
          <button type="button" className="wb-button wb-button-primary" onClick={() => props.onSelectSpace("personal")}>
            回到个人空间
          </button>
        </div>
      </section>
    )
  } else if (showPersonalConversation && selectedRecord && selectedSummary) {
    const activePort = personalSessions.localExecutionPort ?? props.execution ?? fallbackExecutionPort
    const uiScope = {
      namespace: "desktop-personal",
      accountId: user.id,
      workspaceId: selectedRecord.workspaceId ?? "__solo__",
      conversationId: selectedRecord.conversationId,
    }
    const headerBar = (
      <SessionMetaHeader
        projectName={null}
        shareStatus={selectedRecord.shareStatus}
        shareMode={selectedRecord.shareMode}
        offline={isOffline}
        hasPublishableTeams={workspaces.length > 0}
        onOpenPublish={() => personalSessions.openPublishDialog(selectedRecord.conversationId)}
        onOpenStopSharing={() => personalSessions.openStopSharingDialog(selectedRecord.conversationId)}
      />
    )
    centerContent = (
      <div className="desktop-personal-stage">
        <LocalSessionPage
          scope={uiScope}
          executionScope={personalSessions.selectedExecutionScope ?? undefined}
          headerBar={headerBar}
          visible
          conversation={selectedSummary}
          directoryPath={selectedRecord.directoryPath}
          recentDirectories={personalSessions.recentDirectories}
          gitSummary={personalSessions.selectedGitSummary}
          entries={personalSessions.selectedEntries}
          contentRevision={personalSessions.selectedContentRevision}
          personal={personalSessions.selectedPersonalState}
          execution={activePort}
          rendering={personalSessions.rendering}
          centralFiles={personalSessions.getCentralFiles()}
          onChooseDirectory={() => personalSessions.chooseSessionDirectory(selectedRecord.conversationId)}
          onSelectDirectory={path => personalSessions.selectSessionDirectory(selectedRecord.conversationId, path)}
          onChooseLocalFiles={() => personalSessions.chooseLocalFiles(selectedRecord.conversationId)}
          onChooseLocalDirectories={() => personalSessions.chooseLocalDirectories(selectedRecord.conversationId)}
          onOpenChangesPanel={() => personalSessions.openChangesPanel(selectedRecord.conversationId)}
          onRefreshGitStatus={() => personalSessions.refreshGitStatus(selectedRecord.conversationId)}
          onPersonalChange={personalSessions.onPersonalChange}
          onRequestFileCandidates={personalSessions.requestFileCandidates}
          onOpenFile={personalSessions.openFile}
        />
      </div>
    )
  } else {
    centerContent = (
      <div className="desktop-personal-stage">
        <PersonalNewSessionPage
          accountId={user.id}
          visible
          draft={personalSessions.newDraft}
          busy={personalSessions.createBusy}
          errorMessage={personalSessions.createError}
          providers={personalSessions.preflightProviders?.providers}
          checkingProviders={personalSessions.checkingProviders}
          defaultProviderId={personalSessions.preflightProviders?.defaultProviderId}
          recentDirectories={personalSessions.recentDirectories}
          rendering={personalSessions.rendering}
          onRefreshProviders={() => { void personalSessions.refreshProviders() }}
          onOpenSettings={() => props.setSettingsOpen(true)}
          onChooseDirectory={personalSessions.chooseNewDirectory}
          onSelectDirectory={personalSessions.selectNewDirectory}
          onSelectProvider={personalSessions.selectNewProvider}
          onDraftChange={personalSessions.updateNewDraftText}
          onStartSession={() => { void personalSessions.startNewPersonalSession() }}
        />
      </div>
    )
  }

  return <>
    <WorkbenchLayout
      titleBarClassName={props.titleBarClassName}
      context={{
        title: showPersonalConversation && selectedSummary
          ? selectedSummary.title
          : activeSpace === "team"
            ? "团队空间"
            : "个人工作台",
        subtitle: showPersonalConversation
          ? (selectedRecord?.directoryPath
              ? (directoryBasename(selectedRecord.directoryPath) || selectedRecord.directoryPath)
              : "仅本机")
          : "仅本机",
      }}
      renderHeaderTitle={() => {
        if (activeSpace === "team") {
          return (
            <>
              <span className="tb-name">团队空间</span>
              <span className="tb-count">{isOffline ? "离线" : "未入团"}</span>
            </>
          )
        }
        if (showPersonalConversation && selectedSummary) {
          return (
            <>
              <span className="tb-name" title={selectedSummary.title}>{selectedSummary.title}</span>
              <span className="tb-count">{selectedRecord?.shareStatus === "stopped" ? "已停止同步" : "仅本机"}</span>
            </>
          )
        }
        return (
          <>
            <span className="tb-name">新建个人会话</span>
            <span className="tb-count">仅本机</span>
          </>
        )
      }}
      backButton={activeSpace === "team" ? (
        <button type="button" className="collab-back-btn" onClick={() => props.onSelectSpace("personal")}>
          <IconArrowLeft size={14} aria-hidden="true" />
          <span>回到个人空间</span>
        </button>
      ) : undefined}
      headerExtra={offlineBanner}
      colorScheme={props.preferences.state.colorScheme}
      onToggleTheme={props.preferences.toggleTheme}
      overlays={overlays}
      navigation={<div className="desktop-navigation">
        <ProjectNavigation view={{
          accountName: user.userName,
          accountPhoto: resolveUserPhoto(user),
          workspaceName: workspace?.name ?? null,
          workspaces: workspaceItems,
          currentWorkspaceId: workspace?.id ?? null,
          projects: [],
          projectsAvailability: { state: isOffline ? "failed" : "unavailable" },
          currentProjectId: null,
          groups: [],
          membersAvailability: { state: "unavailable" },
          sessionsAvailability: { state: "ready" },
          search: "",
          activePage: null,
          selectedConversationId: null,
          taskCount: null,
          activeSpace,
          offline: isOffline,
          canPublishPersonal: workspaces.length > 0,
          personalGroups: personalNavGroups,
          personalSearch,
          selectedPersonalConversationId: personalSessions.selectedConversationId,
          publishedSessionCount: personalPartition.publishedCount,
        }} actions={{
          selectSpace: dualTrack.selectSpace,
          createPersonalSession: dualTrack.createPersonalSession,
          selectPersonalConversation: dualTrack.selectPersonalConversation,
          renamePersonalConversation: dualTrack.renamePersonalConversation,
          publishPersonalConversation: dualTrack.publishPersonalConversation,
          stopSharingConversation: id => dualTrack.stopSharingConversation(id),
          setPersonalSearch: dualTrack.setPersonalSearch,
          reconnect: dualTrack.reconnect,
          selectWorkspace: props.onSelectWorkspace,
          selectProject: noop,
          createProject: noop,
          openProjectSettings: noop,
          openPage: noop,
          selectConversation: noop,
          toggleMember: noop,
          setSearch: noop,
          retry: noop,
          openSettings: () => props.setSettingsOpen(true),
        }} />
        {props.personalError && <p className="desktop-navigation-note" role="alert">{props.personalError}{" "}
          <button className="wb-button wb-button-small wb-button-quiet" onClick={() => { void props.persistence.flush() }}>重试保存</button>
        </p>}
      </div>}
      center={centerContent}
      right={slot => showPersonalConversation ? personalSessions.renderRight(slot) : null}
      leftOpen={leftOpen}
      leftWidthPx={leftWidthPx}
      rightOpen={showPersonalConversation && rightOpen}
      rightWidthPx={rightWidthPx}
      setPanelOpen={(side, open) => {
        if (side === "left") setLeftOpen(open)
        else setRightOpen(open)
      }}
      setPanelWidth={(side, width) => {
        if (side === "left") setLeftWidthPx(width)
        else setRightWidthPx(width)
      }}
      settingsOpen={props.settingsOpen}
      closeSettings={() => props.setSettingsOpen(false)}
      settings={settings}
    />
  </>
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
  dualTrack?: DualTrackNavigationProps
  pendingReveal?: PendingReveal | null
  onConsumeReveal?: () => void
  onRenderSessionHeader?: (conversation: ProjectConversationSummary, projectName: string | null) => ReactNode
  colorScheme?: "light" | "dark"
  onToggleTheme?(): void
  user: UserSummary
  titleBarClassName: string
  settingsHead: ReactNode
  settingsBody: ReactNode
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
  const knowledgeRows = useWorkspaceKnowledgeMetadata(props.collaborationApps, shell.scope, knowledgeRevision)
  const knowledgeCount = knowledgeRows.status === "ready" ? knowledgeRows.items.length : null
  const [taskDetailRevision, setTaskDetailRevision] = useState(0)
  const [knowledgeRequest, setKnowledgeRequest] = useState<{ readonly itemId: string; readonly token: number } | null>(null)
  useEffect(() => {
    setKnowledgeRequest(null)
  }, [props.workspaceId, props.user.id])
  useEffect(() => {
    if (currentPage.kind !== "knowledge") setKnowledgeRequest(null)
  }, [currentPage.kind])
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
    onOpenRightPanel: () => {
      if (shell.workspace.status !== "ready" || shell.workspace.value.panels.right.open) return
      shell.saveWorkspace({
        ...shell.workspace.value,
        panels: {
          ...shell.workspace.value.panels,
          right: { ...shell.workspace.value.panels.right, open: true },
        },
      })
    },
  })
  const { pageController, integration } = projectSessions

  // 发布成功后自动切换到对应 Project，刷新列表并定位停留在同一条 conversationId。
  useEffect(() => {
    const reveal = props.pendingReveal
    if (!reveal || shell.workspace.status !== "ready") return
    if (shell.projectId !== reveal.projectId) {
      if (shell.projects.projects.some(p => p.projectId === reveal.projectId)) {
        shell.selectProject(reveal.projectId)
      }
      return
    }
    if (!shell.scope || shell.scope.projectId !== reveal.projectId) return
    const targetScope = shell.scope
    void integration.refreshMetadata(targetScope).finally(() => {
      shell.openPage({ kind: "conversation", conversationId: reveal.conversationId })
      props.onConsumeReveal?.()
    })
  }, [props.pendingReveal, shell.workspace.status, shell.projectId, shell.projects.projects, shell.scope])

  const [lastLocalConversationId, setLastLocalConversationId] = useState<string | null>(null)
  useEffect(() => {
    setLastLocalConversationId(null)
  }, [shell.projectId, props.user.id])
  useEffect(() => {
    if (!selectedConversationId) return
    const selected = pageController.conversations.find(item => item.conversationId === selectedConversationId)
    if (selected?.ownerUserId === props.user.id) {
      setLastLocalConversationId(selectedConversationId)
    }
  }, [selectedConversationId, pageController.conversations, props.user.id])
  const preferredConversationId = selectedConversationId ?? lastLocalConversationId
  const scope = shell.scope
  const { refresh: refreshBoard, ...board } = useProjectBoard(props.projectUpdates, scope, currentPage.kind === "board")
  // 订阅跟随团队外壳。切页面、切项目时只替换刷新目标，正文读取仍在原页面动作内。
  const notification = useProjectUpdates(props.projectUpdates, props.user.id, props.workspaceId, {
    projectId: scope?.projectId ?? null,
    isBoardActive: currentPage.kind === "board",
    refreshProjectList: () => { void shell.projects.reload() },
    refreshProjectDetail: () => { void shell.detail.reload() },
    refreshConversations: () => {
      if (scope) void integration.refreshMetadata(scope).catch(() => {})
    },
    refreshBoard,
    refreshTasks: taskIds => {
      if (!scope) return
      refreshTaskMetadata(scope)
      if (shouldRefreshTaskDetail(currentPage, taskIds)) {
        setTaskDetailRevision(value => value + 1)
      }
    },
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
    preferredConversationId,
    isNewSession: currentPage.kind === "new",
    pageController,
    integration,
    readSnapshot: props.referenceSnapshots,
    host: props.collaborationApps,
    members: taskMembers,
    tasks: taskRows.status === "ready" ? taskRows.tasks : undefined,
    knowledge: knowledgeRows.status === "ready" ? knowledgeRows.items : undefined,
    onChooseMember: canPublish ? assigneeId => setPublishing({
      scope: shell.scope, page: currentPage, assigneeId, sourceId: selectedConversationId ?? undefined,
    }) : undefined,
    onOpenTask: taskContext ? openTask : undefined,
    chooseDirectory,
    locateConversation,
  })

  const sourceConversations = pageController.conversations.filter(item => item.projectId === shell.scope?.projectId)

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
      ...(props.onRenderSessionHeader
        ? { renderSessionHeader: conv => props.onRenderSessionHeader!(conv, currentProject?.name ?? null) }
        : {}),
      hooks: {
        ...references.hooks,
        onCreateTaskFromConversation: canPublish ? conversation => setPublishing({
          scope: shell.scope, page: currentPage, sourceId: conversation.conversationId,
        }) : undefined,
      },
    }),
    ...(taskContext ? {
      tasks: {
        render({ scope, page, navigator, visible }) {
          if (!visible || (page.kind !== "tasks" && page.kind !== "task")) return null
          const id = page.kind === "task" ? page.taskId : undefined
          return <div className="collaboration-page-scroll" key={JSON.stringify([scope, id])}>
            <LiveProjectTasks context={taskContext} rows={taskRows} taskId={id} detailRevision={taskDetailRevision} navigator={navigator}
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
              requestedItem={knowledgeRequest}
              canReference={references.canReference} previewFixed={references.previewFixed} />
          </div>
        },
      },
    } : createCollaborationPageProviders({
      projectName: currentProject?.name ?? "当前项目",
      workspaceName: props.workspaceName,
    })),
  }

  const settings = <div className="desktop-settings">
    {props.settingsHead}
    <div className="desktop-settings-body">
      {props.settingsBody}
    </div>
  </div>

  const paletteMetadataMessage = !props.collaborationApps ? "任务与知识服务尚未接入。"
    : taskRows.status === "error" ? taskRows.message
    : knowledgeRows.status === "error" ? knowledgeRows.message
    : taskRows.status === "loading" || knowledgeRows.status === "loading" ? "正在读取任务与知识摘要…" : undefined

  const teamDualTrack: DualTrackNavigationProps | undefined = props.dualTrack
    ? {
        ...props.dualTrack,
        stopSharingConversation: conversationId => {
          const matched = pageController.conversations.find(item => item.conversationId === conversationId)
          props.dualTrack!.stopSharingConversation(conversationId, {
            workspaceId: props.workspaceId,
            ...(matched?.projectId ?? shell.projectId ? { projectId: matched?.projectId ?? shell.projectId! } : {}),
            ...(matched?.title ? { title: matched.title } : {}),
            projectName: currentProject?.name ?? null,
          })
        },
      }
    : undefined

  return <>
    <ProjectWorkbench
      shell={shell}
      organization={props.organization}
      persistence={props.persistence}
      workspaceId={props.workspaceId}
      workspaceName={props.workspaceName}
      workspaces={props.workspaces}
      onSelectWorkspace={props.onSelectWorkspace}
      dualTrack={teamDualTrack}
      colorScheme={props.colorScheme}
      onToggleTheme={props.onToggleTheme}
      user={props.user}
      titleBarClassName={props.titleBarClassName}
      settings={settings}
      settingsOpen={props.settingsOpen}
      setSettingsOpen={props.setSettingsOpen}
      personalError={props.personalError}
      tasks={taskRows.status === "ready" ? taskRows.tasks : undefined}
      knowledge={knowledgeRows.status === "ready" ? knowledgeRows.items : undefined}
      metadataMessage={paletteMetadataMessage}
      taskCount={taskCount}
      knowledgeCount={knowledgeCount}
      sessions={projectSessions.navigationSource}
      providers={providers}
      onSelectKnowledge={knowledgeId => {
        setKnowledgeRequest(prev => ({ itemId: knowledgeId, token: (prev?.token ?? 0) + 1 }))
        shell.openPage({ kind: "knowledge" })
      }}
    />
    {references.dialog}
    {publishing?.scope === shell.scope && publishing?.page === currentPage && taskContext?.projectActive && <ProjectTaskPublication
      context={taskContext} members={taskMembers} draftMaterials={references.draftMaterials} sources={sourceConversations}
      assigneeId={publishing.assigneeId} sourceId={publishing.sourceId} onClose={() => setPublishing(null)} onPublished={taskId => {
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
