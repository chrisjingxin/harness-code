/** HC-233获批接点冒烟：真实协调器prepare/release→标准ACP会话配置→真实HTTP MCP，不改发送正文或轮次约定。 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"
import { CollaborationState } from "@workbench/collaboration-client"
import { LocalAcpHost } from "@workbench/acp-runtime"
import { createLocalExecutionCoordinator } from "../../desktop/src/main/local-execution-coordinator.ts"
import { ProjectMemoryStore } from "../../desktop/src/main/workbench-context/memory-store.ts"
import { WorkbenchContextService } from "../../desktop/src/main/workbench-context/service.ts"

const origin = "http://127.0.0.1:9999"
const accountId = "11111111111111111111111111111111"
const workspaceId = "11111111-1111-4111-8111-111111111111"
const projectId = "22222222-2222-4222-8222-222222222222"
const scope = { accountId, workspaceId, projectId, conversationId: "33333333-3333-4333-8333-333333333333" }
const json = body => new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), { headers: { "content-type": "application/json" } })
const identity = new CollaborationState(origin, async input => {
  const path = new URL(String(input)).pathname
  if (path.endsWith("/csrf")) return json({ headerName: "X-CSRF-TOKEN", token: "test-only" })
  if (path.endsWith("/demo-login") || path.endsWith("/me")) return json({ user: { id: accountId, userNo: "80000001", userName: "接点冒烟", photo: "", orgId: "org", orgNo: "001", orgName: "研发", orgPathName: "研发" }, workspaces: [{ id: workspaceId, slug: "smoke", name: "团队", role: "admin", memberVersion: 1, accessVersion: 1 }] })
  if (path.endsWith("/logout")) return json(null)
  if (path.includes("/conversations/")) return json({ conversation: { conversationId: path.split("/").at(-1), projectId, ownerUserId: accountId, title: "本人会话", status: "idle", briefText: "", briefSource: "rule", briefUpdatedAtMs: 1, syncedSequence: 0, updatedAt: "2026-11-23T00:00:00.000Z", shareMode: "full", shareStatus: "active", stoppedAt: null, repositories: [] } })
  throw Error("未预期请求")
})
const root = await mkdtemp(join(tmpdir(), "hc233-bind-"))
const cwd = await mkdir(join(root, "cwd"), { recursive: true })
const report = join(root, "setup.jsonl")
const fixture = fileURLToPath(new URL("./fixtures/context-acp-agent.mjs", import.meta.url))
const notices = [], events = [], prepared = [], released = []
let prepareFailure = false, bindFailure = false, leaveDuringPrepare = false, leaveDuringBind = false, noHttp = false
let bindCount = 0, coordinator
const hosts = []
const createHost = () => {
  const host = new LocalAcpHost({ executable: process.execPath, args: [fixture], env: { PATH: process.env.PATH, HC233_SETUP_REPORT: report, ...(noHttp ? { HC233_NO_HTTP: "1" } : {}) } }, { bindingDirectory: join(root, "native"), bindingNamespace: origin, restorePolicy: "fallback-new" })
  hosts.push(host)
  return host
}
let host = createHost()
const service = new WorkbenchContextService({ origin, identity, store: new ProjectMemoryStore(join(root, "memory")), authorizeBinding: async current => {
  const result = await identity.getProjectConversation(current.workspaceId, current.projectId, current.conversationId)
  return result.ok && result.value.conversation.ownerUserId === current.accountId
} })
const runtime = { host: { async bind(...args) {
  events.push("bind"); bindCount++
  if (bindFailure) throw Error("受控bind失败")
  const session = await host.bind(...args)
  if (leaveDuringBind) await identity.signOut()
  return new Proxy(session, { get(target, key) {
    if (key === "close") return async () => { events.push("close"); await target.close() }
    const value = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
} } }
const contextSession = {
  async prepare(current, bindingId) {
    events.push("prepare")
    // 授权依赖真实身份/本人会话，prepare发生在协调器bind之前，无执行binding依赖。
    const setup = await service.prepareSession(current, bindingId, { mcpServers: [{ name: "existing-user-service", type: "http", url: "http://127.0.0.1:1/mcp", headers: [] }] })
    prepared.push({ bindingId, setup })
    if (leaveDuringPrepare) await identity.signOut()
    if (prepareFailure) throw Error("受控MCP准备失败")
    return setup
  },
  release(current, bindingId) { events.push("release"); released.push(bindingId); service.revokeSession(current, bindingId) },
}
const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_channel, notice) => notices.push(notice) } }
const reports = async () => (await readFile(report, "utf8")).trim().split("\n").map(JSON.parse)
const accessStatus = async setup => {
  const server = setup.mcpServers.find(s => s.name === "workbench-context")
  return (await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", Authorization: server.headers[0].value }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status
}
async function login() { const result = await identity.signIn("80000001"); assert.equal(result.ok, true, JSON.stringify(result)) }
async function prepare(providerId = "default") {
  return coordinator.prepare(scope, cwd, providerId)
}
async function ordinarySend(bindingId) {
  const result = await coordinator.send(scope, bindingId, randomUUID(), "HC233_PLAIN_BIND_SMOKE")
  assert.equal(result.ok && result.value.status, "accepted", JSON.stringify(result))
  for (let i = 0; i < 100; i++) {
    const end = notices.find(n => n.kind === "finished" && n.turnId === result.value.turnId)
    if (end) { assert.equal(end.failure, undefined); return }
    await pause(20)
  }
  throw Error("普通会话终态超时")
}
try {
  await login()
  coordinator = createLocalExecutionCoordinator(window, identity, null, runtime, { origin, contextSession })
  await coordinator.captureDirectorySelection()(cwd)
  const first = await prepare()
  assert.equal(first.ok && first.value.available, true, JSON.stringify(first))
  assert.equal(prepared[0].bindingId, first.value.bindingId)
  assert.deepEqual((await reports())[0].servers, ["existing-user-service", "workbench-context"])
  assert.equal((await reports())[0].tools.length, 4)
  assert.equal(await accessStatus(prepared[0].setup), 200)
  assert.deepEqual(events.slice(0, 2), ["prepare", "bind"])
  const reuse = await prepare()
  assert.equal(reuse.value.bindingId, first.value.bindingId)
  assert.equal(prepared.length, 1, "复用有效绑定不生成新凭据")
  const switched = await prepare("other-agent")
  assert.equal(switched.ok, true)
  assert.notEqual(switched.value.bindingId, first.value.bindingId)
  assert.deepEqual(events.slice(2, 6), ["release", "close", "prepare", "bind"])
  assert.equal(await accessStatus(prepared[0].setup), 401)
  contextSession.release(scope, first.value.bindingId)
  assert.equal(await accessStatus(prepared.at(-1).setup), 200, "旧bindingId迟到释放不能撤销新凭据")
  // MCP准备异常不阻止普通会话，真实原因沿既有session-state可见。
  prepareFailure = true
  const plain = await prepare("prepare-failed")
  assert.equal(plain.ok && plain.value.available, true)
  assert.equal(await accessStatus(prepared.at(-1).setup), 401)
  assert.ok(notices.some(n => n.kind === "session-state" && n.bindingId === plain.value.bindingId && n.state.setupDiagnostics?.some(d => d.includes("受控MCP准备失败"))))
  assert.deepEqual((await reports()).at(-1).servers, [])
  await ordinarySend(plain.value.bindingId)
  prepareFailure = false
  bindFailure = true
  const failed = await prepare("bind-failed")
  assert.equal(failed.ok, false)
  assert.equal(await accessStatus(prepared.at(-1).setup), 401)
  bindFailure = false
  leaveDuringPrepare = true
  const before = bindCount
  const departed = await prepare("left-during-prepare")
  assert.equal(departed.ok, false)
  assert.equal(bindCount, before, "准备后账号变化不能继续bind")
  assert.equal(await accessStatus(prepared.at(-1).setup), 401)
  leaveDuringPrepare = false
  await login()
  await coordinator.captureDirectorySelection()(cwd)
  leaveDuringBind = true
  const late = await prepare("left-during-bind")
  assert.equal(late.ok, false)
  assert.equal(await accessStatus(prepared.at(-1).setup), 401)
  assert.deepEqual(events.slice(-2), ["release", "close"])
  leaveDuringBind = false
  await login()
  await coordinator.captureDirectorySelection()(cwd)
  // 真实Agent未声明HTTP MCP：通用ACP不发送服务，沿现有能力提示显示，普通会话仍可走通。
  noHttp = true; host = createHost()
  const unsupported = await prepare("no-http-agent")
  assert.equal(unsupported.ok && unsupported.value.available, true)
  assert.deepEqual((await reports()).at(-1).servers, [])
  assert.ok(notices.some(n => n.kind === "session-state" && n.bindingId === unsupported.value.bindingId && n.state.setupDiagnostics?.some(d => d.includes("MCP"))))
  await ordinarySend(unsupported.value.bindingId)
  await coordinator.dispose(); coordinator = undefined
  assert.equal(await accessStatus(prepared.at(-1).setup), 401)
  assert.deepEqual(events.slice(-2), ["release", "close"])
  console.log(JSON.stringify({ result: "PASS", binding: "真实协调器prepare→ACP new/load配置→回环MCP四工具；保留已有MCP配置", lifecycle: "复用不换凭据/换Agent先撤销/旧bindingId不误撤销/bind失败/准备及bind期间换账号/关闭撤销", degradation: "准备失败与HTTP MCP不支持均显示现有诊断，真实普通对话完成", task: "HC-256接入与凭据边界证据，正文与即时保存见smoke-workbench-context" }, null, 2))
} finally {
  await coordinator?.dispose()
  await service.dispose()
  await Promise.all(hosts.map(h => h.close()))
  identity.dispose()
  await rm(root, { recursive: true, force: true })
}
