/**
 * HC-218 会话模型单元测试：覆盖归属分类、同步五态推导、左栏徽标投影、
 * 增量历史单调校验合并、1MB 容量裁剪兜底与四类消息防御性解码。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  boundCachedMessages,
  buildSessionBadge,
  classifyConversation,
  decodeHistoryToTimelineEntries,
  deriveSyncStatus,
  emptySyncState,
  mergeIncrementalHistory,
  toNavigationSessionEntries,
} from "../src/renderer/features/session/session-model.ts"
import type { ProjectConversationSummary, ProjectHistoryMessage } from "../src/renderer/features/session/contracts.ts"

const sampleConversation = (overrides: Partial<ProjectConversationSummary> = {}): ProjectConversationSummary => ({
  conversationId: "conv-1",
  projectId: "proj-1",
  ownerUserId: "user-self",
  deviceId: "dev-local",
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

test("classifyConversation 严格区分本人本机与同账号其他设备/他人会话", () => {
  assert.equal(classifyConversation(sampleConversation(), "user-self", "dev-local"), "local")
  assert.equal(classifyConversation(sampleConversation({ deviceId: "dev-other" }), "user-self", "dev-local"), "remote_self")
  assert.equal(classifyConversation(sampleConversation(), "user-self", null), "remote_self")
  assert.equal(classifyConversation(sampleConversation({ ownerUserId: "user-peer" }), "user-self", "dev-local"), "remote_other")
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
    sampleConversation({ conversationId: "c1", ownerUserId: "u1", deviceId: "d1", syncedSequence: 2 }),
    sampleConversation({ conversationId: "c2", ownerUserId: "u2", deviceId: "d2", syncedSequence: 2 }),
  ]
  const projected = toNavigationSessionEntries(items, "u1", "d1", { c2: { ...emptySyncState(), localSyncedSequence: 2 } })
  assert.equal(projected[0]?.badge?.text, "本机")
  assert.equal(projected[1]?.badge?.text, "已同步")
})
