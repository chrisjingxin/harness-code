/**
 * HC-239 单元测试：覆盖 LocalConversationStore 独立存储的 CRUD/排序过滤、账号与来源隔离、
 * 团队锁定、4 MiB 旧轮摘要折叠（保留最近 20 轮）、500 条数量上限与损坏文件保护。
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  LocalConversationStore,
  MAX_CONVERSATION_DETAIL_BYTES,
  MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT,
} from "../src/main/local-conversation-store.ts"

const ORIGIN = "http://127.0.0.1:9999"
const USER_A = "11111111111111111111111111111111"
const USER_B = "22222222222222222222222222222222"
const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "99999999-9999-4999-8999-999999999999"
const PROJECT_A = "22222222-2222-4222-8222-222222222222"

test("LocalConversationStore 支持无团队与多团队过滤、重启恢复、首轮后锁定及账号隔离", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc239-local-conv-"))
  try {
    const store = new LocalConversationStore(dir, ORIGIN)

    const solo = await store.create(USER_A, { workspaceId: null, directoryPath: "/tmp/solo" })
    const teamA = await store.create(USER_A, { workspaceId: WS_A, title: "A 团队本地调研" })
    const teamB = await store.create(USER_A, { workspaceId: WS_B, title: "B 团队本地调研" })
    assert.equal(solo.ok && teamA.ok && teamB.ok, true)
    if (!solo.ok || !teamA.ok || !teamB.ok) return

    // 首轮发出前允许修改团队上下文
    const switched = await store.updateWorkspace(USER_A, solo.value.conversationId, WS_A)
    assert.equal(switched.ok, true)
    const switchedBack = await store.updateWorkspace(USER_A, solo.value.conversationId, null)
    assert.equal(switchedBack.ok, true)

    // 写入首轮后锁定团队上下文，并自动从首问提炼默认标题
    const firstTurn = await store.appendTurn(USER_A, solo.value.conversationId, {
      turnId: "turn-1",
      userText: "排查无团队本机会话断网持久化问题",
      reply: "已完成排查并输出修复方案。",
      tools: [
        {
          label: "read_file",
          summary: "store.ts",
          status: "completed",
          tone: "read",
          occurredAtMs: 1_700_000_000_100,
        },
      ],
      status: "completed",
      acceptedAtMs: 1_700_000_000_000,
      completedAtMs: 1_700_000_000_500,
    })
    assert.equal(firstTurn.ok, true)
    if (firstTurn.ok) {
      assert.equal(firstTurn.value.record.title, "排查无团队本机会话断网持久化问题")
      assert.equal(firstTurn.value.turns.length, 1)
      assert.equal(firstTurn.value.turns[0]!.sequenceStart, 1)
      assert.equal(firstTurn.value.turns[0]!.sequenceEnd, 3)
      assert.equal(firstTurn.value.nextSequence, 4)
    }

    const lockedAfterTurn = await store.updateWorkspace(USER_A, solo.value.conversationId, WS_A)
    assert.equal(lockedAfterTurn.ok, false)

    // 按当前选中团队过滤：null / WS_A / WS_B 严格隔离
    const listSolo = await store.list(USER_A, { workspaceId: null })
    assert.equal(listSolo.ok, true)
    if (listSolo.ok) assert.deepEqual(listSolo.value.map(item => item.conversationId), [solo.value.conversationId])

    const listWsA = await store.list(USER_A, { workspaceId: WS_A })
    assert.equal(listWsA.ok, true)
    if (listWsA.ok) assert.deepEqual(listWsA.value.map(item => item.conversationId), [teamA.value.conversationId])

    // 账号严格隔离：USER_B 看不到 USER_A 的任何会话
    const otherList = await store.list(USER_B, {})
    assert.equal(otherList.ok, true)
    if (otherList.ok) assert.equal(otherList.value.length, 0)
    assert.equal((await store.get(USER_B, solo.value.conversationId)).ok, false)

    // 发布到 Project 与停止共享状态流转，并在重开 Store 实例后完整恢复
    const published = await store.markPublished(USER_A, teamA.value.conversationId, {
      workspaceId: WS_A,
      projectId: PROJECT_A,
      shareMode: "summary_only",
      syncedSequence: 0,
    })
    assert.equal(published.ok, true)
    if (published.ok) {
      assert.equal(published.value.shareStatus, "active")
      assert.equal(published.value.shareMode, "summary_only")
      assert.equal(published.value.projectId, PROJECT_A)
    }
    const unpublishedOnly = await store.list(USER_A, { workspaceId: WS_A, includePublished: false })
    assert.equal(unpublishedOnly.ok && unpublishedOnly.value.length, 0)

    const seqUpdated = await store.updateSyncedSequence(USER_A, teamA.value.conversationId, 4)
    assert.equal(seqUpdated.ok && seqUpdated.value.syncedSequence, 4)
    const stopped = await store.markSharingStopped(USER_A, teamA.value.conversationId, 1_700_000_010_000)
    assert.equal(stopped.ok, true)
    if (stopped.ok) {
      assert.equal(stopped.value.shareStatus, "stopped")
      assert.equal(stopped.value.stoppedAtMs, 1_700_000_010_000)
    }

    const reopened = new LocalConversationStore(dir, ORIGIN)
    const detail = await reopened.get(USER_A, solo.value.conversationId)
    assert.equal(detail.ok, true)
    if (detail.ok) {
      assert.equal(detail.value.turns.length, 1)
      assert.equal(detail.value.turns[0]!.reply, "已完成排查并输出修复方案。")
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalConversationStore 详情超出 4 MiB 时自动折叠旧轮并完整保留最近 20 轮", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc239-local-trim-"))
  try {
    const store = new LocalConversationStore(dir, ORIGIN)
    const created = await store.create(USER_A, { workspaceId: null, title: "长会话裁剪验证" })
    assert.equal(created.ok, true)
    if (!created.ok) return

    const bigText = "甲".repeat(60_000)
    for (let i = 1; i <= 25; i++) {
      const res = await store.appendTurn(USER_A, created.value.conversationId, {
        turnId: `turn-${i}`,
        userText: `第${i}轮提问：${bigText.slice(0, 600)}`,
        reply: `第${i}轮回答：${bigText}`,
        tools: [
          {
            label: "cmd",
            summary: `tool-${i}`,
            status: "completed",
            tone: "neutral",
            occurredAtMs: 1_700_000_000_000 + i,
          },
        ],
        status: "completed",
        acceptedAtMs: 1_700_000_000_000 + i * 10,
        completedAtMs: 1_700_000_000_000 + i * 10 + 5,
      })
      assert.equal(res.ok, true)
    }

    const detail = await store.get(USER_A, created.value.conversationId)
    assert.equal(detail.ok, true)
    if (!detail.ok) return
    assert.equal(detail.value.historyTrimmed, true)
    assert.equal(detail.value.turns.length, 25)
    // 第 1 轮已被折叠摘要并移除工具详情；最近 20 轮（6..25）完整保留
    assert.ok(detail.value.turns[0]!.reply.length <= 405)
    assert.equal(detail.value.turns[0]!.tools, undefined)
    assert.equal(detail.value.turns[5]!.reply.length, `第6轮回答：${bigText}`.length)
    assert.equal(detail.value.turns[24]!.tools?.length, 1)

    const originHash = createHash("sha256").update(ORIGIN).digest("hex")
    const rawDetail = await readFile(
      join(dir, "workbench", "local-conversations", originHash, USER_A, "conversations", `${created.value.conversationId}.json`),
      "utf8",
    )
    assert.ok(Buffer.byteLength(rawDetail, "utf8") <= MAX_CONVERSATION_DETAIL_BYTES)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("LocalConversationStore 校验 500 条会话上限并在文件损坏时拒绝覆盖原盘文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc239-local-limit-"))
  try {
    const store = new LocalConversationStore(dir, ORIGIN)
    const originHash = createHash("sha256").update(ORIGIN).digest("hex")
    const accountDir = join(dir, "workbench", "local-conversations", originHash, USER_A)

    const first = await store.create(USER_A, { workspaceId: null, title: "seed" })
    assert.equal(first.ok, true)
    if (!first.ok) return

    const seeded = Array.from({ length: MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT }, (_, idx) => ({
      conversationId: idx === 0 ? first.value.conversationId : randomUUID(),
      workspaceId: null,
      projectId: null,
      shareMode: null,
      shareStatus: "local_only",
      title: `会话 ${idx + 1}`,
      directoryPath: null,
      providerId: null,
      status: "idle",
      createdAtMs: 1_700_000_000_000 + idx,
      updatedAtMs: 1_700_000_000_000 + idx,
      publishedAtMs: null,
      stoppedAtMs: null,
      syncedSequence: 0,
    }))
    await writeFile(join(accountDir, "index.json"), JSON.stringify({ version: 1, records: seeded }))

    const overflow = await store.create(USER_A, { workspaceId: null, title: "第501条" })
    assert.equal(overflow.ok, false)
    if (!overflow.ok) assert.equal(overflow.error.code, "PAYLOAD_TOO_LARGE")

    // 破坏单会话正文文件：get 返回失败，且磁盘原文件字节不被覆写
    await store.appendTurn(USER_A, first.value.conversationId, {
      turnId: "t-corrupt",
      userText: "测试",
      reply: "完成",
      status: "completed",
      acceptedAtMs: 1,
      completedAtMs: 2,
    })
    const detailPath = join(accountDir, "conversations", `${first.value.conversationId}.json`)
    const brokenContent = "{corrupt-detail-json"
    await writeFile(detailPath, brokenContent)
    const brokenRead = await store.get(USER_A, first.value.conversationId)
    assert.equal(brokenRead.ok, false)
    assert.equal(await readFile(detailPath, "utf8"), brokenContent)

    // 破坏 index.json：list 与 create 均拒绝写入且保留损坏原件供排障
    const brokenIndex = "{corrupt-index"
    await writeFile(join(accountDir, "index.json"), brokenIndex)
    assert.equal((await store.list(USER_A)).ok, false)
    assert.equal((await store.create(USER_A, { workspaceId: null })).ok, false)
    assert.equal(await readFile(join(accountDir, "index.json"), "utf8"), brokenIndex)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
