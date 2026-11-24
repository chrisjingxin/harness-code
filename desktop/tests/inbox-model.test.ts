/**
 * HC-246 全局收件箱与方案 A 本机等待确认纯模型单元测试：
 * 覆盖权限/Plan/Goal/澄清/出错归约与消退、排除当前正在查看会话、单行截断清洗、
 * 本机/云端项目归属解析、跨午夜免打扰时段转换及类别/状态文案。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { InboxItem, TaskDetail } from "@workbench/collaboration-client/types"
import type { LocalConversationRecord, LocalExecutionNotice, LocalExecutionScope } from "../src/shared/index.ts"
import {
  applyLocalExecutionNoticeToSignals,
  badgeToneForCategory,
  badgeToneForTaskStatus,
  classifyPermissionKind,
  collectLocalAttentionItems,
  formatDndWindow,
  formatInboxCategoryLabel,
  formatInboxTaskStatusLabel,
  minutesToTimeString,
  resolveInboxTaskActions,
  resolveSelectedInboxItemKey,
  sanitizeSingleLineSummary,
  timeStringToMinutes,
  type LocalAttentionSignal,
} from "../src/renderer/features/inbox/inbox-model.ts"

const makeScope = (overrides: Partial<LocalExecutionScope> = {}): LocalExecutionScope => ({
  accountId: "user-1",
  workspaceId: null,
  projectId: null,
  conversationId: "conv-1",
  ...overrides,
})

const makeRecord = (overrides: Partial<LocalConversationRecord> = {}): LocalConversationRecord => ({
  conversationId: "conv-1",
  workspaceId: null,
  projectId: null,
  shareMode: null,
  shareStatus: "local_only",
  title: "支付联调排查",
  directoryPath: "/work/harness-code",
  providerId: "harness",
  status: "idle",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_001_000,
  publishedAtMs: null,
  stoppedAtMs: null,
  syncedSequence: 0,
  ...overrides,
})

test("collectLocalAttentionItems 按最近时间倒序聚合非当前查看的权限/Plan/Goal/澄清/出错会话", () => {
  let signals: Readonly<Record<string, LocalAttentionSignal>> = {}

  const push = (notice: LocalExecutionNotice, ts: number) => {
    signals = applyLocalExecutionNoticeToSignals(signals, notice, ts)
  }

  // conv-active 是当前正在查看的会话，必须被排除
  push({
    scope: makeScope({ conversationId: "conv-active" }),
    bindingId: "b-0",
    turnId: "t-0",
    sequence: 1,
    kind: "permission",
    request: {
      id: "perm-0",
      title: "允许执行 rm -rf",
      options: [{ id: "allow", label: "允许", kind: "allow_once" }],
    },
  }, 5_000)

  // conv-perm 普通权限审批
  push({
    scope: makeScope({ conversationId: "conv-perm" }),
    bindingId: "b-1",
    turnId: "t-1",
    sequence: 1,
    kind: "permission",
    request: {
      id: "perm-1",
      title: "执行数据库迁移脚本\n请确认是否继续",
      tool: { id: "tool-1", kind: "execute", title: "bash" },
      options: [{ id: "allow", label: "允许", kind: "allow_once" }],
    },
  }, 2_000)

  // conv-plan 计划确认（带 project scope）
  push({
    scope: makeScope({ workspaceId: "ws-1", projectId: "proj-1", conversationId: "conv-plan" }),
    bindingId: "b-2",
    turnId: "t-2",
    sequence: 1,
    kind: "permission",
    request: {
      id: "perm-2",
      title: "请确认实施 Plan 与停点拆分",
      options: [{ id: "approve", label: "批准", kind: "allow_once" }],
    },
  }, 3_000)

  // conv-elicit 澄清问答
  push({
    scope: makeScope({ conversationId: "conv-elicit" }),
    bindingId: "b-3",
    kind: "elicitation",
    request: {
      id: "el-1",
      mode: "form",
      message: "请补充需要压测的并发数和超时阈值",
      requestedSchema: { type: "object", properties: { qps: { type: "number" } } },
    },
  }, 4_000)

  // conv-error 执行失败
  push({
    scope: makeScope({ conversationId: "conv-error" }),
    bindingId: "b-4",
    turnId: "t-4",
    sequence: 2,
    kind: "finished",
    failure: "Agent 进程意外退出（exit 137）",
    availability: { available: true },
  }, 1_000)

  const items = collectLocalAttentionItems({
    signals,
    personalRecords: [
      makeRecord({ conversationId: "conv-perm", title: "迁移脚本校验", directoryPath: "/work/billing" }),
      makeRecord({
        conversationId: "conv-plan",
        workspaceId: "ws-1",
        projectId: "proj-1",
        shareStatus: "active",
        shareMode: "full",
        title: "HC-246 Plan",
      }),
      makeRecord({ conversationId: "conv-elicit", title: "压测参数确认", directoryPath: null }),
      makeRecord({ conversationId: "conv-error", title: "夜间回归脚本" }),
      makeRecord({ conversationId: "conv-active", title: "当前打开会话" }),
    ],
    activeViewedConversationId: "conv-active",
    projectNamesById: { "proj-1": "全球收件箱" },
  })

  assert.deepEqual(items.map(i => i.conversationId), ["conv-elicit", "conv-plan", "conv-perm", "conv-error"])
  assert.equal(items[0]?.kindLabel, "问题待答")
  assert.equal(items[0]?.locationLabel, "本机会话")
  assert.equal(items[1]?.kindLabel, "计划确认")
  assert.equal(items[1]?.locationLabel, "项目 · 全球收件箱")
  assert.equal(items[1]?.workspaceId, "ws-1")
  assert.equal(items[2]?.kindLabel, "权限审批")
  assert.equal(items[2]?.locationLabel, "billing")
  assert.equal(items[2]?.summary, "执行数据库迁移脚本 请确认是否继续")
  assert.equal(items[3]?.kindLabel, "执行出错")
  assert.equal(items[3]?.status, "error")

  // 若用户在收件箱视图中（activeViewedConversationId = null），conv-active 也应浮现并排在最前
  const itemsInInbox = collectLocalAttentionItems({
    signals,
    personalRecords: [makeRecord({ conversationId: "conv-active", title: "当前打开会话" })],
    activeViewedConversationId: null,
  })
  assert.equal(itemsInInbox[0]?.conversationId, "conv-active")
})

test("权限应答与正常终态清除本机待确认信号，并抑制旧索引记录回影", () => {
  let signals: Readonly<Record<string, LocalAttentionSignal>> = {}
  const scope = makeScope({ conversationId: "conv-done" })

  signals = applyLocalExecutionNoticeToSignals(signals, {
    scope,
    bindingId: "b-1",
    turnId: "t-1",
    sequence: 1,
    kind: "permission",
    request: { id: "p-1", title: "确认目标 Goal 范围", options: [] },
  }, 1_000)
  assert.equal(classifyPermissionKind(signals["conv-done"]!.permission!), "goal")

  // 清屏 + 正常结束
  signals = applyLocalExecutionNoticeToSignals(signals, {
    scope,
    bindingId: "b-1",
    turnId: "t-1",
    sequence: 2,
    kind: "permission",
    request: null,
  }, 2_000)
  signals = applyLocalExecutionNoticeToSignals(signals, {
    scope,
    bindingId: "b-1",
    turnId: "t-1",
    sequence: 3,
    kind: "finished",
    availability: { available: true },
  }, 3_000)

  const items = collectLocalAttentionItems({
    signals,
    personalRecords: [
      // 模拟持久化索引尚未同步的陈旧 waiting_approval 状态
      makeRecord({ conversationId: "conv-done", status: "waiting_approval", updatedAtMs: 1_500 }),
    ],
    activeViewedConversationId: null,
  })
  assert.equal(items.length, 0)
})

test("新一轮 accepted 会清除历史执行失败状态", () => {
  let signals: Readonly<Record<string, LocalAttentionSignal>> = {}
  const scope = makeScope({ conversationId: "conv-retry" })

  signals = applyLocalExecutionNoticeToSignals(signals, {
    scope,
    bindingId: "b-1",
    turnId: "t-1",
    sequence: 1,
    kind: "finished",
    failure: "网络超时",
    availability: { available: true },
  }, 1_000)
  assert.ok(signals["conv-retry"]?.error)

  signals = applyLocalExecutionNoticeToSignals(signals, {
    scope,
    bindingId: "b-1",
    turnId: "t-2",
    requestId: "req-2",
    kind: "accepted",
    text: "重试一次",
  }, 2_000)

  const items = collectLocalAttentionItems({
    signals,
    personalRecords: [],
    activeViewedConversationId: null,
  })
  assert.equal(items.length, 0)
})

test("摘要单行清洗截断、DND 时间换算与分类状态文案映射正确", () => {
  const longText = "第一行\n\t" + "A".repeat(95)
  const sanitized = sanitizeSingleLineSummary(longText, 80)
  assert.equal(sanitized.includes("\n"), false)
  assert.equal(sanitized.includes("\t"), false)
  assert.equal(sanitized.length, 80)
  assert.ok(sanitized.endsWith("…"))

  assert.equal(minutesToTimeString(1320), "22:00")
  assert.equal(minutesToTimeString(540), "09:00")
  assert.equal(timeStringToMinutes("22:00"), 1320)
  assert.equal(timeStringToMinutes("invalid"), null)
  assert.equal(formatDndWindow(1320, 540), "22:00 ~ 次日 09:00")
  assert.equal(formatDndWindow(540, 720), "09:00 ~ 12:00")

  assert.equal(formatInboxCategoryLabel("task_review"), "待我验收")
  assert.equal(formatInboxCategoryLabel("task_assigned"), "任务指派")
  assert.equal(formatInboxCategoryLabel("task_in_progress"), "推进中任务")
  assert.equal(formatInboxCategoryLabel("task_resolved"), "已处理任务")
  assert.equal(formatInboxCategoryLabel("knowledge_review"), "知识审核")
  assert.equal(formatInboxTaskStatusLabel("todo"), "待接收")
  assert.equal(formatInboxTaskStatusLabel("review"), "待验收")
  assert.equal(badgeToneForCategory("task_review"), "warn")
  assert.equal(badgeToneForCategory("task_assigned"), "accent")
  assert.equal(badgeToneForCategory("task_in_progress"), "info")
  assert.equal(badgeToneForCategory("task_resolved"), "muted")
  assert.equal(badgeToneForCategory("knowledge_review"), "info")
  assert.equal(badgeToneForTaskStatus("todo"), "warn")
  assert.equal(badgeToneForTaskStatus("doing"), "info")
  assert.equal(badgeToneForTaskStatus("review"), "accent")
  assert.equal(badgeToneForTaskStatus("done"), "success")
})

const makeInboxItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  itemKey: "task:t-1",
  sourceType: "task",
  category: "task_assigned",
  urgency: "normal",
  workspaceId: "ws-1",
  projectId: "proj-1",
  projectName: "结账拆分",
  objectId: "t-1",
  title: "补齐 retryAfterMs",
  status: "todo",
  actorId: "u-creator",
  delegated: false,
  updatedAtMs: 1_700_000_000_000,
  ...overrides,
})

const makeTaskDetail = (overrides: Partial<TaskDetail["task"]> = {}): TaskDetail => ({
  task: {
    taskId: "t-1",
    projectId: "proj-1",
    title: "补齐 retryAfterMs",
    creatorId: "u-creator",
    assigneeId: "u-assignee",
    status: "todo",
    version: 1,
    conversationId: null,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  },
  description: "任务详细描述",
  snapshotIds: [],
  knowledgeRefs: [],
  transitions: [],
})

test("resolveSelectedInboxItemKey 支持默认首项、原项保留与消退自动顺延", () => {
  const item1 = makeInboxItem({ itemKey: "task:t-1" })
  const item2 = makeInboxItem({ itemKey: "task:t-2" })

  assert.equal(resolveSelectedInboxItemKey([], null), null)
  assert.equal(resolveSelectedInboxItemKey([item1, item2], null), "task:t-1")
  assert.equal(resolveSelectedInboxItemKey([item1, item2], "task:t-2"), "task:t-2")
  assert.equal(resolveSelectedInboxItemKey([item2], "task:t-1"), "task:t-2")
})

test("resolveInboxTaskActions 精准判定受让人、创建人与离职代管拍板权限", () => {
  // 受让人接收 todo
  assert.deepEqual(
    resolveInboxTaskActions({
      item: makeInboxItem({ status: "todo" }),
      detail: makeTaskDetail({ status: "todo" }),
      currentUserId: "u-assignee",
    }),
    { canAccept: true, canReview: false, canCancel: false },
  )

  // 创建人验收或退回 review，并可取消
  assert.deepEqual(
    resolveInboxTaskActions({
      item: makeInboxItem({ status: "review", category: "task_review" }),
      detail: makeTaskDetail({ status: "review" }),
      currentUserId: "u-creator",
    }),
    { canAccept: false, canReview: true, canCancel: true },
  )

  // 离职代管项目负责人验收/退回原发起人离开的任务
  assert.deepEqual(
    resolveInboxTaskActions({
      item: makeInboxItem({ status: "review", category: "task_review", delegated: true }),
      detail: makeTaskDetail({ status: "review", creatorId: "u-departed" }),
      currentUserId: "u-owner",
    }),
    { canAccept: false, canReview: true, canCancel: true },
  )

  // 非权限人或已终态均不可操作
  assert.deepEqual(
    resolveInboxTaskActions({
      item: makeInboxItem({ status: "done" }),
      detail: makeTaskDetail({ status: "done" }),
      currentUserId: "u-creator",
    }),
    { canAccept: false, canReview: false, canCancel: false },
  )
  assert.deepEqual(
    resolveInboxTaskActions({
      item: makeInboxItem({ status: "review" }),
      detail: makeTaskDetail({ status: "review" }),
      currentUserId: "u-assignee",
    }),
    { canAccept: false, canReview: false, canCancel: false },
  )
})
