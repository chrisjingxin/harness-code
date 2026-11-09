/**
 * HC-195 真实 HTTP/SSE 冒烟。用生产主进程客户端验证共享、去重、连续位置和退出。
 * 显式提供已迁移、已初始化的隔离服务。脚本经生产接口登记本次临时设备/项目，留证后由宿主清理隔离库。
 */
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { CollaborationClient } from "../../apps/desktop/src/main/collaboration-client.ts"

const origin = process.env.WORKBENCH_ORIGIN
assert(origin, "请提供本轮隔离 WORKBENCH_ORIGIN")
const user01 = new CollaborationClient(origin)
let streamResponse
const seenResumeHeaders = []
let disconnect
const user02 = new CollaborationClient(origin, async (url, options) => {
  if (!new URL(url).pathname.endsWith("/events")) return fetch(url, options)
  if (options.headers["Last-Event-ID"]) seenResumeHeaders.push(options.headers["Last-Event-ID"])
  const transport = new AbortController()
  disconnect = () => transport.abort()
  const response = await fetch(url, { ...options, signal: AbortSignal.any([options.signal, transport.signal]) })
  streamResponse = response.headers.get("content-type")
  return response
})

function ok(result) {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error))
  return result.value
}

function denied(result, code) {
  assert.equal(result.ok, false)
  assert.equal(result.error.code, code)
}

async function waitFor(test, message) {
  const deadline = Date.now() + 7_000
  while (Date.now() < deadline) {
    if (test()) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(message)
}

async function request(path, options = {}) {
  const { headers, ...rest } = options
  return fetch(`${origin}${path}`, {
    ...rest,
    headers: { Origin: origin, "X-Workbench-Protocol-Version": "1", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  })
}

const checks = []
let stream
try {
  const a = ok(await user01.signIn("user01"))
  const b = ok(await user02.signIn("user02"))
  const workspaceId = a.workspaces[0]?.id
  assert(workspaceId && b.workspaces.some(workspace => workspace.id === workspaceId))
  const base = `/api/v1/workspaces/${workspaceId}`
  const deviceId = randomUUID(), projectId = randomUUID(), agentConfigId = randomUUID()
  const secret = randomBytes(32).toString("base64url")
  ok(await user01.registerDevice(workspaceId, {
    registrationId: randomUUID(), deviceId, installationId: randomUUID(), ledgerId: randomUUID(), name: "冒烟设备", secret,
  }))
  const publishOptions = {
    method: "POST",
    headers: { Authorization: `Bearer ${deviceId}.${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID(), projectId, name: "冒烟项目", shareEnabled: true, expectedShareVersion: "0",
      agentConfigs: [{ agentConfigId, name: "受控执行配置", available: true }],
    }),
  }
  const invalidOrigin = await request("/api/v1/device/projects", {
    ...publishOptions, headers: { ...publishOptions.headers, Origin: "https://rejected.invalid" },
  })
  assert.equal(invalidOrigin.status, 403)
  assert.equal((await invalidOrigin.json()).error.code, "REQUEST_SOURCE_REJECTED")
  const published = await request("/api/v1/device/projects", publishOptions)
  assert.equal(published.status, 201, await published.text())
  assert(ok(await user01.listDevices(workspaceId)).devices.some(device => device.deviceId === deviceId))
  const share = ok(await user01.listProjects(workspaceId, deviceId)).projects.find(project => project.projectId === projectId)
  assert(share)
  checks.push("device-origin-denied", "device-publish", "device-and-project-list")

  const create = () => user01.createConversation(workspaceId, {
    requestId: randomUUID(), title: "冒烟会话", deviceId, projectId, agentConfigId,
  })
  const { conversation: { conversationId } } = ok(await create())
  const other = ok(await create()).conversation.conversationId
  assert(ok(await user01.listConversations(workspaceId)).conversations.some(row => row.conversationId === conversationId))
  assert.equal((await request(`${base}/conversations?limit=1&limit=1`)).status, 400)
  checks.push("conversation-list", "duplicate-query-denied")

  const input = { requestId: randomUUID(), text: "冒烟：共享历史 😀" }
  const [first, replay] = await Promise.all([
    user01.sendInput(workspaceId, conversationId, input),
    user01.sendInput(workspaceId, conversationId, input),
  ])
  const saved = ok(first)
  assert.deepEqual(ok(replay), saved)
  denied(await user01.sendInput(workspaceId, conversationId, { ...input, text: "冲突正文" }), "REQUEST_ID_CONFLICT")
  denied(await user01.sendInput(workspaceId, other, input), "REQUEST_ID_CONFLICT")
  assert.equal(ok(await user01.getExecution(workspaceId, conversationId, saved.executionId)).execution.state, "queued")
  checks.push("offline-queued", "concurrent-deduplication", "different-body-and-target-conflict")

  const before = ok(await user01.history(workspaceId, conversationId))
  const shared = ok(await user02.history(workspaceId, conversationId))
  assert.deepEqual(shared, before)
  const authored = before.events.filter(event => event.type === "message.created")
  assert.equal(authored.length, 1)
  assert.equal(authored[0].payload.message.author.username, "user01")
  assert(before.events.every(event => event.workspaceId === workspaceId))
  assert.equal((await request(`${base}/conversations/${conversationId}/history`)).status, 401)
  checks.push("shared-history-author", "anonymous-denied")

  // 先固定历史上界，再写入，最后订阅，验证历史转实时的接缝。
  const added = ok(await user02.sendInput(workspaceId, conversationId, { requestId: randomUUID(), text: "历史上界之后" }))
  const events = [], problems = []
  stream = user02.subscribeConversation(workspaceId, conversationId, before.throughSequence,
    event => events.push(event), problem => problems.push(problem.code))
  await waitFor(() => events.some(event => event.sequence === added.committedSequence), "SSE 未补齐历史上界后的事件")
  assert.match(streamResponse, /^text\/event-stream/)
  assert.deepEqual(events.map(event => event.sequence), [added.inputSequence, added.committedSequence])
  disconnect()
  const afterDisconnect = ok(await user01.sendInput(workspaceId, conversationId, { requestId: randomUUID(), text: "断线期间" }))
  await waitFor(() => events.some(event => event.sequence === afterDisconnect.committedSequence), "SSE 未从连续位置重连")
  assert.deepEqual(seenResumeHeaders, [`${conversationId}:${added.committedSequence}`])
  assert.deepEqual(events.map(event => event.sequence), [
    added.inputSequence, added.committedSequence, afterDisconnect.inputSequence, afterDisconnect.committedSequence,
  ])
  const cancelled = ok(await user01.cancelExecution(workspaceId, conversationId, saved.executionId, { requestId: randomUUID() }))
  assert.equal(cancelled.cancelState, "resolved")
  assert.equal(ok(await user01.getExecution(workspaceId, conversationId, saved.executionId)).execution.state, "cancelled")
  checks.push("history-to-stream", "last-event-id-reconnect", "queued-cancel")

  ok(await user02.signOut())
  await waitFor(() => seenResumeHeaders.length === 1, "旧会话不应建立新订阅")
  const eventCount = events.length
  ok(await user01.sendInput(workspaceId, conversationId, { requestId: randomUUID(), text: "退出之后" }))
  await new Promise(resolve => setTimeout(resolve, 1_250))
  assert.equal(events.length, eventCount)
  assert.equal(seenResumeHeaders.length, 1)
  assert(problems.every(code => code === "NETWORK_UNAVAILABLE"))
  ok(await user01.stopSharing(workspaceId, projectId, { requestId: randomUUID(), expectedShareVersion: share.shareVersion }))
  const rejected = await user01.sendInput(workspaceId, conversationId, { requestId: randomUUID(), text: "撤回后拒绝" })
  assert.equal(rejected.ok, false)
  assert(["PROJECT_NOT_SHARED", "TARGET_UNAVAILABLE"].includes(rejected.error.code))
  assert(ok(await user01.history(workspaceId, conversationId)).events.length > before.events.length)
  checks.push("logout-stops-delivery", "share-revocation-preserves-history")

  console.log(JSON.stringify({ ok: true, workspaceId, conversationId, inputId: saved.inputId, checks }))
} finally {
  stream?.close()
  user01.dispose()
  user02.dispose()
}
