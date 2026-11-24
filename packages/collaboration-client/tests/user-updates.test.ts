/**
 * `@workbench/collaboration-client` 跨团队 Inbox、用户级通知流与偏好设置单元测试。
 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  CollaborationClient as CollaborationClientType,
  UserUpdatesService as UserUpdatesServiceType,
} from "../src/index.ts"
import type {
  InboxResponse,
  NotificationPreferences,
  UserNotificationEvent,
  UserUpdatesNotice,
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

const { CollaborationClient, UserUpdatesService } = await import("../src/index.ts") as {
  CollaborationClient: typeof CollaborationClientType
  UserUpdatesService: typeof UserUpdatesServiceType
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_ID = "11111111111111111111111111111111"
const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "22222222-2222-4222-8222-222222222222"
const PROJECT_ID = "33333333-3333-4333-8333-333333333333"
const TASK_ID = "44444444-4444-4444-8444-444444444444"
const EVENT_ID = "55555555-5555-4555-8555-555555555555"

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test("CollaborationClient 支持全局 Inbox、跨团队通知分页与偏好设置契约校验", async () => {
  let badInbox = false
  let csrfIssued = false

  const sampleInbox: InboxResponse = {
    bucket: "action_required",
    items: [
      {
        itemKey: `task:${TASK_ID}`,
        sourceType: "task",
        category: "task_review",
        urgency: "urgent",
        workspaceId: WS_A,
        projectId: PROJECT_ID,
        projectName: "支付重构",
        objectId: TASK_ID,
        title: "核对账单",
        status: "review",
        actorId: USER_ID,
        delegated: false,
        updatedAtMs: 1000,
      },
    ],
    counts: { actionRequired: 1, urgent: 1, sent: 0 },
    notificationCursor: 12,
    workspaces: [{ workspaceId: WS_A, name: "架构组", slug: "arch" }],
    actors: [{ userId: USER_ID, userNo: "80278667", name: "沈北辰", active: true }],
    truncated: false,
  }

  const samplePrefs: NotificationPreferences = {
    externalEnabled: true,
    subscribedEvents: ["task.assigned", "task.review_requested"],
    dndEnabled: true,
    dndStartMinute: 1320,
    dndEndMinute: 540,
    dndTimezone: "Asia/Shanghai",
    mergeWindowSec: 60,
    version: 1,
  }

  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/api/v1/auth/csrf") {
      csrfIssued = true
      return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    }
    if (url.pathname === "/api/v1/me/inbox") {
      if (badInbox) return jsonOk({ bucket: "action_required", items: [] })
      assert.equal(url.searchParams.get("bucket"), "action_required")
      assert.equal(url.searchParams.get("limit"), "150")
      return jsonOk(sampleInbox)
    }
    if (url.pathname === "/api/v1/me/notifications") {
      return jsonOk({
        events: [
          {
            id: 12,
            eventId: EVENT_ID,
            workspaceId: WS_A,
            type: "task.assigned",
            objectId: TASK_ID,
            projectId: PROJECT_ID,
            occurredAtMs: 2000,
          },
        ],
        nextAfterId: 12,
        hasMore: false,
      })
    }
    if (url.pathname === "/api/v1/me/notification-preferences") {
      if (init?.method === "PUT") {
        assert.equal(csrfIssued, true)
        return jsonOk(samplePrefs)
      }
      return jsonOk({ ...samplePrefs, version: 0 })
    }
    return new Response("not found", { status: 404 })
  }

  const client = new CollaborationClient(ORIGIN, transport)

  const inbox = await client.getInbox({ bucket: "action_required", limit: 150 })
  assert.equal(inbox.ok, true)
  if (inbox.ok) {
    assert.equal(inbox.value.counts.actionRequired, 1)
    assert.equal(inbox.value.notificationCursor, 12)
  }

  const badQuery = await client.getInbox({ limit: 201 })
  assert.equal(badQuery.ok, false)
  if (!badQuery.ok) assert.equal(badQuery.error.code, "INVALID_REQUEST")

  badInbox = true
  const malformed = await client.getInbox()
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.equal(malformed.error.code, "INVALID_SERVER_RESPONSE")

  const page = await client.listUserNotifications(0, 20)
  assert.equal(page.ok, true)
  if (page.ok) assert.equal(page.value.events[0]!.workspaceId, WS_A)

  const prefGet = await client.getNotificationPreferences()
  assert.equal(prefGet.ok, true)
  if (prefGet.ok) assert.equal(prefGet.value.version, 0)

  const prefPut = await client.updateNotificationPreferences({
    externalEnabled: true,
    subscribedEvents: ["task.assigned", "task.review_requested"],
    dndEnabled: true,
    dndStartMinute: 1320,
    dndEndMinute: 540,
    dndTimezone: "Asia/Shanghai",
    mergeWindowSec: 60,
    expectedVersion: 0,
  })
  assert.equal(prefPut.ok, true)
  if (prefPut.ok) assert.equal(prefPut.value.version, 1)

  const badPrefPut = await client.updateNotificationPreferences({
    externalEnabled: true,
    subscribedEvents: ["task.assigned"],
    dndEnabled: true,
    dndStartMinute: 1500,
    dndEndMinute: 540,
    dndTimezone: "Asia/Shanghai",
    mergeWindowSec: 60,
    expectedVersion: 0,
  })
  assert.equal(badPrefPut.ok, false)
  if (!badPrefPut.ok) assert.equal(badPrefPut.error.code, "INVALID_REQUEST")

  client.dispose()
})

test("UserUpdatesService 跨团队乱序提交不丢低 ID 事件且单调保存游标", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc246-user-updates-"))
  try {
    const encoder = new TextEncoder()
    const evt102: UserNotificationEvent = {
      id: 102,
      eventId: EVENT_ID,
      workspaceId: WS_A,
      type: "task.assigned",
      objectId: TASK_ID,
      projectId: PROJECT_ID,
      occurredAtMs: 1000,
    }
    const evt101: UserNotificationEvent = {
      id: 101,
      eventId: EVENT_ID,
      workspaceId: WS_B,
      type: "task.changed",
      objectId: TASK_ID,
      projectId: PROJECT_ID,
      occurredAtMs: 900,
    }
    const dup102: UserNotificationEvent = { ...evt102 }

    let capturedAfterId = -1
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/v1/me/notifications/stream") {
        const headers = new Headers(init?.headers)
        capturedAfterId = Number(headers.get("Last-Event-ID"))
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(":heartbeat\n\n"))
            for (const item of [evt102, evt101, dup102]) {
              controller.enqueue(
                encoder.encode(`id: ${item.id}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`),
              )
            }
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response("not found", { status: 404 })
    }

    const client = new CollaborationClient(ORIGIN, transport)
    const service = new UserUpdatesService(dir, ORIGIN)
    const notices: UserUpdatesNotice[] = []

    service.subscribe({
      subscriptionId: "sub-1",
      accountId: USER_ID,
      initialCursor: 100,
      network: client,
      isCurrent: () => true,
      publish: notice => {
        notices.push(notice)
        if (notice.kind === "event") {
          service.acknowledge("sub-1", notice.event.id)
        }
      },
    })

    await waitUntil(() => notices.filter(n => n.kind === "event").length === 2)
    // 稍微等待确认重复事件 evt102 不会触发第 3 次投递，且游标已写入磁盘。
    await new Promise(resolve => setTimeout(resolve, 40))

    const delivered = notices
      .filter((n): n is Extract<UserUpdatesNotice, { kind: "event" }> => n.kind === "event")
      .map(n => `${n.event.workspaceId}:${n.event.id}`)
    assert.deepEqual(delivered, [`${WS_A}:102`, `${WS_B}:101`])
    assert.equal(capturedAfterId, 100)

    service.stop("sub-1")
    client.dispose()

    const files = await import("node:fs/promises").then(fs => fs.readdir(dir))
    assert.equal(files.length, 1)
    assert.equal((await readFile(join(dir, files[0]!), "utf8")).trim(), "102")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("UserUpdatesService 将更高的 initialCursor 基线立即持久化并作为 Last-Event-ID 重连起点", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc246-user-updates-seed-"))
  try {
    const encoder = new TextEncoder()
    const { notificationCursor } = await import("../src/project-notification-cursor.ts")
    const cursor = notificationCursor(dir, ORIGIN, USER_ID, "__me__")
    await cursor.save(164)

    let capturedAfterId = -1
    let connected = false
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/v1/me/notifications/stream") {
        capturedAfterId = Number(new Headers(init?.headers).get("Last-Event-ID"))
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(":heartbeat\n\n"))
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response("not found", { status: 404 })
    }

    const client = new CollaborationClient(ORIGIN, transport)
    const service = new UserUpdatesService(dir, ORIGIN)
    service.subscribe({
      subscriptionId: "sub-seed",
      accountId: USER_ID,
      initialCursor: 243,
      network: client,
      isCurrent: () => true,
      publish: notice => {
        if (notice.kind === "status" && notice.status === "connected") connected = true
      },
    })

    await waitUntil(() => connected)
    service.stop("sub-seed")
    client.dispose()

    assert.equal(capturedAfterId, 243)
    assert.equal(await cursor.read(), 243)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
