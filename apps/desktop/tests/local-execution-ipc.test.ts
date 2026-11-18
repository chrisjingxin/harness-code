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
import type { ConversationSyncRequest } from "@workbench/contracts"
import type { CollaborationState as CollaborationStateType } from "../src/main/collaboration-state.ts"
import type { ConversationUploads as ConversationUploadsType } from "../src/main/conversation-uploads.ts"
import type { createLocalExecutionIpc as createLocalExecutionIpcFn } from "../src/main/local-execution-ipc.ts"

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

const { CollaborationState } = await import("../src/main/collaboration-state.ts") as {
  CollaborationState: typeof CollaborationStateType
}
const { ConversationUploads, syncPayloadLimit } = await import("../src/main/conversation-uploads.ts") as {
  ConversationUploads: typeof ConversationUploadsType
  syncPayloadLimit: number
}
const { createLocalExecutionIpc } = await import("../src/main/local-execution-ipc.ts") as {
  createLocalExecutionIpc: typeof createLocalExecutionIpcFn
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_A = "11111111111111111111111111111111"
const USER_B = "22222222222222222222222222222222"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"
const REQ_ID = "44444444-4444-4444-8444-444444444444"

type IpcWindow = Parameters<typeof createLocalExecutionIpc>[0]
type IpcRuntime = Extract<Parameters<typeof createLocalExecutionIpc>[3], { host: unknown }>
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

    const ipc = createLocalExecutionIpc(window, identity, uploads, runtime)
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

    const ipc = createLocalExecutionIpc(window, identity, uploads, runtime)
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
    const ipc1 = createLocalExecutionIpc(window, identityA1, null, runtime, grantsDir)

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
    const ipc2 = createLocalExecutionIpc(window, identityA2, null, runtime, grantsDir)

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
    const ipcB = createLocalExecutionIpc(window, identityB, null, runtime, grantsDir)
    const crossAccount = await ipcB.prepare(scopeB, selectedDir)
    assert.equal(crossAccount.ok, false)
    if (!crossAccount.ok) assert.equal(crossAccount.error.code, "PROJECT_PATH_INVALID")

    await Promise.all([ipc2.dispose(), ipcB.dispose()])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
