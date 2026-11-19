/**
 * `@workbench/collaboration-client` 独立单元测试：
 * 验证内联 Schema 校验（含畸形回包拦截）、SSE 事件流解析与游标原子持久化、
 * 以及无 Electron 依赖的 `ConversationUploads` 作用域隔离与工具摘要裁剪。
 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  CollaborationClient as CollaborationClientType,
  ConversationUploads as ConversationUploadsType,
  collaborationConversationKey as collaborationConversationKeyFn,
  createCollaborationSdk as createCollaborationSdkFn,
  notificationCursor as notificationCursorFn,
  readProjectNotifications as readProjectNotificationsFn,
} from "../src/index.ts"
import type {
  CollaborationConversationScope,
  ConversationSyncRequest,
  ConversationUploadNotice,
  ProjectUpdatesNotice,
} from "../src/types/index.ts"

if (!("bun" in process.versions)) {
  const resolveTsHook = `
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    export async function resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const jsUrl = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(jsUrl))) {
          const tsSpecifier = specifier.slice(0, -3) + ".ts";
          const tsUrl = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsSpecifier, context);
        }
      }
      return nextResolve(specifier, context);
    }
  `
  register(`data:text/javascript,${encodeURIComponent(resolveTsHook)}`)
}

const {
  CollaborationClient,
  ConversationUploads,
  collaborationConversationKey,
  createCollaborationSdk,
  notificationCursor,
  readProjectNotifications,
  syncPayloadLimit,
} = await import("../src/index.ts") as {
  CollaborationClient: typeof CollaborationClientType
  ConversationUploads: typeof ConversationUploadsType
  collaborationConversationKey: typeof collaborationConversationKeyFn
  createCollaborationSdk: typeof createCollaborationSdkFn
  notificationCursor: typeof notificationCursorFn
  readProjectNotifications: typeof readProjectNotificationsFn
  syncPayloadLimit: number
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_ID = "11111111111111111111111111111111"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

test("CollaborationClient 使用内联 Schema 校验合法响应并拦截畸形响应", async () => {
  let badBoard = false
  const transport: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith("/api/v1/meta")) {
      return jsonOk({ productVersion: "0.2.0", protocolVersion: 1, loginMode: "demo" })
    }
    if (url.endsWith(`/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/board`)) {
      if (badBoard) return jsonOk({ projectId: "not-a-uuid" })
      return jsonOk({
        projectId: PROJECT_ID,
        members: [],
        conversations: [],
        tasks: [],
        conversationsTruncated: false,
        tasksTruncated: false,
      })
    }
    return new Response("not found", { status: 404 })
  }

  const client = new CollaborationClient(ORIGIN, transport)
  const meta = await client.getMeta()
  assert.equal(meta.ok, true)
  if (meta.ok) assert.equal(meta.value.productVersion, "0.2.0")

  const boardOk = await client.readProjectBoard(WORKSPACE_ID, PROJECT_ID)
  assert.equal(boardOk.ok, true)

  badBoard = true
  const boardBad = await client.readProjectBoard(WORKSPACE_ID, PROJECT_ID)
  assert.equal(boardBad.ok, false)
  if (!boardBad.ok) assert.equal(boardBad.error.code, "INVALID_SERVER_RESPONSE")

  client.dispose()
})

test("SSE 帧解析与游标单调保存可独立在无 Electron 环境下运行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc231-collab-sse-"))
  try {
    const encoder = new TextEncoder()
    const payload = {
      id: 7,
      eventId: "44444444-4444-4444-8444-444444444444",
      type: "task.changed",
      objectId: "55555555-5555-4555-8555-555555555555",
      projectId: PROJECT_ID,
      occurredAtMs: 1_700_000_000_000,
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"))
        controller.enqueue(encoder.encode(`id: 7\nevent: task.changed\ndata: ${JSON.stringify(payload)}\n\n`))
        controller.close()
      },
    })
    const received = []
    for await (const event of readProjectNotifications(stream, (v): v is typeof payload => Boolean(v && typeof v === "object"))) {
      received.push(event)
    }
    assert.deepEqual(received, [payload])

    const cursor = notificationCursor(dir, ORIGIN, USER_ID, WORKSPACE_ID)
    assert.equal(await cursor.read(), 0)
    await cursor.save(7)
    await cursor.save(3)
    assert.equal(await cursor.read(), 7)

    // 验证同步后的 dist/schema 也可从包根目录读取
    const sdk = createCollaborationSdk({ origin: ORIGIN, storageDir: dir })
    assert.ok(sdk.client)
    await sdk.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ConversationUploads 基于自有作用域键隔离队列并裁剪超长工具摘要", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc231-collab-uploads-"))
  try {
    const scope: CollaborationConversationScope = {
      accountId: USER_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      conversationId: CONV_ID,
    }
    assert.equal(
      collaborationConversationKey(scope),
      JSON.stringify([USER_ID, WORKSPACE_ID, PROJECT_ID, CONV_ID]),
    )

    const uploaded: ConversationSyncRequest[] = []
    const notices: unknown[] = []
    let watermark = 0
    const uploads = new ConversationUploads(
      dir,
      {
        watermark: async () => ({ ok: true, value: watermark }),
        upload: async (_s, req) => {
          uploaded.push(req)
          watermark = req.messages.at(-1)?.sequence ?? watermark
          return { ok: true, value: { syncedSequence: watermark } }
        },
      },
      notice => notices.push(notice),
    )

    await uploads.enqueue(scope, {
      turnId: "turn-1",
      userText: "检查边界",
      reply: "已完成",
      acceptedAtMs: 1_700_000_000_000,
      completedAtMs: 1_700_000_001_000,
      tools: [
        {
          label: "终端命令",
          name: "cmd " + "汉".repeat(15_000),
          summary: "输出 " + "字".repeat(15_000),
          status: "completed",
          tone: "neutral",
          occurredAtMs: 1_700_000_000_500,
        },
      ],
    })
    await uploads.flush()
    const persisted = JSON.parse(await readFile(join(dir, USER_ID, `${CONV_ID}.json`), "utf8")) as { turns: unknown[] }
    assert.equal(persisted.turns.length, 1)

    uploads.useAccount(USER_ID)
    const deadline = Date.now() + 5000
    while (uploaded.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(uploaded.length, 1)
    assert.deepEqual(uploaded[0]!.messages.map(m => m.type), ["user", "tool_summary", "assistant"])
    for (const msg of uploaded[0]!.messages) {
      assert.ok(Buffer.byteLength(msg.payload, "utf8") <= syncPayloadLimit)
    }
    assert.equal(notices.length, 1)

    uploads.useAccount(null)
    await uploads.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test("createCollaborationSdk 自动联动登录态、所有权校验并在登出/销毁时停止上传与 SSE 通知", async () => {
  const OTHER_USER_ID = "22222222222222222222222222222222"
  const user = {
    id: USER_ID,
    userNo: "80000001",
    userName: "测试用户",
    photo: "",
    orgId: "org-1",
    orgNo: "001",
    orgName: "研发组",
    orgPathName: "研发部/研发组",
  }
  const workspace = { id: WORKSPACE_ID, slug: "ws", name: "测试团队" }
  const scope: CollaborationConversationScope = {
    accountId: USER_ID,
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    conversationId: CONV_ID,
  }

  let watermark = 0
  let conversationOwnerId = USER_ID
  let sseAborted = false
  let sseConnected = false
  const requests: string[] = []
  const syncedRequests: ConversationSyncRequest[] = []
  const notices: ConversationUploadNotice[] = []
  const updateNotices: ProjectUpdatesNotice[] = []

  const transport: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    requests.push(`${method} ${url}`)

    if (url.endsWith("/api/v1/auth/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) {
      return jsonOk({ user, workspaces: [workspace] })
    }
    if (url.endsWith("/api/v1/auth/logout")) {
      return new Response(null, { status: 204 })
    }
    if (url.endsWith(`/projects/${PROJECT_ID}/conversations/${CONV_ID}`)) {
      return jsonOk({
        conversation: {
          conversationId: CONV_ID,
          projectId: PROJECT_ID,
          ownerUserId: conversationOwnerId,
          title: "SDK 自动上传会话",
          status: "idle",
          briefText: "",
          briefSource: "rule",
          briefUpdatedAtMs: 1_700_000_000_000,
          syncedSequence: watermark,
          updatedAt: "2026-11-18T00:00:00.000Z",
          repositories: [],
        },
      })
    }
    if (url.endsWith(`/projects/${PROJECT_ID}/conversations/${CONV_ID}/sync`)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as ConversationSyncRequest
      syncedRequests.push(body)
      watermark = body.messages.at(-1)?.sequence ?? watermark
      return jsonOk({ syncedSequence: watermark })
    }
    if (url.endsWith(`/workspaces/${WORKSPACE_ID}/notifications/stream`)) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"))
          init?.signal?.addEventListener("abort", () => {
            sseAborted = true
            try { controller.close() } catch {}
          }, { once: true })
        },
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }

  // 1) 未登录前先入队：只落盘不发请求；登录后不手调 useAccount 自动排空上传
  const dir1 = await mkdtemp(join(tmpdir(), "hc231-sdk-auto-"))
  try {
    const sdk = createCollaborationSdk({
      origin: ORIGIN,
      storageDir: dir1,
      transport,
      onUploadNotice: notice => notices.push(notice),
    })
    assert.ok(sdk.client && sdk.uploads)

    await sdk.uploads.enqueue(scope, {
      turnId: "turn-prelogin",
      userText: "登录前入队",
      reply: "待登录后自动上传",
      acceptedAtMs: 1_700_000_000_000,
      completedAtMs: 1_700_000_000_500,
    })
    await sdk.uploads.flush()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(syncedRequests.length, 0)
    assert.equal(requests.some(item => item.includes("/conversations/")), false)

    const login = await sdk.state.signIn("80000001")
    assert.equal(login.ok, true)

    await waitUntil(() => notices.length >= 1)
    assert.equal(syncedRequests.length, 1)
    assert.equal(notices[0]!.failure, undefined)
    assert.equal(notices[0]!.firstSequence, 1)
    assert.equal(notices[0]!.syncedSequence, 2)

    // 2) 登录后直接入队（不手动调用 useAccount）自动上传
    await sdk.uploads.enqueue(scope, {
      turnId: "turn-signedin",
      userText: "登录后入队",
      reply: "立即自动上传",
      acceptedAtMs: 1_700_000_001_000,
      completedAtMs: 1_700_000_001_500,
    })
    await waitUntil(() => notices.length >= 2)
    assert.equal(syncedRequests.length, 2)
    assert.equal(notices[1]!.failure, undefined)
    assert.equal(notices[1]!.firstSequence, 3)
    assert.equal(notices[1]!.syncedSequence, 4)

    // 3) 开启 SSE 通知后登出：停止通知流并停止后续入队上传
    sdk.updates.subscribe({
      subscriptionId: "sub-1",
      accountId: USER_ID,
      workspaceId: WORKSPACE_ID,
      network: sdk.client,
      isCurrent: () => true,
      publish: notice => {
        updateNotices.push(notice)
        if (notice.kind === "status" && notice.status === "connected") sseConnected = true
      },
    })
    await waitUntil(() => sseConnected)

    const out = await sdk.state.signOut()
    assert.equal(out.ok, true)
    await waitUntil(() => sseAborted)

    const syncCountBeforeSignOutEnqueue = syncedRequests.length
    const requestCountBeforeSignOutEnqueue = requests.length
    await sdk.uploads.enqueue(scope, {
      turnId: "turn-signedout",
      userText: "登出后入队",
      reply: "不应上传",
      acceptedAtMs: 1_700_000_002_000,
      completedAtMs: 1_700_000_002_500,
    })
    await sdk.uploads.flush()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(syncedRequests.length, syncCountBeforeSignOutEnqueue)
    assert.equal(requests.length, requestCountBeforeSignOutEnqueue)

    await sdk.dispose()
  } finally {
    await rm(dir1, { recursive: true, force: true })
  }

  // 4) 非会话创建者拦截：watermark 返回 ownerUserId 不一致时拒绝上传且不发 /sync
  const dir2 = await mkdtemp(join(tmpdir(), "hc231-sdk-owner-"))
  try {
    conversationOwnerId = OTHER_USER_ID
    const foreignNotices: ConversationUploadNotice[] = []
    const syncBeforeForeign = syncedRequests.length
    const sdk = createCollaborationSdk({
      origin: ORIGIN,
      storageDir: dir2,
      transport,
      onUploadNotice: notice => foreignNotices.push(notice),
    })
    const login = await sdk.state.signIn("80000001")
    assert.equal(login.ok, true)

    await sdk.uploads!.enqueue(scope, {
      turnId: "turn-foreign",
      userText: "他人会话",
      reply: "应被创建者校验拦截",
      acceptedAtMs: 1_700_000_003_000,
      completedAtMs: 1_700_000_003_500,
    })
    await waitUntil(() => foreignNotices.length >= 1)
    assert.equal(foreignNotices[0]!.failure, "会话共享失败：仅会话创建者可执行该操作。")
    assert.equal(syncedRequests.length, syncBeforeForeign)

    await sdk.dispose()
  } finally {
    await rm(dir2, { recursive: true, force: true })
  }
})
