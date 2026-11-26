/**
 * HC-257 单元测试：个人会话整理 IPC——归档/置顶/显示目录通道参数校验与错误语义、
 * 删除收紧（运行中与团队侧记录拒绝）以及删除后的真实清理链（协调器遗忘、个人视图文件、检查点）。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { CollaborationResult } from "@workbench/collaboration-client/types"
import type { CollaborationState as CollaborationStateType } from "@workbench/collaboration-client"
import type {
  bindLocalConversationsIpc as bindLocalConversationsIpcFn,
  LocalConversationsCleanup,
} from "../src/main/local-conversations-ipc.ts"
import type { LocalConversationStore as LocalConversationStoreType } from "../src/main/local-conversation-store.ts"
import type { PersonalStore as PersonalStoreType } from "../src/main/personal-store.ts"
import type {
  createLocalExecutionCoordinator as createCoordinatorFn,
  LocalExecutionCoordinator,
  LocalExecutionRuntime,
} from "../src/main/local-execution-coordinator.ts"
import type { LocalConversationRecord } from "../src/shared/index.ts"
import type { digest as digestFn } from "../src/main/project-service/git-command.ts"

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
const { bindLocalConversationsIpc } = await import("../src/main/local-conversations-ipc.ts") as {
  bindLocalConversationsIpc: typeof bindLocalConversationsIpcFn
}
const { LocalConversationStore } = await import("../src/main/local-conversation-store.ts") as {
  LocalConversationStore: typeof LocalConversationStoreType
}
const { PersonalStore } = await import("../src/main/personal-store.ts") as {
  PersonalStore: typeof PersonalStoreType
}
const { createLocalExecutionCoordinator } = await import("../src/main/local-execution-coordinator.ts") as {
  createLocalExecutionCoordinator: typeof createCoordinatorFn
}
const { digest } = await import("../src/main/project-service/git-command.ts") as {
  digest: typeof digestFn
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_A = "11111111111111111111111111111111"
const CONV_ID = "33333333-3333-4333-8333-333333333333"
const REQ_ID = "44444444-4444-4444-8444-444444444444"
const MISSING_ID = "55555555-5555-4555-8555-555555555555"

type IpcWindow = Parameters<typeof createCoordinatorFn>[0]
type IpcRuntime = Extract<LocalExecutionRuntime, { host: unknown }>
type BoundSession = Awaited<ReturnType<IpcRuntime["host"]["bind"]>>
type AcpListener = Parameters<BoundSession["subscribe"]>[0]
type AcpEvent = Parameters<AcpListener>[0]
type IpcResult = CollaborationResult<unknown>
type CleanupOptions = { cleanup?: LocalConversationsCleanup; revealPath?: (path: string) => Promise<string> }

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

async function createSignedInState(userId: string) {
  const user = {
    id: userId,
    userNo: "80000001",
    userName: "测试甲",
    photo: "",
    orgId: "org-1",
    orgNo: "001",
    orgName: "研发组",
    orgPathName: "研发部/研发组",
  }
  const transport: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith("/api/v1/auth/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    if (url.endsWith("/api/v1/auth/logout")) return jsonOk(null)
    if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) {
      return jsonOk({ user, workspaces: [] })
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
      mainFrame: { url: `${ORIGIN}/index.html` },
    },
  } as unknown as IpcWindow
  return { window, notices }
}

function createFakeIpc() {
  const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const fakeIpc = {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => { registered.set(channel, handler) },
    removeHandler: (channel: string) => { registered.delete(channel) },
  }
  return { registered, fakeIpc }
}

function createMockRuntime() {
  const listeners = new Set<AcpListener>()
  let counter = 0
  let closed = false
  const session: BoundSession = {
    getAvailability: () => ({ available: true }),
    send: () => ({ status: "accepted" as const, turnId: `turn-${++counter}` }),
    sendPrompt: () => ({ status: "accepted" as const, turnId: `turn-${++counter}` }),
    cancel: () => true,
    answerPermission: () => true,
    subscribe: (listener: AcpListener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    close: async () => { closed = true; listeners.clear() },
  } as BoundSession
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
  return { runtime, session, emit, isClosed: () => closed }
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for async task")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test("整理通道参数校验、参数个数与未登录拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc257-ipc-guard-"))
  try {
    const identity = await createSignedInState(USER_A)
    const store = new LocalConversationStore(root, ORIGIN)
    const { window } = createFakeWindow()
    const { registered, fakeIpc } = createFakeIpc()
    const unbind = bindLocalConversationsIpc(
      window, `${ORIGIN}/index.html`, identity, store, null, fakeIpc as never,
    )
    const senderEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }

    const invalid = async (channel: string, ...args: unknown[]) => {
      const result = await registered.get(channel)!(senderEvent, ...args) as IpcResult
      assert.equal(result.ok, false, `${channel} 应拒绝 ${JSON.stringify(args)}`)
      if (!result.ok) assert.equal(result.error.code, "INVALID_REQUEST")
    }
    // 参数个数不符由注册器统一拦截
    await invalid("workbench:local-conversations:set-archived", CONV_ID)
    await invalid("workbench:local-conversations:set-archived", CONV_ID, true, "extra")
    await invalid("workbench:local-conversations:set-archived", "not-uuid", true)
    await invalid("workbench:local-conversations:set-archived", CONV_ID, "yes")
    await invalid("workbench:local-conversations:set-pinned", "not-uuid", true)
    await invalid("workbench:local-conversations:set-pinned", CONV_ID, 1)
    await invalid("workbench:local-conversations:reveal-directory")
    await invalid("workbench:local-conversations:reveal-directory", "not-uuid")
    await invalid("workbench:local-conversations:reveal-directory", CONV_ID, "extra")
    unbind()

    // 未登录统一返回 AUTHENTICATION_REQUIRED
    const anonymous = new CollaborationState(ORIGIN, async () => new Response("x", { status: 404 }))
    const { registered: anon, fakeIpc: anonIpc } = createFakeIpc()
    const unbindAnon = bindLocalConversationsIpc(
      window, `${ORIGIN}/index.html`, anonymous, store, null, anonIpc as never,
    )
    for (const [channel, args] of [
      ["workbench:local-conversations:set-archived", [CONV_ID, true]],
      ["workbench:local-conversations:set-pinned", [CONV_ID, true]],
      ["workbench:local-conversations:reveal-directory", [CONV_ID]],
      ["workbench:local-conversations:remove", [CONV_ID]],
    ] as const) {
      const result = await anon.get(channel)!(senderEvent, ...args) as IpcResult
      assert.equal(result.ok, false, `${channel} 应要求登录`)
      if (!result.ok) assert.equal(result.error.code, "AUTHENTICATION_REQUIRED")
    }
    unbindAnon()
    identity.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("归档/置顶通道与显示目录的错误映射", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc257-ipc-tidy-"))
  const workdir = await mkdtemp(join(tmpdir(), "hc257-ipc-workdir-"))
  try {
    const identity = await createSignedInState(USER_A)
    const store = new LocalConversationStore(root, ORIGIN)
    const { window } = createFakeWindow()
    const { registered, fakeIpc } = createFakeIpc()

    const revealed: string[] = []
    let revealImpl: (path: string) => Promise<string> = async () => ""
    const cleanupCalls: [string, string][] = []
    let busy = false
    const options: CleanupOptions = {
      cleanup: {
        isBusy: (accountId, conversationId) => { cleanupCalls.push([accountId, conversationId]); return busy },
        forget: async () => {},
      },
      revealPath: async path => { revealed.push(path); return revealImpl(path) },
    }
    const unbind = bindLocalConversationsIpc(
      window, `${ORIGIN}/index.html`, identity, store, null, fakeIpc as never, options,
    )
    const senderEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const setArchived = registered.get("workbench:local-conversations:set-archived")!
    const setPinned = registered.get("workbench:local-conversations:set-pinned")!
    const reveal = registered.get("workbench:local-conversations:reveal-directory")!

    const created = await store.create(USER_A, { conversationId: CONV_ID, workspaceId: null, directoryPath: workdir })
    assert.equal(created.ok, true)

    // 归档成功；协调器报告运行中时拒绝归档
    const archived = await setArchived(senderEvent, CONV_ID, true) as CollaborationResult<LocalConversationRecord>
    assert.equal(archived.ok, true)
    if (archived.ok) assert.equal(typeof archived.value.archivedAtMs, "number")
    assert.equal((await setArchived(senderEvent, CONV_ID, false)).ok, true)
    busy = true
    const archiveBusy = await setArchived(senderEvent, CONV_ID, true) as IpcResult
    assert.equal(archiveBusy.ok, false)
    if (!archiveBusy.ok) {
      assert.equal(archiveBusy.error.code, "EXECUTION_STATE_CONFLICT")
      assert.equal(archiveBusy.error.message, "会话正在运行，请先停止后再归档。")
    }
    assert.deepEqual(cleanupCalls.at(-1), [USER_A, CONV_ID])
    // 取消归档不受 busy 限制：已归档会话被继续发送后，轮次完成前必须能随时恢复
    assert.equal((await store.setArchived(USER_A, CONV_ID, true)).ok, true)
    const unarchiveBusy = await setArchived(senderEvent, CONV_ID, false) as IpcResult
    assert.equal(unarchiveBusy.ok, true)
    busy = false

    // 置顶成功并返回带 pinnedAtMs 的记录
    const pinned = await setPinned(senderEvent, CONV_ID, true) as CollaborationResult<LocalConversationRecord>
    assert.equal(pinned.ok, true)
    if (pinned.ok) assert.equal(typeof pinned.value.pinnedAtMs, "number")

    // 显示目录：成功调用注入的 revealPath
    const revealedOk = await reveal(senderEvent, CONV_ID) as IpcResult
    assert.equal(revealedOk.ok, true)
    assert.deepEqual(revealed, [workdir])

    // 未绑定目录 → INVALID_REQUEST
    const noDir = await store.create(USER_A, { workspaceId: null, title: "无目录" })
    assert.equal(noDir.ok, true)
    if (!noDir.ok) return
    const noDirResult = await reveal(senderEvent, noDir.value.conversationId) as IpcResult
    assert.equal(noDirResult.ok, false)
    if (!noDirResult.ok) {
      assert.equal(noDirResult.error.code, "INVALID_REQUEST")
      assert.equal(noDirResult.error.message, "该会话尚未绑定目录。")
    }

    // 目录不存在或不是目录 → RESOURCE_NOT_FOUND
    await store.updateBinding(USER_A, CONV_ID, { directoryPath: join(workdir, "gone") })
    const gone = await reveal(senderEvent, CONV_ID) as IpcResult
    assert.equal(gone.ok, false)
    if (!gone.ok) {
      assert.equal(gone.error.code, "RESOURCE_NOT_FOUND")
      assert.equal(gone.error.message, "目录不存在或已被移动。")
    }
    const filePath = join(workdir, "file.txt")
    await writeFile(filePath, "x")
    await store.updateBinding(USER_A, CONV_ID, { directoryPath: filePath })
    const notDir = await reveal(senderEvent, CONV_ID) as IpcResult
    assert.equal(notDir.ok, false)
    if (!notDir.ok) assert.equal(notDir.error.code, "RESOURCE_NOT_FOUND")

    // 系统打开失败（返回非空串或抛错）→ INTERNAL_ERROR
    await store.updateBinding(USER_A, CONV_ID, { directoryPath: workdir })
    revealImpl = async () => "应用程序拒绝打开"
    const failed = await reveal(senderEvent, CONV_ID) as IpcResult
    assert.equal(failed.ok, false)
    if (!failed.ok) {
      assert.equal(failed.error.code, "INTERNAL_ERROR")
      assert.equal(failed.error.message, "无法打开该目录。")
    }
    revealImpl = async () => { throw new Error("shell.openPath 崩溃") }
    const crashed = await reveal(senderEvent, CONV_ID) as IpcResult
    assert.equal(crashed.ok, false)
    if (!crashed.ok) assert.equal(crashed.error.code, "INTERNAL_ERROR")

    unbind()
    identity.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workdir, { recursive: true, force: true })
  }
})

test("删除收紧：运行中与团队侧记录拒绝，local_only 删除后真实清理链执行", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc257-ipc-remove-"))
  const workdir = await mkdtemp(join(tmpdir(), "hc257-remove-workdir-"))
  try {
    const identity = await createSignedInState(USER_A)
    const store = new LocalConversationStore(root, ORIGIN)
    const personal = new PersonalStore(identity, ORIGIN, root, store)
    const checkpointsDir = join(root, "checkpoints")
    const grantsDir = join(root, "grants")
    const { window } = createFakeWindow()
    const { registered, fakeIpc } = createFakeIpc()
    const { runtime, emit, isClosed } = createMockRuntime()
    const changedIds: string[] = []
    const coordinator: LocalExecutionCoordinator = createLocalExecutionCoordinator(window, identity, null, runtime, {
      grantsDir,
      checkpointsDir,
      origin: ORIGIN,
      personal,
      localConversations: store,
      onLocalConversationChanged: id => { changedIds.push(id) },
    })

    // 与生产装配一致：cleanup 由协调器与 PersonalStore 组合
    const options: CleanupOptions = {
      cleanup: {
        isBusy: (accountId, conversationId) => coordinator.hasActiveTurn(accountId, conversationId),
        forget: async (accountId, conversationId) => {
          await coordinator.forgetConversation(accountId, conversationId).catch(() => {})
          await personal.removeConversation(accountId, conversationId).catch(() => {})
        },
      },
      revealPath: async () => "",
    }
    const unbind = bindLocalConversationsIpc(
      window, `${ORIGIN}/index.html`, identity, store, null, fakeIpc as never, options,
    )
    const senderEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const remove = registered.get("workbench:local-conversations:remove")!

    const created = await store.create(USER_A, { conversationId: CONV_ID, workspaceId: null, directoryPath: workdir })
    assert.equal(created.ok, true)
    const scope = { accountId: USER_A, workspaceId: null, projectId: null, conversationId: CONV_ID }

    // 个人视图三类文件就绪：会话草稿、右侧面板、待发队列
    const convKey = { kind: "conversation" as const, workspaceId: null, projectId: null, conversationId: CONV_ID }
    const panelKey = { kind: "sessionWorkspace" as const, workspaceId: null, projectId: null, conversationId: CONV_ID }
    const sampleConversation = {
      scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
      expandedTools: [],
      expandedOutputs: [],
      draft: { text: "草稿", selectionStart: 0, selectionEnd: 0, revision: 1, referenceIds: [], attachmentIds: [] },
      localDirectoryPath: workdir,
      syncCache: null,
    }
    const panelData = {
      personal: {
        view: {
          dockOpen: true, dockWidthPx: 320, panel: "files" as const,
          selectedPath: null, fileTabs: [], activeFilePath: null, selectedChanges: [], commitMessage: "",
        },
        expanded: [], centralPaths: [], activeCentral: null, diffPath: null,
      },
      positions: [],
    }
    // save 依赖已确认授权缓存，先经 load 完成授权再写入
    assert.equal((await personal.load(convKey)).ok, true)
    assert.equal((await personal.load(panelKey)).ok, true)
    assert.equal((await personal.save(convKey, 1, sampleConversation)).ok, true)
    assert.equal((await personal.save(panelKey, 1, panelData)).ok, true)
    assert.equal((await personal.conversationPromptQueue(scope, {
      items: [{ requestId: REQ_ID, text: "待发消息", referenceIds: [], attachments: [] }],
    })).ok, true)
    assert.equal((await readdir(join(root, "personal-view-v2"))).length, 3)

    // 建立执行绑定并发送一轮：协调器报告进行中轮次 → 删除与归档均被拒
    await coordinator.captureDirectorySelection()(workdir)
    const prep = await coordinator.prepare(scope, workdir)
    assert.equal(prep.ok, true)
    if (!prep.ok) return
    const send = await coordinator.send(scope, prep.value.bindingId, REQ_ID, "整理前最后一问", [])
    assert.equal(send.ok && send.value.status === "accepted", true)
    assert.equal(coordinator.hasActiveTurn(USER_A, CONV_ID), true)
    const scopeId = digest(JSON.stringify([ORIGIN, USER_A, CONV_ID])).slice(0, 32)
    await mkdir(checkpointsDir, { recursive: true })
    await writeFile(join(checkpointsDir, `${scopeId}.json`), "[]")
    assert.equal((await readdir(join(checkpointsDir, "directories"))).length, 1)

    const removeBusy = await remove(senderEvent, CONV_ID) as IpcResult
    assert.equal(removeBusy.ok, false)
    if (!removeBusy.ok) {
      assert.equal(removeBusy.error.code, "EXECUTION_STATE_CONFLICT")
      assert.equal(removeBusy.error.message, "会话正在运行，请先停止后再删除。")
    }
    const archiveBusy = await registered.get("workbench:local-conversations:set-archived")!(senderEvent, CONV_ID, true) as IpcResult
    assert.equal(archiveBusy.ok, false)
    if (!archiveBusy.ok) assert.equal(archiveBusy.error.code, "EXECUTION_STATE_CONFLICT")

    // 记录状态同样拦截删除
    await store.updateBinding(USER_A, CONV_ID, { status: "waiting_approval" })
    const removeWaiting = await remove(senderEvent, CONV_ID) as IpcResult
    assert.equal(removeWaiting.ok, false)
    if (!removeWaiting.ok) assert.equal(removeWaiting.error.code, "EXECUTION_STATE_CONFLICT")
    await store.updateBinding(USER_A, CONV_ID, { status: "idle" })

    // 不存在的会话删除返回 NOT_FOUND 而非忙碌冲突
    const removeMissing = await remove(senderEvent, MISSING_ID) as IpcResult
    assert.equal(removeMissing.ok, false)
    if (!removeMissing.ok) assert.equal(removeMissing.error.code, "RESOURCE_NOT_FOUND")

    // 终态落地后删除成功：绑定释放、检查点与个人视图三类文件一并清理
    emit({ turnId: (send as { value: { turnId: string } }).value.turnId, sequence: 1, type: "completed", shareable: true })
    await waitFor(() => changedIds.includes(CONV_ID))
    await waitFor(() => !coordinator.hasActiveTurn(USER_A, CONV_ID))

    const removed = await remove(senderEvent, CONV_ID) as IpcResult
    assert.equal(removed.ok, true)
    assert.equal(isClosed(), true)
    assert.equal((await store.getRecord(USER_A, CONV_ID)), null)
    assert.equal((await readdir(join(root, "personal-view-v2"))).length, 0)
    assert.equal((await readdir(join(checkpointsDir, "directories"))).length, 0)
    assert.deepEqual((await readdir(checkpointsDir)).filter(name => name.endsWith(".json")), [])

    unbind()
    await coordinator.dispose()
    identity.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workdir, { recursive: true, force: true })
  }
})
