/**
 * HC-217 受控 Project 导航预览：固定示例项目、成员与会话 → 公共导航组件 → 中央只显示页面占位。
 * 不连接账号、组织服务、会话同步或 Agent；用于核对左栏布局、折叠、搜索与按项目恢复选择。
 */
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ThemeMode, WindowState } from "../../shared/index.js"
import { ProjectNavigation, WorkbenchLayout, buildMemberGroups } from "../../ui/index.js"
import type {
  NavigationMember,
  NavigationPageKind,
  NavigationPersonalEntry,
  NavigationSessionEntry,
  NavigationSpaceKind,
  PersonalNavigationDirectoryGroup,
  ProjectNavigationActions,
} from "../../ui/index.js"
import "../../ui/theme.css"
import "../../ui/navigation/navigation.css"
import "../../ui/layout/layout.css"
import "./preview.css"

type Page = { kind: Exclude<NavigationPageKind, "conversation"> } | { kind: "conversation"; conversationId: string }
type ProjectPersonal = { page: Page; expandedMembers: readonly string[]; selfCollapsed: boolean }
type Fixture = { projectId: string; name: string; archived: boolean; members: readonly NavigationMember[]; entries: readonly NavigationSessionEntry[] }

const orgName = "平台架构二组"
const orgPathName = "信息技术部/架构管理团队/零售应用架构四室/平台架构二组"
const self: NavigationMember = { userId: "u-shen", userName: "沈北辰", userNo: "80278667", orgName, orgPathName, left: false }
const zhang: NavigationMember = { userId: "u-zhang", userName: "张景新", userNo: "80278668", orgName, orgPathName, left: false }
const wang: NavigationMember = { userId: "u-wang", userName: "王大林", userNo: "80278669", orgName, orgPathName, left: false }
const feng: NavigationMember = { userId: "u-feng", userName: "冯学茗", userNo: "80278670", orgName, orgPathName, left: false }
const yang: NavigationMember = { userId: "u-yang", userName: "杨康", userNo: "80278671", orgName, orgPathName, left: false }
const yangLeft: NavigationMember = { userId: "u-yang-2", userName: "杨康", userNo: "80278672", orgName: "零售应用架构四室", left: true }
const entry = (conversationId: string, owner: NavigationMember, title: string, timeLabel: string, badge?: NavigationSessionEntry["badge"]): NavigationSessionEntry =>
  ({ conversationId, ownerUserId: owner.userId, title, timeLabel, ...(badge ? { badge } : {}) })

const projects: readonly Fixture[] = [
  {
    projectId: "p-payment", name: "零售核心架构演进", archived: false, members: [self, zhang, wang, feng, yang],
    entries: [
      entry("c-1", self, "支付失败重试方案", "15:56", { text: "本机", tone: "neutral" }),
      entry("c-2", self, "订单回传接口梳理", "14:20", { text: "本机", tone: "neutral" }),
      { ...entry("c-3", self, "支付异常分析", "昨天"), remoteSelf: true },
      ...Array.from({ length: 9 }, (_, index) => entry(`c-self-${index}`, self, `历史讨论 ${index + 1}`, `11-0${(index % 9) + 1}`, { text: "本机", tone: "neutral" })),
      entry("c-4", zhang, "服务 A · 幂等接口设计", "16:08", { text: "未同步", tone: "accent" }),
      entry("c-5", zhang, "支付超时监控补充", "15:12", { text: "有更新", tone: "warning" }),
      entry("c-6", wang, "服务 B · 错误码约定", "16:03", { text: "已同步", tone: "neutral" }),
      entry("c-7", feng, "对账脚本校验", "13:40", { text: "同步失败", tone: "danger" }),
    ],
  },
  {
    projectId: "p-order", name: "中台服务治理专项", archived: false, members: [self, zhang, yang, yangLeft],
    entries: [
      entry("c-8", zhang, "订单状态机拆分", "10:30", { text: "未同步", tone: "accent" }),
      entry("c-9", yangLeft, "旧订单迁移评估", "11-08", { text: "已同步", tone: "neutral" }),
    ],
  },
  {
    projectId: "p-legacy", name: "旧版结算下线", archived: true, members: [self, wang],
    entries: [entry("c-10", self, "下线检查清单", "10-21", { text: "本机", tone: "neutral" })],
  },
]
/** HC-257 演示数据：置顶、目录分组与已归档个人会话，用于预览新区域与分组「更多」菜单。 */
const personalEntry = (
  conversationId: string,
  title: string,
  timeLabel: string,
  overrides: Partial<NavigationPersonalEntry> = {},
): NavigationPersonalEntry => ({ conversationId, title, timeLabel, status: "idle", shareStatus: "local_only", ...overrides })

const personalPinned: readonly NavigationPersonalEntry[] = [
  personalEntry("pc-pin-1", "对账脚本线上排查", "09:41", { pinned: true, directoryLabel: "retail-core", hasDirectory: true, status: "running" }),
  personalEntry("pc-pin-2", "每日构建失败跟踪", "昨天", { pinned: true, directoryLabel: "未设置目录" }),
]
const personalArchived: readonly NavigationPersonalEntry[] = [
  personalEntry("pc-arc-1", "旧网关压测记录", "11-02", { archived: true, directoryLabel: "gateway-bench", hasDirectory: true }),
  personalEntry("pc-arc-2", "移动端灰度方案草稿", "10-28", { archived: true, directoryLabel: "未设置目录", shareStatus: "stopped" }),
]
const personalGroupsFixture: readonly PersonalNavigationDirectoryGroup[] = [
  {
    directoryKey: "/Users/dev/Projects/retail-core",
    directoryPath: "/Users/dev/Projects/retail-core",
    label: "retail-core",
    records: [
      personalEntry("pc-1", "支付链路超时复盘", "16:20", { hasDirectory: true }),
      personalEntry("pc-2", "结算任务幂等改造", "15:05", { shareStatus: "stopped", hasDirectory: true }),
      personalEntry("pc-3", "库存扣减回滚脚本", "11-19", { hasDirectory: true }),
    ],
  },
  {
    directoryKey: "__unset__",
    directoryPath: null,
    label: "未设置目录",
    records: [personalEntry("pc-4", "随手记的接口问题", "11-15")],
  },
]
const pageNames: Record<Page["kind"], string> = {
  new: "新对话准备页", conversation: "会话", board: "项目看板", tasks: "项目任务", info: "项目资料", knowledge: "团队知识",
}
const owners: Record<Page["kind"], string> = {
  new: "HC-218", conversation: "HC-218", board: "HC-220", tasks: "HC-219", info: "HC-217 停点二", knowledge: "HC-219",
}

function Preview() {
  const [projectId, setProjectId] = useState<string>("p-payment")
  const [personal, setPersonal] = useState<Record<string, ProjectPersonal>>({
    "p-payment": { page: { kind: "conversation", conversationId: "c-1" }, expandedMembers: [], selfCollapsed: false },
  })
  const [search, setSearch] = useState("")
  const [space, setSpace] = useState<NavigationSpaceKind>("personal")
  const [personalSearch, setPersonalSearch] = useState("")
  const [includeArchived, setIncludeArchived] = useState(false)
  const [selectedPersonalId, setSelectedPersonalId] = useState<string | null>("pc-1")
  const [settings, setSettings] = useState(false)
  const [notice, setNotice] = useState("")
  const [left, setLeft] = useState({ open: true, width: 280 })
  const [windowState, setWindowState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  useEffect(() => {
    let active = true
    const update = (state: WindowState) => {
      if (!active) return
      setWindowState(state)
      document.documentElement.dataset.theme = state.colorScheme
    }
    const off = window.workbench.onWindowStateChanged(update)
    window.workbench.getWindowState().then(update).catch(() => {})
    return () => { active = false; off() }
  }, [])

  const project = projects.find(item => item.projectId === projectId)!
  const current = personal[projectId] ?? { page: { kind: "new" }, expandedMembers: [], selfCollapsed: false }
  const update = (change: (value: ProjectPersonal) => ProjectPersonal) =>
    setPersonal(previous => ({ ...previous, [projectId]: change(previous[projectId] ?? current) }))
  const groups = buildMemberGroups({
    members: project.members, entries: project.entries, selfUserId: self.userId,
    expandedMembers: current.expandedMembers, selfCollapsed: current.selfCollapsed, search,
  })
  const page = current.page
  const selected = page.kind === "conversation" ? project.entries.find(item => item.conversationId === page.conversationId) : undefined
  const actions: ProjectNavigationActions = {
    selectProject: id => { setProjectId(id); setSearch(""); setNotice("") },
    createProject: () => setNotice("创建项目将在停点二接入真实接口。"),
    openProjectSettings: () => { setNotice(""); update(value => ({ ...value, page: { kind: "info" } })) },
    openPage: kind => { setNotice(""); update(value => ({ ...value, page: { kind } })) },
    selectConversation: conversationId => { setNotice(""); update(value => ({ ...value, page: { kind: "conversation", conversationId } })) },
    toggleMember: userId => update(value => userId === self.userId
      ? { ...value, selfCollapsed: !value.selfCollapsed }
      : { ...value, expandedMembers: value.expandedMembers.includes(userId) ? value.expandedMembers.filter(id => id !== userId) : [...value.expandedMembers, userId] }),
    setSearch,
    retry: () => {},
    openSettings: () => setSettings(true),
    selectSpace: next => { setSpace(next); setNotice("") },
    createPersonalSession: () => { setSelectedPersonalId(null); setNotice("演示：新建个人会话") },
    selectPersonalConversation: id => { setSelectedPersonalId(id); setNotice("") },
    renamePersonalConversation: async () => { setNotice("演示：重命名个人会话"); return null },
    publishPersonalConversation: () => { setNotice("演示：发布到项目…") },
    pinPersonalConversation: async () => { setNotice("演示：置顶/取消置顶"); return null },
    archivePersonalConversation: async () => { setNotice("演示：归档会话"); return null },
    restorePersonalConversation: async () => { setNotice("演示：取消归档"); return null },
    deletePersonalConversation: async () => { setNotice("演示：删除会话"); return null },
    copyPersonalConversationMarkdown: async () => { setNotice("演示：复制为 Markdown"); return null },
    copyPersonalDirectoryPath: async () => { setNotice("演示：复制目录路径"); return null },
    revealPersonalDirectory: async () => { setNotice("演示：在文件管理器中显示"); return null },
    archivePersonalGroup: async () => { setNotice("演示：归档整组"); return null },
    deletePersonalGroup: async () => { setNotice("演示：删除整组会话"); return null },
    newPersonalSessionInDirectory: () => { setSelectedPersonalId(null); setNotice("演示：在此目录新建会话") },
    setPersonalSearch: text => setPersonalSearch(text),
    setPersonalIncludeArchived: next => setIncludeArchived(next),
  }
  return (
    <WorkbenchLayout
      context={{ title: selected?.title ?? pageNames[page.kind], projectName: project.name }}
      navigation={<ProjectNavigation view={{
        accountName: self.userName,
        workspaceName: "平台架构二组协作区",
        projects: projects.map(({ projectId, name, archived }) => ({ projectId, name, archived })),
        projectsAvailability: { state: "ready" },
        currentProjectId: projectId,
        groups,
        membersAvailability: { state: "ready" },
        sessionsAvailability: { state: "ready" },
        search,
        activePage: page.kind,
        selectedConversationId: page.kind === "conversation" ? page.conversationId : null,
        taskCount: projectId === "p-payment" ? 2 : null,
        activeSpace: space,
        canPublishPersonal: true,
        personalGroups: personalGroupsFixture,
        pinnedPersonal: personalPinned,
        archivedPersonal: personalArchived,
        personalIncludeArchived: includeArchived,
        personalSearch,
        selectedPersonalConversationId: selectedPersonalId,
        publishedSessionCount: 3,
      }} actions={actions} />}
      center={<section className="hc217-page" aria-label="中央页面">
        <h1>{selected?.title ?? pageNames[page.kind]}</h1>
        <p>{project.name} · {pageNames[page.kind]}页面由 {owners[page.kind]} 接入</p>
        {notice && <p role="status">{notice}</p>}
      </section>}
      right={() => null}
      leftOpen={left.open}
      leftWidthPx={left.width}
      rightOpen={false}
      rightWidthPx={340}
      setPanelOpen={(side, open) => { if (side === "left") setLeft(value => ({ ...value, open })) }}
      setPanelWidth={(side, width) => { if (side === "left") setLeft(value => ({ ...value, width })) }}
      settingsOpen={settings}
      closeSettings={() => setSettings(false)}
      settings={<div className="hc217-settings">
        <h2>设置</h2>
        <label>外观
          <select aria-label="外观" value={windowState.themeMode} onChange={event => {
            void window.workbench.setThemeMode(event.target.value as ThemeMode).then(setWindowState)
          }}>
            <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
          </select>
        </label>
        <p>本页为隔离的受控预览，项目、成员与会话均为固定示例。</p>
      </div>}
    />
  )
}
createRoot(document.getElementById("root")!).render(<Preview />)
