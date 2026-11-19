/**
 * HC-224 单元测试：覆盖本机执行 IPC 定稿分段、tool_summary 收集/上传限制以及工作目录授权持久化恢复。
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ConversationSyncRequest } from "@workbench/collaboration-client/types"
import type { CollaborationState as CollaborationStateType, ConversationUploads as ConversationUploadsType } from "@workbench/collaboration-client"
import type { LocalExecutionNotice } from "../src/shared/index.ts"
import type { LocalExecutionCoordinator, LocalExecutionRuntime, createLocalExecutionCoordinator as createCoordinatorFn } from "../src/main/local-execution-coordinator.ts"
import type { bindLocalExecutionIpc as bindLocalExecutionIpcFn } from "../src/main/local-execution-ipc.ts"

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

const { CollaborationState, ConversationUploads, syncPayloadLimit } = await import("@workbench/collaboration-client") as {
  CollaborationState: typeof CollaborationStateType
  ConversationUploads: typeof ConversationUploadsType
  syncPayloadLimit: number
}
const { createLocalExecutionCoordinator } = await import("../src/main/local-execution-coordinator.ts") as {
  createLocalExecutionCoordinator: typeof createCoordinatorFn
}
const { bindLocalExecutionIpc } = await import("../src/main/local-execution-ipc.ts") as {
  bindLocalExecutionIpc: typeof bindLocalExecutionIpcFn
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_A = "11111111111111111111111111111111"
const USER_B = "22222222222222222222222222222222"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"
const REQ_ID = "44444444-4444-4444-8444-444444444444"

type IpcWindow = Parameters<typeof createLocalExecutionCoordinator>[0]
type IpcRuntime = Extract<Parameters<typeof createLocalExecutionCoordinator>[3], { host: unknown }>
type BoundSession = Awaited<ReturnType<IpcRuntime["host"]["bind"]>>
type AcpListener = Parameters<BoundSession["subscribe"]>[0]
type AcpEvent = Parameters<AcpListener>[0]

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

async function createSignedInState(userId: string) {
  const user = {
    id: userId,
    userNo: userId === USER_A ? "80000001" : "80000002",
    userName: userId === USER_A ? "测试甲" : "测试乙",
    photo: "",
    orgId: "org-1",
    orgNo: "001",
    orgName: "研发组",
    orgPathName: "研发部/研发组",
  }
  const workspace = { id: WORKSPACE_ID, slug: "ws", name: "团队" }
  const transport: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith("/api/v1/auth/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) {
      return jsonOk({ user, workspaces: [workspace] })
    }
    if (url.includes(`/projects/${PROJECT_ID}/conversations/${CONV_ID}`)) {
      return jsonOk({
        conversation: {
          conversationId: CONV_ID,
          projectId: PROJECT_ID,
          ownerUserId: userId,
          title: "本机会话",
          status: "idle",
          briefText: "",
          briefSource: "rule",
          briefUpdatedAtMs: 1_700_000_000_000,
          syncedSequence: 0,
          updatedAt: "2026-11-18T00:00:00.000Z",
          repositories: [],
        },
      })
    }
    return new Response("not found", { status: 404 })
  }
  const state = new CollaborationState(ORIGIN, transport)
  const login = await state.signIn(user.userNo)
  assert.equal(login.ok, true)
  return state
}

function createFakeWindow() {
  const notices: unknown[] = []
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => { notices.push(payload) },
    },
  } as unknown as IpcWindow
  return { window, notices }
}

function createMockRuntime() {
  const listeners = new Set<AcpListener>()
  let turnCounter = 0
  const session: BoundSession = {
    getAvailability: () => ({ available: true }),
    send: () => ({ status: "accepted", turnId: `turn-${++turnCounter}` }),
    cancel: () => true,
    answerPermission: () => true,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: async () => { listeners.clear() },
  }
  const runtime: IpcRuntime = {
    host: {
      bind: async () => session,
      subscribeDiagnostics: () => () => {},
      close: async () => {},
    } as unknown as IpcRuntime["host"],
  }
  const emit = (event: AcpEvent) => {
    for (const listener of listeners) listener(event)
  }
  return { runtime, emit }
}

// ConversationUploads 成功上传一批后会进入 2,000ms 冷却定时器，需预留充足等待窗口。
async function waitFor(predicate: () => boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for async upload")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test("thought-delta 不向定稿正文插入空行，且工具/messageId 换行不叠加空行", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc224-ipc-sync-"))
  try {
    const workdir = join(root, "work")
    const uploadsDir = join(root, "uploads")
    await mkdir(workdir, { recursive: true })
    const identity = await createSignedInState(USER_A)
    const { window } = createFakeWindow()
    const { runtime, emit } = createMockRuntime()
    const uploadedBatches: ConversationSyncRequest[] = []
    let watermark = 0
    const uploads = new ConversationUploads(
      uploadsDir,
      {
        watermark: async () => ({ ok: true, value: watermark }),
        upload: async (_scope, req) => {
          uploadedBatches.push(req)
          watermark = req.messages.at(-1)?.sequence ?? watermark
          return { ok: true, value: { syncedSequence: watermark } }
        },
      },
      () => {},
    )
    uploads.useAccount(USER_A)

    const ipc = createLocalExecutionCoordinator(window, identity, uploads, runtime)
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await ipc.captureDirectorySelection()(workdir)
    const prepared = await ipc.prepare(scope, workdir)
    assert.equal(prepared.ok, true)
    if (!prepared.ok) return

    // 轮次 1：text -> thought -> text，不插入 \n\n
    const sent1 = await ipc.send(scope, prepared.value.bindingId, REQ_ID, "检查文件名", [])
    assert.equal(sent1.ok, true)
    if (!sent1.ok || sent1.value.status !== "accepted") return assert.fail("expected accepted")
    const turn1 = sent1.value.turnId
    emit({ turnId: turn1, sequence: 1, type: "text-delta", text: "`wc -l pi", messageId: "m-1" })
    emit({ turnId: turn1, sequence: 2, type: "thought-delta", text: "确认后缀" })
    emit({ turnId: turn1, sequence: 3, type: "text-delta", text: "-probe.txt`", messageId: "m-1" })
    emit({ turnId: turn1, sequence: 4, type: "completed", shareable: true })

    await waitFor(() => uploadedBatches.length >= 1)
    const batch1 = uploadedBatches[0]!
    assert.deepEqual(batch1.messages.map(m => m.type), ["user", "assistant"])
    assert.equal(JSON.parse(batch1.messages[1]!.payload).text, "`wc -l pi-probe.txt`")

    // 轮次 2：已有尾部 \n + 工具打断 + 前导 \n，合并成恰好 \n\n；以及 messageId 切换合并
    const sent2 = await ipc.send(scope, prepared.value.bindingId, REQ_ID, "继续", [])
    assert.equal(sent2.ok, true)
    if (!sent2.ok || sent2.value.status !== "accepted") return assert.fail("expected accepted")
    const turn2 = sent2.value.turnId
    emit({ turnId: turn2, sequence: 1, type: "text-delta", text: "第一段\n", messageId: "m-1" })
    emit({ turnId: turn2, sequence: 2, type: "tool", tool: { id: "t-1", title: "wc -l pi-probe.txt", kind: "execute", status: "completed" } })
    emit({ turnId: turn2, sequence: 3, type: "text-delta", text: "\n第二段", messageId: "m-1" })
    emit({ turnId: turn2, sequence: 4, type: "text-delta", text: "第三段", messageId: "m-2" })
    emit({ turnId: turn2, sequence: 5, type: "completed", shareable: true })

    await waitFor(() => uploadedBatches.length >= 2)
    const batch2 = uploadedBatches[1]!
    assert.deepEqual(batch2.messages.map(m => m.type), ["user", "tool_summary", "assistant"])
    assert.equal(JSON.parse(batch2.messages[2]!.payload).text, "第一段\n\n第二段\n\n第三段")
    assert.deepEqual(JSON.parse(batch2.messages[1]!.payload), {
      label: "终端命令",
      name: "wc -l pi-probe.txt",
      summary: "wc -l pi-probe.txt",
      status: "completed",
      tone: "neutral",
    })

    await ipc.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("定稿工具摘要按 tool.id 去重且最多收录 50 条，超长摘要在上传前裁剪到 32 KiB 内", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc224-ipc-tools-"))
  try {
    const workdir = join(root, "work")
    const uploadsDir = join(root, "uploads")
    await mkdir(workdir, { recursive: true })
    const identity = await createSignedInState(USER_A)
    const { window } = createFakeWindow()
    const { runtime, emit } = createMockRuntime()
    const uploadedBatches: ConversationSyncRequest[] = []
    let watermark = 0
    const uploads = new ConversationUploads(
      uploadsDir,
      {
        watermark: async () => ({ ok: true, value: watermark }),
        upload: async (_scope, req) => {
          uploadedBatches.push(req)
          watermark = req.messages.at(-1)?.sequence ?? watermark
          return { ok: true, value: { syncedSequence: watermark } }
        },
      },
      () => {},
    )
    uploads.useAccount(USER_A)

    const ipc = createLocalExecutionCoordinator(window, identity, uploads, runtime)
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await ipc.captureDirectorySelection()(workdir)
    const prepared = await ipc.prepare(scope, workdir)
    assert.equal(prepared.ok, true)
    if (!prepared.ok) return

    const sent = await ipc.send(scope, prepared.value.bindingId, REQ_ID, "批量检查", [])
    assert.equal(sent.ok, true)
    if (!sent.ok || sent.value.status !== "accepted") return assert.fail("expected accepted")
    const turnId = sent.value.turnId
    let seq = 0
    // 增量工具调用（先 in_progress 带 title，再 completed 只带状态）+ 未终态工具 + 超 50 条工具
    emit({ turnId, sequence: ++seq, type: "tool", tool: { id: "pending-only", title: "read_file skip.ts", kind: "read", status: "in_progress" } })
    emit({ turnId, sequence: ++seq, type: "tool", tool: { id: "t-0", title: "read_file a.ts", kind: "read", status: "in_progress" } })
    emit({ turnId, sequence: ++seq, type: "tool", tool: { id: "t-0", status: "completed" } })
    for (let i = 1; i <= 55; i += 1) {
      emit({
        turnId,
        sequence: ++seq,
        type: "tool",
        tool: {
          id: `t-${i}`,
          title: `edit_file file-${i}.ts`,
          kind: "edit",
          status: i === 2 ? "failed" : "completed",
        },
      })
    }
    emit({ turnId, sequence: ++seq, type: "text-delta", text: "完成。" })
    emit({ turnId, sequence: ++seq, type: "completed", shareable: true })

    await waitFor(() => uploadedBatches.length >= 1)
    const toolMsgs = uploadedBatches[0]!.messages.filter(m => m.type === "tool_summary")
    assert.equal(toolMsgs.length, 50)
    assert.deepEqual(JSON.parse(toolMsgs[0]!.payload), {
      label: "read_file",
      name: "read_file a.ts",
      summary: "a.ts",
      status: "completed",
      tone: "read",
    })
    assert.deepEqual(JSON.parse(toolMsgs[2]!.payload), {
      label: "edit_file",
      name: "edit_file file-2.ts",
      summary: "file-2.ts",
      status: "failed",
      tone: "write",
    })

    // 直接测试 ConversationUploads.enqueue 对超长 tool_summary（> 32 KiB）的裁剪而不阻断整轮上传
    await uploads.enqueue(scope, {
      turnId: "turn-oversized",
      userText: "测试超长工具摘要",
      reply: "完成",
      acceptedAtMs: 1_700_000_000_000,
      completedAtMs: 1_700_000_001_000,
      tools: [
        {
          label: "终端命令",
          name: "cmd " + "汉".repeat(15_000),
          summary: "输出 " + "字".repeat(15_000),
          status: "completed",
          tone: "neutral",
          occurredAtMs: 1_700_000_000_500,
        },
      ],
    })
    await waitFor(() => uploadedBatches.length >= 2)
    const oversizedBatch = uploadedBatches[1]!
    assert.deepEqual(oversizedBatch.messages.map(m => m.type), ["user", "tool_summary", "assistant"])
    for (const msg of oversizedBatch.messages) {
      assert.ok(Buffer.byteLength(msg.payload, "utf8") <= syncPayloadLimit)
    }

    await ipc.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("重启后从 grantsDir 恢复已选目录授权，未选目录/跨账号/替换目录仍拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc224-ipc-grants-"))
  try {
    const selectedDir = join(root, "selected")
    const unselectedDir = join(root, "unselected")
    const swappedDir = join(root, "swapped")
    const symlinkTarget = join(root, "symlink-target")
    const symlinkTargetOther = join(root, "symlink-target-other")
    const symlinkDir = join(root, "symlink-dir")
    const selectedSymlink = join(root, "selected-symlink")
    const grantsDir = join(root, "grants")
    await Promise.all([
      mkdir(selectedDir, { recursive: true }),
      mkdir(unselectedDir, { recursive: true }),
      mkdir(swappedDir, { recursive: true }),
      mkdir(symlinkTarget, { recursive: true }),
      mkdir(symlinkTargetOther, { recursive: true }),
    ])
    await symlink(symlinkTarget, symlinkDir)
    await symlink(symlinkTarget, selectedSymlink)

    const { window } = createFakeWindow()
    const { runtime } = createMockRuntime()
    const scopeA = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    const scopeB = { accountId: USER_B, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }

    // 首次会话：只挑选 selectedDir、swappedDir 与 selectedSymlink（从未挑选 unselectedDir / symlinkDir）
    const identityA1 = await createSignedInState(USER_A)
    const ipc1 = createLocalExecutionCoordinator(window, identityA1, null, runtime, grantsDir)

    const unselectedBefore = await ipc1.prepare(scopeA, unselectedDir)
    assert.equal(unselectedBefore.ok, false)
    if (!unselectedBefore.ok) assert.equal(unselectedBefore.error.code, "PROJECT_PATH_INVALID")

    await ipc1.captureDirectorySelection()(selectedDir)
    await ipc1.captureDirectorySelection()(swappedDir)
    await ipc1.captureDirectorySelection()(selectedSymlink)
    const firstPrepare = await ipc1.prepare(scopeA, selectedDir)
    assert.equal(firstPrepare.ok, true)

    // 核对授权文件按 sha256(accountId).json 落盘且权限为 0o600
    const grantFile = join(grantsDir, `${createHash("sha256").update(USER_A).digest("hex")}.json`)
    const fileStat = await stat(grantFile)
    assert.equal(fileStat.mode & 0o777, 0o600)
    await ipc1.dispose()

    // 删除并重建 swappedDir（改变 inode），并将 selectedSymlink 改指向另一目录
    await rm(swappedDir, { recursive: true, force: true })
    await mkdir(swappedDir, { recursive: true })
    await rm(selectedSymlink, { force: true })
    await symlink(symlinkTargetOther, selectedSymlink)

    // 模拟重启：全新 IPC 实例，内存 grants 为空
    const identityA2 = await createSignedInState(USER_A)
    const ipc2 = createLocalExecutionCoordinator(window, identityA2, null, runtime, grantsDir)

    const restored = await ipc2.prepare(scopeA, selectedDir)
    assert.equal(restored.ok, true)

    const unselectedAfter = await ipc2.prepare(scopeA, unselectedDir)
    assert.equal(unselectedAfter.ok, false)
    if (!unselectedAfter.ok) assert.equal(unselectedAfter.error.code, "PROJECT_PATH_INVALID")

    const symlinkAfter = await ipc2.prepare(scopeA, symlinkDir)
    assert.equal(symlinkAfter.ok, false)
    if (!symlinkAfter.ok) assert.equal(symlinkAfter.error.code, "PROJECT_PATH_INVALID")

    const swappedAfter = await ipc2.prepare(scopeA, swappedDir)
    assert.equal(swappedAfter.ok, false)
    if (!swappedAfter.ok) assert.equal(swappedAfter.error.code, "PROJECT_PATH_INVALID")

    const repointedAfter = await ipc2.prepare(scopeA, selectedSymlink)
    assert.equal(repointedAfter.ok, false)
    if (!repointedAfter.ok) assert.equal(repointedAfter.error.code, "PROJECT_PATH_INVALID")

    // 跨账号不能恢复账号 A 的授权目录
    const identityB = await createSignedInState(USER_B)
    const ipcB = createLocalExecutionCoordinator(window, identityB, null, runtime, grantsDir)
    const crossAccount = await ipcB.prepare(scopeB, selectedDir)
    assert.equal(crossAccount.ok, false)
    if (!crossAccount.ok) assert.equal(crossAccount.error.code, "PROJECT_PATH_INVALID")

    await Promise.all([ipc2.dispose(), ipcB.dispose()])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("多代理切换、会话级能力透传（session-state/elicitation/mode/configOption）与工作区附件沙箱校验", async () => {
  const { writeFile } = await import("node:fs/promises")
  const { pathToFileURL } = await import("node:url")
  const root = await mkdtemp(join(tmpdir(), "hc229-ipc-full-"))
  try {
    const workdir = join(root, "ws")
    const outsideDir = join(root, "outside")
    await Promise.all([mkdir(join(workdir, "src"), { recursive: true }), mkdir(outsideDir, { recursive: true })])
    const insideFile = join(workdir, "src", "app file.ts")
    const outsideFile = join(outsideDir, "secret.txt")
    const escapeSymlink = join(workdir, "escape-link.txt")
    await Promise.all([
      writeFile(insideFile, "export const x = 1\n", "utf8"),
      writeFile(outsideFile, "TOP_SECRET\n", "utf8"),
    ])
    await symlink(outsideFile, escapeSymlink)

    const identity = await createSignedInState(USER_A)
    const { window, notices } = createFakeWindow()

    type SessionUpdateListener = (ev: unknown) => void
    const closedProviders: string[] = []
    const sentPrompts: Array<{ provider: string; blocks: unknown }> = []
    const modeCalls: string[] = []
    const configCalls: Array<{ configId: string; value: string | boolean }> = []
    const elicitationAnswers: Array<{ requestId: string; answer: unknown }> = []

    const makeRichSession = (providerId: string) => {
      const turnListeners = new Set<AcpListener>()
      const sessionListeners = new Set<SessionUpdateListener>()
      let state = {
        connected: false,
        sessionId: `native-${providerId}`,
        authMethods: [],
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "默认" }, { id: "plan", name: "计划" }],
        },
        currentModeId: "default",
        models: { currentModelId: "m-1", availableModels: [{ modelId: "m-1", name: "Model 1" }] },
        configOptions: [
          {
            id: "workflow",
            name: "工作流",
            type: "select" as const,
            currentValue: "build",
            options: [{ value: "build", name: "直接执行" }, { value: "compose", name: "分阶段协作" }],
          },
        ],
        availableCommands: [{ name: "compact", description: "压缩上下文" }],
        plans: [{ kind: "entries" as const, entries: [{ content: "检查代码", priority: "high" as const, status: "in_progress" as const }] }],
        sessionInfo: { title: `${providerId} 会话标题` },
        usage: { used: 120, size: 1000 },
        restoreStatus: { kind: "new" as const, sessionId: `native-${providerId}` },
      }
      const session = {
        getAvailability: () => ({ available: true as const }),
        getState: () => structuredClone(state),
        connect: async () => {
          state = { ...state, connected: true }
          for (const listener of sessionListeners) listener({ type: "session-opened", state: structuredClone(state) })
          return structuredClone(state)
        },
        send: () => ({ status: "accepted" as const, turnId: `turn-${providerId}` }),
        sendPrompt: (blocks: unknown) => {
          sentPrompts.push({ provider: providerId, blocks })
          return { status: "accepted" as const, turnId: `turn-${providerId}` }
        },
        cancel: () => true,
        answerPermission: () => true,
        answerElicitation: (requestId: string, answer: unknown) => {
          elicitationAnswers.push({ requestId, answer })
          for (const listener of sessionListeners) listener({ type: "elicitation", request: null })
          return true
        },
        setMode: async (modeId: string) => {
          modeCalls.push(modeId)
          state = { ...state, currentModeId: modeId, modes: { ...state.modes, currentModeId: modeId } }
          for (const listener of sessionListeners) listener({ type: "current-mode", currentModeId: modeId })
        },
        setConfigOption: async (configId: string, value: string | boolean) => {
          configCalls.push({ configId, value })
          state = {
            ...state,
            configOptions: state.configOptions.map(c => c.id === configId && c.type === "select" ? { ...c, currentValue: String(value) } : c),
          }
          for (const listener of sessionListeners) listener({ type: "config-options", configOptions: state.configOptions })
        },
        subscribe: (listener: AcpListener) => {
          turnListeners.add(listener)
          return () => { turnListeners.delete(listener) }
        },
        subscribeSession: (listener: SessionUpdateListener) => {
          sessionListeners.add(listener)
          return () => { sessionListeners.delete(listener) }
        },
        close: async () => {
          closedProviders.push(providerId)
          turnListeners.clear()
          sessionListeners.clear()
        },
        emitElicitation: (req: unknown) => {
          for (const listener of sessionListeners) listener({ type: "elicitation", request: req })
        },
      }
      return session
    }

    const activeSessions = new Map<string, ReturnType<typeof makeRichSession>>()
    const runtime: LocalExecutionRuntime = {
      registry: {
        listProviders: () => ({
          providers: [
            { id: "harness", label: "Harness Code", available: true },
            { id: "qwen", label: "Qwen Code", available: true },
          ],
          defaultProviderId: "harness",
        }),
        hasProvider: (id: string) => id === "harness" || id === "qwen",
        getHost: (providerId?: string) => {
          const targetId = providerId ?? "harness"
          return {
            providerId: targetId,
            available: true,
            host: {
              bind: async () => {
                const s = makeRichSession(targetId)
                activeSessions.set(targetId, s)
                return s
              },
              subscribeDiagnostics: () => () => {},
              close: async () => {},
            } as unknown as Extract<LocalExecutionRuntime, { host: unknown }>["host"],
          }
        },
        close: async () => {},
      },
    }

    const ipc = createLocalExecutionCoordinator(window, identity, null, runtime)
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }

    const providers = await ipc.listProviders()
    assert.equal(providers.ok, true)
    if (providers.ok) {
      assert.equal(providers.value.defaultProviderId, "harness")
      assert.deepEqual(providers.value.providers.map(p => p.id), ["harness", "qwen"])
    }

    await ipc.captureDirectorySelection()(workdir)
    const prep1 = await ipc.prepare(scope, workdir)
    assert.equal(prep1.ok, true)
    if (!prep1.ok) return
    assert.equal(prep1.value.providerId, "harness")

    const typedNotices = notices as LocalExecutionNotice[]
    const initialSessionNotice = typedNotices.find(n => n.kind === "session-state" && n.bindingId === prep1.value.bindingId)
    assert.ok(initialSessionNotice && initialSessionNotice.kind === "session-state")
    assert.equal(initialSessionNotice.state.providerId, "harness")
    assert.equal(initialSessionNotice.state.modes?.currentModeId, "default")
    assert.equal(initialSessionNotice.state.availableCommands[0]?.name, "compact")
    assert.equal(initialSessionNotice.state.sessionTitle, "harness 会话标题")

    // 切换模式、配置项与表单应答
    const modeRes = await ipc.setMode(scope, prep1.value.bindingId, "plan")
    assert.equal(modeRes.ok, true)
    assert.deepEqual(modeCalls, ["plan"])

    const cfgRes = await ipc.setConfigOption(scope, prep1.value.bindingId, "workflow", "compose")
    assert.equal(cfgRes.ok, true)
    assert.deepEqual(configCalls, [{ configId: "workflow", value: "compose" }])

    activeSessions.get("harness")?.emitElicitation({
      id: "el-1",
      message: "确认计划",
      requestedSchema: { type: "object", properties: { decision: { type: "string" } } },
    })
    assert.ok(typedNotices.some(n => n.kind === "elicitation" && n.request?.id === "el-1"))

    const elRes = await ipc.answerElicitation(scope, prep1.value.bindingId, "el-1", { action: "accept", content: { decision: "approved" } })
    assert.equal(elRes.ok, true)
    assert.equal(elicitationAnswers.length, 1)

    // 切换 Provider 到 qwen：关闭旧绑定并重绑新会话
    const prep2 = await ipc.prepare(scope, workdir, "qwen")
    assert.equal(prep2.ok, true)
    if (!prep2.ok) return
    assert.equal(prep2.value.providerId, "qwen")
    assert.notEqual(prep2.value.bindingId, prep1.value.bindingId)
    assert.deepEqual(closedProviders, ["harness"])

    // 工作区内合法附件转 resource_link
    const validAttach = await ipc.send(scope, prep2.value.bindingId, REQ_ID, "请看文件", [], ["src/app file.ts"])
    assert.equal(validAttach.ok, true)
    assert.equal(sentPrompts.length, 1)
    assert.equal(sentPrompts[0]?.provider, "qwen")
    assert.deepEqual(sentPrompts[0]?.blocks, [
      { type: "text", text: "请看文件" },
      {
        type: "resource_link",
        uri: pathToFileURL(await import("node:fs/promises").then(fs => fs.realpath(insideFile))).href,
        name: "src/app file.ts",
        title: "app file.ts",
        size: Buffer.byteLength("export const x = 1\n"),
      },
    ])

    // 越界路径（.. / 绝对路径 / 软链逃逸）必须被严格拒绝
    const traversal = await ipc.send(scope, prep2.value.bindingId, REQ_ID, "越界", [], ["../outside/secret.txt"])
    assert.equal(traversal.ok, false)
    const absPath = await ipc.send(scope, prep2.value.bindingId, REQ_ID, "绝对", [], [outsideFile])
    assert.equal(absPath.ok, false)
    const symlinkEscape = await ipc.send(scope, prep2.value.bindingId, REQ_ID, "软链逃逸", [], ["escape-link.txt"])
    assert.equal(symlinkEscape.ok, false)
    assert.equal(sentPrompts.length, 1)

    // bindLocalExecutionIpc 参数校验与频道注册/解绑
    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const fakeIpc = {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(channel, handler) },
      removeHandler: (channel: string) => { registered.delete(channel) },
    }
    const trustedWindow = {
      ...window,
      webContents: { ...window.webContents, mainFrame: { url: `${ORIGIN}/index.html` } },
    } as unknown as IpcWindow
    const unbind = bindLocalExecutionIpc(trustedWindow, `${ORIGIN}/index.html`, ipc, fakeIpc as never)
    assert.equal(registered.has("workbench:local-execution:list-providers"), true)
    assert.equal(registered.has("workbench:local-execution:set-mode"), true)
    assert.equal(registered.has("workbench:local-execution:set-config-option"), true)
    assert.equal(registered.has("workbench:local-execution:answer-elicitation"), true)

    const senderEvent = { sender: trustedWindow.webContents, senderFrame: trustedWindow.webContents.mainFrame }
    const listFromIpc = await registered.get("workbench:local-execution:list-providers")!(senderEvent)
    assert.equal((listFromIpc as { ok: boolean }).ok, true)
    const untrustedList = await registered.get("workbench:local-execution:list-providers")!({
      sender: trustedWindow.webContents,
      senderFrame: { url: "https://evil.example/index.html" },
    })
    assert.equal((untrustedList as { ok: boolean }).ok, false)
    const badAttachIpc = await registered.get("workbench:local-execution:send")!(
      senderEvent, scope, prep2.value.bindingId, REQ_ID, "hi", [], ["bad\0file"],
    )
    assert.equal((badAttachIpc as { ok: boolean }).ok, false)

    // 校验 2 参 prepare（会切回默认 harness 绑定）、5 参 send、set-mode、set-config-option 与 answer-elicitation 通道
    const prepLegacyIpc = await registered.get("workbench:local-execution:prepare")!(senderEvent, scope, workdir) as {
      ok: boolean
      value?: { bindingId: string; providerId?: string }
    }
    assert.equal(prepLegacyIpc.ok, true)
    const ipcBindingId = prepLegacyIpc.value!.bindingId
    assert.equal(prepLegacyIpc.value?.providerId, "harness")
    const modeIpc = await registered.get("workbench:local-execution:set-mode")!(senderEvent, scope, ipcBindingId, "plan")
    assert.equal((modeIpc as { ok: boolean }).ok, true)
    const cfgIpc = await registered.get("workbench:local-execution:set-config-option")!(senderEvent, scope, ipcBindingId, "workflow", "build")
    assert.equal((cfgIpc as { ok: boolean }).ok, true)
    const badCfgIpc = await registered.get("workbench:local-execution:set-config-option")!(senderEvent, scope, ipcBindingId, "workflow", "")
    assert.equal((badCfgIpc as { ok: boolean }).ok, false)
    activeSessions.get("harness")?.emitElicitation({
      id: "el-ipc",
      message: "请确认",
      requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    })
    const elIpc = await registered.get("workbench:local-execution:answer-elicitation")!(
      senderEvent, scope, ipcBindingId, "el-ipc", { action: "accept", content: { ok: true } },
    )
    assert.equal((elIpc as { ok: boolean }).ok, true)
    const sendLegacyIpc = await registered.get("workbench:local-execution:send")!(
      senderEvent, scope, ipcBindingId, REQ_ID, "五参调用", [],
    )
    assert.equal((sendLegacyIpc as { ok: boolean }).ok, true)

    unbind()
    assert.equal(registered.size, 0)
    await ipc.dispose()

    // 验证缺少 sendPrompt 的极简 Mock 会话也能优雅降级到 session.send(prompt)
    const { runtime: minimalRuntime } = createMockRuntime()
    const minimalIpc = createLocalExecutionCoordinator(window, identity, null, minimalRuntime)
    await minimalIpc.captureDirectorySelection()(workdir)
    const minPrep = await minimalIpc.prepare(scope, workdir)
    assert.equal(minPrep.ok, true)
    if (minPrep.ok) {
      const fallbackSend = await minimalIpc.send(scope, minPrep.value.bindingId, REQ_ID, "带附件回退", [], ["src/app file.ts"])
      assert.equal(fallbackSend.ok, true)
      if (fallbackSend.ok) assert.equal(fallbackSend.value.status, "accepted")
    }
    await minimalIpc.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
