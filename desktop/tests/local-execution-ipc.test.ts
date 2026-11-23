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
import type { LocalExecutionNotice, PersonalDraftImage } from "../src/shared/index.ts"
import type { LocalExecutionCoordinator, LocalExecutionRuntime, createLocalExecutionCoordinator as createCoordinatorFn } from "../src/main/local-execution-coordinator.ts"
import type { bindLocalExecutionIpc as bindLocalExecutionIpcFn } from "../src/main/local-execution-ipc.ts"
import type { bindLocalConversationsIpc as bindLocalConversationsIpcFn } from "../src/main/local-conversations-ipc.ts"
import type { LocalConversationStore as LocalConversationStoreType } from "../src/main/local-conversation-store.ts"
import type { LocalImageStore as LocalImageStoreType } from "../src/main/local-image-store.ts"
import type { PersonalStore as PersonalStoreType } from "../src/main/personal-store.ts"

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
const { bindLocalConversationsIpc } = await import("../src/main/local-conversations-ipc.ts") as {
  bindLocalConversationsIpc: typeof bindLocalConversationsIpcFn
}
const { LocalConversationStore } = await import("../src/main/local-conversation-store.ts") as {
  LocalConversationStore: typeof LocalConversationStoreType
}
const { LocalImageStore } = await import("../src/main/local-image-store.ts") as {
  LocalImageStore: typeof LocalImageStoreType
}
const { PersonalStore } = await import("../src/main/personal-store.ts") as {
  PersonalStore: typeof PersonalStoreType
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
    if (url.endsWith("/api/v1/auth/logout")) return jsonOk(null)
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
          shareMode: "full",
          shareStatus: "active",
          stoppedAt: null,
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

function createMockRuntime(agentCapabilities?: ReturnType<BoundSession["getState"]>["agentCapabilities"]) {
  const listeners = new Set<AcpListener>()
  const sent: string[] = []
  let turnCounter = 0
  const session: BoundSession = {
    ...(agentCapabilities ? { getState: () => ({
      connected: true, authMethods: [], configOptions: [], availableCommands: [], plans: [],
      restoreStatus: { kind: "none" as const }, agentCapabilities,
    }) } : {}),
    getAvailability: () => ({ available: true }),
    send: text => {
      sent.push(text)
      return { status: "accepted", turnId: `turn-${++turnCounter}` }
    },
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
  return { runtime, session, emit, sent }
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
    const { window, notices } = createFakeWindow()
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
    const finished = (notices as LocalExecutionNotice[]).find(notice => notice.kind === "finished" && notice.turnId === turn1)
    assert.equal(finished?.runSummary?.completedAtMs, batch1.messages[1]!.occurredAtMs)
    assert.equal(finished?.runSummary?.durationMs, batch1.messages[1]!.occurredAtMs - batch1.messages[0]!.occurredAtMs)

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
    const ipc1 = createLocalExecutionCoordinator(window, identityA1, null, runtime, { grantsDir, origin: ORIGIN })

    const unselectedBefore = await ipc1.prepare(scopeA, unselectedDir)
    assert.equal(unselectedBefore.ok, false)
    assert.equal(unselectedBefore.directoryStatus, "confirmation-required")
    if (!unselectedBefore.ok) assert.equal(unselectedBefore.error.code, "PROJECT_PATH_INVALID")

    await ipc1.captureDirectorySelection()(selectedDir)
    await ipc1.captureDirectorySelection()(swappedDir)
    await ipc1.captureDirectorySelection()(selectedSymlink)
    const firstPrepare = await ipc1.prepare(scopeA, selectedDir)
    assert.equal(firstPrepare.ok, true)
    assert.equal(firstPrepare.directoryStatus, "ready")

    // 核对授权文件按 sha256(JSON.stringify([origin, accountId])).json 落盘且权限为 0o600
    const grantFile = join(grantsDir, `${createHash("sha256").update(JSON.stringify([ORIGIN, USER_A])).digest("hex")}.json`)
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
    const ipc2 = createLocalExecutionCoordinator(window, identityA2, null, runtime, { grantsDir, origin: ORIGIN })

    const restored = await ipc2.prepare(scopeA, selectedDir)
    assert.equal(restored.ok, true)
    assert.equal(restored.directoryStatus, "ready")

    const unselectedAfter = await ipc2.prepare(scopeA, unselectedDir)
    assert.equal(unselectedAfter.ok, false)
    assert.equal(unselectedAfter.directoryStatus, "confirmation-required")
    if (!unselectedAfter.ok) assert.equal(unselectedAfter.error.code, "PROJECT_PATH_INVALID")

    const symlinkAfter = await ipc2.prepare(scopeA, symlinkDir)
    assert.equal(symlinkAfter.ok, false)
    assert.equal(symlinkAfter.directoryStatus, "confirmation-required")
    if (!symlinkAfter.ok) assert.equal(symlinkAfter.error.code, "PROJECT_PATH_INVALID")

    const swappedAfter = await ipc2.prepare(scopeA, swappedDir)
    assert.equal(swappedAfter.ok, false)
    assert.equal(swappedAfter.directoryStatus, "invalid")
    if (!swappedAfter.ok) assert.equal(swappedAfter.error.code, "PROJECT_ROOT_CHANGED")

    const repointedAfter = await ipc2.prepare(scopeA, selectedSymlink)
    assert.equal(repointedAfter.ok, false)
    assert.equal(repointedAfter.directoryStatus, "invalid")
    if (!repointedAfter.ok) assert.equal(repointedAfter.error.code, "PROJECT_ROOT_CHANGED")

    // 跨账号不能恢复账号 A 的授权目录
    const identityB = await createSignedInState(USER_B)
    const ipcB = createLocalExecutionCoordinator(window, identityB, null, runtime, { grantsDir, origin: ORIGIN })
    const crossAccount = await ipcB.prepare(scopeB, selectedDir)
    assert.equal(crossAccount.ok, false)
    assert.equal(crossAccount.directoryStatus, "confirmation-required")
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
    assert.equal(registered.has("workbench:local-execution:confirm-directory"), true)
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
    const badQueueItem = await registered.get("workbench:local-execution:prompt-queue")!(senderEvent, scope, {
      kind: "add", bindingId: prep2.value.bindingId,
      item: { requestId: REQ_ID, text: "hi", referenceIds: [], attachments: ["bad\0file"] },
    })
    assert.equal((badQueueItem as { ok: boolean }).ok, false)

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

test("显式原生选择本机文件与本机目录可作为 ACP resource_link 发送，未授权路径及登出后立即失效", async () => {
  const { realpath, writeFile } = await import("node:fs/promises")
  const { pathToFileURL } = await import("node:url")
  const root = await mkdtemp(join(tmpdir(), "local-attach-grants-"))
  try {
    const workdir = join(root, "ws")
    const wsSrc = join(workdir, "src")
    const outsideDir = join(root, "outside-dir")
    const outsideFile = join(root, "outside-note.md")
    const ungrantedFile = join(root, "ungranted.txt")
    const inlineWsFile = join(wsSrc, "app file.ts")
    await Promise.all([mkdir(wsSrc, { recursive: true }), mkdir(outsideDir, { recursive: true })])
    await Promise.all([
      writeFile(inlineWsFile, "export const y = 2\n", "utf8"),
      writeFile(outsideFile, "# external note\n", "utf8"),
      writeFile(ungrantedFile, "secret\n", "utf8"),
    ])

    const identity = await createSignedInState(USER_A)
    const { window, notices } = createFakeWindow()
    const sentPrompts: Array<{ blocks: unknown }> = []
    const listeners = new Set<AcpListener>()
    let turnCounter = 0
    const runtime: LocalExecutionRuntime = {
      host: {
        bind: async () => ({
          getAvailability: () => ({ available: true as const }),
          send: () => ({ status: "accepted" as const, turnId: `turn-${++turnCounter}` }),
          sendPrompt: (blocks: unknown) => {
            sentPrompts.push({ blocks })
            return { status: "accepted" as const, turnId: `turn-${++turnCounter}` }
          },
          cancel: () => true,
          answerPermission: () => true,
          subscribe: (listener: AcpListener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          close: async () => { listeners.clear() },
        }) as unknown as BoundSession,
        subscribeDiagnostics: () => () => {},
        close: async () => {},
      },
    }

    const ipc = createLocalExecutionCoordinator(window, identity, null, runtime)
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await ipc.captureDirectorySelection()(workdir)
    const prep1 = await ipc.prepare(scope, workdir)
    assert.equal(prep1.ok, true)
    if (!prep1.ok) return

    // 未经过原生选择器授权的外部绝对路径必须被拒绝
    const rejectedUngranted = await ipc.send(scope, prep1.value.bindingId, REQ_ID, "未授权文件", [], [ungrantedFile])
    assert.equal(rejectedUngranted.ok, false)

    // 通过选择器授权本机文件与本机目录
    const grantedFiles = await ipc.captureAttachmentSelections("file")([outsideFile])
    const grantedDirs = await ipc.captureAttachmentSelections("directory")([outsideDir])
    assert.equal(grantedFiles.length, 1)
    assert.equal(grantedDirs.length, 1)
    assert.equal(grantedDirs[0]?.endsWith("/"), true)

    const sentOk = await ipc.send(
      scope,
      prep1.value.bindingId,
      REQ_ID,
      "对照外部材料分析",
      [],
      [...grantedFiles, ...grantedDirs],
    )
    assert.equal(sentOk.ok, true)
    assert.equal(sentPrompts.length, 1)

    const canonicalOutsideFile = await realpath(outsideFile)
    const canonicalOutsideDir = await realpath(outsideDir)
    const expectedDisplayAttachments = [
      { label: "outside-note.md", kind: "file" as const, path: canonicalOutsideFile },
      { label: "outside-dir/", kind: "directory" as const, path: canonicalOutsideDir },
    ]
    assert.equal(sentOk.value.status, "accepted")
    if (sentOk.value.status === "accepted") {
      assert.deepEqual(sentOk.value.attachments, expectedDisplayAttachments)
      for (const listener of listeners) {
        listener({ type: "completed", turnId: sentOk.value.turnId, sequence: 1, shareable: false })
      }
    }
    const acceptedNotice = (notices as LocalExecutionNotice[]).find(
      item => item.kind === "accepted" && item.requestId === REQ_ID,
    )
    assert.ok(acceptedNotice && acceptedNotice.kind === "accepted")
    assert.deepEqual(acceptedNotice.attachments, expectedDisplayAttachments)
    assert.deepEqual(sentPrompts[0]?.blocks, [
      { type: "text", text: "对照外部材料分析" },
      {
        type: "resource_link",
        uri: pathToFileURL(canonicalOutsideFile).href,
        name: "outside-note.md",
        title: canonicalOutsideFile,
        size: Buffer.byteLength("# external note\n"),
      },
      {
        type: "resource_link",
        uri: pathToFileURL(canonicalOutsideDir).href,
        name: "outside-dir/",
        title: canonicalOutsideDir,
        mimeType: "inode/directory",
      },
    ])

    // 行内已有 @file 时，展示摘要自动去重该工作区文件，只保留未出现在正文中的附加文件
    const sentInlineAndExternal = await ipc.send(
      scope,
      prep1.value.bindingId,
      REQ_ID,
      '请看 @"src/app file.ts" 并对照外部笔记',
      [],
      ["src/app file.ts", ...grantedFiles],
    )
    assert.equal(sentInlineAndExternal.ok, true)
    if (sentInlineAndExternal.ok && sentInlineAndExternal.value.status === "accepted") {
      assert.deepEqual(sentInlineAndExternal.value.attachments, [
        { label: "outside-note.md", kind: "file", path: canonicalOutsideFile },
      ])
    }

    // 登出后重新登录同账号，先前会话的本机附件授权必须立即失效
    await identity.signOut()
    const relogin = await identity.signIn("80000001")
    assert.equal(relogin.ok, true)
    await ipc.captureDirectorySelection()(workdir)
    const prep2 = await ipc.prepare(scope, workdir)
    assert.equal(prep2.ok, true)
    if (!prep2.ok) return

    const afterSignOut = await ipc.send(
      scope,
      prep2.value.bindingId,
      REQ_ID,
      "尝试复用旧授权",
      [],
      [...grantedFiles, ...grantedDirs],
    )
    assert.equal(afterSignOut.ok, false)

    await ipc.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("prepare 未指定 providerId 时优先使用已绑定的历史 Agent，明确指定未配置 Agent 返回清晰提示", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc231-ipc-provider-persist-"))
  try {
    const workdir = join(root, "work")
    await mkdir(workdir, { recursive: true })
    const identity = await createSignedInState(USER_A)
    const { window } = createFakeWindow()
    const { runtime: baseRuntime } = createMockRuntime()
    const boundCalls: string[] = []

    const runtime: LocalExecutionRuntime = {
      registry: {
        listProviders: () => ({
          providers: [
            { id: "harness", label: "Harness Code", available: true },
            { id: "custom", label: "自定义 Agent", available: true },
          ],
          defaultProviderId: "custom",
        }),
        hasProvider: id => id === "harness" || id === "custom",
        findBoundProvider: async (s, dir) => {
          boundCalls.push(`${s.conversationId}:${dir}`)
          return "harness"
        },
        getHost: providerId => ({
          providerId: providerId ?? "custom",
          available: true,
          host: baseRuntime.host,
        }),
        close: async () => {},
      },
    }

    const ipc = createLocalExecutionCoordinator(window, identity, null, runtime)
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await ipc.captureDirectorySelection()(workdir)

    // 未传 providerId 且 registry 命中历史绑定时，不得被默认项 custom 覆盖
    const restored = await ipc.prepare(scope, workdir)
    assert.equal(restored.ok, true)
    if (restored.ok) assert.equal(restored.value.providerId, "harness")
    assert.equal(boundCalls.length, 1)

    // 显式传已保存但当前环境已移除的 providerId，给出清晰中文提示而非默默切到其他 Agent
    const missing = await ipc.prepare(scope, workdir, "removed-agent")
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.match(missing.error.message, /removed-agent/)
      assert.match(missing.error.message, /未配置/)
    }

    await ipc.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("不同服务 origin 隔离目录确认记录，旧个人记录路径经 confirmDirectory 原生确认后可恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc218-ipc-confirm-"))
  try {
    const legacyDir = join(root, "legacy-workdir")
    const grantsDir = join(root, "grants")
    const userDataDir = join(root, "user-data")
    await mkdir(legacyDir, { recursive: true })

    const { window } = createFakeWindow()
    const { runtime } = createMockRuntime()
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }

    // 1. 同一账号在不同服务 origin 下不得共享磁盘目录确认
    const identityA = await createSignedInState(USER_A)
    const ipcOriginA = createLocalExecutionCoordinator(window, identityA, null, runtime, { grantsDir, origin: ORIGIN })
    await ipcOriginA.captureDirectorySelection()(legacyDir)
    assert.equal((await ipcOriginA.prepare(scope, legacyDir)).directoryStatus, "ready")
    await ipcOriginA.dispose()

    const ipcOriginOther = createLocalExecutionCoordinator(window, identityA, null, runtime, {
      grantsDir,
      origin: "http://127.0.0.1:8888",
    })
    const crossOrigin = await ipcOriginOther.prepare(scope, legacyDir)
    assert.equal(crossOrigin.ok, false)
    assert.equal(crossOrigin.directoryStatus, "confirmation-required")
    await ipcOriginOther.dispose()

    // 2. 仅有个人记录旧路径（无 confirm 记录）时，取消/确认 confirmDirectory 闭环
    const legacyGrantsDir = join(root, "legacy-grants")
    const personal = new PersonalStore(identityA, ORIGIN, userDataDir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    assert.equal((await personal.load(convKey)).ok, true)
    assert.equal((await personal.save(convKey, 1, {
      scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
      expandedTools: [],
      expandedOutputs: [],
      draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
      localDirectoryPath: legacyDir,
      syncCache: null,
    })).ok, true)

    let confirmAnswer = false
    const promptedPaths: string[] = []
    const ipcLegacy = createLocalExecutionCoordinator(window, identityA, null, runtime, {
      grantsDir: legacyGrantsDir,
      origin: ORIGIN,
      personal,
      confirmDirectoryPrompt: async path => {
        promptedPaths.push(path)
        return confirmAnswer
      },
    })

    const unconfirmed = await ipcLegacy.prepare(scope, legacyDir)
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.directoryStatus, "confirmation-required")
    if (!unconfirmed.ok) assert.equal(unconfirmed.error.code, "PROJECT_PATH_INVALID")

    const rejectedConfirm = await ipcLegacy.confirmDirectory(scope)
    assert.deepEqual(rejectedConfirm, { ok: true, value: false })
    assert.deepEqual(promptedPaths, [legacyDir])
    assert.equal((await ipcLegacy.prepare(scope, legacyDir)).directoryStatus, "confirmation-required")

    confirmAnswer = true
    const acceptedConfirm = await ipcLegacy.confirmDirectory(scope)
    assert.deepEqual(acceptedConfirm, { ok: true, value: true })
    assert.deepEqual(promptedPaths, [legacyDir, legacyDir])

    const readyNow = await ipcLegacy.prepare(scope, legacyDir)
    assert.equal(readyNow.ok, true)
    assert.equal(readyNow.directoryStatus, "ready")
    await ipcLegacy.dispose()

    // 模拟重启恢复
    const ipcRestarted = createLocalExecutionCoordinator(window, identityA, null, runtime, {
      grantsDir: legacyGrantsDir,
      origin: ORIGIN,
      personal,
      confirmDirectoryPrompt: async () => false,
    })
    const readyAfterRestart = await ipcRestarted.prepare(scope, legacyDir)
    assert.equal(readyAfterRestart.ok, true)
    assert.equal(readyAfterRestart.directoryStatus, "ready")
    await ipcRestarted.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("仅已协商的 Harness 旁路跳过上传，标准 Agent 的定稿照常入队", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc234-side-turn-"))
  const identity = await createSignedInState(USER_A)
  const { window, notices } = createFakeWindow()
  const meta = { harnessCode: { version: 1, capabilities: ["commands", "approval", "subagent", "runSummary"] } }
  const { runtime, emit } = createMockRuntime({ _meta: meta })
  const batches: ConversationSyncRequest[] = []
  const uploads = new ConversationUploads(join(root, "uploads"), {
    watermark: async () => ({ ok: true, value: 0 }),
    upload: async (_scope, request) => {
      batches.push(request)
      return { ok: true, value: { syncedSequence: request.messages.at(-1)?.sequence ?? 0 } }
    },
  }, () => {})
  uploads.useAccount(USER_A)
  const coordinator = createLocalExecutionCoordinator(window, identity, uploads, { registry: {
    listProviders: () => ({ providers: [], defaultProviderId: "harness" }),
    getHost: providerId => ({ providerId: providerId ?? "harness", host: runtime.host, available: true, clientMeta: meta }),
    close: async () => {},
  } })
  try {
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await coordinator.captureDirectorySelection()(root)
    const a = await coordinator.prepare(scope, root, "harness")
    assert.ok(a.ok)
    const sent = await coordinator.send(scope, a.value.bindingId, REQ_ID, "/btw fixture", [])
    assert.ok(sent.ok && sent.value.status === "accepted")
    const turn = sent.value.turnId
    emit({ type: "text-delta", turnId: turn, sequence: 1, text: "only here", rawMeta: { harnessCode: { ephemeral: true } } })
    emit({ type: "completed", turnId: turn, sequence: 2, shareable: true })
    assert.ok((notices as LocalExecutionNotice[]).some(event => event.kind === "finished" && event.ephemeral))

    const b = await coordinator.prepare(scope, root, "custom")
    assert.ok(b.ok)
    const next = await coordinator.send(scope, b.value.bindingId, REQ_ID, "standard text", [])
    assert.ok(next.ok && next.value.status === "accepted")
    emit({ type: "text-delta", turnId: next.value.turnId, sequence: 1, text: "shared", rawMeta: { harnessCode: { ephemeral: true } } })
    emit({ type: "completed", turnId: next.value.turnId, sequence: 2, shareable: true })
    await waitFor(() => batches.length > 0)
    assert.deepEqual(batches.flatMap(batch => batch.messages.map(message => JSON.parse(message.payload).text)), ["standard text", "shared"])
  } finally {
    await coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("待发项可编辑和移除，正常终态兑现 FIFO，停止后须显式继续", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc235-fifo-"))
  const identity = await createSignedInState(USER_A)
  const { window, notices } = createFakeWindow()
  const { runtime, sent, emit } = createMockRuntime()
  const coordinator = createLocalExecutionCoordinator(window, identity, null, runtime, { personal: new PersonalStore(identity, ORIGIN, root) })
  try {
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await coordinator.captureDirectorySelection()(root)
    const ready = await coordinator.prepare(scope, root)
    assert.ok(ready.ok)
    const { bindingId } = ready.value
    await coordinator.send(scope, bindingId, REQ_ID, "首轮", [])
    const add = (tail: string, text: string) => coordinator.promptQueue(scope, {
      kind: "add", bindingId,
      item: { requestId: `00000000-0000-4000-8000-00000000000${tail}`, text, referenceIds: [], attachments: [] },
    })
    const first = await add("1", "原第二轮")
    const middle = await add("2", "不发送")
    const last = await add("3", "第三轮")
    assert.ok(first.ok && middle.ok && last.ok)
    const requestId = first.value.items[0].requestId
    assert.ok((await coordinator.promptQueue(scope, { kind: "edit", requestId, text: "修订第二轮" })).ok)
    assert.ok((await coordinator.promptQueue(scope, { kind: "remove", requestId: middle.value.items[1].requestId })).ok)
    assert.deepEqual(sent, ["首轮"])
    emit({ type: "completed", turnId: "turn-1", sequence: 1, shareable: true })
    await coordinator.promptQueue(scope, { kind: "read" })
    assert.deepEqual(sent, ["首轮", "修订第二轮"])
    assert.ok((notices as LocalExecutionNotice[]).some(event => event.kind === "accepted" && event.queued && event.requestId === requestId))

    const stop = coordinator.cancel(scope, bindingId, "turn-2")
    // Agent 在停止请求通过权限核对之前正常结束。仍须保留待发项，直到用户恢复。
    emit({ type: "completed", turnId: "turn-2", sequence: 1, shareable: true })
    await stop
    const held = await coordinator.promptQueue(scope, { kind: "read" })
    assert.ok(held.ok && held.value.paused && !held.value.pausedReason && held.value.items[0].text === "第三轮")
    assert.deepEqual(sent, ["首轮", "修订第二轮"])
    const resumed = await coordinator.promptQueue(scope, { kind: "resume", bindingId })
    assert.ok(resumed.ok && resumed.value.items.length === 0)
    assert.deepEqual(sent, ["首轮", "修订第二轮", "第三轮"])
  } finally {
    await coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("待发项在换绑定及重启后暂停，提交结果不确定时禁止重发，跨账号不可读", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc235-restart-"))
  const identity = await createSignedInState(USER_A)
  const other = await createSignedInState(USER_B)
  const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
  const { window } = createFakeWindow()
  const { runtime, emit, sent } = createMockRuntime()
  const otherDir = join(root, "other")
  await mkdir(otherDir)
  let personal = new PersonalStore(identity, ORIGIN, root)
  let coordinator = createLocalExecutionCoordinator(window, identity, null, runtime, { personal })
  try {
    await coordinator.captureDirectorySelection()(root)
    await coordinator.captureDirectorySelection()(otherDir)
    const ready = await coordinator.prepare(scope, root, "one")
    assert.ok(ready.ok)
    await coordinator.send(scope, ready.value.bindingId, REQ_ID, "首轮", [])
    const item = { requestId: REQ_ID, text: "重启保留", referenceIds: [], attachments: [] }
    assert.ok((await coordinator.promptQueue(scope, { kind: "add", bindingId: ready.value.bindingId, item })).ok)
    assert.ok((await coordinator.prepare(scope, otherDir, "two")).ok)
    const held = await coordinator.promptQueue(scope, { kind: "read" })
    assert.ok(held.ok && held.value.paused && held.value.items[0].text === item.text)
    emit({ type: "completed", turnId: "turn-1", sequence: 1, shareable: true })
    assert.deepEqual(sent, ["首轮"])
    await coordinator.dispose()
    personal = new PersonalStore(identity, ORIGIN, root)
    coordinator = createLocalExecutionCoordinator(window, identity, null, runtime, { personal })
    const restarted = await coordinator.promptQueue(scope, { kind: "read" })
    assert.ok(restarted.ok && restarted.value.paused && !restarted.value.pausedReason && restarted.value.items[0].text === item.text)
    assert.equal((await new PersonalStore(other, ORIGIN, root).conversationPromptQueue(scope)).ok, false)
    await personal.conversationPromptQueue(scope, { items: [item], starting: item.requestId })
    await coordinator.captureDirectorySelection()(otherDir)
    const rebound = await coordinator.prepare(scope, otherDir)
    assert.ok(rebound.ok)
    const unknown = await coordinator.promptQueue(scope, { kind: "read" })
    assert.ok(unknown.ok && unknown.value.starting === item.requestId)
    assert.equal((await coordinator.promptQueue(scope, { kind: "resume", bindingId: rebound.value.bindingId })).ok, false)
    assert.deepEqual(sent, ["首轮"])
    const removed = await coordinator.promptQueue(scope, { kind: "remove", requestId: item.requestId })
    assert.ok(removed.ok && !removed.value.starting && removed.value.items.length === 0)
  } finally {
    await coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("支持追发时只移除已确认的待发项，其余仍按原顺序发送", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc236-steering-"))
  const identity = await createSignedInState(USER_A)
  const { window, notices } = createFakeWindow()
  const meta = { harnessCode: { version: 1, capabilities: ["steering"] } }
  const { runtime, session, emit, sent } = createMockRuntime({ _meta: meta })
  const selected = "55555555-5555-4555-8555-555555555555"
  let confirm: ((value: Record<string, unknown>) => void) | undefined
  session.requestDuringTurn = async (turnId, method, params) => {
    assert.equal(turnId, "turn-1")
    assert.equal(method, "_harnessCode/steer")
    if (params.requestId !== selected) throw Object.assign(new Error("rejected"), { code: -32002 })
    assert.equal(params.text, "先追发这一条")
    return new Promise(resolve => { confirm = resolve })
  }
  const coordinator = createLocalExecutionCoordinator(window, identity, null, { registry: {
    listProviders: () => ({ providers: [], defaultProviderId: "harness" }),
    getHost: providerId => ({ providerId: providerId ?? "harness", host: runtime.host, available: true, clientMeta: meta }),
    close: async () => {},
  } }, { personal: new PersonalStore(identity, ORIGIN, root) })
  try {
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    await coordinator.captureDirectorySelection()(root)
    const ready = await coordinator.prepare(scope, root, "harness")
    assert.ok(ready.ok)
    const { bindingId } = ready.value
    const receipt = await coordinator.send(scope, bindingId, REQ_ID, "首轮", [])
    assert.ok(receipt.ok && receipt.value.status === "accepted" && receipt.value.canSteer)
    const { turnId } = receipt.value
    for (const [requestId, text] of [[REQ_ID, "下一轮"], [selected, "先追发这一条"]]) {
      assert.ok((await coordinator.promptQueue(scope, { kind: "add", bindingId,
        item: { requestId, text, attachments: [], referenceIds: [] },
      })).ok)
    }
    const rejected = await coordinator.steer(scope, bindingId, turnId, { kind: "queued", requestId: REQ_ID })
    assert.equal(rejected.ok, false)
    const pending = coordinator.steer(scope, bindingId, turnId, { kind: "queued", requestId: selected })
    await waitFor(() => Boolean(confirm))
    const awaiting = await coordinator.promptQueue(scope, { kind: "read" })
    assert.ok(awaiting.ok && awaiting.value.items.length === 2 && awaiting.value.starting === selected)
    assert.deepEqual(sent, ["首轮"])
    confirm!({ requestId: selected })
    assert.ok((await pending).ok)
    const remaining = await coordinator.promptQueue(scope, { kind: "read" })
    assert.ok(remaining.ok)
    assert.deepEqual(remaining.value.items.map(item => item.requestId), [REQ_ID])
    assert.ok((notices as LocalExecutionNotice[]).some(event =>
      event.kind === "steered" && event.turnId === turnId && event.requestId === selected))
    emit({ type: "completed", turnId, sequence: 1, shareable: true })
    await coordinator.promptQueue(scope, { kind: "read" })
    assert.deepEqual(sent, ["首轮", "下一轮"])
  } finally {
    await coordinator.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

const PNG_TEST_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

test("HC-238 本机执行图片协商：Fail-Closed 阻断不支持图片的 Agent、冻结 sent-* 发送标准 image 块并上传文本摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc238-coord-image-"))
  try {
    const workdir = join(root, "work")
    const uploadsDir = join(root, "uploads")
    const imagesDir = join(root, "images")
    await mkdir(workdir, { recursive: true })

    const identity = await createSignedInState(USER_A)
    const { window, notices } = createFakeWindow()
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

    const listeners = new Map<string, AcpListener>()
    const sentPromptCalls: { provider: string; blocks: unknown[] }[] = []
    let turnCounter = 0

    const coordinator = createLocalExecutionCoordinator(window, identity, uploads, {
      registry: {
        listProviders: () => ({
          providers: [
            { id: "text-only", label: "Text Only", available: true },
            { id: "vision", label: "Vision Agent", available: true },
          ],
          defaultProviderId: "text-only",
        }),
        getHost: providerId => {
          const id = providerId ?? "text-only"
          const supportsImage = id === "vision"
          return {
            providerId: id,
            available: true,
            clientMeta: { harnessCode: { version: 1, capabilities: ["steering"] } },
            host: {
              bind: async () => ({
                getState: () => ({
                  connected: true,
                  authMethods: [],
                  configOptions: [],
                  availableCommands: [],
                  plans: [],
                  restoreStatus: { kind: "none" as const },
                  agentCapabilities: {
                    promptCapabilities: { image: supportsImage },
                    _meta: { harnessCode: { version: 1, capabilities: ["steering"] } },
                  },
                }),
                getAvailability: () => ({ available: true }),
                send: () => ({ status: "accepted" as const, turnId: `turn-${++turnCounter}` }),
                sendPrompt: blocks => {
                  sentPromptCalls.push({ provider: id, blocks: [...blocks] })
                  return { status: "accepted" as const, turnId: `turn-${++turnCounter}` }
                },
                cancel: () => true,
                answerPermission: () => true,
                requestDuringTurn: async () => ({ ok: true }),
                subscribe: listener => {
                  listeners.set(id, listener)
                  return () => { listeners.delete(id) }
                },
                close: async () => { listeners.delete(id) },
              }),
              subscribeDiagnostics: () => () => {},
              close: async () => {},
            } as unknown as IpcRuntime["host"],
          }
        },
        close: async () => {},
      },
    }, {
      personal: new PersonalStore(identity, ORIGIN, root),
      images: new LocalImageStore(imagesDir),
    })

    try {
      const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
      await coordinator.captureDirectorySelection()(workdir)

      const staged = await coordinator.stageImage(scope, {
        name: "bug.png",
        mimeType: "image/png",
        bytes: PNG_TEST_BYTES,
        width: 320,
        height: 240,
      })
      assert.ok(staged.ok && staged.value.id.startsWith("pending-"))
      if (!staged.ok) return

      // 1. 不支持图片的 Agent 广播 supportsImagePrompt: false 并 Fail-Closed 拒绝发送
      const textOnlyPrep = await coordinator.prepare(scope, workdir, "text-only")
      assert.ok(textOnlyPrep.ok)
      const typedNotices = notices as LocalExecutionNotice[]
      const textOnlyState = [...typedNotices].reverse().find(n => n.kind === "session-state")
      assert.ok(textOnlyState?.kind === "session-state" && textOnlyState.state.supportsImagePrompt === false)

      const rejectedSend = await coordinator.send(scope, textOnlyPrep.value.bindingId, REQ_ID, "", [], [], [staged.value])
      assert.ok(rejectedSend.ok && rejectedSend.value.status === "rejected")
      assert.match(rejectedSend.value.reason, /不支持图片/)
      assert.equal(sentPromptCalls.length, 0)
      assert.equal((await coordinator.readImage(scope, staged.value.id)).ok, true)

      // 2. 切换支持多模态的 Agent，仅图片无文字也可发送，并推送 sent-* 副本和标准 ACP image block
      const visionPrep = await coordinator.prepare(scope, workdir, "vision")
      assert.ok(visionPrep.ok)
      const visionState = [...typedNotices].reverse().find(n => n.kind === "session-state")
      assert.ok(visionState?.kind === "session-state" && visionState.state.supportsImagePrompt === true)

      const acceptedSend = await coordinator.send(scope, visionPrep.value.bindingId, REQ_ID, "", [], [], [staged.value])
      assert.ok(acceptedSend.ok && acceptedSend.value.status === "accepted")
      assert.equal(sentPromptCalls.length, 1)
      assert.deepEqual(sentPromptCalls[0]?.blocks, [{
        type: "image",
        data: Buffer.from(PNG_TEST_BYTES).toString("base64"),
        mimeType: "image/png",
      }])
      const acceptedNotice = typedNotices.find(n => n.kind === "accepted" && n.requestId === REQ_ID)
      assert.ok(acceptedNotice?.kind === "accepted" && acceptedNotice.images?.length === 1)
      assert.ok(acceptedNotice.images[0]!.id.startsWith("sent-"))

      // 3. 含图片的待发队列禁止 Steer 追发
      const queuedReqId = "66666666-6666-4666-8666-666666666666"
      const queuedRes = await coordinator.promptQueue(scope, {
        kind: "add",
        bindingId: visionPrep.value.bindingId,
        item: {
          requestId: queuedReqId,
          text: "",
          referenceIds: [],
          attachments: [],
          images: [staged.value],
        },
      })
      assert.equal(queuedRes.ok, true)
      const turnId = acceptedSend.ok && acceptedSend.value.status === "accepted" ? acceptedSend.value.turnId : "turn-1"
      const steerBlocked = await coordinator.steer(scope, visionPrep.value.bindingId, turnId, {
        kind: "queued",
        requestId: queuedReqId,
      })
      assert.equal(steerBlocked.ok, false)

      // 移除排队项以免完成后自动触发下一轮
      await coordinator.promptQueue(scope, { kind: "remove", requestId: queuedReqId })

      // 4. 轮次完成后上传摘要写作 `[附 1 张本机图片]`，绝不包含 Base64 或路径
      listeners.get("vision")?.({ type: "text-delta", turnId, text: "已收到截图分析完成。", messageId: "m-1" })
      listeners.get("vision")?.({ type: "completed", turnId, sequence: 1, shareable: true })
      await waitFor(() => uploadedBatches.length > 0)
      const userMsg = uploadedBatches[0]!.messages.find(m => m.type === "user")
      assert.ok(userMsg)
      assert.match(userMsg.payload, /\[附 1 张本机图片\]/)
      assert.equal(userMsg.payload.includes(Buffer.from(PNG_TEST_BYTES).toString("base64")), false)
    } finally {
      await coordinator.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("HC-238 IPC 通道校验 stage-image / read-image / remove-staged-image 与 7 参 send", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc238-ipc-images-"))
  try {
    const workdir = join(root, "work")
    await mkdir(workdir, { recursive: true })
    const identity = await createSignedInState(USER_A)
    const { window } = createFakeWindow()
    const trustedWindow = {
      ...window,
      webContents: { ...window.webContents, mainFrame: { url: `${ORIGIN}/index.html` } },
    } as unknown as IpcWindow
    const { runtime } = createMockRuntime({ promptCapabilities: { image: true } })
    const coordinator = createLocalExecutionCoordinator(window, identity, null, runtime, {
      personal: new PersonalStore(identity, ORIGIN, root),
      images: new LocalImageStore(join(root, "images")),
    })
    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const fakeIpc = {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(channel, handler) },
      removeHandler: (channel: string) => { registered.delete(channel) },
    }
    const unbind = bindLocalExecutionIpc(trustedWindow, `${ORIGIN}/index.html`, coordinator, fakeIpc as never)
    try {
      const senderEvent = { sender: trustedWindow.webContents, senderFrame: trustedWindow.webContents.mainFrame }
      const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
      await coordinator.captureDirectorySelection()(workdir)
      const ready = await coordinator.prepare(scope, workdir)
      assert.ok(ready.ok)

      const staged = await registered.get("workbench:local-execution:stage-image")!(senderEvent, scope, {
        name: "clip.png",
        mimeType: "image/png",
        bytes: PNG_TEST_BYTES,
        width: 120,
        height: 90,
      }) as { ok: true; value: PersonalDraftImage } | { ok: false }
      assert.equal(staged.ok, true)
      if (!staged.ok) return

      const badStage = await registered.get("workbench:local-execution:stage-image")!(senderEvent, scope, {
        mimeType: "image/png",
        bytes: [1, 2, 3],
      }) as { ok: boolean }
      assert.equal(badStage.ok, false)

      const readRes = await registered.get("workbench:local-execution:read-image")!(senderEvent, scope, staged.value.id) as {
        ok: true; value: { mimeType: string; bytes: Uint8Array }
      }
      assert.equal(readRes.ok, true)
      assert.equal(readRes.value.mimeType, "image/png")

      const sendRes = await registered.get("workbench:local-execution:send")!(
        senderEvent, scope, ready.value.bindingId, REQ_ID, "", [], [], [staged.value],
      ) as { ok: boolean }
      assert.equal(sendRes.ok, true)

      const removeRes = await registered.get("workbench:local-execution:remove-staged-image")!(
        senderEvent, scope, staged.value.id,
      ) as { ok: boolean }
      assert.equal(removeRes.ok, true)

      const badRead = await registered.get("workbench:local-execution:read-image")!(senderEvent, scope, "../bad-id") as { ok: boolean }
      assert.equal(badRead.ok, false)
    } finally {
      unbind()
      await coordinator.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("HC-239 支持无团队与断网个人会话本地多轮执行、LocalConversationStore 持久化及发布/停止共享上传分流", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc239-ipc-offline-"))
  try {
    const workdir = join(root, "work")
    const uploadsDir = join(root, "uploads")
    const grantsDir = join(root, "grants")
    const checkpointsDir = join(root, "checkpoints")
    await mkdir(workdir, { recursive: true })

    let serverDown = false
    const cloudCalls: string[] = []
    const user = {
      id: USER_A,
      userNo: "80000001",
      userName: "测试甲",
      photo: "",
      orgId: "org-1",
      orgNo: "001",
      orgName: "研发组",
      orgPathName: "研发部/研发组",
    }
    const workspace = { id: WORKSPACE_ID, slug: "ws", name: "团队" }
    const transport: typeof fetch = async input => {
      const url = String(input)
      cloudCalls.push(url)
      if (serverDown) throw new Error("offline")
      if (url.endsWith("/api/v1/auth/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
      if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) return jsonOk({ user, workspaces: [workspace] })
      if (url.endsWith(`/workspaces/${WORKSPACE_ID}/projects`)) return jsonOk({ workspaceId: WORKSPACE_ID, projects: [] })
      if (url.includes("/knowledge/")) {
        return jsonOk({
          knowledgeId: "77777777-7777-4777-8777-777777777777",
          termKey: "team-rule",
          archived: false,
          version: {
            versionId: "88888888-8888-4888-8888-888888888888",
            version: 1,
            category: "rule",
            title: "团队规范",
            authorId: USER_A,
            createdAtMs: 1_700_000_000_000,
          },
          text: "务必保留单测",
        })
      }
      return new Response("not found", { status: 404 })
    }

    const identity = new CollaborationState(ORIGIN, transport)
    assert.equal((await identity.signIn("80000001")).ok, true)

    // 触发断网进入 connectionError（offline 续用态）
    serverDown = true
    await identity.withWorkspace(WORKSPACE_ID, c => c.listProjects(WORKSPACE_ID))
    assert.equal(identity.personalIdentity()?.offline, true)
    cloudCalls.length = 0

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
    const localConversations = new LocalConversationStore(root, ORIGIN)
    const { window } = createFakeWindow()
    const trustedWindow = {
      ...window,
      webContents: { ...window.webContents, mainFrame: { url: `${ORIGIN}/index.html` } },
    } as unknown as IpcWindow

    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>()
    const fakeIpc = {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(channel, handler) },
      removeHandler: (channel: string) => { registered.delete(channel) },
    }
    const unbindLocal = bindLocalConversationsIpc(trustedWindow, `${ORIGIN}/index.html`, identity, localConversations, uploads, fakeIpc as never)

    const senderEvent = { sender: trustedWindow.webContents, senderFrame: trustedWindow.webContents.mainFrame }
    const createdSolo = await registered.get("workbench:local-conversations:create")!(senderEvent, {
      workspaceId: null,
      directoryPath: workdir,
      title: "断网离线个人会话",
    }) as { ok: true; value: { conversationId: string } }
    assert.equal(createdSolo.ok, true)
    const soloConvId = createdSolo.value.conversationId
    const soloScope = { accountId: USER_A, workspaceId: null, projectId: null, conversationId: soloConvId }

    const promptHistories: unknown[] = []
    const assembledCalls: string[] = []
    const settledCalls: string[] = []
    const listeners = new Set<AcpListener>()
    let counter = 0
    const mockRuntime: IpcRuntime = {
      host: {
        bind: async () => ({
          getAvailability: () => ({ available: true }),
          send: () => ({ status: "accepted" as const, turnId: `t-${++counter}` }),
          sendPrompt: (_blocks: unknown, history: unknown) => {
            promptHistories.push(history)
            return { status: "accepted" as const, turnId: `t-${++counter}` }
          },
          cancel: () => true,
          answerPermission: () => true,
          subscribe: (listener: AcpListener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
          close: async () => { listeners.clear() },
        }),
        subscribeDiagnostics: () => () => {},
        close: async () => {},
      } as unknown as IpcRuntime["host"],
    }

    const assembler = {
      async assembleTurnContext(input: { turnId: string }) {
        assembledCalls.push(input.turnId)
        return { contextBlocks: [{ type: "text" as const, text: "TEAM_CTX_BLOCK" }] }
      },
      async onTurnSettled(input: { turnId: string; outcome: "completed" | "failed" | "cancelled" }) {
        settledCalls.push(`${input.turnId}:${input.outcome}`)
      },
    }

    const coordinator1 = createLocalExecutionCoordinator(window, identity, uploads, mockRuntime, {
      grantsDir,
      checkpointsDir,
      origin: ORIGIN,
      localConversations,
      contextAssembler: assembler,
    })
    const unbindExec = bindLocalExecutionIpc(trustedWindow, `${ORIGIN}/index.html`, coordinator1, fakeIpc as never)

    await coordinator1.captureDirectorySelection()(workdir)
    const prep1 = await registered.get("workbench:local-execution:prepare")!(senderEvent, soloScope, workdir) as {
      ok: true; value: { bindingId: string }
    }
    assert.equal(prep1.ok, true)
    const send1 = await coordinator1.send(soloScope, prep1.value.bindingId, REQ_ID, "断网第一问", [])
    assert.equal(send1.ok && send1.value.status === "accepted", true)
    if (!send1.ok || send1.value.status !== "accepted") return
    for (const listener of listeners) {
      listener({ turnId: send1.value.turnId, sequence: 1, type: "text-delta", text: "离线第一答", messageId: "m1" })
      listener({ turnId: send1.value.turnId, sequence: 2, type: "completed", shareable: true })
    }
    await coordinator1.dispose()
    unbindExec()

    // 断网执行全程零云端请求、零上传入队、无团队跳过 contextAssembler，但完整落盘 LocalConversationStore
    assert.equal(cloudCalls.length, 0)
    assert.equal(uploadedBatches.length, 0)
    assert.equal(assembledCalls.length, 0)
    assert.equal(settledCalls.length, 0)
    const persistedAfterRestart = await localConversations.get(USER_A, soloConvId)
    assert.equal(persistedAfterRestart.ok && persistedAfterRestart.value.turns.length, 1)

    // 恢复联机，新建协调器验证从 LocalConversationStore 还原第二轮前情
    serverDown = false
    await identity.getState()
    uploads.useAccount(USER_A)

    const coordinator2 = createLocalExecutionCoordinator(window, identity, uploads, mockRuntime, {
      grantsDir,
      checkpointsDir,
      origin: ORIGIN,
      localConversations,
      contextAssembler: assembler,
    })
    await coordinator2.captureDirectorySelection()(workdir)
    const prep2 = await coordinator2.prepare(soloScope, workdir)
    assert.equal(prep2.ok, true)
    if (!prep2.ok) return
    const req2 = "55555555-5555-4555-8555-555555555555"
    const send2 = await coordinator2.send(soloScope, prep2.value.bindingId, req2, "继续第二问", [])
    assert.equal(send2.ok && send2.value.status === "accepted", true)
    assert.equal(promptHistories.length, 1)
    assert.match(JSON.stringify(promptHistories[0]), /断网第一问/)
    assert.match(JSON.stringify(promptHistories[0]), /离线第一答/)
    if (send2.ok && send2.value.status === "accepted") {
      for (const listener of listeners) {
        listener({ turnId: send2.value.turnId, sequence: 1, type: "text-delta", text: "已续传", messageId: "m2" })
        listener({ turnId: send2.value.turnId, sequence: 2, type: "completed", shareable: true })
      }
    }

    // 团队绑定但未发布会话：触发 contextAssembler、允许知识引用、拒绝项目快照引用、且不上传云端
    const teamCreated = await localConversations.create(USER_A, { workspaceId: WORKSPACE_ID, directoryPath: workdir })
    assert.equal(teamCreated.ok, true)
    if (!teamCreated.ok) return
    const teamConvId = teamCreated.value.conversationId
    const teamPersonalScope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: null, conversationId: teamConvId }
    const prepTeam = await coordinator2.prepare(teamPersonalScope, workdir)
    assert.equal(prepTeam.ok, true)
    if (!prepTeam.ok) return

    const badSnapshotSend = await coordinator2.send(
      teamPersonalScope,
      prepTeam.value.bindingId,
      "66666666-6666-4666-8666-666666666666",
      "引用快照",
      ["snapshot:99999999-9999-4999-8999-999999999999"],
    )
    assert.equal(badSnapshotSend.ok, false)

    const sendTeam = await coordinator2.send(
      teamPersonalScope,
      prepTeam.value.bindingId,
      "77777777-7777-4777-8777-777777777777",
      "按团队规范回答",
      ["knowledge:77777777-7777-4777-8777-777777777777:88888888-8888-4888-8888-888888888888"],
    )
    assert.equal(sendTeam.ok && sendTeam.value.status === "accepted", true)
    assert.equal(assembledCalls.length, 1)
    assert.match(JSON.stringify(promptHistories[1]), /TEAM_CTX_BLOCK/)
    if (sendTeam.ok && sendTeam.value.status === "accepted") {
      for (const listener of listeners) {
        listener({ turnId: sendTeam.value.turnId, sequence: 1, type: "text-delta", text: "收到规范", messageId: "m3" })
        listener({ turnId: sendTeam.value.turnId, sequence: 2, type: "completed", shareable: true })
      }
    }
    await waitFor(() => settledCalls.length === 1)
    assert.equal(uploadedBatches.length, 0)

    // 发布为 summary_only 后发送一轮：仅上传空 messages + brief；停止共享后发送一轮：仅写本机不入队
    await localConversations.markPublished(USER_A, teamConvId, {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      shareMode: "summary_only",
    })
    const publishedScope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: teamConvId }
    const sendPublished = await coordinator2.send(
      publishedScope,
      prepTeam.value.bindingId,
      "99999999-9999-4999-8999-999999999991",
      "仅简报上传验证",
      [],
    )
    assert.equal(sendPublished.ok && sendPublished.value.status === "accepted", true)
    if (sendPublished.ok && sendPublished.value.status === "accepted") {
      for (const listener of listeners) {
        listener({ turnId: sendPublished.value.turnId, sequence: 1, type: "text-delta", text: "结论摘要文本", messageId: "m4" })
        listener({ turnId: sendPublished.value.turnId, sequence: 2, type: "completed", shareable: true })
      }
    }
    await waitFor(() => uploadedBatches.length >= 1)
    assert.equal(uploadedBatches.length, 1)
    assert.deepEqual(uploadedBatches[0]!.messages, [])

    await registered.get("workbench:local-conversations:mark-sharing-stopped")!(senderEvent, teamConvId)
    const sendAfterStop = await coordinator2.send(
      publishedScope,
      prepTeam.value.bindingId,
      "99999999-9999-4999-8999-999999999992",
      "停止共享后继续本地问",
      [],
    )
    assert.equal(sendAfterStop.ok && sendAfterStop.value.status === "accepted", true)
    if (sendAfterStop.ok && sendAfterStop.value.status === "accepted") {
      for (const listener of listeners) {
        listener({ turnId: sendAfterStop.value.turnId, sequence: 1, type: "text-delta", text: "本地保留答复", messageId: "m5" })
        listener({ turnId: sendAfterStop.value.turnId, sequence: 2, type: "completed", shareable: true })
      }
    }
    await coordinator2.dispose()
    await uploads.flush()
    assert.equal(uploadedBatches.length, 1)
    const finalDetail = await localConversations.get(USER_A, teamConvId)
    assert.equal(finalDetail.ok && finalDetail.value.turns.length, 3)

    unbindLocal()
    identity.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

