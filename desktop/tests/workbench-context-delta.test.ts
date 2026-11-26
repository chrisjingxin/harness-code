/**
 * 团队知识库与本机记忆分层增量注入单元测试：
 * 覆盖 L0 MCP instructions、首轮基线去目录、次轮零注入、规约新增/改版/归档差量、
 * 本机记忆单边更新、普通 Markdown 即时保存、跨轮已读与 force 重读、list level 筛选、
 * 发送未受理不推进快照，以及协调器 session-reset / session-opened / usage 压缩兜底重置。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LocalAcpEvent, LocalAcpPromptBlock, LocalAcpSessionState, LocalAcpSessionUpdateEvent } from "@workbench/acp-runtime/types"
import type { CollaborationState as CollaborationStateType } from "@workbench/collaboration-client"
import type { KnowledgeLevel } from "@workbench/collaboration-client/types"
import type { createLocalExecutionCoordinator as createCoordinatorFn } from "../src/main/local-execution-coordinator.ts"
import type { LocalConversationStore as LocalConversationStoreType } from "../src/main/local-conversation-store.ts"
import type { ProjectMemoryStore as ProjectMemoryStoreType } from "../src/main/workbench-context/memory-store.ts"
import type { WorkbenchContextService as WorkbenchContextServiceType } from "../src/main/workbench-context/service.ts"

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

const { CollaborationState } = await import("@workbench/collaboration-client") as {
  CollaborationState: typeof CollaborationStateType
}
const { createLocalExecutionCoordinator } = await import("../src/main/local-execution-coordinator.ts") as {
  createLocalExecutionCoordinator: typeof createCoordinatorFn
}
const { LocalConversationStore } = await import("../src/main/local-conversation-store.ts") as {
  LocalConversationStore: typeof LocalConversationStoreType
}
const { ProjectMemoryStore } = await import("../src/main/workbench-context/memory-store.ts") as {
  ProjectMemoryStore: typeof ProjectMemoryStoreType
}
const { WorkbenchContextService } = await import("../src/main/workbench-context/service.ts") as {
  WorkbenchContextService: typeof WorkbenchContextServiceType
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_ID = "11111111111111111111111111111111"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"
const RULE_A_ID = "44444444-4444-4444-8444-444444444441"
const RULE_A_V1 = "55555555-5555-4555-8555-555555555501"
const RULE_A_V2 = "55555555-5555-4555-8555-555555555502"
const RULE_B_ID = "44444444-4444-4444-8444-444444444442"
const RULE_B_V1 = "55555555-5555-4555-8555-555555555503"
const EXP_ID = "44444444-4444-4444-8444-444444444443"
const EXP_V1 = "55555555-5555-4555-8555-555555555504"

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

type MockKnowledgeItem = {
  knowledgeId: string
  termKey: string
  title: string
  level: KnowledgeLevel
  currentVersionId: string
  version: number
  text: string
  archived?: boolean
}

async function createContextHarness() {
  const root = await mkdtemp(join(tmpdir(), "wb-ctx-delta-"))
  const cwd = join(root, "cwd")
  await mkdir(cwd, { recursive: true })

  let items: MockKnowledgeItem[] = [
    {
      knowledgeId: RULE_A_ID,
      termKey: "rule-a",
      title: "红线规约A",
      level: "rule",
      currentVersionId: RULE_A_V1,
      version: 1,
      text: "规约A第一版：禁止直接写主库。",
    },
    {
      knowledgeId: EXP_ID,
      termKey: "exp-1",
      title: "回调幂等经验",
      level: "experience",
      currentVersionId: EXP_V1,
      version: 1,
      text: "经验正文：回调必须按业务键去重。",
    },
  ]

  const versionReads: string[] = []
  const listLevels: Array<string | null> = []
  let readReports = 0

  const user = {
    id: USER_ID,
    userNo: "80000001",
    userName: "测试成员",
    photo: "",
    orgId: "org",
    orgNo: "001",
    orgName: "研发",
    orgPathName: "研发",
  }

  const identity = new CollaborationState(ORIGIN, async input => {
    const url = new URL(String(input))
    const path = url.pathname
    if (path.endsWith("/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-test" })
    if (path.endsWith("/demo-login") || path.endsWith("/me")) {
      return jsonOk({
        user,
        workspaces: [{ id: WORKSPACE_ID, slug: "delta", name: "增量团队", role: "admin", memberVersion: 1, accessVersion: 1 }],
      })
    }
    if (path.endsWith("/logout")) return jsonOk(null)
    if (path.endsWith("/projects")) {
      return jsonOk({
        workspaceId: WORKSPACE_ID,
        projects: [{
          projectId: PROJECT_ID,
          workspaceId: WORKSPACE_ID,
          name: "核心支付项目",
          description: "处理支付与回调",
          ownerUserId: USER_ID,
          status: "active",
          role: "owner",
          memberCount: 1,
          version: 1,
          createdAt: "2026-11-23T00:00:00.000Z",
          updatedAt: "2026-11-23T00:00:00.000Z",
        }],
      })
    }
    if (path.includes("/projects/")) {
      return jsonOk({
        project: {
          projectId: PROJECT_ID,
          workspaceId: WORKSPACE_ID,
          name: "核心支付项目",
          description: "处理支付与回调",
          ownerUserId: USER_ID,
          status: "active",
          role: "owner",
          memberCount: 1,
          version: 1,
          createdAt: "2026-11-23T00:00:00.000Z",
          updatedAt: "2026-11-23T00:00:00.000Z",
        },
        members: [],
        repositories: [],
      })
    }
    if (path.endsWith("/repositories")) return jsonOk({ workspaceId: WORKSPACE_ID, repositories: [] })
    if (path.endsWith("/knowledge")) {
      const level = url.searchParams.get("level")
      listLevels.push(level)
      const filtered = items
        .filter(item => !item.archived && (!level || item.level === level))
        .map(item => ({
          knowledgeId: item.knowledgeId,
          termKey: item.termKey,
          category: "规范",
          title: item.title,
          currentVersionId: item.currentVersionId,
          version: item.version,
          archived: Boolean(item.archived),
          updatedAtMs: 1,
          level: item.level,
          scope: { kind: "workspace", repositoryIds: [] },
          contentType: "article",
          health: { readCount: readReports, usefulCount: 0, expiredCount: 0, needsReview: false, lastReviewedAtMs: 1, feedbackWatermark: 0 },
        }))
      return jsonOk({ items: filtered, nextAfterId: null })
    }
    if (path.endsWith("/reads")) {
      readReports++
      return jsonOk({ versionReadCount: readReports, totalReadCount: readReports })
    }
    if (path.includes("/versions/")) {
      const versionId = path.split("/").at(-1)!
      versionReads.push(versionId)
      const matched = items.find(item => item.currentVersionId === versionId)
        ?? (versionId === RULE_A_V1
          ? { knowledgeId: RULE_A_ID, termKey: "rule-a", title: "红线规约A", level: "rule" as const, currentVersionId: RULE_A_V1, version: 1, text: "规约A第一版：禁止直接写主库。" }
          : undefined)
      if (!matched) throw new Error(`未找到版本 ${versionId}`)
      return jsonOk({
        knowledgeId: matched.knowledgeId,
        termKey: matched.termKey,
        archived: Boolean(matched.archived),
        version: {
          versionId: matched.currentVersionId,
          version: matched.version,
          category: "规范",
          title: matched.title,
          authorId: USER_ID,
          createdAtMs: 1,
          level: matched.level,
          scope: { kind: "workspace", repositoryIds: [] },
          contentType: "article",
          contributors: [USER_ID],
          reviewerId: null,
          reviewedAtMs: null,
          proposalId: null,
        },
        text: matched.text,
      })
    }
    throw new Error(`未预期请求: ${path}`)
  })

  await identity.signIn("80000001")
  const store = new ProjectMemoryStore(join(root, "memory"))
  const localConversations = new LocalConversationStore(root, ORIGIN)
  const created = await localConversations.create(USER_ID, { workspaceId: WORKSPACE_ID, directoryPath: cwd, title: "增量测试会话" })
  assert.equal(created.ok, true)
  if (!created.ok) throw new Error("创建测试会话失败")

  const scope = { accountId: USER_ID, workspaceId: WORKSPACE_ID, projectId: null, conversationId: created.value.conversationId }
  const service = new WorkbenchContextService({
    origin: ORIGIN,
    identity,
    store,
    authorizeBinding: async () => true,
  })

  const mcpCall = async (server: { url: string; headers: readonly { name: string; value: string }[] }, method: string, params: Record<string, unknown> = {}, id = "test") => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...Object.fromEntries(server.headers.map(h => [h.name, h.value])),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } }
    if (payload.error) throw new Error(payload.error.message)
    const result = payload.result!
    if (method === "tools/call") {
      if (result.isError && !result.content?.[0]?.text?.startsWith("{")) throw new Error(result.content?.[0]?.text ?? "工具报错")
      return JSON.parse(result.content![0]!.text)
    }
    return result
  }

  return {
    root,
    cwd,
    identity,
    store,
    localConversations,
    service,
    scope,
    versionReads,
    listLevels,
    getReadReports: () => readReports,
    setItems: (next: MockKnowledgeItem[]) => { items = next },
    getItems: () => items,
    mcpCall,
    cleanup: async () => {
      await service.dispose()
      identity.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("L0 MCP initialize 提供常驻 instructions 与增强工具参数，保持 4 个工具", async () => {
  const ctx = await createContextHarness()
  try {
    const setup = await ctx.service.prepareSession(ctx.scope, "b-1")
    const server = setup.mcpServers!.find(s => s.name === "workbench-context")!
    assert.ok(server && "url" in server)
    const init = await ctx.mcpCall(server, "initialize", { protocolVersion: "2025-03-26" }) as { instructions?: string }
    assert.ok(typeof init.instructions === "string" && init.instructions.length > 0)
    assert.match(init.instructions, /list_team_knowledge/)
    assert.match(init.instructions, /update_project_memory/)
    assert.match(init.instructions, /force: true/)

    const listed = await ctx.mcpCall(server, "tools/list") as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }
    assert.equal(listed.tools.length, 4)
    const listTool = listed.tools.find(t => t.name === "list_team_knowledge")!
    const readTool = listed.tools.find(t => t.name === "read_team_knowledge")!
    assert.ok("level" in listTool.inputSchema.properties)
    assert.ok("force" in readTool.inputSchema.properties)
  } finally {
    await ctx.cleanup()
  }
})

test("首轮基线不含知识目录，无变化次轮严格零注入，规约新增/改版/归档与记忆单边更新按差量推送", async () => {
  const ctx = await createContextHarness()
  try {
    const setup = await ctx.service.prepareSession(ctx.scope, "b-1")
    const server = setup.mcpServers!.find(s => s.name === "workbench-context")! as { url: string; headers: readonly { name: string; value: string }[] }

    // 第 1 轮：首轮基线（有 team.md + personal.md + 规约A v1，不含知识目录）
    const turn1 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "第一轮", directoryPath: ctx.cwd, turnId: "t-1" })
    assert.equal(turn1.contextBlocks.length, 1)
    const text1 = turn1.contextBlocks[0]!.text
    assert.match(text1, /<本机记忆 team\.md>/)
    assert.match(text1, /<本机记忆 personal\.md>/)
    assert.match(text1, /规约A第一版：禁止直接写主库/)
    assert.equal(text1.includes("团队知识标题（按需读取固定版本）"), false)
    assert.equal(text1.includes("回调幂等经验"), false)
    ctx.service.confirmTurnDelivered(ctx.scope, "t-1", turn1.preparedKnowledge)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-1", outcome: "completed" })

    // 第 2 轮：无任何变化 → contextBlocks 为空 []，且不重复拉取规约正文
    const readsBeforeTurn2 = ctx.versionReads.length
    const turn2 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "第二轮", directoryPath: ctx.cwd, turnId: "t-2" })
    assert.deepEqual(turn2.contextBlocks, [])
    assert.equal(ctx.versionReads.length, readsBeforeTurn2)
    ctx.service.confirmTurnDelivered(ctx.scope, "t-2", turn2.preparedKnowledge)

    // 当前轮立即保存普通 MD，终态只清理轮次，之后仅 team.md 增量触发。
    const original = await ctx.mcpCall(server, "tools/call", { name: "read_project_memory", arguments: { document: "team" } })
    const updatedText = original.content + "\n## 订单子系统\n负责订单状态流转。\n"
    const proposed = await ctx.mcpCall(server, "tools/call", {
      name: "update_project_memory", arguments: { document: "team", content: updatedText, expectedRevision: original.revision },
    }) as { status: string }
    assert.equal(proposed.status, "saved")
    const savedMemory = await ctx.store.read({ origin: ORIGIN, accountId: USER_ID, workspaceId: WORKSPACE_ID }, "team", () => true)
    assert.equal(savedMemory.status, "ready")
    assert.equal(savedMemory.status === "ready" && savedMemory.content, updatedText)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-2", outcome: "completed" })

    // 第 3 轮：仅 team.md 变化（新增了订单子系统）+ 规约A 升级到 v2 + 新增规约B v1
    ctx.setItems([
      { knowledgeId: RULE_A_ID, termKey: "rule-a", title: "红线规约A", level: "rule", currentVersionId: RULE_A_V2, version: 2, text: "规约A第二版：必须走领域服务。" },
      { knowledgeId: RULE_B_ID, termKey: "rule-b", title: "红线规约B", level: "rule", currentVersionId: RULE_B_V1, version: 1, text: "规约B第一版：单测必须覆盖回滚。" },
      { knowledgeId: EXP_ID, termKey: "exp-1", title: "回调幂等经验", level: "experience", currentVersionId: EXP_V1, version: 1, text: "经验正文：回调必须按业务键去重。" },
    ])
    const turn3 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "第三轮", directoryPath: ctx.cwd, turnId: "t-3" })
    assert.equal(turn3.contextBlocks.length, 1)
    const text3 = turn3.contextBlocks[0]!.text
    assert.match(text3, /<本机记忆 team\.md（已更新）>/)
    assert.match(text3, /订单子系统/)
    assert.equal(text3.includes("personal.md"), false)
    assert.match(text3, /<团队规约更新（固定版本，替代先前同名旧版）>/)
    assert.match(text3, /规约A第二版：必须走领域服务/)
    assert.match(text3, /规约B第一版：单测必须覆盖回滚/)
    assert.equal(text3.includes("规约A第一版"), false)
    ctx.service.confirmTurnDelivered(ctx.scope, "t-3", turn3.preparedKnowledge)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-3", outcome: "completed" })

    // 第 4 轮：归档规约A（仅剩规约B不变）→ 只推规约A失效通知，不重发规约B
    ctx.setItems([
      { knowledgeId: RULE_B_ID, termKey: "rule-b", title: "红线规约B", level: "rule", currentVersionId: RULE_B_V1, version: 1, text: "规约B第一版：单测必须覆盖回滚。" },
      { knowledgeId: EXP_ID, termKey: "exp-1", title: "回调幂等经验", level: "experience", currentVersionId: EXP_V1, version: 1, text: "经验正文：回调必须按业务键去重。" },
    ])
    const readsBeforeTurn4 = ctx.versionReads.length
    const turn4 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "第四轮", directoryPath: ctx.cwd, turnId: "t-4" })
    assert.equal(turn4.contextBlocks.length, 1)
    assert.equal(ctx.versionReads.length, readsBeforeTurn4)
    const text4 = turn4.contextBlocks[0]!.text
    assert.match(text4, /<团队规约失效通知>/)
    assert.match(text4, /红线规约A/)
    assert.equal(text4.includes("规约B第一版"), false)
    ctx.service.confirmTurnDelivered(ctx.scope, "t-4", turn4.preparedKnowledge)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-4", outcome: "completed" })

    // 第 5 轮：再次无变化 → 0 字节
    const turn5 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "第五轮", directoryPath: ctx.cwd, turnId: "t-5" })
    assert.deepEqual(turn5.contextBlocks, [])
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-5", outcome: "completed" })
  } finally {
    await ctx.cleanup()
  }
})

test("跨轮 read_team_knowledge 去重、force 重读、list level 筛选与发送未确认不推进快照", async () => {
  const ctx = await createContextHarness()
  try {
    const setup = await ctx.service.prepareSession(ctx.scope, "b-1")
    const server = setup.mcpServers!.find(s => s.name === "workbench-context")! as { url: string; headers: readonly { name: string; value: string }[] }

    // 1) 未调用 confirmTurnDelivered（模拟发送被拒绝/取消）→ 下一轮仍发完整基线
    const rejectedTurn = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "被拒轮", directoryPath: ctx.cwd, turnId: "t-rej" })
    assert.equal(rejectedTurn.contextBlocks.length, 1)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-rej", outcome: "cancelled" })

    const turn1 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "首轮", directoryPath: ctx.cwd, turnId: "t-1" })
    assert.match(turn1.contextBlocks[0]!.text, /<本机记忆 team\.md>/)
    ctx.service.confirmTurnDelivered(ctx.scope, "t-1", turn1.preparedKnowledge)

    // 2) list_team_knowledge 透传 level 过滤
    const filteredList = await ctx.mcpCall(server, "tools/call", {
      name: "list_team_knowledge",
      arguments: { level: "rule" },
    }) as { items: Array<{ level: string; referenceId: string }> }
    assert.equal(filteredList.items.length, 1)
    assert.equal(filteredList.items[0]!.level, "rule")
    assert.equal(ctx.listLevels.at(-1), "rule")

    // 3) 第一轮读取经验正文
    const expRef = `knowledge:${EXP_ID}:${EXP_V1}`
    const firstRead = await ctx.mcpCall(server, "tools/call", {
      name: "read_team_knowledge",
      arguments: { referenceId: expRef },
    }) as { text?: string; alreadyRead?: boolean }
    assert.match(firstRead.text ?? "", /回调必须按业务键去重/)
    assert.equal(firstRead.alreadyRead, undefined)
    // 等待异步 reportRead 完成
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(ctx.getReadReports(), 1)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-1", outcome: "completed" })

    // 4) 第二轮同会话重读经验：返回 alreadyRead=true 且不重复上报统计；但仍可作为 sourceIds 提案；传 force=true 返回完整正文
    const turn2 = await ctx.service.assembleTurnContext({ scope: ctx.scope, userText: "次轮", directoryPath: ctx.cwd, turnId: "t-2" })
    assert.deepEqual(turn2.contextBlocks, [])
    ctx.service.confirmTurnDelivered(ctx.scope, "t-2", turn2.preparedKnowledge)

    const dupRead = await ctx.mcpCall(server, "tools/call", {
      name: "read_team_knowledge",
      arguments: { referenceId: expRef },
    }) as { text?: string; alreadyRead?: boolean }
    assert.equal(dupRead.alreadyRead, true)
    assert.equal(dupRead.text, undefined)
    assert.equal(ctx.getReadReports(), 1)

    const original = await ctx.mcpCall(server, "tools/call", { name: "read_project_memory", arguments: { document: "team" } })
    const memUpdate = await ctx.mcpCall(server, "tools/call", {
      name: "update_project_memory", arguments: { document: "team", content: original.content + "\n幂等网关：基于先前已读经验整理。\n", expectedRevision: original.revision },
    }) as { status: string }
    assert.equal(memUpdate.status, "saved")

    const forcedRead = await ctx.mcpCall(server, "tools/call", {
      name: "read_team_knowledge",
      arguments: { referenceId: expRef, force: true },
    }) as { text?: string; alreadyRead?: boolean }
    assert.match(forcedRead.text ?? "", /回调必须按业务键去重/)
    assert.equal(forcedRead.alreadyRead, undefined)
    await ctx.service.onTurnSettled({ scope: ctx.scope, turnId: "t-2", outcome: "completed" })
  } finally {
    await ctx.cleanup()
  }
})

test("协调器在 session-reset、换原生 sessionId/断开、及 Token 断崖压缩时自动重置基线", async () => {
  const ctx = await createContextHarness()
  try {
    const prompts: LocalAcpPromptBlock[][] = []
    const eventListeners = new Set<(event: LocalAcpEvent) => void>()
    const sessionListeners = new Set<(event: LocalAcpSessionUpdateEvent) => void>()
    let turnSeq = 0
    let currentSessionId = "native-1"

    const baseState = (): LocalAcpSessionState => ({
      connected: true,
      sessionId: currentSessionId,
      authMethods: [],
      configOptions: [],
      availableCommands: [],
      plans: [],
      restoreStatus: { kind: "new", sessionId: currentSessionId },
    })

    const mockRuntime = {
      host: {
        async bind() {
          return {
            getAvailability: () => ({ available: true as const }),
            getState: () => baseState(),
            send: () => ({ status: "rejected" as const, reason: "session-closed" as const }),
            sendPrompt: (blocks: readonly LocalAcpPromptBlock[]) => {
              prompts.push([...blocks])
              return { status: "accepted" as const, turnId: `acp-${++turnSeq}` }
            },
            subscribe: (fn: (event: LocalAcpEvent) => void) => {
              eventListeners.add(fn)
              return () => { eventListeners.delete(fn) }
            },
            subscribeSession: (fn: (event: LocalAcpSessionUpdateEvent) => void) => {
              sessionListeners.add(fn)
              return () => { sessionListeners.delete(fn) }
            },
            cancel: () => true,
            close: async () => {
              eventListeners.clear()
              sessionListeners.clear()
            },
          }
        },
        subscribeDiagnostics: () => () => {},
        async close() {},
      },
    }

    const coordinator = createLocalExecutionCoordinator(
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => {} } } as never,
      ctx.identity,
      null,
      mockRuntime as never,
      {
        origin: ORIGIN,
        grantsDir: join(ctx.root, "grants"),
        localConversations: ctx.localConversations,
        contextSession: {
          prepare: (s, id) => ctx.service.prepareSession(s, id),
          release: (s, id) => ctx.service.revokeSession(s, id),
        },
        contextAssembler: ctx.service,
      },
    )

    await coordinator.captureDirectorySelection()(ctx.cwd)
    const prep = await coordinator.prepare(ctx.scope, ctx.cwd)
    assert.equal(prep.ok, true)
    if (!prep.ok) return

    const runTurn = async (reqId: string, text: string, complete = true) => {
      const res = await coordinator.send(ctx.scope, prep.value.bindingId, reqId, text, [])
      assert.equal(res.ok && res.value.status === "accepted", true, JSON.stringify(res))
      if (!res.ok || res.value.status !== "accepted") throw new Error("未受理")
      if (complete) {
        for (const fn of eventListeners) fn({ type: "completed", turnId: res.value.turnId, sequence: 1, shareable: true })
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return res.value.turnId
    }

    // 轮次 1：首轮含基线块（blocks.length === 2）
    await runTurn("11111111-1111-4111-8111-000000000001", "第一轮")
    assert.equal(prompts.at(-1)!.length, 2)

    // 轮次 2：无变化 → blocks.length === 1（只有用户文本）
    await runTurn("11111111-1111-4111-8111-000000000002", "第二轮")
    assert.equal(prompts.at(-1)!.length, 1)

    // 触发兜底 1：session-reset 事件 → 轮次 3 重新发送基线
    currentSessionId = "native-2"
    for (const fn of sessionListeners) {
      fn({ type: "session-reset", reason: "session-restore-failed", previousSessionId: "native-1", sessionId: "native-2" })
    }
    await runTurn("11111111-1111-4111-8111-000000000003", "重置后首轮")
    assert.equal(prompts.at(-1)!.length, 2)

    // 轮次 4：再次无变化 → blocks.length === 1
    await runTurn("11111111-1111-4111-8111-000000000004", "重置后次轮")
    assert.equal(prompts.at(-1)!.length, 1)

    // 触发兜底 2：小幅 Token 回落（5000 -> 2000）不误重置；大会话断崖式压缩（60000 -> 18000）触发重置
    for (const fn of sessionListeners) fn({ type: "usage", usage: { used: 5000, size: 200000 } })
    for (const fn of sessionListeners) fn({ type: "usage", usage: { used: 2000, size: 200000 } })
    await runTurn("11111111-1111-4111-8111-000000000005", "小回落不重置")
    assert.equal(prompts.at(-1)!.length, 1)

    for (const fn of sessionListeners) fn({ type: "usage", usage: { used: 60000, size: 200000 } })
    for (const fn of sessionListeners) fn({ type: "usage", usage: { used: 18000, size: 200000 } })
    await runTurn("11111111-1111-4111-8111-000000000006", "压缩后补发基线")
    assert.equal(prompts.at(-1)!.length, 2)

    // 触发兜底 3：agent-disconnected 失败 → 下一轮补发基线（真实 LocalAcpSession 重连时会伴随 session-opened）
    const discTurnId = await runTurn("11111111-1111-4111-8111-000000000007", "将断开轮", false)
    for (const fn of eventListeners) fn({ type: "failed", turnId: discTurnId, sequence: 1, reason: "agent-disconnected" })
    await new Promise(resolve => setTimeout(resolve, 20))

    for (const fn of sessionListeners) fn({ type: "session-opened", state: baseState() })
    await runTurn("11111111-1111-4111-8111-000000000008", "重连后首轮")
    assert.equal(prompts.at(-1)!.length, 2)

    // 触发兜底 4：session-opened 携带新的原生 sessionId → 下一轮补发基线
    currentSessionId = "native-3"
    for (const fn of sessionListeners) fn({ type: "session-opened", state: baseState() })
    await runTurn("11111111-1111-4111-8111-000000000009", "新原生会话首轮")
    assert.equal(prompts.at(-1)!.length, 2)

    await coordinator.dispose()
  } finally {
    await ctx.cleanup()
  }
})
