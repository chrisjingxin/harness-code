/**
 * HC-218 停点 1 受控独立预览：演示新会话准备、本人本机会话、同账号其他设备只读、
 * 他人会话简报与五态主动同步（未同步 / 同步中 / 已同步 / 有更新 / 同步失败）。
 * 不连接真实服务端与 Agent；预览替身绝不进入正式入口 desktop-workbench.tsx。
 */
import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import { createRoot } from "react-dom/client"
import type { ThemeMode, WindowState } from "@workbench/contracts"
import { ProjectNavigation, WorkbenchLayout, buildMemberGroups } from "@workbench/ui"
import type {
  ConversationPersonalState,
  ConversationScope,
  NavigationMember,
  ProjectNavigationActions,
} from "@workbench/ui"
import "@workbench/ui/theme.css"
import "@workbench/ui/layout.css"
import "@workbench/ui/navigation.css"
import "@workbench/ui/conversation.css"
import "../features/session/session.css"
import "./preview.css"
import type { ProjectPage } from "../features/project-navigation/contracts.js"
import {
  EMPTY_PERSONAL_STATE,
  applyConversationPersonalChange,
  createSessionPageProvider,
  emptySyncState,
  mergeIncrementalHistory,
  toNavigationSessionEntries,
} from "../features/session/index.js"
import type {
  NewSessionDraft,
  ProjectConversationSummary,
  ProjectHistoryMessage,
  SessionSyncState,
} from "../features/session/index.js"

const orgName = "平台架构二组"
const orgPathName = "信息技术部/架构管理团队/零售应用架构四室/平台架构二组"
const SELF_ID = "u-shen"
const LOCAL_DEVICE_ID = "dev-shen-mac"
const DEVICE_NAMES: Record<string, string> = {
  "dev-shen-mac": "MacBook Pro · 办公室",
  "dev-shen-home": "家里台式机",
  "dev-zhang": "张景新的工作电脑",
  "dev-wang": "王大林的工作电脑",
  "dev-feng": "冯学茗的工作电脑",
  "dev-yang": "杨康的工作电脑",
}
const members: readonly NavigationMember[] = [
  { userId: SELF_ID, userName: "沈北辰", userNo: "80278667", orgName, orgPathName, left: false },
  { userId: "u-zhang", userName: "张景新", userNo: "80278668", orgName, orgPathName, left: false },
  { userId: "u-wang", userName: "王大林", userNo: "80278669", orgName, orgPathName, left: false },
  { userId: "u-feng", userName: "冯学茗", userNo: "80278670", orgName, orgPathName, left: false },
  { userId: "u-yang", userName: "杨康", userNo: "80278671", orgName, orgPathName, left: false },
]

const now = Date.now()
const initialConversations: ProjectConversationSummary[] = [
  {
    conversationId: "c-local-1",
    projectId: "p-retail",
    ownerUserId: SELF_ID,
    deviceId: LOCAL_DEVICE_ID,
    title: "支付失败重试方案",
    status: "idle",
    briefText: "梳理支付与订单调用链的幂等键边界。",
    briefSource: "rule",
    briefUpdatedAtMs: now - 15 * 60_000,
    syncedSequence: 3,
    updatedAt: new Date(now - 15 * 60_000).toISOString(),
    repositories: [{ repositoryId: "r-pay", name: "payment-api" }],
  },
  {
    conversationId: "c-self-other-1",
    projectId: "p-retail",
    ownerUserId: SELF_ID,
    deviceId: "dev-shen-home",
    title: "支付异常复盘（家里电脑）",
    status: "idle",
    briefText: "已复盘上周五晚间通道超时波动，汇总了监控阈值调整建议；当前在办公室电脑查看须保持只读。",
    briefSource: "agent",
    briefUpdatedAtMs: now - 3 * 3600_000,
    syncedSequence: 2,
    updatedAt: new Date(now - 3 * 3600_000).toISOString(),
    repositories: [],
  },
  {
    conversationId: "c-zhang-unsynced",
    projectId: "p-retail",
    ownerUserId: "u-zhang",
    deviceId: "dev-zhang",
    title: "服务 A · 幂等接口设计",
    status: "running",
    briefText: "已确认支付服务使用业务请求号作为幂等键，重复请求返回首次结果；正在补充超时重试的边界说明与工具摘要校验。",
    briefSource: "agent",
    briefUpdatedAtMs: now - 6 * 60_000,
    syncedSequence: 4,
    updatedAt: new Date(now - 6 * 60_000).toISOString(),
    repositories: [{ repositoryId: "r-pay", name: "payment-api" }, { repositoryId: "r-ord", name: "order-api" }],
  },
  {
    conversationId: "c-zhang-update",
    projectId: "p-retail",
    ownerUserId: "u-zhang",
    deviceId: "dev-zhang",
    title: "支付超时监控补充",
    status: "idle",
    briefText: "先缓存了第 1~2 条历史，随后原设备继续上传了第 3~4 条定稿，因此状态呈现「有更新」。",
    briefSource: "rule",
    briefUpdatedAtMs: now - 25 * 60_000,
    syncedSequence: 4,
    updatedAt: new Date(now - 25 * 60_000).toISOString(),
    repositories: [{ repositoryId: "r-pay", name: "payment-api" }],
  },
  {
    conversationId: "c-wang-synced",
    projectId: "p-retail",
    ownerUserId: "u-wang",
    deviceId: "dev-wang",
    title: "服务 B · 错误码约定",
    status: "idle",
    briefText: "已完成订单侧与支付侧错误码映射定稿。",
    briefSource: "rule",
    briefUpdatedAtMs: now - 40 * 60_000,
    syncedSequence: 2,
    updatedAt: new Date(now - 40 * 60_000).toISOString(),
    repositories: [{ repositoryId: "r-ord", name: "order-api" }],
  },
  {
    conversationId: "c-feng-failed",
    projectId: "p-retail",
    ownerUserId: "u-feng",
    deviceId: "dev-feng",
    title: "对账脚本校验（同步失败可重试）",
    status: "error",
    briefText: "首次点同步演示网络异常保留简报与错误提示，再次点击同步可成功恢复并拉取正文。",
    briefSource: "rule",
    briefUpdatedAtMs: now - 55 * 60_000,
    syncedSequence: 2,
    updatedAt: new Date(now - 55 * 60_000).toISOString(),
    repositories: [],
  },
  {
    conversationId: "c-yang-empty",
    projectId: "p-retail",
    ownerUserId: "u-yang",
    deviceId: "dev-yang",
    title: "灰度开关设计（仅简报未传正文）",
    status: "idle",
    briefText: "刚创建会话并登记了标题与简报，原设备尚未上传消息正文。",
    briefSource: "rule",
    briefUpdatedAtMs: now - 70 * 60_000,
    syncedSequence: 0,
    updatedAt: new Date(now - 70 * 60_000).toISOString(),
    repositories: [],
  },
]

const fixtureHistory: Record<string, ProjectHistoryMessage[]> = {
  "c-local-1": [
    { sequence: 1, type: "user", occurredAtMs: now - 20 * 60_000, payload: JSON.stringify({ text: "先梳理支付失败重试和订单状态回传的边界。" }) },
    { sequence: 2, type: "tool_summary", occurredAtMs: now - 18 * 60_000, payload: JSON.stringify({ label: "读取本地文档", name: "read_file", summary: "notes/retry-notes.md · 普通目录可读", status: "completed", tone: "read" }) },
    { sequence: 3, type: "assistant", occurredAtMs: now - 16 * 60_000, payload: JSON.stringify({ text: "已完成本地目录说明的核对：\n- 同一业务请求号只产生一次有效扣款。\n- 网络超时先查单，不直接判失败。" }) },
  ],
  "c-self-other-1": [
    { sequence: 1, type: "user", occurredAtMs: now - 4 * 3600_000, payload: JSON.stringify({ text: "把昨晚通道超时的慢查询指标整理一下。" }) },
    { sequence: 2, type: "assistant", occurredAtMs: now - 3 * 3600_000, payload: JSON.stringify({ text: "这是你在家里电脑上传的记录；换到当前电脑时按规则保持只读。" }) },
  ],
  "c-zhang-unsynced": [
    { sequence: 1, type: "user", occurredAtMs: now - 12 * 60_000, payload: JSON.stringify({ text: "请给出服务 A 幂等键设计与并发超时处理结论。" }) },
    { sequence: 2, type: "tool_summary", occurredAtMs: now - 10 * 60_000, payload: JSON.stringify({ label: "检索代码", name: "grep", summary: "payment-api/src/idempotency · 4 处引用", status: "completed", tone: "read" }) },
    { sequence: 3, type: "status", occurredAtMs: now - 8 * 60_000, payload: JSON.stringify({ text: "已确认幂等键唯一索引方案" }) },
    { sequence: 4, type: "assistant", occurredAtMs: now - 6 * 60_000, payload: JSON.stringify({ text: "幂等键采用 `merchantId + requestNo` 唯一约束；并发请求进入同一记录时返回 `IN_PROGRESS`，不重复下发通道。" }) },
  ],
  "c-zhang-update": [
    { sequence: 1, type: "user", occurredAtMs: now - 35 * 60_000, payload: JSON.stringify({ text: "补充支付通道超时阈值监控。" }) },
    { sequence: 2, type: "assistant", occurredAtMs: now - 32 * 60_000, payload: JSON.stringify({ text: "已加上 P99 > 1.5s 的告警规则。" }) },
    { sequence: 3, type: "tool_summary", occurredAtMs: now - 27 * 60_000, payload: JSON.stringify({ label: "更新监控配置", name: "edit_file", summary: "alerts/payment-timeout.yaml", status: "completed", tone: "write" }) },
    { sequence: 4, type: "assistant", occurredAtMs: now - 25 * 60_000, payload: JSON.stringify({ text: "新增消息：已把熔断降级开关同步进监控面板。" }) },
  ],
  "c-wang-synced": [
    { sequence: 1, type: "user", occurredAtMs: now - 45 * 60_000, payload: JSON.stringify({ text: "对齐可重试错误与终态失败错误。" }) },
    { sequence: 2, type: "assistant", occurredAtMs: now - 40 * 60_000, payload: JSON.stringify({ text: "已区分 `TIMEOUT_RETRYABLE` 与 `BUSINESS_REJECTED` 两类返回码。" }) },
  ],
  "c-feng-failed": [
    { sequence: 1, type: "user", occurredAtMs: now - 60 * 60_000, payload: JSON.stringify({ text: "校验昨日对账脚本输出。" }) },
    { sequence: 2, type: "assistant", occurredAtMs: now - 55 * 60_000, payload: JSON.stringify({ text: "重试同步成功：对账差异记录数为 0。" }) },
  ],
}

function Preview(): ReactElement {
  const [conversations, setConversations] = useState<ProjectConversationSummary[]>(initialConversations)
  const [syncStates, setSyncStates] = useState<Record<string, SessionSyncState>>(() => ({
    "c-local-1": { localSyncedSequence: 3, lastSyncedAtMs: now - 15 * 60_000, syncing: false, syncError: null, messages: fixtureHistory["c-local-1"] },
    "c-zhang-update": { localSyncedSequence: 2, lastSyncedAtMs: now - 30 * 60_000, syncing: false, syncError: null, messages: fixtureHistory["c-zhang-update"].slice(0, 2) },
    "c-wang-synced": { localSyncedSequence: 2, lastSyncedAtMs: now - 38 * 60_000, syncing: false, syncError: null, messages: fixtureHistory["c-wang-synced"] },
    "c-feng-failed": { localSyncedSequence: 0, lastSyncedAtMs: null, syncing: false, syncError: "模拟网络超时：点击「同步会话」重试可恢复", messages: [] },
  }))
  const [personalStates, setPersonalStates] = useState<Record<string, ConversationPersonalState>>({})
  const [directories, setDirectories] = useState<Record<string, string | null>>({
    "c-local-1": "/Users/shen/workspace/plain-notes-folder",
  })
  const [newDraft, setNewDraft] = useState<NewSessionDraft>({ directoryPath: null, draftText: "" })
  const [page, setPage] = useState<ProjectPage>({ kind: "conversation", conversationId: "c-zhang-unsynced" })
  const [expandedMembers, setExpandedMembers] = useState<string[]>(["u-zhang", "u-wang", "u-feng", "u-yang"])
  const [selfCollapsed, setSelfCollapsed] = useState(false)
  const [search, setSearch] = useState("")
  const [left, setLeft] = useState({ open: true, width: 280 })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState("")
  const [windowState, setWindowState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  const failOnceRef = useRef(true)

  useEffect(() => {
    let active = true
    const apply = (state: WindowState) => {
      if (!active) return
      setWindowState(state)
      document.documentElement.dataset.theme = state.colorScheme
    }
    const off = window.workbench.onWindowStateChanged(apply)
    window.workbench.getWindowState().then(apply).catch(() => {})
    return () => { active = false; off() }
  }, [])

  const pickDirectory = async (onPick: (path: string) => void) => {
    try {
      const selected = await window.workbench.chooseDirectory()
      if (selected) { onPick(selected); return }
    } catch {
      // 无原生选择器或取消时保持现状或允许在预览里用默认非 Git 目录样例
    }
    onPick("/Users/shen/Documents/非Git普通工作目录")
  }

  const triggerSync = (conversationId: string) => {
    const conv = conversations.find(item => item.conversationId === conversationId)
    if (!conv) return
    setSyncStates(prev => ({
      ...prev,
      [conversationId]: { ...(prev[conversationId] ?? emptySyncState()), syncing: true, syncError: null },
    }))
    window.setTimeout(() => {
      if (conversationId === "c-feng-failed" && failOnceRef.current) {
        failOnceRef.current = false
        setSyncStates(prev => ({
          ...prev,
          [conversationId]: { ...(prev[conversationId] ?? emptySyncState()), syncing: false, syncError: "模拟网关超时，请再次点击同步" },
        }))
        return
      }
      setSyncStates(prev => {
        const current = prev[conversationId] ?? emptySyncState()
        const merged = mergeIncrementalHistory(
          current.messages,
          current.localSyncedSequence,
          fixtureHistory[conversationId] ?? [],
          conv.syncedSequence,
        )
        return {
          ...prev,
          [conversationId]: {
            localSyncedSequence: merged.syncedSequence,
            lastSyncedAtMs: Date.now(),
            syncing: false,
            syncError: null,
            messages: merged.messages,
          },
        }
      })
    }, 220)
  }

  const provider = createSessionPageProvider({
    projectName: "零售核心架构演进",
    currentUserId: SELF_ID,
    localDeviceId: LOCAL_DEVICE_ID,
    localDeviceName: DEVICE_NAMES[LOCAL_DEVICE_ID],
    conversations,
    syncStates,
    personalStates,
    directories,
    newDraft,
    newSessionBusy: false,
    canCreateConversation: true,
    execution: { getAvailability: () => ({ available: false, reason: "本机 Agent 与 ACP 内核尚未接入，支持选择普通目录与保存草稿。" }) },
    rendering: { copyText: text => window.workbench.copyText(text) },
    resolveOwnerName: userId => members.find(m => m.userId === userId)?.userName ?? userId,
    resolveDeviceName: deviceId => DEVICE_NAMES[deviceId],
    onChooseNewDirectory: () => { void pickDirectory(path => setNewDraft(prev => ({ ...prev, directoryPath: path }))) },
    onNewDraftChange: text => setNewDraft(prev => ({ ...prev, draftText: text })),
    onStartNewSession: () => {
      const id = `c-local-${Date.now()}`
      const title = newDraft.draftText.trim().split("\n")[0]?.slice(0, 24) || "新建本机会话"
      const created: ProjectConversationSummary = {
        conversationId: id,
        projectId: "p-retail",
        ownerUserId: SELF_ID,
        deviceId: LOCAL_DEVICE_ID,
        title,
        status: "idle",
        briefText: newDraft.draftText.trim().slice(0, 120),
        briefSource: "rule",
        briefUpdatedAtMs: Date.now(),
        syncedSequence: 1,
        updatedAt: new Date().toISOString(),
        repositories: [],
      }
      setConversations(prev => [created, ...prev])
      setDirectories(prev => ({ ...prev, [id]: newDraft.directoryPath }))
      setSyncStates(prev => ({
        ...prev,
        [id]: {
          localSyncedSequence: 1,
          lastSyncedAtMs: Date.now(),
          syncing: false,
          syncError: null,
          messages: [{ sequence: 1, type: "user", occurredAtMs: Date.now(), payload: JSON.stringify({ text: newDraft.draftText.trim() }) }],
        },
      }))
      setNewDraft({ directoryPath: null, draftText: "" })
      setPage({ kind: "conversation", conversationId: id })
    },
    onChooseSessionDirectory: conversationId => {
      void pickDirectory(path => setDirectories(prev => ({ ...prev, [conversationId]: path })))
    },
    onSyncConversation: triggerSync,
    onRefreshBrief: conversationId => {
      setConversations(prev => prev.map(item => item.conversationId === conversationId
        ? { ...item, briefUpdatedAtMs: Date.now(), updatedAt: new Date().toISOString() }
        : item))
    },
    onPersonalChange: (scope: ConversationScope, change) => {
      setPersonalStates(prev => ({
        ...prev,
        [scope.conversationId]: applyConversationPersonalChange(prev[scope.conversationId] ?? EMPTY_PERSONAL_STATE, change),
      }))
    },
  })

  const entries = toNavigationSessionEntries(conversations, SELF_ID, LOCAL_DEVICE_ID, syncStates)
  const groups = buildMemberGroups({
    members,
    entries,
    selfUserId: SELF_ID,
    expandedMembers,
    selfCollapsed,
    search,
  })
  const scope = { namespace: "preview", accountId: SELF_ID, workspaceId: "ws-demo", projectId: "p-retail" }
  const navigator = {
    openPage: (next: ProjectPage) => setPage(next),
    locateConversation: (conversationId: string) => {
      const target = conversations.find(item => item.conversationId === conversationId)
      if (!target) return false
      if (target.ownerUserId === SELF_ID) setSelfCollapsed(false)
      else setExpandedMembers(prev => prev.includes(target.ownerUserId) ? prev : [...prev, target.ownerUserId])
      setPage({ kind: "conversation", conversationId })
      return true
    },
  }
  const navActions: ProjectNavigationActions = {
    selectProject: () => {},
    createProject: () => {},
    openProjectSettings: () => setPage({ kind: "info" }),
    openPage: kind => setPage({ kind }),
    selectConversation: conversationId => setPage({ kind: "conversation", conversationId }),
    toggleMember: userId => {
      if (userId === SELF_ID) setSelfCollapsed(value => !value)
      else setExpandedMembers(prev => prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId])
    },
    setSearch,
    retry: () => {},
    openSettings: () => setSettingsOpen(true),
  }

  const center = page.kind === "new" || page.kind === "conversation"
    ? provider.render({ scope, page, navigator, visible: true })
    : (
      <section className="hc218-placeholder" aria-label="其他协作页面占位">
        <h1>{page.kind === "board" ? "项目看板" : page.kind === "tasks" ? "项目任务" : page.kind === "knowledge" ? "团队知识" : "项目资料"}</h1>
        <p>该页面属于 HC-217 / HC-219 / HC-220 范围；HC-218 停点 1 聚焦「新会话」「本人本机会话」与「跨机器只读会话」。</p>
      </section>
    )

  return (
    <WorkbenchLayout
      context={provider.context?.({ scope, page }) ?? { title: "零售核心架构演进", projectName: "零售核心架构演进" }}
      navigation={
        <ProjectNavigation
          view={{
            accountName: "沈北辰",
            workspaceName: "平台架构二组协作区",
            projects: [{ projectId: "p-retail", name: "零售核心架构演进", archived: false }],
            projectsAvailability: { state: "ready" },
            currentProjectId: "p-retail",
            groups,
            membersAvailability: { state: "ready" },
            sessionsAvailability: { state: "ready" },
            search,
            activePage: page.kind === "task" ? "tasks" : page.kind,
            selectedConversationId: page.kind === "conversation" ? page.conversationId : null,
            taskCount: null,
          }}
          actions={navActions}
        />
      }
      center={center}
      right={() => null}
      leftOpen={left.open}
      leftWidthPx={left.width}
      rightOpen={false}
      rightWidthPx={340}
      setPanelOpen={(side, open) => { if (side === "left") setLeft(v => ({ ...v, open })) }}
      setPanelWidth={(side, width) => { if (side === "left") setLeft(v => ({ ...v, width })) }}
      settingsOpen={settingsOpen}
      closeSettings={() => setSettingsOpen(false)}
      settings={
        <div className="hc218-settings">
          <h2>预览设置</h2>
          <label>
            外观主题
            <select
              aria-label="外观主题"
              value={windowState.themeMode}
              onChange={event => void window.workbench.setThemeMode(event.target.value as ThemeMode).then(setWindowState)}
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <div className="hc218-settings-actions">
            <button
              type="button"
              className="wb-button wb-button-secondary wb-button-small"
              onClick={() => {
                // 模拟远端元数据推进水位，检验左栏仅变成“有更新”且绝不自动拉取正文。
                fixtureHistory["c-wang-synced"] = [
                  ...(fixtureHistory["c-wang-synced"] ?? []),
                  { sequence: 3, type: "assistant", occurredAtMs: Date.now(), payload: JSON.stringify({ text: "模拟新增一条远端定稿消息，需手动同步更新后才显示。" }) },
                ]
                setConversations(prev => prev.map(item => item.conversationId === "c-wang-synced"
                  ? { ...item, syncedSequence: 3, updatedAt: new Date().toISOString() }
                  : item))
                setSettingsNotice("已向王大林会话追加 1 条远端水位；左栏已标为「有更新」，正文未被静默下载。")
              }}
            >
              模拟王大林会话收到新消息
            </button>
          </div>
          {settingsNotice ? <p className="hc218-settings-note" role="status">{settingsNotice}</p> : null}
          <p className="hc218-settings-note">本页为 HC-218 停点 1 受控预览，演示本机与跨机器只读/主动同步状态，不连接真实后端或 Agent。</p>
        </div>
      }
    />
  )
}

createRoot(document.getElementById("root")!).render(<Preview />)
