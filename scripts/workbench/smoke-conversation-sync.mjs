/** HC-211 必要 HTTP 冒烟。用户登录 → 本人上传 → 同项目成员读简报与增量正文。 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"

const [origin, evidenceFile] = process.argv.slice(2)
assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
assert.ok(evidenceFile, "请提供本轮证据文件")
const workspace = "/api/v1/workspaces/00000000-0000-4000-8000-0000000000c1"
const project = workspace + "/projects/00000000-0000-4000-8000-0000000000a1"
const requests = []
const evidence = { origin, requests }
let historyRequests = 0

/** 只记录结果。Cookie 和 CSRF 留在各自会话内存中。 */
async function call(name, path, session, method = "GET", body, expected = 200) {
  const response = await fetch(origin + path, {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: {
      Origin: origin, "X-Workbench-Protocol-Version": "1",
      ...(session.cookie && { Cookie: session.cookie }),
      ...(method !== "GET" && session.csrf),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  })
  const envelope = await response.json()
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("WBSESSION="))
  if (cookie) session.cookie = cookie.split(";", 1)[0]
  requests.push({ name, method, path, status: response.status, code: envelope.body?.code ?? envelope.returnCode })
  if (path.includes("/history?")) historyRequests++
  assert.equal(response.status, expected, name + " " + JSON.stringify(envelope))
  if (expected < 400) assert.equal(envelope.returnCode, "SUC0000")
  return envelope.body
}

async function login(userNo) {
  const session = {}
  async function csrf() {
    const token = await call("csrf", "/api/v1/auth/csrf", session)
    session.csrf = { [token.headerName]: token.token }
  }
  await csrf()
  await call("login", "/api/v1/auth/demo-login", session, "POST", { userNo })
  await csrf()
  return session
}

try {
  const a = await login("80278667")
  const b = await login("80278668")
  const title = "HC-211 本人上传 " + randomUUID().slice(0, 8)
  const { conversation } = await call("register", project + "/conversations", a, "POST", {
    title, repositoryIds: [], requestId: randomUUID(),
  }, 201)
  assert.equal(conversation.ownerUserId, "000000000000400080000000000000d1")
  assert.equal(conversation.syncedSequence, 0)
  const base = project + "/conversations/" + conversation.conversationId
  const batch = {
    messages: [
      { sequence: 1, type: "user", occurredAtMs: Date.now(), payload: JSON.stringify({ text: "核对本期用户登录同步。" }) },
      { sequence: 2, type: "assistant", occurredAtMs: Date.now(), payload: JSON.stringify({ text: "已完成，只读成员可以主动读取本轮正文。" }) },
    ],
    brief: { status: "idle", briefSource: "rule", briefText: "本期用户上传和成员只读已就绪" },
  }
  evidence.conversationId = conversation.conversationId
  assert.deepEqual(await call("owner-sync", base + "/sync", a, "POST", batch), { syncedSequence: 2 })

  const list = await call("member-brief-list", project + "/conversations", b)
  const brief = list.conversations.find(item => item.conversationId === conversation.conversationId)
  assert.equal(brief.briefText, batch.brief.briefText)
  assert.equal(brief.syncedSequence, 2)
  assert.equal(Object.hasOwn(brief, "messages"), false)
  assert.equal(historyRequests, 0)
  evidence.historyRequestsBeforeExplicitRead = historyRequests

  const incremental = await call("member-explicit-incremental-history", base + "/history?afterSequence=1&limit=100", b)
  assert.equal(incremental.syncedSequence, 2)
  assert.deepEqual(incremental.messages, [batch.messages[1]])
  evidence.incremental = incremental

  assert.deepEqual(await call("owner-identical-replay", base + "/sync", a, "POST", batch), { syncedSequence: 2 })
  const full = await call("member-history-after-replay", base + "/history?afterSequence=0&limit=100", b)
  assert.deepEqual(full.messages, batch.messages)
  assert.equal(full.syncedSequence, 2)

  const gap = await call("owner-gap", base + "/sync", a, "POST", {
    messages: [{ ...batch.messages[0], sequence: 4 }],
  }, 409)
  assert.equal(gap.code, "SEQUENCE_CONFLICT")
  assert.equal(gap.expectedSequence, 3)
  const denied = await call("member-cannot-upload", base + "/sync", b, "POST", { messages: [] }, 403)
  assert.equal(denied.code, "CONVERSATION_FORBIDDEN")

  const final = await call("member-final-brief", base, b)
  assert.equal(final.conversation.syncedSequence, 2)
  assert.equal(final.conversation.briefText, batch.brief.briefText)
  evidence.brief = final.conversation
  evidence.replayMessageCount = full.messages.length
  evidence.gapExpectedSequence = gap.expectedSequence

  // 少量旧入口核对与源码路由清单共同确认旧远程派发退出。
  await call("retired-device-sync", "/api/v1/device/conversations/" + conversation.conversationId + "/sync", a, "POST", { messages: [] }, 404)
  await call("retired-remote-input", base + "/inputs", b, "POST", { text: "unused" }, 404)
  evidence.result = "HC211_CURRENT_SYNC_SMOKE_PASS"
  console.log(evidence.result + " owner=200 watermark=2 replay=2 gap=409/3 memberUpload=403 brief=200 incremental=[2]")
} catch (error) {
  evidence.error = error.message
  throw error
} finally {
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 })
}
