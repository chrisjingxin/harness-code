/**
 * HC-255 工作台双层交互原型纯逻辑单元测试：
 * 1. 合并看板状态四列（todo/doing/review/done）+ 已取消归档 + 归属筛选与成员聚合；
 * 2. ⌘K 全局命令面板跨个人/团队会话、任务、未归档知识与直达入口检索分组及条数上限；
 * 3. 原 tasks/task 与 DeepLink 到看板 `.t-drawer` 抽屉及「返回收件箱」的路由映射，以及管理台真实 6 分区约束。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BoardResponse, ConversationSummary, KnowledgeSummary, TaskSummary } from "@workbench/collaboration-client/types"
import type { NavigationMember, NavigationSessionEntry } from "../src/ui/index.ts"
import { ADMIN_NAV_GROUPS, ADMIN_SECTION_META } from "../src/renderer/features/admin/admin-model.ts"
import { AgentPreflightCard } from "../src/renderer/features/personal-sessions/agent-preflight-card.tsx"
import {
  BOARD_PRIMARY_STATUSES,
  boardTaskStatusTone,
  boardTaskStatuses,
  buildBoardModel,
  buildBoardTaskColumns,
  isBoardRoutePage,
  resolveBoardDrawerTaskId,
  shouldShowReturnToInbox,
} from "../src/renderer/features/board/board-model.ts"
import { buildCommandPaletteGroups } from "../src/renderer/features/collaboration-views/command-palette-model.ts"
import { resolveDeepLinkNavigation } from "../src/renderer/features/inbox/inbox-model.ts"
import {
  resolveFallbackTeamPageForTopNav,
  resolveProjectPageNavTarget,
  resolveReturnToInboxOnNav,
} from "../src/renderer/features/project-navigation/contracts.ts"
import { ProjectNavigation } from "../src/ui/navigation/index.tsx"
import { buildSessionBadge } from "../src/renderer/features/session/session-model.ts"

const ACCOUNT_SELF = "user-self"
const ACCOUNT_PEER = "user-peer"
const ACCOUNT_LEAD = "user-lead"

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    taskId: "task-1",
    projectId: "proj-1",
    title: "默认任务",
    creatorId: ACCOUNT_LEAD,
    assigneeId: ACCOUNT_SELF,
    status: "todo",
    version: 1,
    conversationId: null,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  }
}

function makeConversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: "conv-1",
    projectId: "proj-1",
    ownerUserId: ACCOUNT_SELF,
    title: "本机联调会话",
    status: "idle",
    briefText: "已完成初步接口联调",
    briefSource: "rule",
    briefUpdatedAtMs: 1_700_000_001_000,
    syncedSequence: 4,
    updatedAt: "2026-11-24T08:00:00Z",
    shareMode: "full",
    shareStatus: "active",
    stoppedAt: null,
    repositories: [],
    ...overrides,
  }
}

test("buildBoardTaskColumns 始终输出状态四列并支持全部/指派给我/我发布的与已取消归档", () => {
  assert.deepEqual(BOARD_PRIMARY_STATUSES, ["todo", "doing", "review", "done"])
  assert.equal(boardTaskStatuses.todo, "待接收")
  assert.equal(boardTaskStatusTone("todo"), "muted")
  assert.equal(boardTaskStatusTone("doing"), "info")
  assert.equal(boardTaskStatusTone("review"), "warn")
  assert.equal(boardTaskStatusTone("done"), "success")
  assert.equal(boardTaskStatusTone("cancelled"), "danger")

  const tasks: TaskSummary[] = [
    makeTask({ taskId: "t-todo-old", status: "todo", creatorId: ACCOUNT_LEAD, assigneeId: ACCOUNT_SELF, updatedAtMs: 100 }),
    makeTask({ taskId: "t-todo-new", status: "todo", creatorId: ACCOUNT_SELF, assigneeId: ACCOUNT_PEER, updatedAtMs: 200 }),
    makeTask({ taskId: "t-doing", status: "doing", creatorId: ACCOUNT_SELF, assigneeId: ACCOUNT_SELF, updatedAtMs: 300 }),
    makeTask({ taskId: "t-done", status: "done", creatorId: ACCOUNT_PEER, assigneeId: ACCOUNT_SELF, updatedAtMs: 400 }),
    makeTask({ taskId: "t-cancel", status: "cancelled", creatorId: ACCOUNT_SELF, assigneeId: ACCOUNT_PEER, updatedAtMs: 500 }),
  ]

  // 全部任务：四列全展示（review 空列保留），todo 内按 updatedAtMs 降序，cancelled 单独归档
  const all = buildBoardTaskColumns({ tasks, scope: "all", accountId: ACCOUNT_SELF })
  assert.deepEqual(all.columns.map(col => col.status), ["todo", "doing", "review", "done"])
  assert.deepEqual(all.columns[0]!.tasks.map(t => t.taskId), ["t-todo-new", "t-todo-old"])
  assert.deepEqual(all.columns[2]!.tasks, [])
  assert.deepEqual(all.columns[3]!.tasks.map(t => t.taskId), ["t-done"])
  assert.deepEqual(all.cancelledTasks.map(t => t.taskId), ["t-cancel"])
  assert.deepEqual(all.counts, { total: 5, active: 3, done: 1, cancelled: 1 })

  // 指派给我
  const assigned = buildBoardTaskColumns({ tasks, scope: "assigned", accountId: ACCOUNT_SELF })
  assert.deepEqual(assigned.counts, { total: 3, active: 2, done: 1, cancelled: 0 })
  assert.deepEqual(assigned.columns[0]!.tasks.map(t => t.taskId), ["t-todo-old"])

  // 我发布的
  const published = buildBoardTaskColumns({ tasks, scope: "published", accountId: ACCOUNT_SELF })
  assert.deepEqual(published.counts, { total: 3, active: 2, done: 0, cancelled: 1 })
  assert.deepEqual(published.cancelledTasks.map(t => t.taskId), ["t-cancel"])

  // buildBoardModel 成员进展统计仍与看板接口保持兼容
  const boardResponse: BoardResponse = {
    projectId: "proj-1",
    members: [
      {
        userId: ACCOUNT_SELF,
        name: "本人",
        status: "active",
        deviceOnline: true,
        conversationIds: ["conv-1"],
        receivedTaskIds: ["t-todo-old", "t-doing"],
        sentTaskIds: ["t-todo-new"],
      },
      {
        userId: ACCOUNT_PEER,
        name: "已离开同事",
        status: "removed",
        deviceOnline: false,
        conversationIds: [],
        receivedTaskIds: ["t-todo-new"],
        sentTaskIds: [],
      },
    ],
    conversations: [{ conversation: makeConversation(), deviceOnline: true }],
    tasks: tasks.filter(t => t.status !== "cancelled"),
    conversationsTruncated: false,
    tasksTruncated: false,
  }
  const boardModel = buildBoardModel(boardResponse)
  assert.equal(boardModel.activeMembers, 1)
  assert.equal(boardModel.members[0]!.received, 2)
  assert.equal(boardModel.members[0]!.sent, 1)
  assert.equal(boardModel.members[0]!.conversations.length, 1)
})

test("buildCommandPaletteGroups 在个人离线与在线团队模式下均正确分组、限流并过滤已归档知识", () => {
  const members: NavigationMember[] = [
    { userId: ACCOUNT_SELF, userName: "张工程师", userNo: "001", left: false },
    { userId: ACCOUNT_PEER, userName: "李前端", userNo: "002", left: false },
  ]
  const personalSessions = [
    { conversationId: "p-1", title: "修复登录鉴权", directoryLabel: "harness-code", timeLabel: "10:20" },
    { conversationId: "p-2", title: "重构桌面壳层", directoryLabel: "workbench-ui", timeLabel: "09:15" },
    { conversationId: "p-3", title: "构建脚本排查", directoryLabel: "scripts", timeLabel: "昨天" },
    { conversationId: "p-4", title: "性能压测记录", directoryLabel: "bench-repo", timeLabel: "前天" },
  ]
  const mySessions: NavigationSessionEntry[] = [
    { conversationId: "t-1", ownerUserId: ACCOUNT_SELF, title: "看板抽屉联调", timeLabel: "刚刚" },
  ]
  const peerSessions: NavigationSessionEntry[] = [
    { conversationId: "t-2", ownerUserId: ACCOUNT_PEER, title: "SSE 断线重连排查", timeLabel: "5分钟前" },
  ]
  const tasks: TaskSummary[] = [
    makeTask({ taskId: "task-a", title: "完成停点 4 验收", assigneeId: ACCOUNT_PEER, status: "review" }),
  ]
  const knowledge: KnowledgeSummary[] = [
    {
      knowledgeId: "k-1",
      termKey: "desktop-drawer-spec",
      category: "架构",
      title: "双层工作台设计约定",
      currentVersionId: "v-2",
      version: 2,
      archived: false,
      updatedAtMs: 1_700_000_000_000,
    },
    {
      knowledgeId: "k-2",
      termKey: "legacy-modal",
      category: "规范",
      title: "旧弹窗规范（已归档）",
      currentVersionId: "v-1",
      version: 1,
      archived: true,
      updatedAtMs: 1_699_000_000_000,
    },
  ]
  const quickActions = Array.from({ length: 6 }, (_, i) => ({
    id: `act-${i + 1}`,
    title: `快捷入口 ${i + 1}`,
    sub: i === 5 ? "前往管理台" : "视图跳转",
    onSelect: () => {},
  }))

  // 1. 仅个人/离线无团队数据时，只展示个人会话（默认上限 3 条）和工作台直达（上限 5 条）
  const personalOnly = buildCommandPaletteGroups({
    query: "",
    personalSessions,
    quickActions,
  })
  assert.deepEqual(personalOnly.map(g => g.label), ["个人本机会话", "工作台直达"])
  assert.equal(personalOnly[0]!.items.length, 3)
  assert.equal(personalOnly[1]!.items.length, 5)

  // 2. 在线团队空查询：全量覆盖个人+团队+队友+任务+未归档知识+直达，且剔除 archived 知识
  const fullDefault = buildCommandPaletteGroups({
    query: "",
    projectName: "桌面改版",
    personalSessions,
    members,
    mySessions,
    peerSessions,
    tasks,
    knowledge,
    quickActions,
  })
  assert.deepEqual(fullDefault.map(g => g.label), [
    "个人本机会话",
    "当前项目会话",
    "队友会话（只读）",
    "任务",
    "知识",
    "工作台直达",
  ])
  const knowledgeItems = fullDefault.find(g => g.label === "知识")!.items
  assert.deepEqual(knowledgeItems.map(item => item.id), ["k-1"])

  // 3. 按关键词匹配目录名、队友名字/任务负责人、termKey 均生效且解除默认 3 条预览上限
  const byDir = buildCommandPaletteGroups({
    query: "bench-repo",
    personalSessions,
    quickActions,
  })
  assert.deepEqual(byDir.map(g => g.label), ["个人本机会话"])
  assert.equal(byDir[0]!.items[0]!.id, "p-4")

  const byMember = buildCommandPaletteGroups({
    query: "李前端",
    members,
    peerSessions,
    tasks,
  })
  assert.deepEqual(byMember.map(g => g.label), ["队友会话（只读）", "任务"])
  assert.equal(byMember[0]!.items[0]!.id, "t-2")
  assert.equal(byMember[1]!.items[0]!.id, "task-a")

  const byTermKey = buildCommandPaletteGroups({
    query: "desktop-drawer-spec",
    knowledge,
  })
  assert.deepEqual(byTermKey.map(g => g.label), ["知识"])
  assert.equal(byTermKey[0]!.items[0]!.id, "k-1")

  // 搜索已归档知识键仍不可命中
  const archivedHit = buildCommandPaletteGroups({
    query: "legacy-modal",
    knowledge,
  })
  assert.equal(archivedHit.length, 0)
})

test("看板抽屉与 DeepLink 路由映射收敛至 board/.t-drawer，管理台仅保留 6 项已实现分组", () => {
  // 1. board / tasks / task 均归属看板主视图；仅 task 打开右侧 .t-drawer 抽屉及「返回收件箱」
  assert.equal(isBoardRoutePage({ kind: "board" }), true)
  assert.equal(isBoardRoutePage({ kind: "tasks" }), true)
  assert.equal(isBoardRoutePage({ kind: "task" }), true)
  assert.equal(isBoardRoutePage({ kind: "conversation" }), false)
  assert.equal(isBoardRoutePage({ kind: "knowledge" }), false)

  assert.equal(resolveBoardDrawerTaskId({ kind: "board" }), null)
  assert.equal(resolveBoardDrawerTaskId({ kind: "tasks" }), null)
  assert.equal(resolveBoardDrawerTaskId({ kind: "task", taskId: "task-99" }), "task-99")

  assert.equal(shouldShowReturnToInbox(true, { kind: "task" }), true)
  assert.equal(shouldShowReturnToInbox(true, { kind: "board" }), false)
  assert.equal(shouldShowReturnToInbox(false, { kind: "task" }), false)

  // 2. workbench://open/task?... 经安全校验后映射为 reveal_task -> { kind: "task", taskId } -> 抽屉打开
  const decision = resolveDeepLinkNavigation({
    target: {
      kind: "task",
      workspaceId: "ws-1",
      projectId: "proj-1",
      taskId: "task-88",
    },
    offline: false,
    workspaceIds: ["ws-1"],
  })
  assert.equal(decision.action, "reveal_task")
  if (decision.action === "reveal_task") {
    const targetPage = { kind: "task", taskId: decision.taskId } as const
    assert.equal(isBoardRoutePage(targetPage), true)
    assert.equal(resolveBoardDrawerTaskId(targetPage), "task-88")
    assert.equal(shouldShowReturnToInbox(true, targetPage), true)
  }

  // 3. 管理台导航分组仅包含已实现真实分区（含本机 Agent 探测面板，无未开发空壳）
  const navIds = ADMIN_NAV_GROUPS.flatMap(group => group.items.map(item => item.id))
  assert.deepEqual(navIds, ["appearance", "agents", "notifications", "memory", "account", "team"])
  assert.deepEqual(Object.keys(ADMIN_SECTION_META), navIds)

  // 4. 首页 AgentPreflightCard 在就绪/探测中返回空，仅全部不可用时提示；管理台 panel 模式展示完整列表
  const readyBanner = renderToStaticMarkup(createElement(AgentPreflightCard, {
    mode: "banner",
    providers: [{ id: "harness", label: "Harness Code", available: true }],
    checking: false,
    onRefresh: () => {},
  }))
  assert.equal(readyBanner, "")

  const blockedBanner = renderToStaticMarkup(createElement(AgentPreflightCard, {
    mode: "banner",
    providers: [{ id: "harness", label: "Harness Code", available: false, reason: "未找到可执行文件" }],
    checking: false,
    onRefresh: () => {},
    onOpenSettings: () => {},
  }))
  assert.match(blockedBanner, /未检测到可用的本机 Agent/)
  assert.match(blockedBanner, /本机 Agent 设置/)

  const adminPanel = renderToStaticMarkup(createElement(AgentPreflightCard, {
    mode: "panel",
    providers: [{ id: "harness", label: "Harness Code", available: true }],
    checking: false,
    onRefresh: () => {},
  }))
  assert.match(adminPanel, /Harness Code/)
  assert.match(adminPanel, /重新检测/)
})

test("队友已停止同步会话（含 summary_only）不再显示有未同步更新红点", () => {
  const stoppedBadge = buildSessionBadge({
    kind: "remote_other",
    syncStatus: "unsynced",
    remoteSyncedSequence: 0,
    shareMode: "summary_only",
    shareStatus: "stopped",
  })
  assert.deepEqual(stoppedBadge, { text: "已停止同步", tone: "warning" })

  const activeUpdateBadge = buildSessionBadge({
    kind: "remote_other",
    syncStatus: "has_update",
    remoteSyncedSequence: 4,
    shareMode: "full",
    shareStatus: "active",
  })
  assert.deepEqual(activeUpdateBadge, { text: "有更新", tone: "warning" })

  const renderPeer = (badge: NavigationSessionEntry["badge"]) =>
    renderToStaticMarkup(createElement(ProjectNavigation, {
      view: {
        accountName: "张景新",
        workspaceName: "平台架构二组协作区",
        currentWorkspaceId: "ws-1",
        projects: [{ projectId: "proj-1", name: "零售核心架构演进", archived: false }],
        projectsAvailability: { state: "ready" },
        currentProjectId: "proj-1",
        groups: [
          {
            userId: ACCOUNT_PEER,
            label: "沈北辰",
            initial: "沈",
            self: false,
            collapsed: false,
            sessions: [{
              conversationId: "conv-peer",
              ownerUserId: ACCOUNT_PEER,
              title: "摘要会话",
              timeLabel: "10:00",
              badge,
            }],
          },
        ],
        membersAvailability: { state: "ready" },
        sessionsAvailability: { state: "ready" },
        search: "",
        activePage: "conversation",
        selectedConversationId: null,
        taskCount: 0,
        activeSpace: "team",
      },
      actions: {
        selectProject: () => {},
        createProject: () => {},
        openProjectSettings: () => {},
        openPage: () => {},
        selectConversation: () => {},
        toggleMember: () => {},
        setSearch: () => {},
        retry: () => {},
        openSettings: () => {},
      },
    }))

  const stoppedHtml = renderPeer(stoppedBadge)
  assert.match(stoppedHtml, /已停止同步/)
  assert.doesNotMatch(stoppedHtml, /aria-label="有未同步更新"/)

  const updateHtml = renderPeer(activeUpdateBadge)
  assert.match(updateHtml, /有更新/)
  assert.match(updateHtml, /aria-label="有未同步更新"/)
})

test("resolveProjectPageNavTarget 为项目资料与团队会话保留目标子页并切回团队空间", () => {
  assert.deepEqual(resolveProjectPageNavTarget("info"), {
    nav: "chat",
    targetSpace: "team",
    preserveTeamPage: true,
  })
  assert.deepEqual(resolveProjectPageNavTarget("new"), {
    nav: "chat",
    targetSpace: "team",
    preserveTeamPage: true,
  })
  assert.deepEqual(resolveProjectPageNavTarget("conversation"), {
    nav: "chat",
    targetSpace: "team",
    preserveTeamPage: true,
  })
  assert.deepEqual(resolveProjectPageNavTarget("board"), { nav: "board" })
  assert.deepEqual(resolveProjectPageNavTarget("tasks"), { nav: "board" })
  assert.deepEqual(resolveProjectPageNavTarget("task"), { nav: "board" })
  assert.deepEqual(resolveProjectPageNavTarget("knowledge"), { nav: "knowledge" })
})

test("resolveFallbackTeamPageForTopNav 存在待定位任务时不覆盖非看板旧子页", () => {
  assert.equal(
    resolveFallbackTeamPageForTopNav({
      topNav: "board",
      page: { kind: "info" },
      pendingRevealKind: "task",
    }),
    null,
  )
  assert.equal(
    resolveFallbackTeamPageForTopNav({
      topNav: "board",
      page: { kind: "conversation", conversationId: "conv-1" },
      pendingRevealKind: "task",
    }),
    null,
  )
  assert.equal(
    resolveFallbackTeamPageForTopNav({
      topNav: "board",
      page: { kind: "task", taskId: "task-1" },
      pendingRevealKind: null,
    }),
    null,
  )
  assert.deepEqual(
    resolveFallbackTeamPageForTopNav({
      topNav: "board",
      page: { kind: "info" },
      pendingRevealKind: null,
    }),
    { kind: "board" },
  )
  assert.deepEqual(
    resolveFallbackTeamPageForTopNav({
      topNav: "knowledge",
      page: { kind: "info" },
      pendingRevealKind: null,
    }),
    { kind: "knowledge" },
  )
})

test("resolveReturnToInboxOnNav 在任务定位跳转看板时保留返回按钮，主动切栏时清除", () => {
  assert.equal(resolveReturnToInboxOnNav(true, "board", { preserveReturnToInbox: true }), true)
  assert.equal(resolveReturnToInboxOnNav(true, "board"), false)
  assert.equal(resolveReturnToInboxOnNav(true, "chat"), false)
  assert.equal(resolveReturnToInboxOnNav(true, "inbox"), true)
  assert.equal(resolveReturnToInboxOnNav(false, "board", { preserveReturnToInbox: true }), false)
})

/**
 * HC-257 个人栏整理（置顶/已归档/目录分组批量操作）：
 * 菜单项规划纯函数覆盖 Spec 6.3 的条件与置灰原因，静态渲染验证置顶/已归档区与「含已归档」开关。
 */
import {
  planGroupMenu,
  planPersonalMenu,
  type NavigationPersonalEntry,
  type PersonalNavigationDirectoryGroup,
  type ProjectNavigationActions,
} from "../src/ui/navigation/index.tsx"

const personalEntry = (overrides: Partial<NavigationPersonalEntry> = {}): NavigationPersonalEntry => ({
  conversationId: "conv-p1",
  title: "个人会话",
  timeLabel: "10:00",
  status: "idle",
  shareStatus: "local_only",
  directoryLabel: "retail-core",
  hasDirectory: true,
  ...overrides,
})

const allPersonalActions: ProjectNavigationActions = {
  selectProject: () => {},
  createProject: () => {},
  openProjectSettings: () => {},
  openPage: () => {},
  selectConversation: () => {},
  toggleMember: () => {},
  setSearch: () => {},
  retry: () => {},
  openSettings: () => {},
  renamePersonalConversation: async () => null,
  publishPersonalConversation: () => {},
  pinPersonalConversation: async () => null,
  archivePersonalConversation: async () => null,
  restorePersonalConversation: async () => null,
  deletePersonalConversation: async () => null,
  copyPersonalConversationMarkdown: async () => null,
  copyPersonalDirectoryPath: async () => null,
  revealPersonalDirectory: async () => null,
  archivePersonalGroup: async () => null,
  deletePersonalGroup: async () => null,
  newPersonalSessionInDirectory: () => {},
  setPersonalIncludeArchived: () => {},
}

test("planPersonalMenu 未归档会话按 Spec 6.3 输出全部菜单项", () => {
  const items = planPersonalMenu(personalEntry(), allPersonalActions)
  assert.deepEqual(
    items.map(item => item.id),
    ["rename", "pin", "copy-markdown", "copy-directory", "reveal-directory", "publish", "archive", "delete"],
  )
  assert.equal(items.find(item => item.id === "pin")?.label, "置顶")
  assert.equal(items.find(item => item.id === "delete")?.danger, true)
  assert.ok(items.every(item => !item.disabled))
})

test("planPersonalMenu 运行中会话置灰归档/删除，已停止共享置灰删除，已归档只出取消归档", () => {
  const running = planPersonalMenu(personalEntry({ status: "running" }), allPersonalActions)
  assert.equal(running.find(item => item.id === "archive")?.disabled, true)
  assert.equal(running.find(item => item.id === "archive")?.disabledReason, "会话正在运行，请先停止")
  assert.equal(running.find(item => item.id === "delete")?.disabledReason, "会话正在运行，请先停止")

  const stopped = planPersonalMenu(personalEntry({ shareStatus: "stopped" }), allPersonalActions)
  assert.equal(stopped.find(item => item.id === "delete")?.disabled, true)
  assert.equal(stopped.find(item => item.id === "delete")?.disabledReason, "该会话在团队侧仍有记录，暂不能删除")
  assert.equal(stopped.find(item => item.id === "publish"), undefined)

  const archived = planPersonalMenu(personalEntry({ archived: true }), allPersonalActions)
  assert.deepEqual(
    archived.map(item => item.id),
    ["rename", "copy-markdown", "copy-directory", "reveal-directory", "restore", "delete"],
  )
})

test("planPersonalMenu 无目录会话隐藏目录项，离线时发布置灰，置顶项按状态切换文案", () => {
  const noDir = planPersonalMenu(personalEntry({ directoryLabel: "未设置目录", hasDirectory: false }), allPersonalActions)
  assert.equal(noDir.find(item => item.id === "copy-directory"), undefined)
  assert.equal(noDir.find(item => item.id === "reveal-directory"), undefined)

  const offline = planPersonalMenu(personalEntry(), allPersonalActions, { offline: true })
  assert.equal(offline.find(item => item.id === "publish")?.disabled, true)
  assert.equal(offline.find(item => item.id === "publish")?.disabledReason, "协作服务离线，暂不可发布")

  const pinned = planPersonalMenu(personalEntry({ pinned: true }), allPersonalActions)
  assert.equal(pinned.find(item => item.id === "pin")?.label, "取消置顶")
})

test("planGroupMenu 按目录与组内会话产出分组「更多」菜单项", () => {
  const withDir: PersonalNavigationDirectoryGroup = {
    directoryKey: "/repo/retail-core",
    directoryPath: "/repo/retail-core",
    label: "retail-core",
    records: [personalEntry()],
  }
  assert.deepEqual(
    planGroupMenu(withDir, allPersonalActions).map(item => item.id),
    ["new-in-directory", "copy-directory", "reveal-directory", "archive-group", "delete-group"],
  )
  assert.equal(planGroupMenu(withDir, allPersonalActions).find(item => item.id === "delete-group")?.danger, true)

  const noDir: PersonalNavigationDirectoryGroup = { ...withDir, directoryPath: null, label: "未设置目录" }
  assert.deepEqual(
    planGroupMenu(noDir, allPersonalActions).map(item => item.id),
    ["archive-group", "delete-group"],
  )
})

test("个人空间静态渲染：置顶/已归档区与「含已归档」开关可见，已归档默认折叠", () => {
  const html = renderToStaticMarkup(createElement(ProjectNavigation, {
    view: {
      accountName: "张景新",
      workspaceName: "平台架构二组协作区",
      currentWorkspaceId: "ws-1",
      projects: [],
      projectsAvailability: { state: "ready" },
      currentProjectId: null,
      groups: [],
      membersAvailability: { state: "ready" },
      sessionsAvailability: { state: "ready" },
      search: "",
      activePage: null,
      selectedConversationId: null,
      taskCount: null,
      activeSpace: "personal",
      canPublishPersonal: true,
      personalGroups: [{
        directoryKey: "/repo/retail-core",
        directoryPath: "/repo/retail-core",
        label: "retail-core",
        records: [personalEntry()],
      }],
      pinnedPersonal: [personalEntry({ conversationId: "conv-pin", pinned: true, title: "置顶会话" })],
      archivedPersonal: [personalEntry({ conversationId: "conv-arc", archived: true, title: "归档会话" })],
      personalSearch: "",
      selectedPersonalConversationId: null,
      publishedSessionCount: 2,
    },
    actions: {
      ...allPersonalActions,
      setPersonalSearch: () => {},
    },
  }))
  assert.match(html, /置顶/)
  assert.match(html, /置顶会话/)
  assert.match(html, /已归档/)
  assert.match(html, /aria-pressed="false"/)
  assert.match(html, /目录操作：retail-core/)
  // 已归档区默认折叠（grp-collapse data-open="0"），目录分组默认展开
  assert.match(html, /data-open="0"/)
  assert.match(html, /另有 2 个会话已发布到项目/)
})

test("planPersonalMenu 依据 hasDirectory 字段而非目录文案判断有无目录", () => {
  // 目录恰好叫「未设置目录」时，显式字段仍应判为有目录
  const realDir = planPersonalMenu(
    personalEntry({ directoryLabel: "未设置目录", hasDirectory: true }),
    allPersonalActions,
  )
  assert.ok(realDir.find(item => item.id === "copy-directory"))
  assert.ok(realDir.find(item => item.id === "reveal-directory"))

  const unsetDir = planPersonalMenu(
    personalEntry({ directoryLabel: "未设置目录", hasDirectory: false }),
    allPersonalActions,
  )
  assert.equal(unsetDir.find(item => item.id === "copy-directory"), undefined)
  assert.equal(unsetDir.find(item => item.id === "reveal-directory"), undefined)

  const missingField = planPersonalMenu(personalEntry({ hasDirectory: undefined }), allPersonalActions)
  assert.equal(missingField.find(item => item.id === "copy-directory"), undefined)
  assert.equal(missingField.find(item => item.id === "reveal-directory"), undefined)
})
