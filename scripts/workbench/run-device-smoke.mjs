/** Runner 独立冒烟。用本地受控 WSS 对端验证真实进程、SQLite 和重复投递，Java 事务需另验。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket, { WebSocketServer } from "ws"
import { accepted, cancelReceived, nativeBound, output, running, seal, terminal } from "../../packages/runner-core/dist/execution-codec.js"

// 以共同夹具的字段顺序独立组装预期字节，核对生产构造器的原始正文及指纹。
const fixtures = JSON.parse(await readFile(new URL("../../packages/workbench-contracts/fixtures/execution.json", import.meta.url), "utf8"))
const fixture = type => fixtures.find(item => item.valid && item.data.type === type).data
const sourceStart = fixture("execution.start")
const sourceDecision = fixture("execution.start.decision")
const sourceCancel = fixture("execution.cancel")
const fixtureBody = type => {
  const { bodySha256, ...body } = fixture(type).payload
  return body
}
const acceptedBody = fixtureBody("execution.accepted")
const bindingBody = fixtureBody("execution.native.bound")
const outputBody = fixtureBody("execution.output")
const terminalBody = fixtureBody("execution.terminal")
const sourceCases = [
  [accepted(sourceStart, acceptedBody.runnerSequence), acceptedBody],
  [nativeBound(sourceStart, sourceDecision, bindingBody.runnerSequence, bindingBody.nativeSessionId), bindingBody],
  [running(sourceStart, sourceDecision, bindingBody.runnerSequence, bindingBody.nativeSessionId), bindingBody],
  [output(sourceStart, sourceDecision, outputBody.runnerSequence, outputBody.change), outputBody],
  [terminal(sourceStart, sourceDecision, terminalBody.runnerSequence, terminalBody.state, terminalBody.reasonCode,
    terminalBody.invocationState, terminalBody.nativeSessionId), terminalBody],
  [cancelReceived(sourceCancel, sourceCancel, acceptedBody.runnerSequence), { ...acceptedBody, cancelCommandId: sourceCancel.messageId }],
]
for (const [actual, shape] of sourceCases) {
  const startBodySha256 = actual.type === "execution.cancel.received" ? sourceCancel.payload.startBodySha256 : sourceStart.payload.bodySha256
  const payload = { ...shape, startBodySha256 }
  const expectedBody = JSON.stringify({ protocolVersion: 1, messageId: actual.messageId, type: actual.type, occurredAt: actual.occurredAt, payload })
  const expectedHash = createHash("sha256").update(expectedBody).digest("hex")
  assert.equal(JSON.stringify(actual), JSON.stringify({ ...JSON.parse(expectedBody), payload: { ...payload, bodySha256: expectedHash } }), actual.type)
}

const directory = await mkdtemp(join(tmpdir(), "hc196-device-smoke-"))
const projectRoot = join(directory, "project")
await mkdir(projectRoot)
const children = new Set()
const http = createServer()
const ws = new WebSocketServer({ server: http, perMessageDeflate: false })
http.listen(0, "127.0.0.1")
await once(http, "listening")
const origin = `http://127.0.0.1:${http.address().port}`
const deviceId = randomUUID(), workspaceId = randomUUID(), ledgerId = randomUUID(), ownerUserId = randomUUID()
const projectId = randomUUID(), agentConfigId = randomUUID(), secret = randomBytes(32).toString("base64url")
const probe = new URL("../../apps/runner/dist/index.js", import.meta.url)
const report = ["six-production-source-constructors-match-shared-wire-bytes"]

function message(type, payload) {
  return { protocolVersion: 1, messageId: randomUUID(), type, occurredAt: new Date().toISOString(), payload }
}
function startMessage() {
  return seal(message("execution.start", { workspaceId, conversationId: randomUUID(), executionId: randomUUID(), inputId: randomUUID(),
    deviceId, projectId, inputSequence: "1", initiatedByUserId: ownerUserId, agentConfigId, shareVersion: "1", nativeSessionId: null, input: { text: "验证" } }))
}
function target(start) {
  const { workspaceId, conversationId, executionId, inputId, deviceId, projectId, bodySha256 } = start.payload
  return { workspaceId, conversationId, executionId, inputId, deviceId, projectId, startCommandId: start.messageId, startBodySha256: bodySha256 }
}

async function launch() {
  const listening = once(ws, "connection")
  const child = spawn(process.execPath, [fileURLToPath(probe)], { stdio: "ignore", env: { ...process.env,
    WORKBENCH_SERVER: origin, WORKBENCH_DEVICE_SECRET: secret, WORKBENCH_DATA_DIR: directory,
    WORKBENCH_PROJECT_ROOT: projectRoot, WORKBENCH_PROJECT_ID: projectId, WORKBENCH_PROJECT_NAME: "隔离项目",
    WORKBENCH_AGENT_CONFIG_ID: agentConfigId, WORKBENCH_DEVICE_ID: deviceId, WORKBENCH_WORKSPACE_ID: workspaceId,
    WORKBENCH_LEDGER_ID: ledgerId, WORKBENCH_SHARE_ENABLED: "true", WORKBENCH_SHARE_VERSION: "1" } })
  children.add(child)
  const exited = once(child, "exit").then(result => { children.delete(child); return result })
  const [socket, req] = await Promise.race([listening, exited.then(() => { throw new Error("Runner 握手前退出") })])
  assert.equal(socket.protocol, "workbench.device.v1")
  assert.equal(req.headers.authorization === `Bearer ${deviceId}.${secret}`, true)
  assert.equal(req.headers.origin, origin)
  assert.equal(req.headers["x-workbench-protocol-version"], "1")
  const connectionId = randomUUID(), resumeId = randomUUID()
  const inbox = []
  socket.on("message", data => {
    const frame = JSON.parse(data.toString())
    assert.equal(frame.connectionId, connectionId)
    inbox.push(...(frame.messages ?? [frame.message]))
  })
  const send = inner => socket.send(JSON.stringify({ connectionId, message: inner }))
  const take = async (type, matches = () => true) => {
    for (let step = 0; step < 360; step++) {
      const index = inbox.findIndex(item => item.type === type && matches(item))
      if (index >= 0) return inbox.splice(index, 1)[0]
      assert.equal(socket.readyState, WebSocket.OPEN, `等待 ${type} 时连接关闭`)
      await new Promise(done => setTimeout(done, 20))
    }
    throw new Error(`等待 ${type} 超时`)
  }
  send(message("device.welcome", { deviceId, workspaceId, ownerUserId, ledgerId, resumeId, heartbeatIntervalMs: 15000, heartbeatTimeoutMs: 45000 }))
  const request = message("device.resume.request", { resumeId, kind: "inventory", afterStartCommandId: null })
  send(request)
  const inventory = await take("device.resume")
  assert.equal(inventory.payload.requestMessageId, request.messageId)
  assert.equal(inventory.payload.ledgerId, ledgerId)
  send(message("device.ready", { resumeId, ledgerId }))
  return { child, exited, send, take, inventory, inbox }
}

const ack = (executionId, lastCommittedRunnerSequence) => message("execution.events.ack", { executionId, lastCommittedRunnerSequence })
const deadline = setTimeout(() => {
  for (const child of children) child.kill("SIGKILL")
  for (const socket of ws.clients) socket.terminate()
}, 25_000)
try {
  const initializer = spawn(process.execPath, [fileURLToPath(probe), "--initialize-ledger", directory, ledgerId], { stdio: "ignore" })
  children.add(initializer)
  const [initialized] = await once(initializer, "exit")
  children.delete(initializer)
  assert.equal(initialized, 0)
  const first = await launch()
  assert.deepEqual(first.inventory.payload.records, [])
  report.push("origin-and-bearer-handshake", "server-driven-inventory")
  const start = startMessage()
  first.send(start)
  const accepted = await first.take("execution.accepted")
  first.send(ack(start.payload.executionId, "1"))
  assert.deepEqual(await first.take("execution.accepted"), accepted)
  first.send(seal(message("execution.start.decision", { ...target(start), decision: "allow", reasonCode: null })))
  const rejected = await first.take("execution.terminal")
  assert.equal(rejected.payload.state, "rejected")
  assert.equal(rejected.payload.reasonCode, "CAPABILITY_UNAVAILABLE")
  assert.equal(rejected.payload.invocationState, "notInvoked")
  first.send(ack(start.payload.executionId, "2"))
  report.push("ack-before-decision-replays-accepted", "real-unavailable-port-rejection")

  const lateStart = startMessage()
  const cancel = seal(message("execution.cancel", { ...target(lateStart), requestedByUserId: ownerUserId }))
  first.send(cancel)
  const execution = item => item.payload.executionId === lateStart.payload.executionId
  const received = await first.take("execution.cancel.received", execution)
  const final = await first.take("execution.terminal", execution)
  assert.equal(received.payload.runnerSequence, "1")
  assert.equal(final.payload.runnerSequence, "2")
  assert.equal(final.payload.invocationState, "notInvoked")
  first.child.kill("SIGKILL")
  await first.exited
  const second = await launch()
  const record = second.inventory.payload.records.find(item => item.kind === "cancelBeforeStart")
  assert.deepEqual(record.terminal, final)
  assert.equal(record.lastRunnerSequence, "2")
  assert.equal(record.lastCommittedRunnerSequence, "0")
  assert.deepEqual(await second.take("execution.cancel.received", execution), received)
  assert.deepEqual(await second.take("execution.terminal", execution), final)
  second.send(lateStart)
  await new Promise(done => setTimeout(done, 200))
  assert.equal(second.inbox.some(item => item.type === "execution.accepted" && execution(item)), false)
  second.send(ack(lateStart.payload.executionId, "2"))
  second.child.kill("SIGTERM")
  assert.deepEqual(await second.exited, [0, null])
  report.push("cancel-before-start-without-start", "exact-replay-after-crash", "late-start-not-accepted", "graceful-exit")
  console.log(JSON.stringify({ ok: true, report, childrenExited: children.size === 0 }))
} finally {
  clearTimeout(deadline)
  const exits = [...children].map(child => { const exit = once(child, "exit"); child.kill("SIGKILL"); return exit })
  for (const socket of ws.clients) socket.terminate()
  await Promise.all(exits)
  await new Promise(done => ws.close(() => http.close(done)))
  await rm(directory, { recursive: true, force: true })
}
