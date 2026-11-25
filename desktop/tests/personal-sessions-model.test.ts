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
  makePersonalScopeKey,
  mergeLoadedPersonalRuntime,
  projectLocalConversationHistory,
  partitionPersonalRecords,
  resolvePublishTargets,
  type PersonalRuntimeState,
} from "../src/renderer/features/personal-sessions/personal-sessions-model.ts"
import { EMPTY_PERSONAL_STATE, applyConversationPersonalChange } from "../src/renderer/features/session/session-model.ts"

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

test("mergeLoadedPersonalRuntime 在挂载期仅收到滚动事件时完整恢复磁盘草稿摘录、批注与图片", () => {
  const scopeKey = makePersonalScopeKey({ workspaceId: null, projectId: null })
  const scrolledBeforeLoad: PersonalRuntimeState = {
    loaded: false,
    loadedScopeKey: null,
    providerId: null,
    personal: applyConversationPersonalChange(EMPTY_PERSONAL_STATE, {
      kind: "scroll",
      value: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: 0 },
    }),
  }
  const diskLoaded: PersonalRuntimeState = {
    loaded: true,
    loadedScopeKey: scopeKey,
    providerId: "custom",
    personal: {
      ...EMPTY_PERSONAL_STATE,
      scroll: { anchorEntryId: "local-turn:t1:user", offsetPx: 20, following: false, seenContentRevision: 4 },
      draft: {
        text: "请看这个片段",
        selectionStart: 6,
        selectionEnd: 6,
        revision: 6,
        referenceIds: [],
        attachmentIds: [],
        annotations: [{
          id: "ann-1",
          selectedText: "export function submitOrderDraft()",
          comment: "请重点看这里的幂等校验",
          sourceLabel: "src/service.ts:L10-L13",
        }],
        images: [{
          id: "pending-c606aafa-47a8-40c2-a404-ab5bf5df0262",
          name: "sample-ui-bug.png",
          mimeType: "image/png",
          sizeBytes: 5884,
          width: 800,
          height: 450,
        }],
      },
    },
  }

  const merged = mergeLoadedPersonalRuntime(scrolledBeforeLoad, diskLoaded)
  assert.equal(merged.needsPersist, false)
  assert.equal(merged.runtime.loaded, true)
  assert.equal(merged.runtime.loadedScopeKey, scopeKey)
  assert.equal(merged.runtime.providerId, "custom")
  assert.equal(merged.runtime.personal.scroll.anchorEntryId, "local-turn:t1:user")
  assert.equal(merged.runtime.personal.draft.text, "请看这个片段")
  assert.equal(merged.runtime.personal.draft.annotations?.length, 1)
  assert.equal(merged.runtime.personal.draft.annotations?.[0]?.comment, "请重点看这里的幂等校验")
  assert.equal(merged.runtime.personal.draft.annotations?.[0]?.sourceLabel, "src/service.ts:L10-L13")
  assert.equal(merged.runtime.personal.draft.images?.length, 1)
  assert.equal(merged.runtime.personal.draft.images?.[0]?.id, "pending-c606aafa-47a8-40c2-a404-ab5bf5df0262")
})

test("mergeLoadedPersonalRuntime 在加载完成前已有新编辑时保留并合并双方草稿且触发落盘", () => {
  const scopeKey = makePersonalScopeKey({ workspaceId: "ws-1", projectId: null })
  const editedBeforeLoad: PersonalRuntimeState = {
    loaded: false,
    loadedScopeKey: null,
    providerId: null,
    personal: applyConversationPersonalChange(
      applyConversationPersonalChange(EMPTY_PERSONAL_STATE, {
        kind: "draft-text",
        text: "新补充的提问",
        selectionStart: 6,
        selectionEnd: 6,
      }),
      {
        kind: "draft-annotations",
        annotations: [{ id: "ann-new", selectedText: "new snippet", sourceLabel: "src/a.ts:L1" }],
      },
    ),
  }
  const diskLoaded: PersonalRuntimeState = {
    loaded: true,
    loadedScopeKey: scopeKey,
    providerId: "harness",
    personal: {
      ...EMPTY_PERSONAL_STATE,
      draft: {
        text: "旧草稿文字",
        selectionStart: 0,
        selectionEnd: 0,
        revision: 4,
        referenceIds: [],
        attachmentIds: [],
        annotations: [{ id: "ann-disk", selectedText: "disk snippet", comment: "旧批注", sourceLabel: "src/b.ts:L2" }],
        images: [{
          id: "pending-11111111-1111-4111-8111-111111111111",
          name: "old.png",
          mimeType: "image/png",
          sizeBytes: 1024,
        }],
      },
    },
  }

  const merged = mergeLoadedPersonalRuntime(editedBeforeLoad, diskLoaded)
  assert.equal(merged.needsPersist, true)
  assert.equal(merged.runtime.personal.draft.text, "新补充的提问")
  assert.deepEqual(merged.runtime.personal.draft.annotations?.map(a => a.id), ["ann-disk", "ann-new"])
  assert.equal(merged.runtime.personal.draft.images?.length, 1)
  assert.ok(merged.runtime.personal.draft.revision > 4)
})

test("mergeLoadedPersonalRuntime 对同作用域已加载记录保持幂等并在归属作用域变化时更新作用域键", () => {
  const scopeA = makePersonalScopeKey({ workspaceId: "ws-1", projectId: "proj-1" })
  const scopeB = makePersonalScopeKey({ workspaceId: "ws-1", projectId: null })
  const alreadyLoaded: PersonalRuntimeState = {
    loaded: true,
    loadedScopeKey: scopeA,
    providerId: "harness",
    personal: {
      ...EMPTY_PERSONAL_STATE,
      draft: { ...EMPTY_PERSONAL_STATE.draft, text: "内存中最新草稿", revision: 9 },
    },
  }
  const staleDiskForSameScope: PersonalRuntimeState = {
    loaded: true,
    loadedScopeKey: scopeA,
    providerId: "harness",
    personal: EMPTY_PERSONAL_STATE,
  }
  const sameScopeMerged = mergeLoadedPersonalRuntime(alreadyLoaded, staleDiskForSameScope)
  assert.equal(sameScopeMerged.needsPersist, false)
  assert.equal(sameScopeMerged.runtime, alreadyLoaded)

  const shiftedScopeLoaded: PersonalRuntimeState = {
    loaded: true,
    loadedScopeKey: scopeB,
    providerId: "harness",
    personal: {
      ...EMPTY_PERSONAL_STATE,
      draft: { ...EMPTY_PERSONAL_STATE.draft, revision: 5 },
    },
  }
  const shiftedMerged = mergeLoadedPersonalRuntime(alreadyLoaded, shiftedScopeLoaded)
  assert.equal(shiftedMerged.needsPersist, true)
  assert.equal(shiftedMerged.runtime.loadedScopeKey, scopeB)
  assert.equal(shiftedMerged.runtime.personal.draft.text, "内存中最新草稿")
})

test("Project 本人本机终态保留失败与停止，按实际正文配对成功轮且保留全部云端序号", () => {
  const turns = [
    makeTurn({ turnId: "failed", status: "failed", userText: "失败原文", reply: "部分回答", failure: "运行失败" }),
    makeTurn({ turnId: "cancelled", status: "cancelled", userText: "停止原文", reply: "部分停止回答" }),
    makeTurn({ turnId: "completed", userText: "成功原文", reply: "成功回答", acceptedAtMs: 2000, completedAtMs: 3000 }),
  ]
  const messages = [
    { sequence: 10, type: "user" as const, occurredAtMs: 9000, payload: JSON.stringify({ text: "别的设备时间更晚的历史" }) },
    { sequence: 11, type: "assistant" as const, occurredAtMs: 9500, payload: JSON.stringify({ text: "其他历史回复" }) },
    { sequence: 12, type: "user" as const, occurredAtMs: 2000, payload: JSON.stringify({ text: "成功原文" }) },
    { sequence: 13, type: "assistant" as const, occurredAtMs: 3000, payload: JSON.stringify({ text: "成功回答" }) },
  ]
  const owner = { userId: "u-1", displayName: "本人" }
  const entries = projectLocalConversationHistory(messages, turns, owner)
  assert.deepEqual(entries.filter(entry => entry.id.startsWith("seq-")).map(entry => entry.id), ["seq-10", "seq-11", "seq-12", "seq-13"])
  assert.equal(entries.filter(entry => entry.kind === "message" && entry.text === "成功原文").length, 1)
  assert.ok(entries.some(entry => entry.kind === "message" && entry.text === "部分回答\n\n运行失败"))
  assert.ok(entries.some(entry => entry.kind === "message" && entry.text === "部分停止回答\n\n本轮已停止。"))
  assert.ok(entries.findIndex(entry => entry.id === "local-turn:failed:user") < entries.findIndex(entry => entry.id === "seq-12"))
  const live = [{ kind: "message" as const, id: "local-execution:cancelled:user", role: "user" as const, text: "停止原文", createdAtMs: 1 }]
  const beforeLive = projectLocalConversationHistory([], turns.slice(0, 2), owner, live)
  assert.ok(beforeLive.some(entry => entry.id === "local-turn:failed:user"))
  assert.ok(!beforeLive.some(entry => entry.id === "local-turn:cancelled:user"))
})
