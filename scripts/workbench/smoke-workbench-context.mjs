/** HC-233 必要主路径冒烟：隔离Markdown、真实HTTP MCP、受控ACP Agent；不接触真实模型或用户记忆目录。 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { setTimeout as pause } from "node:timers/promises"
import { LocalConversationStore } from "../../desktop/src/main/local-conversation-store.ts"
import { createLocalExecutionCoordinator } from "../../desktop/src/main/local-execution-coordinator.ts"
import { fileURLToPath } from "node:url"
import { CollaborationState } from "@workbench/collaboration-client"
import { LocalAcpHost } from "@workbench/acp-runtime"
import { WorkbenchContextService, MEMORY_UPDATE_REMINDER } from "../../desktop/src/main/workbench-context/service.ts"
import { ProjectMemoryStore } from "../../desktop/src/main/workbench-context/memory-store.ts"

const user = "11111111111111111111111111111111"
const workspaceId = "11111111-1111-4111-8111-111111111111"
const projectId = "22222222-2222-4222-8222-222222222222"
const otherProject = "22222222-2222-4222-8222-222222222223"
const conversationId = "33333333-3333-4333-8333-333333333333"
const knowledgeId = "44444444-4444-4444-8444-444444444444"
const versionId = "55555555-5555-4555-8555-555555555555"
const origin = "http://127.0.0.1:9999"
const scope = { accountId: user, workspaceId, projectId, conversationId }
const memoryScope = { origin, accountId: user, workspaceId }
let title = "接口错误码规范", titleReads = 0
const now = "2026-11-23T00:00:00.000Z"
const project = id => ({ projectId: id, workspaceId, name: id === projectId ? "账务工程" : "其他工程", description: "工程用途与关系", ownerUserId: user, status: "active", role: "owner", memberCount: 1, version: 1, createdAt: now, updatedAt: now })
const json = body => new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), { headers: { "content-type": "application/json" } })
const transport = async input => {
  const url = new URL(String(input))
  if (url.pathname.endsWith("/csrf")) return json({ headerName: "X-CSRF-TOKEN", token: "test-only" })
  if (url.pathname.endsWith("/demo-login") || url.pathname.endsWith("/me")) return json({ user: { id: user, userNo: "80000001", userName: "冒烟用户", photo: "", orgId: "org", orgNo: "001", orgName: "研发", orgPathName: "研发" }, workspaces: [{ id: workspaceId, slug: "smoke", name: "冒烟团队", role: "admin", memberVersion: 1, accessVersion: 1 }] })
  if (url.pathname.endsWith("/logout")) return json(null)
  if (url.pathname.endsWith("/reads")) return json({ versionReadCount: 1, totalReadCount: 1 })
  if (url.pathname.endsWith("/projects")) return json({ workspaceId, projects: [project(projectId), project(otherProject)] })
  if (url.pathname.includes("/projects/")) return json({ project: project(url.pathname.split("/").at(-1)), members: [], repositories: [] })
  if (url.pathname.endsWith("/repositories")) return json({ workspaceId, repositories: [] })
  if (url.pathname.endsWith("/knowledge")) { const level = url.searchParams.get("level"); if (!level) titleReads++; return json({ items: level === "rule" || level === "term" ? [] : [{ knowledgeId, termKey: "errors", category: "规范", title, currentVersionId: versionId, version: 1, archived: false, updatedAtMs: 1, level:"experience",scope:{kind:"workspace",repositoryIds:[]},contentType:"article",health:{readCount:0,usefulCount:0,expiredCount:0,needsReview:false,lastReviewedAtMs:1,feedbackWatermark:0} }], nextAfterId: null }) }
  if (url.pathname.endsWith(`/versions/${versionId}`)) return json({ knowledgeId, termKey: "errors", archived: false, version: { versionId, version: 1, category: "规范", title, authorId: user, createdAtMs: 1, level:"experience",scope:{kind:"workspace",repositoryIds:[]},contentType:"article",contributors:[user],reviewerId:null,reviewedAtMs:null,proposalId:null }, text: "已发布规范正文：团队工程用途依据。" })
  throw new Error(`未预期请求:${url.pathname}`)
}
const root = await mkdtemp(join(tmpdir(), "hc256-"))
const cwd = join(root, "cwd"); await mkdir(cwd)
const identity = new CollaborationState(origin, transport)
const store = new ProjectMemoryStore(join(root, "memory"))
const local = new LocalConversationStore(join(root, "local"), origin)
const feedback = [], notices = []
let runScope, coordinator, host
const service = new WorkbenchContextService({ origin, identity, store, authorizeBinding: async current => current.accountId === user && current.conversationId === runScope?.conversationId, onFeedback: value => feedback.push(value) })
const serverOf = setup => setup.mcpServers.find(s => s.name === "workbench-context")
const rpc = async (server, method, params = {}, id = randomUUID()) => {
  const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(server.headers.map(h => [h.name, h.value])) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  assert.ok(!result.isError, JSON.stringify(result))
  return method === "tools/call" ? JSON.parse(result.content[0].text) : result
}
const tool = (server, name, args) => rpc(server, "tools/call", { name, arguments: args })
const saved = async (scope, document) => { const result = await store.read(scope, document, () => true); assert.equal(result.status, "ready"); return result }
const update = async (scope, document, content) => { const old = await saved(scope, document); return store.update(scope, { document, content, expectedRevision: old.revision }, () => true) }
try {
  // 原始字节备份、正文/来源保留、损坏只读，以及普通 front matter 代表样本。
  const legacyScope = { ...memoryScope, workspaceId: "legacy" }, dir = store.directory(legacyScope)
  await mkdir(dir, { recursive: true })
  const entry = { entryId: "old-entry", entryRevision: 1, kind: "team_project", name: "旧工程", summary: "旧用途", sources: [{ sourceId: "project:old", kind: "project", projectId }], confirmedAt: now }
  const body = "# 团队工程概览\n\n## 旧工程\n旧用途\n"
  const original = `---\nformatVersion: 1\ndocumentRevision: 1\nupdatedAt: ${JSON.stringify(now)}\nentries: ${JSON.stringify([entry])}\n---\n${body}`
  await writeFile(join(dir, "team.md"), original)
  const migrated = await saved(legacyScope, "team")
  assert.ok(migrated.content.startsWith(body) && migrated.content.includes("project:old"))
  const backup = join(dir, `team.md.hc233-v1.${createHash("sha256").update(original).digest("hex")}.bak`)
  assert.equal(await readFile(backup, "utf8"), original)
  assert.equal((await saved(legacyScope, "team")).revision, migrated.revision)
  const broken = original.replace(JSON.stringify([entry]), "[broken]")
  await writeFile(join(dir, "personal.md"), broken)
  assert.equal((await store.read(legacyScope, "personal", () => true)).status, "unavailable")
  assert.equal((await store.update(legacyScope, { document: "personal", content: "覆盖损坏", expectedRevision: "0".repeat(64) }, () => true)).status, "unavailable")
  assert.equal(await readFile(join(dir, "personal.md"), "utf8"), broken)
  assert.equal((await update(legacyScope, "team", migrated.content + "\n保留健康文件独立保存。\n")).status, "saved")
  assert.equal((await readdir(dir)).filter(x => x.endsWith(".bak")).length, 1)
  const unsafeScope = { ...memoryScope, workspaceId: "linked" }; await mkdir(store.directory(unsafeScope), { recursive: true })
  await symlink(join(dir, "team.md"), join(store.directory(unsafeScope), "team.md"))
  assert.equal((await store.read(unsafeScope, "team", () => true)).reason, "unsafe_path")

  assert.equal((await identity.signIn("80000001")).ok, true)
  const created = await local.create(user, { workspaceId, title: "隔离主路径", directoryPath: cwd }); assert.equal(created.ok, true)
  runScope = { ...scope, projectId: null, conversationId: created.value.conversationId }
  const setup = await service.prepareSession(runScope, "manual"), server = serverOf(setup)
  const init = await rpc(server, "initialize", { protocolVersion: "2025-03-26" })
  assert.ok(init.instructions.includes("update_project_memory")); assert.ok(Buffer.byteLength(MEMORY_UPDATE_REMINDER) <= 256)
  assert.deepEqual((await rpc(server, "tools/list")).tools.map(x => x.name), ["read_project_memory", "update_project_memory", "list_team_knowledge", "read_team_knowledge"])
  const context = await service.assembleTurnContext({ scope: runScope, userText: "新事实", directoryPath: cwd, turnId: "manual" })
  service.confirmTurnDelivered(runScope, "manual", context.preparedKnowledge)
  const first = await tool(server, "read_project_memory", { document: "team" })
  assert.equal(first.status, "ready")
  const candidates = await Promise.all(["甲", "乙"].map(name => tool(server, "update_project_memory", { document: "team", content: first.content + name, expectedRevision: first.revision })))
  assert.deepEqual(candidates.map(x => x.status).sort(), ["conflict", "saved"])
  assert.equal((await tool(server, "read_project_memory", { document: "../../elsewhere" })).status, "error")
  const personal = await tool(server, "read_project_memory", { document: "personal" })
  const markdown = "---\nformatVersion: 1\ntitle: 自由文档\n---\n用户确认目录：/并不存在/也可记录，无需Git证明。\n"
  assert.equal((await tool(server, "update_project_memory", { document: "personal", content: markdown, expectedRevision: personal.revision })).status, "saved")
  assert.equal((await tool(server, "read_project_memory", { document: "personal" })).content, markdown)
  const big = await tool(server, "read_project_memory", { document: "team" })
  const largeText = "长".repeat(3200)
  const large = await tool(server, "update_project_memory", { document: "team", content: largeText, expectedRevision: big.revision })
  assert.equal(large.status, "saved"); assert.equal(large.size.overTarget, true)
  const oversized = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(server.headers.map(h => [h.name, h.value])) }, body: JSON.stringify({ jsonrpc: "2.0", id: "large", method: "tools/call", params: { name: "update_project_memory", arguments: { document: "team", content: "大".repeat(24000), expectedRevision: large.revision } } }) })
  assert.equal(oversized.status, 413)
  assert.equal((await saved(memoryScope, "team")).content, largeText)
  const ref = (await tool(server, "list_team_knowledge", {})).items[0].referenceId
  assert.ok((await tool(server, "read_team_knowledge", { referenceId: ref })).text)
  assert.equal((await tool(server, "read_team_knowledge", { referenceId: ref })).alreadyRead, true)
  await service.onTurnSettled({ scope: runScope, turnId: "manual", outcome: "failed" })
  assert.equal((await saved(memoryScope, "personal")).content, markdown, "失败不回滚saved")
  assert.equal((await service.readMemory({ ...runScope, workspaceId: null }, "team")).reason, "no_team")
  assert.equal((await service.readMemory({ ...runScope, accountId: "other" }, "team")).status, "unavailable")

  // 真协调器 → 真 ACP 子进程 → HTTP MCP，两轮增量以及保存后取消/失败。
  await update(memoryScope, "team", "# 团队工程记忆\n")
  await update(memoryScope, "personal", "# 个人工程记忆\n")
  const report = join(root, "prompts.jsonl")
  host = new LocalAcpHost({ executable: process.execPath, args: [fileURLToPath(new URL("./fixtures/context-turn-acp-agent.mjs", import.meta.url)), report], env: { PATH: process.env.PATH } }, { bindingDirectory: join(root, "native"), bindingNamespace: origin, restorePolicy: "fallback-new" })
  coordinator = createLocalExecutionCoordinator({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_, n) => notices.push(n) } }, identity, null, { host }, { origin, grantsDir: join(root, "grants"), localConversations: local, contextSession: { prepare: (s, id) => service.prepareSession(s, id), release: (s, id) => service.revokeSession(s, id) }, contextAssembler: service })
  await coordinator.captureDirectorySelection()(cwd)
  const ready = await coordinator.prepare(runScope, cwd); assert.ok(ready.ok && ready.value.available, JSON.stringify(ready))
  async function until(check) { for (let n = 0; n < 120; n++) { if (await check()) return; await pause(30) } throw Error("受控协调器等待超时") }
  async function send(message) { const key = randomUUID(), receipt = await coordinator.send(runScope, ready.value.bindingId, key, message, []); assert.ok(receipt.ok && receipt.value.status === "accepted", JSON.stringify(receipt)); return { key, receipt: receipt.value } }
  async function finish(run) { await until(() => notices.some(n => n.kind === "finished" && n.turnId === run.receipt.turnId)); return notices.find(n => n.kind === "finished" && n.turnId === run.receipt.turnId) }
  const one = await send("HC241_CONTEXT_ONE"); assert.equal((await finish(one)).failure, undefined)
  const two = await send("HC241_CONTEXT_TWO"); assert.equal((await finish(two)).failure, undefined)
  const prompts = (await readFile(report, "utf8")).trim().split("\n").map(JSON.parse)
  const secondText = JSON.stringify(prompts[1].prompt)
  assert.ok(secondText.includes("team.md（已更新）") && !secondText.includes("personal.md"))
  const cancelled = await send("HC241_CONTEXT_CANCEL")
  await until(() => feedback.some(f => f.turnId === cancelled.key && f.result.status === "saved"))
  await coordinator.cancel(runScope, ready.value.bindingId, cancelled.receipt.turnId); await finish(cancelled)
  assert.ok((await saved(memoryScope, "team")).content.includes("取消后保留"))
  const failed = await send("HC241_CONTEXT_FAIL"); assert.ok((await finish(failed)).failure)
  assert.ok((await saved(memoryScope, "team")).content.includes("失败后保留"))
  const cleared = await update(memoryScope, "personal", ""); assert.equal(cleared.status, "saved")
  assert.equal((await saved(memoryScope, "personal")).content, "")
  assert.notEqual((await saved({ ...memoryScope, accountId: "other" }, "team")).content, (await saved(memoryScope, "team")).content)
  console.log("PASS HC-256：原件迁移/损坏保护/普通front matter；真实HTTP MCP即时保存、CAS冲突继续、8KiB建议/64KiB拒绝；真实协调器ACP两轮增量、取消/失败保留saved；知识固定版读取与去重。UI未操作。")
} finally { await coordinator?.dispose(); await host?.close(); await service.dispose(); identity.dispose(); await rm(root, { recursive: true, force: true }) }
