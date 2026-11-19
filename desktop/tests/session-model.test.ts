/**
 * HC-218 会话模型单元测试：覆盖归属分类、同步五态推导、左栏徽标投影、
 * 增量历史单调校验合并、1MB 容量裁剪兜底与四类消息防御性解码。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyConversationTitleOverrides,
  boundCachedMessages,
  buildSessionBadge,
  classifyConversation,
  decodeHistoryToTimelineEntries,
  deriveSyncStatus,
  emptySyncState,
  mergeIncrementalHistory,
  resolveConversationTitle,
  toNavigationSessionEntries,
} from "../src/renderer/features/session/session-model.ts"
import { localExecutionKey } from "../src/shared/index.ts"
import type { ProjectConversationSummary, ProjectHistoryMessage } from "../src/renderer/features/session/contracts.ts"

const sampleConversation = (overrides: Partial<ProjectConversationSummary> = {}): ProjectConversationSummary => ({
  conversationId: "conv-1",
  projectId: "proj-1",
  ownerUserId: "user-self",
  title: "测试会话",
  status: "idle",
  briefText: "简报内容",
  briefSource: "rule",
  briefUpdatedAtMs: 1_700_000_000_000,
  syncedSequence: 3,
  updatedAt: "2026-11-13T08:00:00Z",
  repositories: [],
  ...overrides,
})

test("classifyConversation 按人区分本人可执行会话与队友只读会话", () => {
  assert.equal(classifyConversation(sampleConversation(), "user-self"), "local")
  assert.equal(classifyConversation(sampleConversation({ ownerUserId: "user-peer" }), "user-self"), "remote_other")
})

test("deriveSyncStatus 与 buildSessionBadge 正确表达五种本地同步状态", () => {
  assert.equal(deriveSyncStatus({ kind: "remote_other", remoteSyncedSequence: 4, localSyncedSequence: 0, syncing: false, syncError: null }), "unsynced")
  assert.equal(deriveSyncStatus({ kind: "remote_other", remoteSyncedSequence: 4, localSyncedSequence: 2, syncing: false, syncError: null }), "has_update")
  assert.equal(deriveSyncStatus({ kind: "remote_other", remoteSyncedSequence: 4, localSyncedSequence: 4, syncing: false, syncError: null }), "synced")
  assert.equal(deriveSyncStatus({ kind: "remote_other", remoteSyncedSequence: 4, localSyncedSequence: 2, syncing: true, syncError: "old" }), "syncing")
  assert.equal(deriveSyncStatus({ kind: "remote_other", remoteSyncedSequence: 4, localSyncedSequence: 2, syncing: false, syncError: "timeout" }), "sync_failed")

  assert.deepEqual(buildSessionBadge({ kind: "local", syncStatus: "synced", remoteSyncedSequence: 3 }), { text: "本机", tone: "neutral" })
  assert.deepEqual(buildSessionBadge({ kind: "remote_self", syncStatus: "synced", remoteSyncedSequence: 2 }), { text: "其他设备 · 只读", tone: "neutral" })
  assert.deepEqual(buildSessionBadge({ kind: "remote_self", syncStatus: "has_update", remoteSyncedSequence: 5 }), { text: "有更新", tone: "warning" })
  assert.deepEqual(buildSessionBadge({ kind: "remote_other", syncStatus: "unsynced", remoteSyncedSequence: 0 }), { text: "仅简报", tone: "neutral" })
  assert.deepEqual(buildSessionBadge({ kind: "remote_other", syncStatus: "unsynced", remoteSyncedSequence: 3 }), { text: "未同步", tone: "accent" })
  assert.deepEqual(buildSessionBadge({ kind: "remote_other", syncStatus: "sync_failed", remoteSyncedSequence: 3 }), { text: "同步失败", tone: "danger" })
})

test("mergeIncrementalHistory 按序号增量追加并拒绝非单调或非法序号", () => {
  const existing: ProjectHistoryMessage[] = [
    { sequence: 1, type: "user", occurredAtMs: 100, payload: '{"text":"hello"}' },
    { sequence: 2, type: "assistant", occurredAtMs: 110, payload: '{"text":"hi"}' },
  ]
  const incoming: ProjectHistoryMessage[] = [
    { sequence: 2, type: "assistant", occurredAtMs: 110, payload: '{"text":"dup"}' },
    { sequence: 3, type: "tool_summary", occurredAtMs: 120, payload: '{"label":"读文件","summary":"a.ts"}' },
  ]
  const merged = mergeIncrementalHistory(existing, 2, incoming, 4)
  assert.equal(merged.messages.length, 3)
  assert.equal(merged.messages.at(-1)?.sequence, 3)
  assert.equal(merged.syncedSequence, 4)

  assert.throws(() => mergeIncrementalHistory(existing, 2, [
    { sequence: 4, type: "user", occurredAtMs: 120, payload: "{}" },
    { sequence: 4, type: "assistant", occurredAtMs: 121, payload: "{}" },
  ], 4), /HISTORY_SEQUENCE_INVALID/)
})

test("decodeHistoryToTimelineEntries 防御性解析四类消息并在非法 JSON 时不崩溃", () => {
  const entries = decodeHistoryToTimelineEntries([
    { sequence: 1, type: "user", occurredAtMs: 10, payload: '{"text":"问题"}' },
    { sequence: 2, type: "assistant", occurredAtMs: 20, payload: "纯文本降级" },
    { sequence: 3, type: "tool_summary", occurredAtMs: 30, payload: '{"label":"检索","name":"grep","summary":"3处","status":"completed","tone":"read"}' },
    { sequence: 4, type: "status", occurredAtMs: 40, payload: '{"text":"已完成校验"}' },
  ], { userId: "u-1", displayName: "张景新" })

  assert.equal(entries.length, 4)
  assert.equal(entries[0]?.kind, "message")
  if (entries[0]?.kind === "message") assert.equal(entries[0].text, "问题")
  if (entries[1]?.kind === "message") assert.equal(entries[1].text, "纯文本降级")
  assert.equal(entries[2]?.kind, "tool")
  if (entries[2]?.kind === "tool") {
    assert.equal(entries[2].label, "检索")
    assert.equal(entries[2].summary, "3处")
    assert.equal(entries[2].tone, "read")
  }
  if (entries[3]?.kind === "message") assert.equal(entries[3].text, "状态更新：已完成校验")
})

test("boundCachedMessages 超限时从头裁剪最早消息并标明 cacheTruncated", () => {
  const big = "a".repeat(200)
  const messages: ProjectHistoryMessage[] = Array.from({ length: 10 }, (_, idx) => ({
    sequence: idx + 1,
    type: "assistant",
    occurredAtMs: idx + 1,
    payload: JSON.stringify({ text: big }),
  }))
  const bounded = boundCachedMessages(messages, 1_500)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.messages.length < 10)
  assert.equal(bounded.messages.at(-1)?.sequence, 10)
})

test("toNavigationSessionEntries 正确映射多成员会话条目", () => {
  const items = [
    sampleConversation({ conversationId: "c1", ownerUserId: "u1", syncedSequence: 2 }),
    sampleConversation({ conversationId: "c2", ownerUserId: "u2", syncedSequence: 2 }),
  ]
  const projected = toNavigationSessionEntries(items, "u1", { c2: { ...emptySyncState(), localSyncedSequence: 2 } })
  assert.equal(projected[0]?.badge?.text, "本机")
  assert.equal(projected[1]?.badge?.text, "已同步")
})

test("mergeIncrementalHistory 超过单页 200 条上限时分两页无损合并 250 条消息", () => {
  const allMessages: ProjectHistoryMessage[] = Array.from({ length: 250 }, (_, idx) => ({
    sequence: idx + 1,
    type: idx % 2 === 0 ? "user" : "assistant",
    occurredAtMs: 1_700_000_000_000 + idx,
    payload: JSON.stringify({ text: `msg-${idx + 1}` }),
  }))

  const page1 = allMessages.slice(0, 200)
  const mergedPage1 = mergeIncrementalHistory([], 0, page1, 250)
  assert.equal(mergedPage1.messages.length, 200)
  const cursorAfterPage1 = page1.at(-1)?.sequence ?? 0
  assert.equal(cursorAfterPage1, 200)

  const page2 = allMessages.slice(200, 250)
  const mergedPage2 = mergeIncrementalHistory(mergedPage1.messages, cursorAfterPage1, page2, 250)
  assert.equal(mergedPage2.messages.length, 250)
  assert.equal(mergedPage2.messages[0]?.sequence, 1)
  assert.equal(mergedPage2.messages.at(-1)?.sequence, 250)
  assert.equal(mergedPage2.syncedSequence, 250)
})

test("resolveConversationTitle 与 applyConversationTitleOverrides 优先显示实时改名标题并隔离作用域", () => {
  assert.equal(resolveConversationTitle("原登记标题", "  新会话标题  "), "新会话标题")
  assert.equal(resolveConversationTitle("原登记标题", "   "), "原登记标题")
  assert.equal(resolveConversationTitle("", undefined), "未命名会话")

  const scope = { accountId: "user-self", workspaceId: "ws-1", projectId: "proj-1" }
  const items = [
    sampleConversation({ conversationId: "conv-1", ownerUserId: "user-self", title: "初始标题" }),
    sampleConversation({ conversationId: "conv-2", ownerUserId: "user-peer", title: "他人标题" }),
  ]

  // 无匹配覆盖时保持原引用稳定，避免不必要的重渲染
  assert.equal(applyConversationTitleOverrides(items, scope, {}), items)

  const targetKey = localExecutionKey({ ...scope, conversationId: "conv-1" })
  const otherProjectKey = localExecutionKey({ accountId: "user-self", workspaceId: "ws-1", projectId: "proj-2", conversationId: "conv-2" })
  const updated = applyConversationTitleOverrides(items, scope, {
    [targetKey]: "  重构标题  ",
    [otherProjectKey]: "不应污染其他项目",
  })

  assert.notEqual(updated, items)
  assert.equal(updated[0]?.title, "重构标题")
  assert.equal(updated[1]?.title, "他人标题")
})
