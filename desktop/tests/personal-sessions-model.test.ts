/**
 * HC-239 个人优先会话纯模型单元测试：
 * 覆盖个人/已发布会话分区（不按团队隐藏）、工程目录分组排序、跨团队发布目标解析、
 * 历史带入范围及超 32 KiB 预警检测与本地轮次时间线投影。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { ProjectSummary } from "@workbench/collaboration-client/types"
import type { LocalConversationRecord, LocalConversationTurn } from "../src/shared/index.ts"
import {
  buildDefaultPublishBrief,
  groupPersonalRecordsByDirectory,
  inspectPublishHistory,
  localRecordToConversationSummary,
  localTurnsToTimelineEntries,
  partitionPersonalRecords,
  resolvePublishTargets,
} from "../src/renderer/features/personal-sessions/personal-sessions-model.ts"

const makeRecord = (overrides: Partial<LocalConversationRecord> = {}): LocalConversationRecord => ({
  conversationId: "conv-1",
  workspaceId: null,
  projectId: null,
  shareMode: null,
  shareStatus: "local_only",
  title: "示例会话",
  directoryPath: "/tmp/repo-a",
  providerId: "harness",
  status: "idle",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_001_000,
  publishedAtMs: null,
  stoppedAtMs: null,
  syncedSequence: 0,
  ...overrides,
})

const makeTurn = (overrides: Partial<LocalConversationTurn> = {}): LocalConversationTurn => ({
  turnId: "turn-1",
  sequenceStart: 1,
  sequenceEnd: 2,
  userText: "检查接口",
  reply: "已检查完成。",
  status: "completed",
  acceptedAtMs: 1_700_000_000_100,
  completedAtMs: 1_700_000_000_500,
  ...overrides,
})

const makeProject = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: "proj-1",
  workspaceId: "ws-1",
  name: "结账拆分",
  description: "",
  ownerUserId: "u-1",
  status: "active",
  role: "owner",
  memberCount: 2,
  version: 1,
  createdAt: "2026-11-23T00:00:00Z",
  updatedAt: "2026-11-23T00:00:00Z",
  ...overrides,
})

test("partitionPersonalRecords 在个人栏位展示全部未共享及已停止会话并剥离活跃共享会话", () => {
  const records: LocalConversationRecord[] = [
    makeRecord({ conversationId: "solo-1", workspaceId: null, shareStatus: "local_only" }),
    makeRecord({ conversationId: "ws1-local", workspaceId: "ws-1", shareStatus: "local_only" }),
    makeRecord({ conversationId: "ws1-stopped", workspaceId: "ws-1", shareStatus: "stopped" }),
    makeRecord({ conversationId: "ws1-active", workspaceId: "ws-1", projectId: "proj-1", shareStatus: "active", shareMode: "full" }),
    makeRecord({ conversationId: "ws2-local", workspaceId: "ws-2", shareStatus: "local_only" }),
  ]

  const result = partitionPersonalRecords(records)
  assert.deepEqual(result.personal.map(r => r.conversationId), ["solo-1", "ws1-local", "ws1-stopped", "ws2-local"])
  assert.equal(result.publishedCount, 1)
})

test("groupPersonalRecordsByDirectory 按目录分组并处理未设置目录与更新倒序", () => {
  const groups = groupPersonalRecordsByDirectory([
    makeRecord({ conversationId: "c-old", directoryPath: "/work/app-a", updatedAtMs: 100 }),
    makeRecord({ conversationId: "c-unset", directoryPath: null, updatedAtMs: 200 }),
    makeRecord({ conversationId: "c-new", directoryPath: "/work/app-a", updatedAtMs: 300 }),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.label, "app-a")
  assert.deepEqual(groups[0]?.records.map(r => r.conversationId), ["c-new", "c-old"])
  assert.equal(groups[1]?.label, "未设置目录")
})

test("resolvePublishTargets 汇总已加入全部团队中的活跃 Project 供个人会话发布", () => {
  const workspaces = [
    {
      workspaceId: "ws-1",
      workspaceName: "支付研发",
      projects: [
        makeProject({ projectId: "p-1", workspaceId: "ws-1", name: "活跃一", status: "active" }),
        makeProject({ projectId: "p-2", workspaceId: "ws-1", name: "已归档", status: "archived" }),
      ],
    },
    {
      workspaceId: "ws-2",
      workspaceName: "风控组",
      projects: [
        makeProject({ projectId: "p-3", workspaceId: "ws-2", name: "风控重构", status: "active" }),
      ],
    },
  ]

  const targets = resolvePublishTargets(workspaces)
  assert.deepEqual(targets.map(t => t.project.projectId), ["p-1", "p-3"])
  assert.deepEqual(targets.map(t => t.workspaceName), ["支付研发", "风控组"])
})

test("inspectPublishHistory 检测已完成历史范围与超过 32 KiB 限制的轮次", () => {
  const turns: LocalConversationTurn[] = [
    makeTurn({ turnId: "t1", userText: "短问题", reply: "短答复" }),
    makeTurn({ turnId: "t2", userText: "被取消", reply: "", status: "cancelled" }),
    makeTurn({ turnId: "t3", userText: "长输出", reply: "甲".repeat(12_000) }),
    makeTurn({ turnId: "t4", userText: "收尾问题", reply: "收尾答复" }),
  ]

  const all = inspectPublishHistory(turns, 0)
  assert.equal(all.completedTurns.length, 3)
  assert.equal(all.selectedCount, 3)
  assert.deepEqual(all.oversizedDisplayIndices, [2])

  // t4 的原始数组下标是 3，跳过超限第 2 完成轮后无超限提示
  const tailOnly = inspectPublishHistory(turns, 3)
  assert.equal(tailOnly.selectedCount, 1)
  assert.deepEqual(tailOnly.oversizedDisplayIndices, [])
})

test("localTurnsToTimelineEntries 与 localRecordToConversationSummary 正确投影展示结构", () => {
  const entries = localTurnsToTimelineEntries([
    makeTurn({
      turnId: "t-a",
      followUps: [{ text: "补充条件", occurredAtMs: 1_700_000_000_200 }],
      tools: [{ label: "读文件", summary: "a.ts", status: "completed", tone: "read", occurredAtMs: 1_700_000_000_300 }],
    }),
  ], { userId: "u-1", displayName: "张三" })
  assert.equal(entries.length, 4)
  assert.equal(entries[0]?.kind, "message")
  assert.equal(entries[1]?.kind, "message")
  assert.equal(entries[2]?.kind, "tool")
  assert.equal(entries[3]?.kind, "message")

  const summary = localRecordToConversationSummary(makeRecord({ workspaceId: null, projectId: null }), "u-1")
  assert.equal(summary.projectId, "__personal__")
  assert.equal(summary.shareStatus, "stopped")

  const brief = buildDefaultPublishBrief(makeRecord({ title: "重构" }), [makeTurn({ userText: "怎么拆？", reply: "按域拆。" })])
  assert.match(brief, /按域拆/)
})
