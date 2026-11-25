/**
 * 正式窗口装配（HC-255 统一单壳层：56px Rail + 304px 双模次级侧栏 + 1200px 宽屏业务页）：
 * 1. 登录即用与断网续用：已确认账号（含断网只读快照 `lastKnownUser`）立即进入双轨工作台，未登录/连接异常展示内联登录引导卡；
 * 2. 工作台次级侧栏严格按「个人 | 团队」分栏：个人按工程目录折叠，团队按 Workspace 切换 + 单激活 Project 手风琴展开；
 * 3. 管理与设置收敛至 304px 管理导航 + 1200px 居中管理台，个人会话发布与停止共享支持自动切轨及 `row-land` 落位高亮。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { IconArrowLeft, IconRefresh, IconWifiOff } from "@tabler/icons-react"
import type { CollaborationHost, InboxItem, UserSummary, WorkspaceRole, WorkspaceSummary } from "@workbench/collaboration-client/types"
import type {
  AccountPersonal,
  CollaborationAppsHost,
  DesktopHost,
  DesktopLocalExecutionHost,
  InboxHost,
  LocalConversationsHost,
  LocalDirectoryHost,
  LocalExecutionScope,
  OrganizationHost,
  PersonalHost,
  ProjectConversationHost,
  ProjectUpdatesHost,
  ThemeMode,
  WindowState,
  WorkbenchDeepLinkEvent,
  WorkbenchDeepLinkTarget,
  ZoomAction,
} from "../shared/index.js"
import { ACCENT_OPTIONS, AppRail, DEFAULT_ACCENT, IdentityPanel, ProjectNavigation, WorkbenchLayout, useCollaborationIdentity } from "../ui/index.js"
import type { AccentId, NavigationInboxView, NavigationSpaceKind, NavigationWorkspaceItem, WorkbenchNavId } from "../ui/index.js"
import { useProjectShell, useProjectWorkbenchSlots } from "./features/project-navigation/index.js"
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
import {
  InboxPage,
  resolveDeepLinkNavigation,
  useInbox,
  useLocalAttention,
  type LocalAttentionItem,
} from "./features/inbox/index.js"
import { directoryBasename, formatShortTime } from "./features/session/session-model.js"
import { createCollaborationPageProviders } from "./features/collaboration/collaboration-pages.js"
import { useCollaborationMetadata } from "./features/collaboration/metadata.js"
import { LiveProjectTasks, LiveTaskDetail, ProjectTaskPublication, useProjectTaskMetadata } from "./features/collaboration/tasks/live-project-tasks.js"
import type { TasksContext } from "./features/collaboration/tasks/live-project-tasks.js"
import { LiveTeamKnowledge, useWorkspaceKnowledgeMetadata } from "./features/collaboration/knowledge/live-team-knowledge.js"
import { createBoardPageProvider } from "./features/board/board-provider.js"
import { isBoardRoutePage, shouldShowReturnToInbox } from "./features/board/board-model.js"
import { useProjectBoard } from "./features/board/use-project-board.js"
import { useProjectUpdates, shouldRefreshTaskDetail } from "./features/project-updates/use-project-updates.js"
import { CommandPaletteModal } from "./features/collaboration-views/index.js"
import { useWorkbenchReferences } from "./features/collaboration/references/workbench-references.js"
import type { ReferenceActions } from "./features/collaboration/references/conversation-references.js"
import { PersonalPersistence } from "./personal-persistence.js"
import { resolveUserPhoto } from "./demo-avatars.js"
import { ADMIN_SECTION_META, AdminPage, AdminSidebar, type AdminSectionId } from "./features/admin/index.js"
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
  inbox?: InboxHost
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

type PendingReveal =
  | {
      readonly kind: "conversation"
      readonly workspaceId: string
      readonly projectId: string
      readonly conversationId: string
      readonly token: number
      readonly land?: boolean
    }
  | {
      readonly kind: "task"
      readonly workspaceId: string
      readonly projectId: string
      readonly taskId: string
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
  const [queuedDeepLink, setQueuedDeepLink] = useState<{
    readonly target: WorkbenchDeepLinkTarget
    readonly token: number
  } | null>(null)
  const [deepLinkNotice, setDeepLinkNotice] = useState("")
  const deepLinkTokenRef = useRef(0)

  const acceptDeepLinkEvent = useCallback((event: WorkbenchDeepLinkEvent | null | undefined) => {
    if (!event) return
    if (!event.ok) {
      setDeepLinkNotice(event.message)
      return
    }
    setDeepLinkNotice("")
    setQueuedDeepLink({ target: event.target, token: ++deepLinkTokenRef.current })
  }, [])

  useEffect(() => {
    const stop = host.onDeepLink?.(acceptDeepLinkEvent)
    void host.consumePendingDeepLink?.().then(acceptDeepLinkEvent).catch(() => {})
    return () => { stop?.() }
  }, [host, acceptDeepLinkEvent])

  useEffect(() => {
    if (identity.state.status === "signedOut") {
      setQueuedDeepLink(null)
      return
    }
    if (identity.state.status === "signedIn") {
      void host.consumePendingDeepLink?.().then(acceptDeepLinkEvent).catch(() => {})
    }
  }, [host, identity.state.status, acceptDeepLinkEvent])

  const identityKey = identity.state.status === "signedIn" ? `signed:${identity.state.user.id}`
    : identity.state.status === "connectionError" && identity.state.lastKnownUser ? `signed:${identity.state.lastKnownUser.id}` : identity.state.status
  const persistence = useMemo(() => new PersonalPersistence(personalHost, setPersonalError), [personalHost, identityKey])
  useEffect(() => { setPersonalError(""); return personalHost.onCloseRequested(() => persistence.flush()) }, [personalHost, persistence])
  const guardedIdentity = {
    ...identity,
    signOut: async () => {
      setQueuedDeepLink(null)
      setDeepLinkNotice("")
      try { await persistence.flush() } catch { /* 退出前尽力落盘，保存失败不阻断账号退出。 */ }
      persistence.reset()
      await identity.signOut()
    },
  }
  return <DesktopSession key={identityKey} {...hosts} identity={guardedIdentity} preferences={preferences}
    persistence={persistence} personalError={personalError}
    queuedDeepLink={queuedDeepLink}
    onConsumeQueuedDeepLink={() => setQueuedDeepLink(null)}
    deepLinkNotice={deepLinkNotice}
    onClearDeepLinkNotice={() => setDeepLinkNotice("")} />
}

function DesktopSession(props: Hosts & {
  identity: Identity
  preferences: Preferences
  persistence: PersonalPersistence
  personalError: string
  queuedDeepLink: { readonly target: WorkbenchDeepLinkTarget; readonly token: number } | null
  onConsumeQueuedDeepLink: () => void
  deepLinkNotice: string
  onClearDeepLinkNotice: () => void
}) {
  const { identity, persistence } = props
  const [chosen, setChosen] = useState<string | null>(null)
  const [activeSpace, setActiveSpace] = useState<NavigationSpaceKind>("personal")
  const [account, setAccount] = useState<"loading" | "ready" | "failed">("loading")
  const [attempt, setAttempt] = useState(0)
  const [knownWorkspaces, setKnownWorkspaces] = useState<readonly WorkspaceSummary[]>([])

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
      if (isOffline) setActiveSpace("personal")
      else if (saved?.activeView === "workspace") setActiveSpace("team")
      else if (saved?.activeView === "solo") setActiveSpace("personal")
      setAccount("ready")
    })
    return () => { current = false }
  }, [activeUser?.id, isOffline, persistence, attempt])

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

  const selectSpace = useCallback((space: NavigationSpaceKind) => {
    setActiveSpace(space)
    saveAccountPrefs(workspace?.id ?? chosen, space)
  }, [workspace?.id, chosen])

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
      />
    )
  }

  const status = identity.state.status
  const message = status === "loading" ? "正在确认账号。"
    : status === "connectionError" ? identity.state.error.message
    : !activeUser ? "请先登录演示账号，立即在本机开始对话或协作。"
    : account === "failed" ? props.personalError || "无法恢复个人视图。"
    : "正在恢复个人视图…"

  return <WorkbenchLayout
    titleBarClassName={titleBarClassName}
    noSidebar
    context={{ title: "协作工作台" }}
    navigation={null}
    center={<section className="desktop-login-stage" aria-label="开始">
      <div className="desktop-login-card">
        <h1>协作工作台</h1>
        <p role={account === "failed" ? "alert" : "status"}>{message}</p>
        {!activeUser && status !== "loading" && (
          <IdentityPanel host={props.collaboration} identity={identity} workspaceId={workspace?.id ?? null} />
        )}
        {activeUser && account === "failed" && (
          <div className="identity-actions">
            <button type="button" className="wb-button wb-button-secondary" onClick={() => setAttempt(value => value + 1)}>重试</button>
          </div>
        )}
        {(props.deepLinkNotice || identity.notice) && (
          <p className="error" role="alert">{props.deepLinkNotice || identity.notice}</p>
        )}
      </div>
    </section>}
    right={() => null}
    leftOpen={false}
    leftWidthPx={304}
    rightOpen={false}
    rightWidthPx={340}
    setPanelOpen={noop}
    setPanelWidth={noop}
    settingsOpen={false}
    closeSettings={noop}
    settings={null}
  />
}

function ConfirmedUserWorkbench(props: Hosts & {
  identity: Identity
  preferences: Preferences
  persistence: PersonalPersistence
  personalError: string
  user: UserSummary
  workspaces: readonly WorkspaceSummary[]
  workspace: WorkspaceSummary | null
  activeSpace: NavigationSpaceKind
  isOffline: boolean
  onSelectWorkspace: (workspaceId: string) => void
  onSelectSpace: (space: NavigationSpaceKind) => void
  queuedDeepLink: { readonly target: WorkbenchDeepLinkTarget; readonly token: number } | null
  onConsumeQueuedDeepLink: () => void
  deepLinkNotice: string
  onClearDeepLinkNotice: () => void
  titleBarClassName: string
}) {
  const { user, workspaces, workspace, activeSpace, isOffline } = props
  const hasTeamOnline = Boolean(!isOffline && workspace)
  const [personalSearch, setPersonalSearch] = useState("")
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null)
  const [topNav, setTopNav] = useState<WorkbenchNavId>("chat")
  const [adminSection, setAdminSection] = useState<AdminSectionId>("appearance")
  const [landingConversationId, setLandingConversationId] = useState<string | null>(null)
  const landingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [returnToInbox, setReturnToInbox] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [knownProjectNames, setKnownProjectNames] = useState<Readonly<Record<string, string>>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftWidthPx, setLeftWidthPx] = useState(304)
  const [rightOpen, setRightOpen] = useState(true)
  const [rightWidthPx, setRightWidthPx] = useState(340)
  const syncTeamPageOnNavRef = useRef<(next: WorkbenchNavId, targetSpace?: NavigationSpaceKind) => void>(() => {})

  useEffect(() => () => {
    if (landingTimerRef.current) clearTimeout(landingTimerRef.current)
  }, [])

  const triggerLanding = useCallback((conversationId: string) => {
    if (landingTimerRef.current) clearTimeout(landingTimerRef.current)
    setLandingConversationId(conversationId)
    landingTimerRef.current = setTimeout(() => {
      landingTimerRef.current = null
      setLandingConversationId(current => (current === conversationId ? null : current))
    }, 900)
  }, [])

  const selectTopNav = useCallback((
    next: WorkbenchNavId,
    targetSpace?: NavigationSpaceKind,
    options?: { readonly preserveTeamPage?: boolean },
  ) => {
    if (targetSpace) props.onSelectSpace(targetSpace)
    setTopNav(next)
    if (next === "admin") setLeftOpen(true)
    if (next !== "inbox") setReturnToInbox(false)
    if (!options?.preserveTeamPage) {
      syncTeamPageOnNavRef.current(next, targetSpace)
    }
  }, [props.onSelectSpace])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  // 全局单外壳快捷键入口：⌘K 开关命令面板，⌘\ 在工作台/管理模式收起或展开次级侧栏。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPaletteOpen(prev => !prev)
        return
      }
      if (event.key === "\\" && (topNav === "chat" || topNav === "admin")) {
        event.preventDefault()
        setLeftOpen(prev => !prev)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [topNav])

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
      setReturnToInbox(false)
      props.onSelectWorkspace(result.workspaceId)
      props.onSelectSpace("team")
      selectTopNav("chat", "team")
      setPendingReveal({
        kind: "conversation",
        workspaceId: result.workspaceId,
        projectId: result.projectId,
        conversationId: result.conversationId,
        token: Date.now(),
        land: true,
      })
    },
    onStoppedSharing: result => {
      setReturnToInbox(false)
      setPersonalSearch("")
      if (result.workspaceId !== null) {
        props.onSelectWorkspace(result.workspaceId)
      }
      props.onSelectSpace("personal")
      selectTopNav("chat", "personal")
      triggerLanding(result.conversationId)
    },
    onOpenRightPanel: () => setRightOpen(true),
    onNotify: msg => setToast(msg),
  })

  const inbox = useInbox({
    host: props.inbox,
    accountId: user.id,
    online: !isOffline,
  })

  useEffect(() => {
    if (!props.deepLinkNotice) return
    setToast(props.deepLinkNotice)
    props.onClearDeepLinkNotice()
  }, [props.deepLinkNotice, props.onClearDeepLinkNotice])

  // 仅做只读页面跳转，绝不自动触发 Agent 执行或写操作；跨团队/无权任务弹窗提示且不暴露多余信息。
  useEffect(() => {
    const queued = props.queuedDeepLink
    if (!queued) return
    const decision = resolveDeepLinkNavigation({
      target: queued.target,
      offline: isOffline,
      workspaceIds: workspaces.map(w => w.id),
    })
    if (decision.action === "open_inbox") {
      selectTopNav("inbox")
      if (decision.shouldRefreshInbox) void inbox.refresh()
      props.onConsumeQueuedDeepLink()
      return
    }
    if (decision.action === "deny") {
      setToast(decision.message)
      props.onConsumeQueuedDeepLink()
      return
    }
    props.onSelectWorkspace(decision.workspaceId)
    props.onSelectSpace("team")
    setTopNav("board")
    setReturnToInbox(true)
    setPendingReveal({
      kind: "task",
      workspaceId: decision.workspaceId,
      projectId: decision.projectId,
      taskId: decision.taskId,
      token: queued.token,
    })
    props.onConsumeQueuedDeepLink()
  }, [props.queuedDeepLink, isOffline, workspaces, props.onSelectWorkspace, props.onSelectSpace, props.onConsumeQueuedDeepLink, selectTopNav])

  const handleProjectsLoaded = useCallback((projectNames: Readonly<Record<string, string>>) => {
    setKnownProjectNames(prev => {
      let changed = false
      const next = { ...prev }
      for (const [id, name] of Object.entries(projectNames)) {
        if (next[id] !== name) {
          next[id] = name
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const handleOpenLocalItem = useCallback((item: LocalAttentionItem) => {
    setReturnToInbox(false)
    if (item.workspaceId && item.projectId && !isOffline && workspaces.some(w => w.id === item.workspaceId)) {
      props.onSelectWorkspace(item.workspaceId)
      props.onSelectSpace("team")
      selectTopNav("chat", "team")
      setPendingReveal({
        kind: "conversation",
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        conversationId: item.conversationId,
        token: Date.now(),
      })
      return
    }
    personalSessions.selectConversation(item.conversationId)
    props.onSelectSpace("personal")
    selectTopNav("chat", "personal")
  }, [isOffline, workspaces, props.onSelectWorkspace, props.onSelectSpace, personalSessions, selectTopNav])

  const handleOpenCloudItem = useCallback((item: InboxItem) => {
    if (isOffline) {
      setToast("当前处于离线状态，重连协作服务后可打开团队任务。")
      return
    }
    if (item.sourceType !== "task" || !item.projectId || !workspaces.some(w => w.id === item.workspaceId)) {
      setToast("当前账号无权访问该任务或已不在对应团队。")
      return
    }
    props.onSelectWorkspace(item.workspaceId)
    props.onSelectSpace("team")
    setTopNav("board")
    setReturnToInbox(true)
    setPendingReveal({
      kind: "task",
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      taskId: item.objectId,
      token: Date.now(),
    })
  }, [isOffline, workspaces, props.onSelectWorkspace, props.onSelectSpace])

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

  const dualTrack: DualTrackNavigationProps = {
    activeSpace,
    workspaceRoleLabel: workspace ? (workspace.role === "admin" ? "管理员" : "开发者") : null,
    offline: isOffline,
    canPublishPersonal: workspaces.length > 0,
    personalGroups: personalNavGroups,
    personalSearch,
    selectedPersonalConversationId: personalSessions.selectedConversationId,
    landingConversationId,
    publishedSessionCount: personalPartition.publishedCount,
    selectSpace: space => {
      setReturnToInbox(false)
      props.onSelectSpace(space)
      selectTopNav("chat", space)
    },
    createPersonalSession: () => {
      setReturnToInbox(false)
      personalSessions.startNewDraft()
      props.onSelectSpace("personal")
      selectTopNav("chat", "personal")
    },
    selectPersonalConversation: id => {
      setReturnToInbox(false)
      personalSessions.selectConversation(id)
      props.onSelectSpace("personal")
      selectTopNav("chat", "personal")
    },
    renamePersonalConversation: personalSessions.renameConversation,
    publishPersonalConversation: id => personalSessions.openPublishDialog(id),
    stopSharingConversation: (id, fallback) => personalSessions.openStopSharingDialog(id, fallback),
    setPersonalSearch: setPersonalSearch,
    reconnect: () => { void props.identity.refresh() },
  }

  const cloudActionCount = isOffline ? 0 : (inbox.data?.counts.actionRequired ?? 0)

  // 团队工作台桥接在已确认用户生命周期内始终挂载，保证切空间、切一级视图或短时断网时不丢失输入与滚动。
  const team = useTeamWorkspaceBridge({
    host: props.host,
    organization: props.organization,
    collaboration: props.collaboration,
    collaborationApps: props.collaborationApps,
    projectUpdates: props.projectUpdates,
    projectConversations: props.projectConversations,
    localConversations: props.localConversations,
    localDirectory: props.localDirectory,
    localExecution: props.localExecution,
    referenceSnapshots: props.referenceSnapshots,
    execution: props.execution,
    persistence: props.persistence,
    workspaceId: hasTeamOnline && workspace ? workspace.id : null,
    workspaceName: workspace?.name ?? "",
    workspaceRole: workspace?.role,
    workspaceAccessVersion: workspace?.accessVersion ?? 0,
    workspaces: workspaceItems,
    onSelectWorkspace: id => {
      setReturnToInbox(false)
      props.onSelectWorkspace(id)
    },
    dualTrack,
    inboxActive: topNav === "inbox",
    cloudActionCount,
    returnToInbox,
    onSelectNav: selectTopNav,
    onOpenCommandPalette: () => setPaletteOpen(true),
    onToggleLeftSidebar: () => setLeftOpen(prev => !prev),
    onOpenRightPanel: () => setRightOpen(true),
    onReturnToInbox: () => selectTopNav("inbox"),
    onProjectsLoaded: handleProjectsLoaded,
    onTaskMutated: () => { void inbox.refresh() },
    pendingReveal: hasTeamOnline && workspace && pendingReveal?.workspaceId === workspace.id ? pendingReveal : null,
    onConversationRevealed: (conversationId, land) => {
      if (land) triggerLanding(conversationId)
    },
    onConsumeReveal: () => setPendingReveal(null),
    onRevealUnavailable: msg => setToast(msg),
    onRenderSessionHeader: renderSessionHeaderForTeam,
    user,
    isTeamChatActive: Boolean(hasTeamOnline && topNav === "chat" && activeSpace === "team"),
    isBoardActive: Boolean(hasTeamOnline && topNav === "board"),
  })

  syncTeamPageOnNavRef.current = (next: WorkbenchNavId, targetSpace?: NavigationSpaceKind) => {
    if (!hasTeamOnline) return
    const nextSpace = targetSpace ?? activeSpace
    const pageKind = team.slots.page.kind
    if (next === "board") {
      if (pageKind !== "board" && pageKind !== "tasks" && pageKind !== "task") {
        team.shell.openPage({ kind: "board" })
      }
      return
    }
    if (next === "knowledge") {
      if (pageKind !== "knowledge") {
        team.shell.openPage({ kind: "knowledge" })
      }
      return
    }
    if (next === "chat" && nextSpace === "team") {
      if (pageKind === "board" || pageKind === "tasks" || pageKind === "task" || pageKind === "knowledge") {
        team.shell.openPage(team.slots.lastChatPageRef.current)
      }
    }
  }

  // 当项目列表稍后就绪时，同步当前一级页所需的团队子页（看板 / 团队知识）。
  const teamPage = team.slots.page
  useEffect(() => {
    if (!hasTeamOnline || !team.shell.projectId) return
    if (topNav === "board" && !isBoardRoutePage(teamPage)) {
      team.shell.openPage({ kind: "board" })
    } else if (topNav === "knowledge" && teamPage.kind !== "knowledge") {
      team.shell.openPage({ kind: "knowledge" })
    }
  }, [hasTeamOnline, team.shell.projectId, topNav, teamPage.kind])

  // 只有在当前真正停留在某条对话上时才豁免该会话的等待通知。
  const activeViewedConversationId = topNav !== "chat"
    ? null
    : activeSpace === "personal"
      ? personalSessions.selectedConversationId
      : hasTeamOnline
        ? team.selectedConversationId
        : null

  const localAttentionItems = useLocalAttention({
    localExecution: props.localExecution,
    accountId: user.id,
    personalRecords: personalSessions.records,
    activeViewedConversationId,
    projectNamesById: knownProjectNames,
  })

  const navInboxView: NavigationInboxView = {
    active: topNav === "inbox",
    cloudActionCount,
    localAttentionCount: localAttentionItems.length,
  }

  const inboxPageNode = (
    <InboxPage
      currentUserId={user.id}
      collaborationApps={props.collaborationApps}
      online={!isOffline}
      workspaces={workspaces}
      localItems={localAttentionItems}
      bucket={inbox.bucket}
      workspaceFilter={inbox.workspaceFilter}
      categoryFilter={inbox.categoryFilter}
      data={inbox.data}
      loading={inbox.loading}
      refreshing={inbox.refreshing}
      error={inbox.error}
      streamStatus={inbox.streamStatus}
      onChangeBucket={inbox.setBucket}
      onChangeWorkspaceFilter={inbox.setWorkspaceFilter}
      onChangeCategoryFilter={inbox.setCategoryFilter}
      onRefresh={() => { void inbox.refresh() }}
      onReconnect={() => { void props.identity.refresh() }}
      onOpenLocalItem={handleOpenLocalItem}
      onOpenCloudItem={handleOpenCloudItem}
      onTaskMutated={msg => {
        void inbox.refresh()
        if (msg) setToast(msg)
      }}
    />
  )

  const palettePersonalSessions = useMemo(
    () => personalSessions.records.map(rec => ({
      conversationId: rec.conversationId,
      title: rec.title || "新会话",
      directoryLabel: rec.directoryPath ? (directoryBasename(rec.directoryPath) || rec.directoryPath) : "未选目录",
      timeLabel: formatShortTime(rec.updatedAtMs),
    })),
    [personalSessions.records],
  )

  const paletteQuickActions = useMemo(() => [
    {
      id: "nav-chat-personal",
      title: "切换到工作台 · 个人空间",
      sub: "本机对话与工程目录会话",
      onSelect: () => {
        props.onSelectSpace("personal")
        selectTopNav("chat", "personal")
      },
    },
    ...(workspaces.length > 0 ? [{
      id: "nav-chat-team",
      title: "切换到工作台 · 团队空间",
      sub: workspace ? `${workspace.name} · 协作会话` : "团队协作会话",
      onSelect: () => {
        props.onSelectSpace("team")
        selectTopNav("chat", "team")
      },
    }] : []),
    {
      id: "nav-inbox",
      title: "打开 Inbox · 待办与审批",
      sub: isOffline ? "仅本机等待处理" : `${cloudActionCount} 项团队待办 · ${localAttentionItems.length} 项本机`,
      onSelect: () => selectTopNav("inbox"),
    },
    {
      id: "nav-board",
      title: "打开 Project 看板",
      sub: hasTeamOnline && team.slots.current ? team.slots.current.name : "团队项目看板与任务",
      onSelect: () => selectTopNav("board"),
    },
    {
      id: "nav-knowledge",
      title: "打开团队知识库",
      sub: workspace ? `${workspace.name} · 经验与约定` : "团队知识沉淀",
      onSelect: () => selectTopNav("knowledge"),
    },
    {
      id: "nav-admin",
      title: "打开管理与设置",
      sub: "外观主题、强调色、通知提醒、快捷键与账号",
      onSelect: () => selectTopNav("admin"),
    },
    {
      id: "new-personal-session",
      title: "新建个人本机会话",
      sub: "在本地工程目录发起新的对话",
      onSelect: () => {
        personalSessions.startNewDraft()
        props.onSelectSpace("personal")
        selectTopNav("chat", "personal")
      },
    },
  ], [
    workspaces.length,
    workspace,
    isOffline,
    cloudActionCount,
    localAttentionItems.length,
    hasTeamOnline,
    team.slots.current,
    props.onSelectSpace,
    selectTopNav,
    personalSessions,
  ])

  const selectedRecord = personalSessions.selectedRecord
  const selectedSummary = personalSessions.selectedSummary
  const personalChatActive = topNav === "chat" && activeSpace === "personal"
  const teamChatActive = topNav === "chat" && activeSpace === "team"
  const showPersonalConversation = Boolean(personalChatActive && selectedRecord && selectedSummary)

  const renderTeamUnavailable = (title: string, actionLabel = "回到工作台") => (
    <section className="desktop-empty desktop-conversation" aria-label={title}>
      <h1>{isOffline ? `${title}暂不可达` : `${title}需要团队空间`}</h1>
      <p role="status">
        {isOffline
          ? "当前无法连接到协作服务端，但你的本机个人会话、工作目录与 ACP Agent 可继续使用。"
          : "当前账号尚未加入团队；你可以先在个人空间进行本机会话，或在管理与设置查看账号状态。"}
      </p>
      <div className="desktop-workspace-choice">
        {isOffline && (
          <button type="button" className="wb-button wb-button-secondary" onClick={() => { void props.identity.refresh() }}>
            <IconRefresh size={14} aria-hidden="true" />
            <span>重连服务</span>
          </button>
        )}
        <button
          type="button"
          className="wb-button wb-button-primary"
          onClick={() => {
            props.onSelectSpace("personal")
            selectTopNav("chat", "personal")
          }}
        >
          {actionLabel}
        </button>
        <button type="button" className="wb-button wb-button-secondary" onClick={() => selectTopNav("admin")}>
          管理与设置
        </button>
      </div>
    </section>
  )

  let personalStageNode: ReactNode
  if (selectedRecord && selectedSummary) {
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
    personalStageNode = (
      <LocalSessionPage
        scope={uiScope}
        executionScope={personalSessions.selectedExecutionScope ?? undefined}
        headerBar={headerBar}
        visible={personalChatActive}
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
    )
  } else {
    personalStageNode = (
      <PersonalNewSessionPage
        accountId={user.id}
        visible={personalChatActive}
        draft={personalSessions.newDraft}
        busy={personalSessions.createBusy}
        errorMessage={personalSessions.createError}
        providers={personalSessions.preflightProviders?.providers}
        checkingProviders={personalSessions.checkingProviders}
        defaultProviderId={personalSessions.preflightProviders?.defaultProviderId}
        recentDirectories={personalSessions.recentDirectories}
        rendering={personalSessions.rendering}
        onRefreshProviders={() => { void personalSessions.refreshProviders() }}
        onOpenSettings={() => { setAdminSection("agents"); selectTopNav("admin") }}
        onChooseDirectory={personalSessions.chooseNewDirectory}
        onSelectDirectory={personalSessions.selectNewDirectory}
        onSelectProvider={personalSessions.selectNewProvider}
        onDraftChange={personalSessions.updateNewDraftText}
        onStartSession={() => { void personalSessions.startNewPersonalSession() }}
      />
    )
  }

  const memoryScope: LocalExecutionScope | null = hasTeamOnline && workspace && team.shell.scope && team.activeOwnConversationId
    ? {
        accountId: user.id,
        workspaceId: workspace.id,
        projectId: team.shell.scope.projectId,
        conversationId: team.activeOwnConversationId,
      }
    : null

  let primaryView: ReactNode = null
  if (topNav === "inbox") {
    primaryView = inboxPageNode
  } else if (topNav === "admin") {
    primaryView = (
      <AdminPage
        activeSection={adminSection}
        appearanceContent={<WindowPreferences {...props.preferences} />}
        providers={personalSessions.preflightProviders?.providers}
        checkingProviders={personalSessions.checkingProviders}
        onRefreshProviders={() => { void personalSessions.refreshProviders() }}
        inboxHost={props.inbox}
        collaboration={props.collaboration}
        organization={props.organization}
        identity={props.identity}
        workspace={workspace}
        userId={user.id}
        isOffline={isOffline}
        memoryScope={memoryScope}
        memoryWorkspaceName={workspace?.name ?? null}
        memoryProjectName={team.slots.current?.name ?? null}
        onReconnect={() => { void props.identity.refresh() }}
        onBackToWorkbench={() => selectTopNav("chat")}
        onSelectSection={setAdminSection}
      />
    )
  } else if (topNav === "board") {
    primaryView = hasTeamOnline
      ? team.slots.pageView
      : renderTeamUnavailable("Project 看板")
  } else if (topNav === "knowledge") {
    primaryView = hasTeamOnline
      ? team.slots.pageView
      : renderTeamUnavailable("团队知识库")
  } else if (teamChatActive) {
    primaryView = hasTeamOnline
      ? team.slots.pageView
      : renderTeamUnavailable(isOffline ? "团队空间" : "协作团队", "回到个人空间")
  }

  const useTeamHeader = hasTeamOnline && (topNav === "board" || topNav === "knowledge" || teamChatActive)

  const headerContext = useTeamHeader
    ? team.slots.headerContext
    : topNav === "inbox"
      ? { title: "收件箱", subtitle: isOffline ? "离线 · 仅本机提醒" : "跨团队待办与本机提醒" }
      : topNav === "admin"
        ? {
            title: ADMIN_SECTION_META[adminSection].title,
            projectName: "管理与设置",
            subtitle: isOffline ? "离线 · 本机设置" : workspace?.name ?? "个人设置",
          }
        : topNav === "board"
          ? { title: "Project 看板", subtitle: isOffline ? "离线" : "未入团" }
          : topNav === "knowledge"
            ? { title: "团队知识库", subtitle: isOffline ? "离线" : "未入团" }
            : teamChatActive
              ? { title: "团队空间", subtitle: isOffline ? "离线" : "未入团" }
              : {
                  title: showPersonalConversation && selectedSummary ? selectedSummary.title : "",
                  subtitle: showPersonalConversation
                    ? (selectedRecord?.directoryPath
                        ? (directoryBasename(selectedRecord.directoryPath) || selectedRecord.directoryPath)
                        : "仅本机")
                    : undefined,
                }

  const renderHeaderTitle = useTeamHeader
    ? team.slots.renderHeaderTitle
    : () => {
        if (topNav === "inbox") {
          return (
            <>
              <span className="tb-name">Inbox · 待办与审批</span>
              {!isOffline ? (
                <span className="tb-count">{cloudActionCount} 项待你拍板</span>
              ) : null}
            </>
          )
        }
        if (topNav === "admin") {
          const sectionTitle = ADMIN_SECTION_META[adminSection].title
          return (
            <>
              <span className="tb-crumb">
                <span className="tb-crumb-name">管理与设置</span>
                <span className="tb-crumb-sep" aria-hidden="true">/</span>
              </span>
              <span className="tb-name">{sectionTitle}</span>
              <span className="tb-count">{isOffline ? "离线 · 本机设置" : workspace?.name ?? "个人设置"}</span>
            </>
          )
        }
        if (topNav === "board" || topNav === "knowledge" || teamChatActive) {
          const title = topNav === "board" ? "Project 看板" : topNav === "knowledge" ? "团队知识库" : "团队空间"
          return (
            <>
              <span className="tb-name">{title}</span>
              <span className="tb-count">{isOffline ? "离线" : "未入团"}</span>
            </>
          )
        }
        if (showPersonalConversation && selectedSummary) {
          const isRunning = Boolean(
            selectedRecord?.status === "running"
              || (selectedRecord && personalSessions.localExecutionPort?.getView?.(selectedRecord.conversationId)?.activeTurnId),
          )
          return (
            <>
              <span className="tb-name" title={selectedSummary.title}>{selectedSummary.title}</span>
              {selectedRecord?.shareStatus === "stopped" ? (
                <span className="tb-count">已停止同步</span>
              ) : null}
              {isRunning ? (
                <span className="tb-state running">
                  <span className="d" aria-hidden="true" />
                  运行中
                </span>
              ) : null}
            </>
          )
        }
        return <></>
      }

  const backButton = useTeamHeader
    ? team.slots.backButton
    : teamChatActive
      ? (
          <button type="button" className="collab-back-btn" onClick={() => props.onSelectSpace("personal")}>
            <IconArrowLeft size={14} aria-hidden="true" />
            <span>回到个人空间</span>
          </button>
        )
      : undefined

  const headerExtra = useTeamHeader ? team.slots.headerExtra : offlineBanner

  const rightContent = (slot: Parameters<typeof personalSessions.renderRight>[0]) => {
    if (topNav !== "chat") return null
    if (activeSpace === "personal") return showPersonalConversation ? personalSessions.renderRight(slot) : null
    return hasTeamOnline ? team.slots.renderRight(slot) : null
  }

  const hasRightOpen = Boolean(
    topNav === "chat"
      && rightOpen
      && (activeSpace === "personal" ? showPersonalConversation : (hasTeamOnline && team.slots.hasRight)),
  )

  const overlays = <>
    <CommandPaletteModal
      open={paletteOpen}
      projectName={hasTeamOnline ? team.slots.current?.name : undefined}
      personalSessions={palettePersonalSessions}
      members={hasTeamOnline ? team.slots.members : []}
      mySessions={hasTeamOnline ? team.slots.myEntries : []}
      peerSessions={hasTeamOnline ? team.slots.peerEntries : []}
      tasks={hasTeamOnline ? team.tasks : []}
      knowledge={hasTeamOnline ? team.knowledge : []}
      quickActions={paletteQuickActions}
      metadataMessage={!hasTeamOnline
        ? (isOffline ? "协作服务离线，仅可检索本机会话与快捷入口。" : "当前未加入团队，仅可检索本机会话与快捷入口。")
        : team.metadataMessage}
      onClose={() => setPaletteOpen(false)}
      onSelectPersonalSession={conversationId => {
        personalSessions.selectConversation(conversationId)
        props.onSelectSpace("personal")
        selectTopNav("chat", "personal")
      }}
      onSelectSession={conversationId => {
        if (!hasTeamOnline) return
        props.onSelectSpace("team")
        selectTopNav("chat", "team")
        team.shell.openPage({ kind: "conversation", conversationId })
      }}
      onSelectTask={taskId => {
        if (!hasTeamOnline) return
        props.onSelectSpace("team")
        selectTopNav("board")
        team.shell.openPage({ kind: "task", taskId })
      }}
      onSelectKnowledge={knowledgeId => {
        if (!hasTeamOnline) return
        props.onSelectSpace("team")
        selectTopNav("knowledge")
        team.openKnowledgeItem(knowledgeId)
      }}
    />
    {hasTeamOnline ? team.overlays : null}
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

  const railNode = (
    <AppRail
      activeNav={topNav}
      onSelectNav={nav => selectTopNav(nav)}
      inboxCount={cloudActionCount}
      localAttentionCount={localAttentionItems.length}
      hasChatUpdates={Boolean(hasTeamOnline && team.hasPeerUpdates)}
      accountName={user.userName}
      accountPhoto={resolveUserPhoto(user)}
      accountRole={hasTeamOnline ? team.slots.navigationView.accountRole ?? null : null}
      online={!isOffline}
      hasTeam={workspaces.length > 0}
      themeMode={props.preferences.state.themeMode}
      onSetThemeMode={mode => { void props.preferences.setThemeMode(mode) }}
      onOpenCommandPalette={() => setPaletteOpen(true)}
      onSignOut={() => { void props.identity.signOut() }}
    />
  )

  const navigationNode = topNav === "admin" ? (
    <div className="desktop-navigation">
      <AdminSidebar
        activeSection={adminSection}
        onSelectSection={setAdminSection}
        onBackToWorkbench={() => selectTopNav("chat")}
        memoryNeedsSessionHint={!memoryScope}
      />
      {props.personalError && <p className="desktop-navigation-note" role="alert">{props.personalError}{" "}
        <button className="wb-button wb-button-small wb-button-quiet" onClick={() => { void props.persistence.flush() }}>重试保存</button>
      </p>}
    </div>
  ) : hasTeamOnline && activeSpace === "team" ? (
    <div className="desktop-navigation">
      <ProjectNavigation
        view={{
          ...team.slots.navigationView,
          hasTeamUpdates: team.hasPeerUpdates,
          inbox: navInboxView,
        }}
        actions={team.slots.navigationActions}
      />
      {team.slots.notice && <p className="desktop-navigation-note" role="status">{team.slots.notice}</p>}
      {props.personalError && <p className="desktop-navigation-note" role="alert">{props.personalError}{" "}
        <button className="wb-button wb-button-small wb-button-quiet" onClick={() => { void props.persistence.flush() }}>重试保存</button>
      </p>}
    </div>
  ) : (
    <div className="desktop-navigation">
      <ProjectNavigation view={{
        accountName: user.userName,
        accountPhoto: resolveUserPhoto(user),
        accountRole: hasTeamOnline ? team.slots.navigationView.accountRole : undefined,
        workspaceName: workspace?.name ?? null,
        workspaceRoleLabel: workspace ? (workspace.role === "admin" ? "管理员" : "开发者") : null,
        workspaces: hasTeamOnline ? team.slots.navigationView.workspaces : workspaceItems,
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
        hasTeamUpdates: hasTeamOnline && team.hasPeerUpdates,
        offline: isOffline,
        canPublishPersonal: workspaces.length > 0,
        personalGroups: personalNavGroups,
        personalSearch,
        selectedPersonalConversationId: personalSessions.selectedConversationId,
        landingConversationId,
        publishedSessionCount: personalPartition.publishedCount,
        inbox: navInboxView,
      }} actions={{
        selectSpace: dualTrack.selectSpace,
        createPersonalSession: dualTrack.createPersonalSession,
        selectPersonalConversation: dualTrack.selectPersonalConversation,
        renamePersonalConversation: dualTrack.renamePersonalConversation,
        publishPersonalConversation: dualTrack.publishPersonalConversation,
        stopSharingConversation: id => dualTrack.stopSharingConversation(id),
        setPersonalSearch: dualTrack.setPersonalSearch,
        reconnect: dualTrack.reconnect,
        openInbox: () => selectTopNav("inbox"),
        openCommandPalette: () => setPaletteOpen(true),
        toggleLeftSidebar: () => setLeftOpen(prev => !prev),
        selectWorkspace: id => {
          setReturnToInbox(false)
          selectTopNav("chat")
          props.onSelectWorkspace(id)
        },
        selectProject: noop,
        createProject: noop,
        openProjectSettings: noop,
        openPage: noop,
        selectConversation: noop,
        toggleMember: noop,
        setSearch: noop,
        retry: noop,
        openSettings: () => selectTopNav("admin"),
      }} />
      {props.personalError && <p className="desktop-navigation-note" role="alert">{props.personalError}{" "}
        <button className="wb-button wb-button-small wb-button-quiet" onClick={() => { void props.persistence.flush() }}>重试保存</button>
      </p>}
    </div>
  )

  return (
    <WorkbenchLayout
      titleBarClassName={props.titleBarClassName}
      rail={railNode}
      noSidebar={topNav === "inbox" || topNav === "board" || topNav === "knowledge"}
      context={headerContext}
      renderHeaderTitle={renderHeaderTitle}
      backButton={backButton}
      headerExtra={headerExtra}
      overlays={overlays}
      navigation={navigationNode}
      center={<>
        <div className="desktop-personal-stage" hidden={!personalChatActive}>
          {personalStageNode}
        </div>
        {hasTeamOnline ? team.slots.sessionSlot : null}
        {primaryView}
      </>}
      right={rightContent}
      leftOpen={leftOpen}
      leftWidthPx={leftWidthPx}
      rightOpen={hasRightOpen}
      rightWidthPx={rightWidthPx}
      setPanelOpen={(side, open) => {
        if (side === "left") setLeftOpen(open)
        else setRightOpen(open)
      }}
      setPanelWidth={(side, width) => {
        if (side === "left") setLeftWidthPx(width)
        else setRightWidthPx(width)
      }}
      settingsOpen={false}
      closeSettings={() => selectTopNav("chat")}
      settings={null}
    />
  )
}

/**
 * 团队协作域持久化桥接 Hook：在已确认用户的单一主外壳内常驻挂载。
 * 切换工作空间、个人/团队空间、或一级页签时仅更新 scope（离线或未入团时传入 null 跳过请求），避免丢失未发送草稿与阅读状态。
 */
function useTeamWorkspaceBridge(props: {
  host: DesktopHost
  organization: OrganizationHost
  collaboration: CollaborationHost
  collaborationApps?: CollaborationAppsHost
  projectUpdates?: ProjectUpdatesHost
  projectConversations: ProjectConversationHost
  localConversations?: LocalConversationsHost
  localDirectory?: LocalDirectoryHost
  localExecution?: DesktopLocalExecutionHost
  referenceSnapshots?: ReferenceActions["readSnapshot"]
  execution?: LocalSessionExecutionPort
  persistence: PersonalPersistence
  workspaceId: string | null
  workspaceName: string
  workspaceRole?: WorkspaceRole
  workspaceAccessVersion: number
  workspaces?: readonly NavigationWorkspaceItem[]
  onSelectWorkspace?(workspaceId: string): void
  dualTrack?: DualTrackNavigationProps
  inboxActive: boolean
  cloudActionCount: number
  returnToInbox: boolean
  onSelectNav(nav: WorkbenchNavId, targetSpace?: NavigationSpaceKind, options?: { readonly preserveTeamPage?: boolean }): void
  onOpenCommandPalette(): void
  onToggleLeftSidebar(): void
  onOpenRightPanel(): void
  onReturnToInbox(): void
  onProjectsLoaded?(projectNames: Readonly<Record<string, string>>): void
  onTaskMutated?(): void
  pendingReveal?: PendingReveal | null
  onConversationRevealed?: (conversationId: string, land: boolean) => void
  onConsumeReveal?: () => void
  onRevealUnavailable?: (message: string) => void
  onRenderSessionHeader?: (conversation: ProjectConversationSummary, projectName: string | null) => ReactNode
  user: UserSummary
  isTeamChatActive: boolean
  isBoardActive: boolean
}) {
  const shell = useProjectShell({
    organization: props.organization,
    collaboration: props.collaboration,
    persistence: props.persistence,
    workspaceId: props.workspaceId,
    user: props.user,
  })

  useEffect(() => {
    if (!props.workspaceId) return
    void shell.team.reload()
    void shell.projects.reload()
    void shell.detail.reload()
  }, [props.workspaceId, props.workspaceAccessVersion])

  const currentProject = shell.projects.projects.find(item => item.projectId === shell.projectId)
  const selectedConversationId = shell.personal.page.kind === "conversation"
    ? shell.personal.page.conversationId
    : null

  useEffect(() => {
    if (!props.workspaceId || !shell.projects.projects.length) return
    props.onProjectsLoaded?.(
      Object.fromEntries(shell.projects.projects.map(item => [item.projectId, item.name])),
    )
  }, [props.workspaceId, shell.projects.projects])

  const currentPage = shell.personal.page
  const { taskRevision, knowledgeRevision, refreshTaskMetadata, refreshKnowledgeMetadata } = useCollaborationMetadata(shell.scope)
  const taskRows = useProjectTaskMetadata(props.collaborationApps, shell.scope, taskRevision)
  const taskCount = taskRows.status === "ready"
    ? taskRows.tasks.filter(task => task.assigneeId === props.user.id && task.status !== "done" && task.status !== "cancelled").length
    : null
  const knowledgeRows = useWorkspaceKnowledgeMetadata(props.collaborationApps, shell.scope, knowledgeRevision)
  const knowledgeCount = knowledgeRows.status === "ready" ? knowledgeRows.items.length : null
  const [taskDetailRevision, setTaskDetailRevision] = useState(0)
  const [knowledgeRequest, setKnowledgeRequest] = useState<{ readonly itemId: string; readonly token: number } | null>(null)
  const [publishing, setPublishing] = useState<{ scope: typeof shell.scope; page: typeof currentPage; assigneeId?: string; sourceId?: string } | null>(null)

  useEffect(() => {
    setKnowledgeRequest(null)
    setPublishing(null)
  }, [props.workspaceId, props.user.id])

  useEffect(() => {
    if (currentPage.kind !== "knowledge") setKnowledgeRequest(null)
  }, [currentPage.kind])

  function locateConversation(conversation: ProjectConversationSummary): boolean {
    const ok = shell.locateConversation(conversation.conversationId, [{
      conversationId: conversation.conversationId,
      ownerUserId: conversation.ownerUserId,
      title: conversation.title,
      timeLabel: "",
    }])
    // 新对话页已在 shell.locateConversation 中入队，切回团队对话时禁止再用 lastChatPageRef 覆盖。
    if (ok) props.onSelectNav("chat", "team", { preserveTeamPage: true })
    return ok
  }

  const projectSessions = useProjectSessions({
    host: props.host,
    projectConversations: props.projectConversations,
    localConversations: props.localConversations,
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
    onOpenRightPanel: props.onOpenRightPanel,
  })
  const { pageController, integration } = projectSessions

  // 发布成功后自动定位会话，或从全局收件箱跨团队/跨项目直达目标任务与对话。
  useEffect(() => {
    const reveal = props.pendingReveal
    if (!props.workspaceId || !reveal) return
    if (shell.projects.availability.state === "failed") {
      props.onRevealUnavailable?.("无法确认目标项目访问权限，请重连后重试。")
      props.onConsumeReveal?.()
      return
    }
    if (shell.workspace.status !== "ready" || shell.projects.availability.state !== "ready") return
    if (shell.projectId !== reveal.projectId) {
      if (shell.projects.projects.some(p => p.projectId === reveal.projectId)) {
        shell.selectProject(reveal.projectId)
      } else {
        props.onRevealUnavailable?.("当前账号无权访问目标项目或项目已移除。")
        props.onConsumeReveal?.()
      }
      return
    }
    if (!shell.scope || shell.scope.projectId !== reveal.projectId) return
    const targetScope = shell.scope
    if (reveal.kind === "task") {
      props.onSelectNav("board")
      refreshTaskMetadata(targetScope)
      setTaskDetailRevision(value => value + 1)
      shell.openPage({ kind: "task", taskId: reveal.taskId })
      props.onConsumeReveal?.()
      return
    }
    void integration.refreshMetadata(targetScope).finally(() => {
      props.onSelectNav("chat", "team", { preserveTeamPage: true })
      shell.openPage({ kind: "conversation", conversationId: reveal.conversationId })
      props.onConversationRevealed?.(reveal.conversationId, Boolean(reveal.land))
      props.onConsumeReveal?.()
    })
  }, [
    props.workspaceId,
    props.pendingReveal,
    shell.workspace.status,
    shell.projects.availability.state,
    shell.projectId,
    shell.projects.projects,
    shell.scope,
  ])

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

  const selectedOwnedBySelf = Boolean(
    selectedConversationId
      && pageController.conversations.some(
        item => item.conversationId === selectedConversationId && item.ownerUserId === props.user.id,
      ),
  )
  const activeOwnConversationId = selectedOwnedBySelf ? selectedConversationId : lastLocalConversationId
  const preferredConversationId = selectedConversationId ?? lastLocalConversationId
  const scope = shell.scope
  const isBoardPage = isBoardRoutePage(currentPage)
  const { refresh: refreshBoard, ...board } = useProjectBoard(
    props.projectUpdates,
    scope,
    Boolean(props.isBoardActive && isBoardPage),
  )
  // 订阅跟随团队外壳。切页面、切项目时只替换刷新目标，正文读取仍在原页面动作内。
  const notification = useProjectUpdates(props.projectUpdates, props.user.id, props.workspaceId, {
    projectId: scope?.projectId ?? null,
    isBoardActive: Boolean(props.isBoardActive && isBoardPage),
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
    host: props.collaborationApps,
    scope: shell.scope,
    projectName: currentProject?.name ?? "当前项目",
    projectActive: canPublish,
    ownerName: pageController.resolveOwnerName,
    localDeviceId: props.user.id,
    canActForCreator: creatorId => shell.team.availability.state === "ready"
      && currentProject?.role === "owner"
      && !shell.team.members.some(m => m.user.id === creatorId && m.status === "active" && m.enabled),
    sessions: integration,
    directories: pageController.directories,
    chooseDirectory,
    locateConversation,
    refreshTaskMetadata: targetScope => {
      refreshTaskMetadata(targetScope)
      refreshBoard()
      props.onTaskMutated?.()
    },
  } : undefined

  const openTask = (taskId: string) => {
    props.onSelectNav("board")
    shell.openPage({ kind: "task", taskId })
  }

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

  // 看板复用项目导航与任务发布表单，合并四列流转、成员协同进展与右侧 .t-drawer 任务详情抽屉。
  const providers: ProjectPageProviders = {
    ...(props.projectUpdates || taskContext ? {
      board: createBoardPageProvider({
        ...(props.projectUpdates ? board : { data: null, updatedAt: null, busy: false, error: "" }),
        projectName: currentProject?.name ?? "当前项目",
        description: currentProject?.description,
        accountId: props.user.id,
        localDeviceId: props.user.id,
        syncStates: pageController.syncStates,
        notification,
        projects: shell.projects.projects,
        currentProjectId: shell.projectId,
        onSelectProject: shell.selectProject,
        allTasks: taskRows.status === "ready" ? taskRows.tasks : undefined,
        tasksLoading: taskRows.status === "loading",
        tasksError: taskRows.status === "error" ? taskRows.message : "",
        resolveOwnerName: pageController.resolveOwnerName,
        onRefresh: () => {
          if (props.projectUpdates) refreshBoard()
          if (scope) refreshTaskMetadata(scope)
        },
        onCreateTask: canPublish ? () => setPublishing({ scope, page: currentPage }) : undefined,
        onQuickAcceptTask: taskContext && canPublish
          ? async task => {
              const result = await taskContext.host.transitionTask(
                taskContext.scope.workspaceId,
                taskContext.scope.projectId,
                task.taskId,
                {
                  targetStatus: "doing",
                  expectedVersion: task.version,
                  requestId: crypto.randomUUID(),
                },
              )
              if (!result.ok) return result.error.message
              taskContext.refreshTaskMetadata(taskContext.scope)
              return null
            }
          : undefined,
        renderTaskDrawer: taskContext
          ? (taskId, onClose, navigator) => (
              <LiveTaskDetail
                key={taskId}
                context={taskContext}
                taskId={taskId}
                detailRevision={taskDetailRevision}
                navigator={navigator}
                embeddedInDrawer
                onClose={onClose}
              />
            )
          : undefined,
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
            <LiveTeamKnowledge host={taskContext.host} scope={scope} teamName={props.workspaceName} canManage={props.workspaceRole === "admin"}
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

  const metadataMessage = !props.collaborationApps ? "任务与知识服务尚未接入。"
    : taskRows.status === "error" ? taskRows.message
    : knowledgeRows.status === "error" ? knowledgeRows.message
    : taskRows.status === "loading" || knowledgeRows.status === "loading" ? "正在读取任务与知识摘要…" : undefined

  const teamDualTrack: DualTrackNavigationProps | undefined = props.dualTrack
    ? {
        ...props.dualTrack,
        stopSharingConversation: conversationId => {
          const matched = pageController.conversations.find(item => item.conversationId === conversationId)
          props.dualTrack!.stopSharingConversation(conversationId, {
            ...(props.workspaceId ? { workspaceId: props.workspaceId } : {}),
            ...(matched?.projectId ?? shell.projectId ? { projectId: matched?.projectId ?? shell.projectId! } : {}),
            ...(matched?.title ? { title: matched.title } : {}),
            projectName: currentProject?.name ?? null,
          })
        },
      }
    : undefined

  const inboxView: NavigationInboxView = {
    active: props.inboxActive,
    cloudActionCount: props.cloudActionCount,
    localAttentionCount: 0,
  }

  const slots = useProjectWorkbenchSlots({
    shell,
    organization: props.organization,
    persistence: props.persistence,
    workspaceId: props.workspaceId,
    workspaceName: props.workspaceName,
    workspaces: props.workspaces,
    onSelectWorkspace: props.onSelectWorkspace,
    dualTrack: teamDualTrack,
    inboxView,
    returnToInbox: shouldShowReturnToInbox(props.returnToInbox, currentPage),
    onOpenInbox: () => props.onSelectNav("inbox"),
    onCloseInbox: () => props.onSelectNav("chat"),
    onReturnToInbox: props.onReturnToInbox,
    onSelectNav: props.onSelectNav,
    onOpenCommandPalette: props.onOpenCommandPalette,
    onToggleLeftSidebar: props.onToggleLeftSidebar,
    disableGlobalShortcuts: true,
    isTeamChatActive: props.isTeamChatActive,
    user: props.user,
    titleBarClassName: "",
    settings: null,
    settingsOpen: false,
    setSettingsOpen: noop,
    personalError: "",
    tasks: taskRows.status === "ready" ? taskRows.tasks : undefined,
    knowledge: knowledgeRows.status === "ready" ? knowledgeRows.items : undefined,
    metadataMessage,
    taskCount,
    knowledgeCount,
    sessions: projectSessions.navigationSource,
    providers,
  })

  const openKnowledgeItem = (knowledgeId: string) => {
    setKnowledgeRequest(prev => ({ itemId: knowledgeId, token: (prev?.token ?? 0) + 1 }))
    shell.openPage({ kind: "knowledge" })
  }

  const overlays = <>
    {slots.overlays}
    {references.dialog}
    {publishing?.scope === shell.scope && publishing?.page === currentPage && taskContext?.projectActive && <ProjectTaskPublication
      context={taskContext} members={taskMembers} draftMaterials={references.draftMaterials} sources={sourceConversations}
      assigneeId={publishing.assigneeId} sourceId={publishing.sourceId} onClose={() => setPublishing(null)} onPublished={taskId => {
        setPublishing(null)
        openTask(taskId)
      }} />}
  </>

  return {
    shell,
    slots,
    tasks: taskRows.status === "ready" ? taskRows.tasks : [],
    knowledge: knowledgeRows.status === "ready" ? knowledgeRows.items : [],
    metadataMessage,
    openKnowledgeItem,
    overlays,
    hasPeerUpdates: slots.hasPeerUpdates,
    selectedConversationId,
    activeOwnConversationId,
  }
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
