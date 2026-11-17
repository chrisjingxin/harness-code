/** 用本机 Java + demo-data.sql 验证会话快照主链路，向隔离测试库写入演示数据。 */
import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:18084").origin
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/, "请传入本机隔离演示服务地址")
const workspace = "/api/v1/workspaces/00000000-0000-4000-8000-0000000000c1"
const project = workspace + "/projects/00000000-0000-4000-8000-0000000000a1"
const otherProject = workspace + "/projects/00000000-0000-4000-8000-0000000000a2"
const snapshots = project + "/snapshots"

async function request(path, { body, expected = body === undefined ? 200 : 201, auth = {}, session } = {}) {
  const method = body === undefined ? "GET" : "POST"
  const response = await fetch(origin + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: origin, "X-Workbench-Protocol-Version": "1",
      ...(session?.cookie ? { Cookie: session.cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json", ...session?.csrf }),
      ...auth,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  async function loadCsrf() {
    const csrf = await request("/api/v1/auth/csrf", { session })
    session.csrf = { [csrf.headerName]: csrf.token }
  }
  await loadCsrf()
  await request("/api/v1/auth/demo-login", { session, body: { userNo }, expected: 200 })
  await loadCsrf()
  return session
}

const a = await login("80278667")
const b = await login("80278668")
const deviceId = randomUUID()
const secret = randomBytes(32).toString("base64url")
await request(workspace + "/devices", {
  session: a,
  body: { registrationId: randomUUID(), deviceId, installationId: randomUUID(), ledgerId: randomUUID(), name: "HC-212 冒烟", secret },
})
const { conversation: { conversationId } } = await request(project + "/conversations", {
  session: a,
  body: { deviceId, title: "HC-212 会话快照", requestId: randomUUID() },
})
const auth = { Authorization: `Bearer ${deviceId}.${secret}` }
const message = (sequence, type, payload) => ({ sequence, type, payload, occurredAtMs: Date.now() })
async function upload(messages) {
  const sync = await request(`/api/v1/device/conversations/${conversationId}/sync`, {
    auth, expected: 200, body: { messages, brief: { briefText: "已同步简报", briefSource: "rule" } },
  })
  assert.equal(sync.syncedSequence, messages.at(-1).sequence)
}

await upload([message(1, "user", "核对账单"), message(2, "tool_summary", '{"toolName":"read","summary":"已核对"}')])
const source = { sourceConversationId: conversationId }
const preview = await request(snapshots, { session: b, body: source })
const fixedPath = snapshots + "/" + preview.snapshotId
assert.deepEqual([preview.fromSequence, preview.toSequence, preview.messageCount, preview.sourceSyncedSequence], [1, 2, 2, 2])
assert.equal(preview.sourceConversationId, conversationId)
assert.equal(preview.sourceTitle, "HC-212 会话快照")
assert.equal(preview.text, '[1 user]\n核对账单\n\n[2 tool_summary]\n{"toolName":"read","summary":"已核对"}')
assert.equal(preview.sha256, createHash("sha256").update(preview.text).digest("hex"))
assert.deepEqual(await request(fixedPath, { session: b }), preview)

const payload = "账".repeat(10000)
const prefix = `[3 assistant]\n${payload}\n\n[4 assistant]\n${payload}\n\n[5 assistant]\n`
const remaining = "x".repeat(65536 - Buffer.byteLength(prefix))
await upload([
  message(3, "assistant", payload), message(4, "assistant", payload),
  message(5, "assistant", remaining), message(6, "assistant", "新增"),
])
assert.deepEqual(await request(fixedPath, { session: b }), preview)

const exact = await request(snapshots, {
  session: b, body: { ...source, range: { type: "range", fromSequence: 3, toSequence: 5 } },
})
assert.equal(Buffer.byteLength(exact.text), 65536)
assert.equal(exact.sha256, createHash("sha256").update(prefix + remaining).digest("hex"))
assert.deepEqual(await request(snapshots + "/" + exact.snapshotId, { session: b }), exact)
const oversized = await request(snapshots, {
  session: b, expected: 413, body: { ...source, range: { type: "through", toSequence: 6 } },
})
assert.equal(oversized.code, "SNAPSHOT_TOO_LARGE")

const brief = await request(snapshots, { session: b, body: { ...source, range: { type: "brief" } } })
assert.deepEqual([brief.fromSequence, brief.toSequence, brief.messageCount, brief.text], [null, null, 0, "已同步简报"])

const c = await login("80278670")
assert.equal((await request(fixedPath, { session: c, expected: 404 })).code, "RESOURCE_NOT_FOUND")
assert.equal((await request(otherProject + "/snapshots", { session: b, expected: 404, body: source })).code, "RESOURCE_NOT_FOUND")
assert.equal((await request(otherProject + "/snapshots/" + preview.snapshotId, { session: b, expected: 404 })).code, "RESOURCE_NOT_FOUND")

console.log(JSON.stringify({
  preview, originalReadUnchangedAfterAppend: true, exactUtf8Bytes: Buffer.byteLength(exact.text),
  oversized: { status: 413, code: oversized.code }, brief: brief.text,
  nonMemberRead: 404, crossProjectCreate: 404, crossProjectRead: 404,
}, null, 2))
