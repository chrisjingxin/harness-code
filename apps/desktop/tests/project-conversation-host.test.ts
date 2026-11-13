/**
 * HC-218 停点 2 单元测试：覆盖项目级会话客户端契约校验与 PersonalStore 同步缓存容量裁剪。
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { CollaborationClient } from "../src/main/collaboration-client.ts"
import { CollaborationState } from "../src/main/collaboration-state.ts"
import { PersonalStore } from "../src/main/personal-store.ts"

const ORIGIN = "http://127.0.0.1:9999"
const USER_ID = "11111111111111111111111111111111"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"
const DEVICE_ID = "44444444-4444-4444-8444-444444444444"
const REQ_ID = "55555555-5555-4555-8555-555555555555"

const jsonOk = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  })

test("CollaborationClient 按 organization Schema 校验项目会话四接口", async () => {
  const requests: { url: string; method: string; body?: string | undefined }[] = []
  const summary = {
    conversationId: CONV_ID,
    projectId: PROJECT_ID,
    ownerUserId: USER_ID,
    deviceId: DEVICE_ID,
    title: "幂等设计",
    status: "idle",
    briefText: "已完成简报",
    briefSource: "rule",
    briefUpdatedAtMs: 1_700_000_000_000,
    syncedSequence: 2,
    updatedAt: "2026-11-13T08:00:00.000Z",
    repositories: [],
  }
  const transport: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined })
    if (url.endsWith("/api/v1/auth/csrf")) {
      return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    }
    if (url.includes(`/projects/${PROJECT_ID}/conversations/${CONV_ID}/history`)) {
      return jsonOk({
        conversationId: CONV_ID,
        syncedSequence: 2,
        messages: [
          { sequence: 1, type: "user", occurredAtMs: 1_700_000_000_001, payload: '{"text":"你好"}' },
          { sequence: 2, type: "tool_summary", occurredAtMs: 1_700_000_000_002, payload: '{"label":"读取","summary":"README.md"}' },
        ],
      })
    }
    if (url.includes(`/projects/${PROJECT_ID}/conversations/${CONV_ID}`)) {
      return jsonOk({ conversation: summary })
    }
    if (url.includes(`/projects/${PROJECT_ID}/conversations`) && method === "POST") {
      return jsonOk({ conversation: summary }, 201)
    }
    if (url.includes(`/projects/${PROJECT_ID}/conversations`)) {
      return jsonOk({ projectId: PROJECT_ID, conversations: [summary] })
    }
    return new Response("not found", { status: 404 })
  }

  const client = new CollaborationClient(ORIGIN, transport)
  const listed = await client.listProjectConversations(WORKSPACE_ID, PROJECT_ID, { ownerId: USER_ID, status: "idle" })
  assert.equal(listed.ok, true)
  if (listed.ok) assert.equal(listed.value.conversations.length, 1)
  assert.equal(
    requests[0]?.url,
    `${ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/conversations?ownerId=${USER_ID}&status=idle`,
  )

  const registered = await client.registerProjectConversation(WORKSPACE_ID, PROJECT_ID, {
    deviceId: DEVICE_ID,
    title: "幂等设计",
    requestId: REQ_ID,
  })
  assert.equal(registered.ok, true)

  const detail = await client.getProjectConversation(WORKSPACE_ID, PROJECT_ID, CONV_ID)
  assert.equal(detail.ok, true)

  const history = await client.readProjectConversationHistory(WORKSPACE_ID, PROJECT_ID, CONV_ID, 0, 200)
  assert.equal(history.ok, true)
  if (history.ok) {
    assert.equal(history.value.messages.length, 2)
    assert.equal(history.value.syncedSequence, 2)
  }

  const badId = await client.getProjectConversation(WORKSPACE_ID, PROJECT_ID, "not-a-uuid")
  assert.equal(badId.ok, false)
  if (!badId.ok) assert.equal(badId.error.code, "INVALID_REQUEST")
})

test("PersonalStore 支持 projectDraft 与 conversation 超 800KB 正文自动从头裁剪", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc218-personal-"))
  try {
    const user = {
      id: USER_ID,
      userNo: "80278668",
      userName: "张景新",
      photo: "",
      orgId: "org-1",
      orgNo: "001",
      orgName: "平台架构二组",
      orgPathName: "信息技术部/平台架构二组",
    }
    const workspace = { id: WORKSPACE_ID, slug: "ws", name: "测试团队" }
    const transport: typeof fetch = async input => {
      const url = String(input)
      if (url.endsWith("/api/v1/auth/csrf")) {
        return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
      }
      if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) {
        return jsonOk({ user, workspaces: [workspace] })
      }
      if (url.endsWith(`/projects/${PROJECT_ID}`)) {
        return jsonOk({
          project: {
            projectId: PROJECT_ID,
            workspaceId: WORKSPACE_ID,
            name: "测试项目",
            description: "",
            ownerUserId: USER_ID,
            status: "active",
            role: "owner",
            memberCount: 1,
            version: 1,
            createdAt: "2026-11-13T00:00:00.000Z",
            updatedAt: "2026-11-13T00:00:00.000Z",
          },
          members: [],
          repositories: [],
        })
      }
      if (url.endsWith(`/projects/${PROJECT_ID}/conversations/${CONV_ID}`)) {
        return jsonOk({
          conversation: {
            conversationId: CONV_ID,
            projectId: PROJECT_ID,
            ownerUserId: USER_ID,
            deviceId: DEVICE_ID,
            title: "长历史会话",
            status: "idle",
            briefText: "简报",
            briefSource: "rule",
            briefUpdatedAtMs: 1_700_000_000_000,
            syncedSequence: 12,
            updatedAt: "2026-11-13T08:00:00.000Z",
            repositories: [],
          },
        })
      }
      return new Response("not found", { status: 404 })
    }

    const state = new CollaborationState(ORIGIN, transport)
    const login = await state.signIn("80278668")
    assert.equal(login.ok, true)

    const store = new PersonalStore(state, ORIGIN, dir)

    const draftKey = { kind: "projectDraft", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID } as const
    const initialDraft = await store.load(draftKey)
    assert.equal(initialDraft.ok, true)
    const savedDraft = await store.save(draftKey, 1, { directoryPath: "/tmp/plain-folder", draftText: "待发起问题" })
    assert.equal(savedDraft.ok, true)

    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    const loadedConv = await store.load(convKey)
    assert.equal(loadedConv.ok, true)

    // 构造约 960KB 的历史消息以触发 800KB 裁剪阈值。
    const largeMessages = Array.from({ length: 12 }, (_, index) => ({
      sequence: index + 1,
      type: "assistant" as const,
      occurredAtMs: 1_700_000_000_000 + index,
      payload: JSON.stringify({ text: "x".repeat(80_000) }),
    }))
    const savedConv = await store.save(convKey, 1, {
      scroll: { anchorEntryId: "seq-12", offsetPx: 12, following: true, seenContentRevision: 12 },
      expandedTools: [],
      expandedOutputs: [],
      draft: { text: "保留草稿", selectionStart: 4, selectionEnd: 4, revision: 1, referenceIds: [], attachmentIds: [] },
      localDirectoryPath: null,
      syncCache: { syncedSequence: 12, syncedAtMs: 1_700_000_000_999, messages: largeMessages },
    })
    assert.equal(savedConv.ok, true)

    // 重新通过新 store 实例从磁盘读取，确认草稿、水位、最新消息保留且已标 cacheTruncated。
    const reloaded = await new PersonalStore(state, ORIGIN, dir).load(convKey)
    assert.equal(reloaded.ok, true, reloaded.ok ? "" : reloaded.message)
    if (reloaded.ok && reloaded.value.data && "syncCache" in reloaded.value.data && reloaded.value.data.syncCache) {
      assert.equal(reloaded.value.data.draft.text, "保留草稿")
      assert.equal(reloaded.value.data.syncCache.syncedSequence, 12)
      assert.equal(reloaded.value.data.syncCache.cacheTruncated, true)
      assert.ok(reloaded.value.data.syncCache.messages.length < 12)
      assert.equal(reloaded.value.data.syncCache.messages.at(-1)?.sequence, 12)
    } else {
      assert.fail(`应从磁盘恢复裁剪后的 syncCache，实际收到: ${JSON.stringify(reloaded)}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
