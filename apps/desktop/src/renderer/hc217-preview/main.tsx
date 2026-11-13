/**
 * HC-217 受控 Project 导航预览：固定示例项目、成员与会话 → 公共导航组件 → 中央只显示页面占位。
 * 不连接账号、组织服务、会话同步或 Agent；用于核对左栏布局、折叠、搜索与按项目恢复选择。
 */
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ThemeMode, WindowState } from "@workbench/contracts"
import { ProjectNavigation, WorkbenchLayout, buildMemberGroups } from "@workbench/ui"
import type { NavigationMember, NavigationPageKind, NavigationSessionEntry, ProjectNavigationActions } from "@workbench/ui"
import "@workbench/ui/theme.css"
import "@workbench/ui/navigation.css"
import "@workbench/ui/layout.css"
import "./preview.css"

type Page = { kind: Exclude<NavigationPageKind, "conversation"> } | { kind: "conversation"; conversationId: string }
type ProjectPersonal = { page: Page; expandedMembers: readonly string[]; selfCollapsed: boolean }
type Fixture = { projectId: string; name: string; archived: boolean; members: readonly NavigationMember[]; entries: readonly NavigationSessionEntry[] }

const self: NavigationMember = { userId: "u-zhang", displayName: "张三", username: "zhangsan", left: false }
const li: NavigationMember = { userId: "u-li", displayName: "李四", username: "lisi", left: false }
const wangA: NavigationMember = { userId: "u-wang-a", displayName: "王五", username: "wangwu", left: false }
const wangB: NavigationMember = { userId: "u-wang-b", displayName: "王五", username: "wangwu2", left: false }
const zhao: NavigationMember = { userId: "u-zhao", displayName: "赵六", username: "zhaoliu", left: false }
const sun: NavigationMember = { userId: "u-sun", displayName: "孙七", username: "sunqi", left: true }
const entry = (conversationId: string, owner: NavigationMember, title: string, timeLabel: string, badge?: NavigationSessionEntry["badge"]): NavigationSessionEntry =>
  ({ conversationId, ownerUserId: owner.userId, title, timeLabel, ...(badge ? { badge } : {}) })

const projects: readonly Fixture[] = [
  {
    projectId: "p-payment", name: "支付体验优化", archived: false, members: [self, li, wangA, wangB, zhao],
    entries: [
      entry("c-1", self, "支付失败重试方案", "15:56", { text: "本机", tone: "neutral" }),
      entry("c-2", self, "订单回传接口梳理", "14:20", { text: "本机", tone: "neutral" }),
      entry("c-3", self, "支付异常分析", "昨天", { text: "其他设备 · 只读", tone: "neutral" }),
      ...Array.from({ length: 9 }, (_, index) => entry(`c-self-${index}`, self, `历史讨论 ${index + 1}`, `11-0${(index % 9) + 1}`, { text: "本机", tone: "neutral" })),
      entry("c-4", li, "服务 A · 幂等接口设计", "16:08", { text: "未同步", tone: "accent" }),
      entry("c-5", li, "支付超时监控补充", "15:12", { text: "有更新", tone: "warning" }),
      entry("c-6", wangA, "服务 B · 错误码约定", "16:03", { text: "已同步", tone: "neutral" }),
      entry("c-7", wangB, "对账脚本校验", "13:40", { text: "同步失败", tone: "danger" }),
    ],
  },
  {
    projectId: "p-order", name: "订单中心重构", archived: false, members: [self, li, zhao, sun],
    entries: [
      entry("c-8", li, "订单状态机拆分", "10:30", { text: "未同步", tone: "accent" }),
      entry("c-9", sun, "旧订单迁移评估", "11-08", { text: "已同步", tone: "neutral" }),
    ],
  },
  {
    projectId: "p-legacy", name: "旧版结算下线", archived: true, members: [self, wangA],
    entries: [entry("c-10", self, "下线检查清单", "10-21", { text: "本机", tone: "neutral" })],
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
  }
  return (
    <WorkbenchLayout
      context={{ title: selected?.title ?? pageNames[page.kind], projectName: project.name }}
      navigation={<ProjectNavigation view={{
        accountName: self.displayName,
        workspaceName: "研发协作组",
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
