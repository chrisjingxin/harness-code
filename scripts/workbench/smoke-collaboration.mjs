/** 隔离 Java 服务冒烟，使用 demo-data.sql 账号验证 HC-212 停点二至四。 */
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:18084").origin
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/, "请使用本机隔离演示服务")
const workspace = "/api/v1/workspaces/00000000-0000-4000-8000-0000000000c1"
const project = workspace + "/projects/00000000-0000-4000-8000-0000000000a1"
const tasks = project + "/tasks"
const knowledge = workspace + "/knowledge"
const notifications = workspace + "/notifications"
const aId = "000000000000400080000000000000d1"
const bId = "000000000000400080000000000000d2"
const commonHeaders = { Origin: origin, "X-Workbench-Protocol-Version": "1" }
const nonce = randomBytes(6).toString("hex")

async function call(path, { session, method = "GET", body, expected = 200, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: {
      ...commonHeaders, ...headers, ...session?.csrf,
      ...(session?.cookie && { Cookie: session.cookie }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  })
  const envelope = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${envelope.body?.code ?? envelope.returnCode}`)
  if (expected < 400) assert.equal(envelope.returnCode, "SUC0000")
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("WBSESSION="))
  if (cookie && session) session.cookie = cookie.split(";", 1)[0]
  return envelope.body
}

async function login(userNo) {
  const session = {}
  async function csrf() {
    const token = await call("/api/v1/auth/csrf", { session })
    session.csrf = { [token.headerName]: token.token }
  }
  await csrf()
  await call("/api/v1/auth/demo-login", { session, method: "POST", body: { userNo } })
  await csrf()
  return session
}

async function register(session, title) {
  const secret = randomBytes(32).toString("base64url")
  const deviceId = randomUUID()
  await call(workspace + "/devices", { session, method: "POST", expected: 201, body: {
    registrationId: randomUUID(), deviceId, installationId: randomUUID(), ledgerId: randomUUID(),
    name: "HC-212 冒烟", secret,
  } })
  const { conversation } = await call(project + "/conversations", {
    session, method: "POST", expected: 201, body: { deviceId, title, requestId: randomUUID() },
  })
  return { conversation, headers: { Authorization: `Bearer ${deviceId}.${secret}` } }
}

async function pages(session, afterId = 0) {
  const events = []
  for (;;) {
    const page = await call(`${notifications}?afterId=${afterId}`, { session })
    events.push(...page.events)
    if (!page.hasMore) return { events, cursor: page.nextAfterId }
    assert.ok(page.nextAfterId > afterId)
    afterId = page.nextAfterId
  }
}

async function openStream(session, since, lastEventId) {
  const stop = new AbortController()
  const response = await fetch(`${origin}${notifications}/stream?afterId=${since}`, {
    headers: { ...commonHeaders, Cookie: session.cookie, Accept: "text/event-stream",
      ...(lastEventId != null && { "Last-Event-ID": String(lastEventId) }) },
    redirect: "error", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(20000)]),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ""
  return {
    close: () => stop.abort(),
    async next() {
      for (;;) {
        const end = buffered.indexOf("\n\n")
        if (end < 0) {
          const received = await reader.read()
          assert.ok(!received.done, "流在收到通知前结束")
          buffered += received.value.replaceAll("\r\n", "\n")
          continue
        }
        const frame = buffered.slice(0, end).split("\n")
        buffered = buffered.slice(end + 2)
        const data = frame.find(line => line.startsWith("data:"))
        if (!data) continue
        const event = JSON.parse(data.slice(5))
        assert.equal(frame.find(line => line.startsWith("id:"))?.slice(3).trim(), String(event.id))
        assert.equal(frame.find(line => line.startsWith("event:"))?.slice(6).trim(), event.type)
        assert.deepEqual(Object.keys(event).sort(), ["eventId", "id", "objectId", "occurredAtMs", "projectId", "type"])
        return event
      }
    },
  }
}

const [a, b, c, outside] = await Promise.all(["80278667", "80278668", "80278669", "80278670"].map(login))
const owner = await register(a, "HC-212 来源")
const recipient = await register(b, "HC-212 本机执行会话")
const { conversationId: sourceId } = owner.conversation
const { conversationId } = recipient.conversation

const synced = await call(`/api/v1/device/conversations/${sourceId}/sync`, {
  method: "POST", headers: owner.headers, body: {
    messages: [{ sequence: 1, type: "user", payload: "仅按需读取的消息正文", occurredAtMs: Date.now() }],
    brief: { briefText: "已同步进展", briefSource: "rule" },
  },
})
assert.equal(synced.syncedSequence, 1)
await call("/api/v1/device/heartbeat", { method: "POST", headers: owner.headers })
const snap = await call(project + "/snapshots", { session: a, method: "POST", expected: 201,
  body: { sourceConversationId: sourceId } })

const termKey = "hc212-" + nonce
const item = await call(knowledge, { session: a, method: "POST", expected: 201,
  body: { termKey, category: "术语", title: "结算术语", text: "第一版正文" } })
const { knowledgeId, currentVersionId: versionId } = item.item
const material = { knowledgeId, versionId }
const knowledgePath = knowledge + "/" + knowledgeId
const versionPath = knowledgePath + "/versions/" + versionId

const baseline = (await pages(b)).cursor
const online = await openStream(b, baseline)
const creation = {
  title: "核对结算", description: "对照固定材料", assigneeId: bId, requestId: randomUUID(),
  snapshotIds: [snap.snapshotId], knowledgeRefs: [material],
}
let taskId
let assigned
try {
  const create = () => call(tasks, { session: a, method: "POST", body: creation, expected: 201 })
  const [created, repeated] = await Promise.all([create(), create()])
  assert.deepEqual(repeated, created)
  taskId = created.task.taskId
  assert.equal(created.task.status, "todo")
  assert.deepEqual(created.snapshotIds, [snap.snapshotId])
  assert.deepEqual(created.knowledgeRefs, [material])
  assert.deepEqual(await create(), created)
  assigned = await online.next()
  assert.equal(assigned.type, "task.assigned")
  assert.equal(assigned.objectId, taskId)
} finally {
  online.close()
}

const task = tasks + "/" + taskId
const take = { targetStatus: "doing", expectedVersion: 1, requestId: randomUUID() }
const flow = (session, body, expected = 200) => call(task + "/transitions", { session, method: "POST", body, expected })
assert.equal((await flow(a, take, 403)).code, "TASK_ROLE_REQUIRED")
assert.equal((await flow(b, take)).task.status, "doing")
assert.equal((await flow(b, { ...take, requestId: randomUUID() }, 409)).code, "VERSION_CONFLICT")
const linked = await call(task + "/conversation", { session: b, method: "PUT",
  body: { conversationId, expectedVersion: 2, requestId: randomUUID() } })
assert.equal(linked.task.conversationId, conversationId)
const { conversation } = await call(project + "/conversations/" + conversationId, { session: b })
assert.equal(conversation.status, "idle")
const received = (await call(tasks + "?assignee=me&status=doing", { session: b })).tasks
assert.ok(received.some(row => row.taskId === taskId))

const board = await call(project + "/board", { session: b })
const ownerRow = board.members.find(member => member.userId === aId)
const recipientRow = board.members.find(member => member.userId === bId)
assert.equal(ownerRow.deviceOnline, true)
assert.ok(ownerRow.conversationIds.includes(sourceId))
assert.ok(ownerRow.sentTaskIds.includes(taskId))
assert.ok(recipientRow.receivedTaskIds.includes(taskId))
const brief = board.conversations.find(row => row.conversation.conversationId === sourceId)
assert.equal(brief.deviceOnline, true)
assert.equal(brief.conversation.briefText, "已同步进展")

const commitSha = "a".repeat(40)
const review = { targetStatus: "review", expectedVersion: 3, requestId: randomUUID(), note: "待验收", commitSha }
assert.equal((await flow(b, review)).task.status, "review")
const done = await flow(a, { targetStatus: "done", expectedVersion: 4, requestId: randomUUID() })
assert.deepEqual(await call(task, { session: b }), done)
assert.deepEqual(done.transitions.map(row => row.toStatus), ["todo", "doing", "doing", "review", "done"])
assert.equal(done.transitions[3].commitSha, commitSha)
assert.equal((await call(task, { session: outside, expected: 404 })).code, "RESOURCE_NOT_FOUND")

const replay = await openStream(b, 0, assigned.id)
try {
  const completed = await replay.next()
  assert.equal(completed.type, "task.changed")
  assert.equal(completed.objectId, taskId)
  assert.ok(completed.id > assigned.id)
  const page = await call(`${notifications}?afterId=${assigned.id}&limit=1`, { session: b })
  assert.deepEqual(page.events, [completed])
} finally {
  replay.close()
}
assert.deepEqual((await pages(b, baseline)).events.filter(event => event.objectId === taskId).map(event => event.type),
  ["task.assigned", "task.changed"])
const other = (await pages(c)).events
assert.ok(other.some(event => event.objectId === sourceId && event.type === "conversation.brief_updated"))
assert.ok(!other.some(event => event.objectId === taskId))

const edited = await call(knowledgePath, { session: b, method: "PUT",
  body: { category: "规范", title: "结算术语新版", text: "第二版正文", expectedVersion: 1 } })
assert.equal(edited.item.version, 2)
assert.equal((await call(versionPath, { session: a })).text, "第一版正文")
assert.deepEqual((await call(knowledgePath + "/versions", { session: a })).versions.map(row => row.version), [2, 1])
let foundBySearch = false
const searchPath = knowledge + "?" + new URLSearchParams({ q: termKey, category: "规范" })
for (let attempt = 0; attempt < 15; attempt++) {
  const result = await call(searchPath, { session: a })
  foundBySearch = result.items.some(row => row.knowledgeId === knowledgeId && row.version === 2)
  if (foundBySearch) break
  await setTimeout(1000)
}
assert.ok(foundBySearch, "应能通过术语和分类找到当前版本")
const archived = await call(knowledgePath + "?expectedVersion=2", { session: a, method: "DELETE" })
assert.equal(archived.item.archived, true)
assert.equal((await call(versionPath, { session: b })).text, "第一版正文")
assert.equal((await call(searchPath, { session: a })).items.some(row => row.knowledgeId === knowledgeId), false)
assert.equal((await call(tasks, { session: a, method: "POST", body: { ...creation, requestId: randomUUID() },
  expected: 404 })).code, "RESOURCE_NOT_FOUND")

console.log(JSON.stringify({ taskId, status: done.task.status, versions: done.transitions.map(row => row.version),
  replayedRequest: true, versionConflict: 409, outOfRole: 403, linkedConversationIdle: true,
  knowledgeId, immutableVersion: versionId, foundBySearch, archiveBlocksNewReference: true,
  online: ownerRow.deviceOnline, liveEvent: assigned.eventId, resumedWithLastEventId: true, unrelatedFiltered: true }, null, 2))
