/** HC-233 必要主路径冒烟：隔离Markdown、真实HTTP MCP、受控ACP Agent；不接触真实模型或用户记忆目录。 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CollaborationState } from "@workbench/collaboration-client"
import { LocalAcpHost } from "@workbench/acp-runtime"
import { WorkbenchContextService, MEMORY_UPDATE_REMINDER } from "../../desktop/src/main/workbench-context/service.ts"
import { ProjectMemoryStore, renderMemory } from "../../desktop/src/main/workbench-context/memory-store.ts"
import { applyLocalExecutionUpdate, emptyLocalExecutionView } from "../../desktop/src/renderer/features/session/local-execution-view.ts"

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
const root = await mkdtemp(join(tmpdir(), "hc233-"))
const cwd = await mkdir(join(root, "cwd"), { recursive: true })
const identity = new CollaborationState(origin, transport)
const store = new ProjectMemoryStore(join(root, "memory"))
const feedback = []
const service = new WorkbenchContextService({ origin, identity, store, authorizeBinding: async () => true, onFeedback: value => feedback.push(value) })
let host
const rpc = async (server, method, params = {}, id = "smoke") => {
  const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...Object.fromEntries(server.headers.map(h => [h.name, h.value])) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
  assert.equal(response.status, 200)
  const result = (await response.json()).result
  if (result.isError && !result.structuredContent) throw new Error(result.content[0].text)
  return method === "tools/call" ? JSON.parse(result.content[0].text) : result
}
const tool = (server, name, args = {}, id = name) => rpc(server, "tools/call", { name, arguments: args }, id)
const setup = binding => service.prepareSession(scope, binding)
const serverOf = setup => setup.mcpServers.find(s => s.name === "workbench-context")
const assemble = turnId => service.assembleTurnContext({ scope, userText: "本轮无工程关键词", directoryPath: cwd, turnId })
const settle = (turnId, outcome = "completed") => service.onTurnSettled({ scope, turnId, outcome })
const entries = async () => (await store.read(memoryScope))["team.md"].entries
try {
  const loginResult = await identity.signIn("80000001"); assert.equal(loginResult.ok, true, JSON.stringify(loginResult))
  const firstSetup = await setup("binding-1"), server = serverOf(firstSetup)
  assert.equal(new URL(server.url).hostname, "127.0.0.1")
  const init = await rpc(server, "initialize", { protocolVersion: "2025-03-26" })
  assert.equal(init.protocolVersion, "2025-03-26")
  assert.ok(init.instructions.includes("list_team_knowledge") && init.instructions.includes("current_turn_user"))
  assert.equal((await rpc(server, "tools/list")).tools.length, 4)
  assert.ok(Buffer.byteLength(MEMORY_UPDATE_REMINDER) <= 256)
  const context = await assemble("first")
  assert.ok(context.contextBlocks[0].text.includes("其他工程"), context.contextBlocks[0].text)
  assert.ok(!context.contextBlocks[0].text.includes("团队知识标题（按需读取固定版本）"))
  service.confirmTurnDelivered(scope, "first", context.preparedKnowledge)
  await assert.rejects(tool(server, "query_project_memory", { workspaceId: "伪造范围" }), /参数无效/)
  await assert.rejects(tool(server, "propose_project_memory_update", { operation: "upsert", kind: "team_repository", baseEntryRevision: 0, fields: { name: "无来源", summary: "" }, sourceIds: ["未读来源"] }), /实际读过/)
  const query = await tool(server, "query_project_memory")
  assert.ok(query.entries.length >= 3)
  const before = await entries()
  const referenceId = (await tool(server, "list_team_knowledge")).items[0].referenceId
  assert.equal((await tool(server, "read_team_knowledge", { referenceId })).text.includes("已发布规范正文"), true)
  assert.equal((await tool(server, "read_team_knowledge", { referenceId })).alreadyRead, true)
  assert.equal((await tool(server, "read_team_knowledge", { referenceId })).text, undefined)
  assert.equal((await tool(server, "read_team_knowledge", { referenceId, force: true })).text.includes("已发布规范正文"), true)
  const proposal = { operation: "upsert", kind: "team_repository", baseEntryRevision: 0, fields: { name: "新增工程", summary: "来自真实读取的固定规范", aliases: ["new"] }, sourceIds: [referenceId] }
  const pending = await tool(server, "propose_project_memory_update", proposal, "proposal-1")
  assert.equal(pending.status, "pending")
  assert.equal((await entries()).length, before.length, "pending不能提前写入")
  assert.equal((await tool(server, "propose_project_memory_update", proposal, "duplicate")).entryId, pending.entryId)
  await settle("first")
  assert.ok((await entries()).some(e => e.entryId === pending.entryId), "预检与保存使用相同生成ID")
  assert.deepEqual(feedback.slice(-3).map(f => f.result.status), ["pending", "saving", "saved"])
  await assemble("cancelled")
  await tool(server, "read_team_knowledge", { referenceId })
  const updated = await tool(server, "query_project_memory", { entryId: pending.entryId })
  assert.equal(updated.entries[0].entryRevision, 1)
  const revisions = updated.documentRevisions
  assert.equal((await tool(server, "propose_project_memory_update", { ...proposal, entryId: pending.entryId, baseEntryRevision: 1 })).status, "no_change")
  assert.deepEqual((await tool(server, "query_project_memory", { entryId: pending.entryId })).documentRevisions, revisions)
  await tool(server, "propose_project_memory_update", { ...proposal, fields: { ...proposal.fields, name: "取消不保存" } }, "cancel-proposal")
  await settle("cancelled", "cancelled")
  assert.ok(!(await entries()).some(e => e.name === "取消不保存"))
  await assemble("limits")
  await tool(server, "read_team_knowledge", { referenceId })
  const unconfirmed = await tool(server, "propose_project_memory_update", { ...proposal, kind: "personal_directory", fields: { name: "未确认目录", summary: "", rootPath: root, relativePath: "." } })
  assert.equal(unconfirmed.status, "needs_confirmation")
  const huge = await tool(server, "propose_project_memory_update", { ...proposal, fields: { name: "超限工程", summary: "长".repeat(2000) } })
  assert.equal(huge.status, "error")
  const confirmed = await service.confirmDirectory(scope, { path: root, fields: { name: "本人选定工程", summary: "直接确认" }, baseEntryRevision: 0 })
  assert.equal(confirmed.status, "saved")
  await settle("limits", "failed")
  assert.ok((await store.read(memoryScope))["personal.md"].entries.some(e => e.entryId === confirmed.entryId))
  // 并发不同条目可合并，同条目过期更新不能覆盖。
  const source = [{ sourceId: "knowledge:smoke", kind: "knowledge" }]
  const conflictProposal = { operation: "upsert", kind: "team_repository", entryId: pending.entryId, baseEntryRevision: 1, fields: { summary: "新用途" }, sourceIds: ["knowledge:smoke"] }
  assert.equal((await store.update(memoryScope, conflictProposal, source, true, () => true)).status, "saved")
  assert.equal((await store.update(memoryScope, { ...conflictProposal, fields: { summary: "过期用途" } }, source, true, () => true)).status, "conflict")
  const otherScope = { ...memoryScope, workspaceId: "another-team" }
  assert.equal((await store.read(otherScope))["team.md"].entries.length, 0)
  assert.equal((await store.read({ ...memoryScope, accountId: "another-user" }))["team.md"].entries.length, 0)
  assert.equal((await store.read({ ...memoryScope, origin: "http://127.0.0.1:9998" }))["team.md"].entries.length, 0)
  // 只在生成/更新阶段限制两份正文合计；超限不能覆盖已保存文件。
  const budgetScope = { ...memoryScope, workspaceId: "budget-team" }
  for (let i = 0; i < 3; i++) {
    const result = await store.update(budgetScope, { operation: "upsert", kind: i === 2 ? "personal_directory" : "team_repository", baseEntryRevision: 0, fields: { name: `预算工程${i}`, summary: "长".repeat(850), ...(i === 2 ? { rootPath: root, relativePath: "." } : {}) }, sourceIds: ["confirmed"] }, [{ sourceId: "confirmed", kind: "user_confirmation", confirmedDirectory: root }], true, () => true)
    assert.equal(result.status, "saved", JSON.stringify(result))
  }
  const beforeBudget = await store.read(budgetScope)
  const overBudget = await store.update(budgetScope, { operation: "upsert", kind: "team_repository", baseEntryRevision: 0, fields: { name: "合计超限", summary: "长".repeat(850) }, sourceIds: ["knowledge:smoke"] }, source, true, () => true)
  assert.equal(overBudget.status, "error")
  assert.ok(overBudget.message.includes("8 KiB"))
  assert.deepEqual(await store.read(budgetScope), beforeBudget)
  // 用户确认目录可在Agent尚未连接时保存和移除；不改变其他会话目录。
  const unconnectedScope = { ...scope, conversationId: "33333333-3333-4333-8333-333333333334" }
  const direct = await service.confirmDirectory(unconnectedScope, { path: root, fields: { name: "本人选定工程", summary: "直接确认" }, baseEntryRevision: 0 })
  assert.equal(direct.status, "no_change")
  const cacheBefore = titleReads
  await Promise.all([service.knowledge.list({ ...memoryScope, generation: identity.personalIdentity().generation }), service.knowledge.list({ ...memoryScope, generation: identity.personalIdentity().generation })])
  assert.equal(titleReads, cacheBefore + 1)
  await service.knowledge.list({ ...memoryScope, generation: identity.personalIdentity().generation })
  assert.equal(titleReads, cacheBefore + 1)
  title = "更新后标题"; service.knowledge.invalidate(workspaceId)
  assert.equal((await service.knowledge.list({ ...memoryScope, generation: identity.personalIdentity().generation })).items[0].title, title)
  assert.equal(titleReads, cacheBefore + 2)
  let view = applyLocalExecutionUpdate(emptyLocalExecutionView, { kind: "accepted", turnId: "ui", text: "用户原文", author: { id: user, displayName: "本人" } })
  view = applyLocalExecutionUpdate(view, { kind: "context-tool", turnId: "ui", tool: { id: "project-memory:1", title: "准备更新项目记忆", status: "in_progress" } })
  view = applyLocalExecutionUpdate(view, { kind: "finished", turnId: "ui" })
  assert.equal(view.entries.find(e => e.kind === "tool").status, "running")
  view = applyLocalExecutionUpdate(view, { kind: "context-tool", turnId: "ui", tool: { id: "project-memory:1", title: "已记住新增工程", status: "completed", output: "team.md" } })
  assert.equal(view.entries.filter(e => e.kind === "tool").length, 1)
  assert.equal(view.entries.find(e => e.kind === "tool").status, "completed")
  // 真实 ACP 子进程消费配置与每轮实际 blocks；明确不代表共享协调器已完成接线。
  const agent = fileURLToPath(new URL("./fixtures/context-acp-agent.mjs", import.meta.url))
  host = new LocalAcpHost({ executable: process.execPath, args: [agent] }, { bindingDirectory: join(root, "native-bindings"), bindingNamespace: origin, restorePolicy: "fallback-new" })
  const agentSetup = await setup("agent-binding"), session = await host.bind(scope, cwd, agentSetup)
  const send = async (session, contextId, mode = "baseline") => {
    const assembled = await assemble(contextId)
    if (mode === "zero") assert.equal(assembled.contextBlocks.length, 0)
    else if (mode === "team-delta") {
      assert.equal(assembled.contextBlocks.length, 1)
      assert.ok(assembled.contextBlocks[0].text.includes("<本机记忆 team.md（已更新）>"))
      assert.ok(!assembled.contextBlocks[0].text.includes("<本机记忆 personal.md"))
    } else assert.ok(assembled.contextBlocks.length > 0)
    let unsubscribe, timeout
    const done = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("受控ACP超时")), 20_000)
      unsubscribe = session.subscribe(event => { if (["completed", "failed", "cancelled"].includes(event.type)) resolve(event) })
    })
    try {
      assert.equal(session.sendPrompt([{ type: "text", text: "用户原文" }, ...assembled.contextBlocks]).status, "accepted")
      service.confirmTurnDelivered(scope, contextId, assembled.preparedKnowledge)
      const event = await done
      assert.equal(event.type, "completed", JSON.stringify(event))
      await settle(contextId)
    } finally { clearTimeout(timeout); unsubscribe?.() }
  }
  await send(session, "agent-first", "baseline")
  assert.ok((await entries()).some(e => e.name === "Agent归纳工程"))
  await send(session, "agent-second-delta", "team-delta")
  await send(session, "agent-third-zero", "zero")
  await session.close()
  const restoredSetup = await setup("agent-restored")
  const restored = await host.bind(scope, cwd, restoredSetup)
  await send(restored, "agent-restored-turn")
  await host.close(); host = undefined
  const oldServer = serverOf(restoredSetup)
  await assemble("late-account")
  await tool(oldServer, "read_team_knowledge", { referenceId })
  await tool(oldServer, "propose_project_memory_update", { ...proposal, fields: { name: "旧账号迟到", summary: "不得保存" } })
  await identity.signOut()
  await settle("late-account")
  assert.ok(!(await entries()).some(e => e.name === "旧账号迟到"))
  assert.equal((await fetch(oldServer.url, { method: "POST", headers: { Authorization: oldServer.headers[0].value } })).status, 401)
  const file = join(store.directory(memoryScope), "team.md")
  const original = await readFile(file, "utf8")
  await writeFile(file, "坏文件")
  const protectedWrite = await store.update(memoryScope, proposal, source, true, () => true)
  assert.equal(protectedWrite.status, "error")
  assert.equal(await readFile(file, "utf8"), "坏文件")
  await writeFile(file, original)
  const bodies = await store.read(memoryScope)
  assert.ok(Buffer.byteLength(renderMemory("team.md", bodies["team.md"].entries) + renderMemory("personal.md", bodies["personal.md"].entries)) <= 8192)
  console.log(JSON.stringify({ result: "PASS", markdown: "隔离/完整正文/原子保存/修订/冲突/超限/损坏保护", mcp: "真实回环HTTP四工具/固定知识版本/pending→saved/取消失败/撤销", acp: "受控Agent实际消费配置与每轮正文，关闭恢复后复用", ui: "既有工具卡终态后同卡更新", reminderBytes: Buffer.byteLength(MEMORY_UPDATE_REMINDER), scope: "模块冒烟；正式协调器和双账号服务端联调仍待接线" }, null, 2))
} finally {
  await host?.close()
  await service.dispose()
  identity.dispose()
  await rm(root, { recursive: true, force: true })
}
