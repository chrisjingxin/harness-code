/**
 * HC-225 单元测试：验证 PersonalStore 权限校验的 60 秒 TTL 缓存、
 * 并发在途请求去重、身份代次切换淘汰以及授权失败清理。
 */
import assert from "node:assert/strict"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  CollaborationResult,
  ConversationDetailResponse,
  ProjectDetailResponse,
} from "@workbench/collaboration-client/types"
import type { CollaborationState } from "@workbench/collaboration-client"
import { PersonalStore } from "../src/main/personal-store.ts"
import type { ConversationPersonal, ProjectNavigationPersonal } from "../src/shared/index.ts"

const ORIGIN = "http://127.0.0.1:9999"
const USER_A = "11111111111111111111111111111111"
const USER_B = "99999999999999999999999999999999"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"

type IdentitySnapshot = ReturnType<CollaborationState["personalIdentity"]>

function createFakeCollaborationState(initialIdentity: IdentitySnapshot) {
  let identity = initialIdentity
  let getProjectCalls = 0
  let getConversationCalls = 0
  let getProjectImpl: (workspaceId: string, projectId: string) => Promise<CollaborationResult<ProjectDetailResponse>> = async (
    workspaceId,
    projectId,
  ) => ({
    ok: true,
    value: {
      project: {
        projectId,
        workspaceId,
        name: "测试项目",
        description: "",
        ownerUserId: USER_A,
        status: "active",
        role: "owner",
        memberCount: 1,
        version: 1,
        createdAt: "2026-11-18T00:00:00.000Z",
        updatedAt: "2026-11-18T00:00:00.000Z",
      },
      members: [],
      repositories: [],
    },
  })
  let getConversationImpl: (
    workspaceId: string,
    projectId: string,
    conversationId: string,
  ) => Promise<CollaborationResult<ConversationDetailResponse>> = async (_workspaceId, projectId, conversationId) => ({
    ok: true,
    value: {
      conversation: {
        conversationId,
        projectId,
        ownerUserId: USER_A,
        title: "测试会话",
        status: "idle",
        briefText: "",
        briefSource: "rule",
        briefUpdatedAtMs: 1_700_000_000_000,
        syncedSequence: 0,
        updatedAt: "2026-11-18T00:00:00.000Z",
        repositories: [],
      },
    },
  })

  const fakeClient = {
    async getProject(workspaceId: string, projectId: string) {
      getProjectCalls++
      return getProjectImpl(workspaceId, projectId)
    },
    async getProjectConversation(workspaceId: string, projectId: string, conversationId: string) {
      getConversationCalls++
      return getConversationImpl(workspaceId, projectId, conversationId)
    },
  }
  const state = {
    personalIdentity: () => identity,
    async withWorkspace<T>(_workspaceId: string, fn: (client: typeof fakeClient) => Promise<CollaborationResult<T>>) {
      return fn(fakeClient)
    },
  } as unknown as CollaborationState

  return {
    state,
    setIdentity(next: IdentitySnapshot) { identity = next },
    setGetProject(fn: typeof getProjectImpl) { getProjectImpl = fn },
    setGetConversation(fn: typeof getConversationImpl) { getConversationImpl = fn },
    counts: () => ({ getProjectCalls, getConversationCalls }),
  }
}

const sampleNavigation: ProjectNavigationPersonal = {
  page: { kind: "board" },
  expandedMembers: [],
  selfCollapsed: false,
}

const sampleConversation: ConversationPersonal = {
  scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
  expandedTools: [],
  expandedOutputs: [],
  draft: { text: "草稿", selectionStart: 2, selectionEnd: 2, revision: 1, referenceIds: [], attachmentIds: [] },
  localDirectoryPath: "/tmp/demo",
  syncCache: null,
}

test("PersonalStore 在 60 秒 TTL 内复用已校验授权，到期后重新向服务端核验", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc225-personal-ttl-"))
  const realDateNow = Date.now
  try {
    let nowMs = 1_700_000_000_000
    Date.now = () => nowMs

    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const navKey = { kind: "projectNavigation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID } as const
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const

    // 首次加载触发校验，随后 59.999 秒内重复 load/save 不得再次请求服务端。
    assert.equal((await store.load(navKey)).ok, true)
    assert.equal((await store.load(navKey)).ok, true)
    assert.equal((await store.save(navKey, 1, sampleNavigation)).ok, true)
    assert.equal(mock.counts().getProjectCalls, 1)

    assert.equal((await store.load(convKey)).ok, true)
    nowMs += 59_999
    assert.equal((await store.load(convKey)).ok, true)
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 1)

    // 超过 60 秒 TTL 后重新校验；仍授权时可继续加载与保存。
    nowMs += 1
    assert.equal((await store.load(convKey)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 2)

    nowMs += 60_000
    assert.equal((await store.save(convKey, 2, sampleConversation)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 3)
  } finally {
    Date.now = realDateNow
    await rm(dir, { recursive: true, force: true })
  }
})

test("PersonalStore 合并同一授权键的并发在途请求，并在失败时不缓存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc225-personal-inflight-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    let release!: (result: CollaborationResult<ConversationDetailResponse>) => void
    mock.setGetConversation(() => new Promise(resolve => { release = resolve }))

    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const

    const pendingFail = Promise.all([
      store.load(convKey),
      store.load(convKey),
      store.load(convKey),
      store.load(convKey),
    ])
    assert.equal(mock.counts().getConversationCalls, 1)
    release({
      ok: false,
      error: { code: "RESOURCE_NOT_FOUND", message: "未找到会话", requestId: "req-1", retryable: false },
    })

    const failResults = await pendingFail
    assert.equal(failResults.every(item => !item.ok), true)
    // 失败后不得残留权限缓存，save 仍应拒绝。
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, false)

    // 恢复正常响应后，再次并发加载只发 1 次请求并全部成功。
    let releaseOk!: (result: CollaborationResult<ConversationDetailResponse>) => void
    mock.setGetConversation(() => new Promise(resolve => { releaseOk = resolve }))
    const pendingOk = Promise.all([store.load(convKey), store.load(convKey), store.load(convKey)])
    assert.equal(mock.counts().getConversationCalls, 2)
    releaseOk({
      ok: true,
      value: {
        conversation: {
          conversationId: CONV_ID,
          projectId: PROJECT_ID,
          ownerUserId: USER_A,
          title: "恢复会话",
          status: "idle",
          briefText: "",
          briefSource: "rule",
          briefUpdatedAtMs: 1_700_000_000_000,
          syncedSequence: 0,
          updatedAt: "2026-11-18T00:00:00.000Z",
          repositories: [],
        },
      },
    })
    const okResults = await pendingOk
    assert.equal(okResults.every(item => item.ok), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("PersonalStore 在身份代次变化、权限失效或过期撤销时淘汰缓存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc225-personal-evict-"))
  const realDateNow = Date.now
  try {
    let nowMs = 1_700_000_000_000
    Date.now = () => nowMs

    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const

    // 未加载前直接保存必须拒绝。
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, false)

    assert.equal((await store.load(convKey)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 1)

    // 切换身份代次（重新登录或切换账号）后，旧代次缓存失效且不得继续用于保存。
    mock.setIdentity({ generation: 2, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, false)
    assert.equal((await store.load(convKey)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 2)

    // 即使回退到旧代次，先前缓存也已被主动淘汰，不得直接命中旧缓存。
    mock.setIdentity({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, false)

    // 切换为另一账号时同样重新校验。
    mock.setIdentity({ generation: 3, accountId: USER_B, workspaces: [WORKSPACE_ID] })
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, false)
    assert.equal((await store.load(convKey)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 3)

    // 在途授权期间发生身份变化，延迟回包必须被拒绝且不得写入权限缓存。
    let releaseStale!: (result: CollaborationResult<ProjectDetailResponse>) => void
    const navKey = { kind: "projectNavigation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID } as const
    mock.setGetProject(() => new Promise(resolve => { releaseStale = resolve }))
    const staleLoad = store.load(navKey)
    mock.setIdentity({ generation: 4, accountId: USER_B, workspaces: [WORKSPACE_ID] })
    releaseStale({
      ok: true,
      value: {
        project: {
          projectId: PROJECT_ID,
          workspaceId: WORKSPACE_ID,
          name: "测试项目",
          description: "",
          ownerUserId: USER_B,
          status: "active",
          role: "owner",
          memberCount: 1,
          version: 1,
          createdAt: "2026-11-18T00:00:00.000Z",
          updatedAt: "2026-11-18T00:00:00.000Z",
        },
        members: [],
        repositories: [],
      },
    })
    assert.equal((await staleLoad).ok, false)
    assert.equal((await store.save(navKey, 1, sampleNavigation)).ok, false)

    // 先加载生成 gen=4 缓存，TTL 过期后服务端拒绝访问，save 与缓存必须一起淘汰。
    assert.equal((await store.load(convKey)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 4)
    nowMs += 60_000
    mock.setGetConversation(async () => ({
      ok: false,
      error: { code: "RESOURCE_NOT_FOUND", message: "无权访问", requestId: "req-2", retryable: false },
    }))
    assert.equal((await store.save(convKey, 2, sampleConversation)).ok, false)
    assert.equal((await store.save(convKey, 2, sampleConversation)).ok, false)
    assert.equal(mock.counts().getConversationCalls, 5)
  } finally {
    Date.now = realDateNow
    await rm(dir, { recursive: true, force: true })
  }
})

test("PersonalStore 在 60 秒 TTL 到期后并发调用 save 复用单次重验且全部成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc232-personal-ttl-concurrent-"))
  const realDateNow = Date.now
  try {
    let nowMs = 1_700_000_000_000
    Date.now = () => nowMs

    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const

    assert.equal((await store.load(convKey)).ok, true)
    assert.equal(mock.counts().getConversationCalls, 1)

    nowMs += 60_000
    let releaseRefresh!: (result: CollaborationResult<ConversationDetailResponse>) => void
    mock.setGetConversation(() => new Promise(resolve => { releaseRefresh = resolve }))

    const concurrentSaves = Promise.all([
      store.save(convKey, 1, sampleConversation),
      store.save(convKey, 2, sampleConversation),
      store.save(convKey, 3, sampleConversation),
    ])
    // 三个并发过期的 save 必须共享同一个在途权限校验请求，且后面的不能因提前删缓存而报错。
    assert.equal(mock.counts().getConversationCalls, 2)
    releaseRefresh({
      ok: true,
      value: {
        conversation: {
          conversationId: CONV_ID,
          projectId: PROJECT_ID,
          ownerUserId: USER_A,
          title: "重验通过会话",
          status: "idle",
          briefText: "",
          briefSource: "rule",
          briefUpdatedAtMs: 1_700_000_000_000,
          syncedSequence: 0,
          updatedAt: "2026-11-18T00:00:00.000Z",
          repositories: [],
        },
      },
    })
    const results = await concurrentSaves
    assert.deepEqual(results.map(item => item.ok), [true, true, true])
  } finally {
    Date.now = realDateNow
    await rm(dir, { recursive: true, force: true })
  }
})

test("PersonalStore 兼容未含 providerId 的历史会话记录并校验与持久化 providerId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc231-personal-provider-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const

    assert.equal((await store.load(convKey)).ok, true)
    // 未传 providerId 的历史结构仍可保存与读取
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, true)

    // 带 providerId 保存后，新实例重登读取必须保留原选择
    const withProvider: ConversationPersonal = { ...sampleConversation, providerId: "harness" }
    assert.equal((await store.save(convKey, 2, withProvider)).ok, true)

    const reloadedStore = new PersonalStore(mock.state, ORIGIN, dir)
    const reloaded = await reloadedStore.load(convKey)
    assert.equal(reloaded.ok, true)
    if (reloaded.ok) {
      assert.equal(reloaded.value.revision, 2)
      assert.equal((reloaded.value.data as ConversationPersonal | null)?.providerId, "harness")
    }

    // 非法 providerId（空串或非字符串）必须被拒绝
    assert.equal((await store.save(convKey, 3, { ...sampleConversation, providerId: "" })).ok, false)
    assert.equal((await store.save(convKey, 3, { ...sampleConversation, providerId: 123 as unknown as string })).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("本人改名与个人视图并发保存，重启后两个改动均保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc234-personal-title-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const key = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const

    assert.deepEqual(await store.load(key), { ok: true, value: { revision: 0, data: null } })
    assert.equal((await store.renameConversation(key, "   \n ")).ok, false)
    assert.equal((await store.renameConversation(key, "字".repeat(81))).ok, false)
    const [renamed, saved] = await Promise.all([
      store.renameConversation(key, "  本机\t\n标题  "),
      store.save(key, 1, sampleConversation),
    ])
    assert.deepEqual(renamed, { ok: true, value: "本机 标题" })
    assert.equal(saved.ok, true)
    assert.equal((await store.save(key, 2, { ...sampleConversation, customTitle: "越过改名入口" })).ok, false)

    const reopened = new PersonalStore(mock.state, ORIGIN, dir)
    assert.deepEqual(await reopened.load(key), {
      ok: true, value: { revision: 1, data: { ...sampleConversation, customTitle: "本机 标题" } },
    })
    assert.equal((await reopened.save(key, 2, { ...sampleConversation, expandedTools: ["tool"] })).ok, true)
    const persisted = new PersonalStore(mock.state, ORIGIN, dir)
    assert.deepEqual(await persisted.load(key), {
      ok: true, value: { revision: 2, data: { ...sampleConversation, expandedTools: ["tool"], customTitle: "本机 标题" } },
    })

    mock.setIdentity({ generation: 2, accountId: USER_B, workspaces: [WORKSPACE_ID] })
    assert.equal((await reopened.load(key)).ok, true)
    assert.equal((await reopened.renameConversation(key, "队友伪造标题")).ok, false)
    assert.equal((await reopened.save(key, 1, { ...sampleConversation, customTitle: "队友伪造标题" })).ok, false)
    assert.equal((await reopened.save(key, 1, sampleConversation)).ok, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("先改名的空记录以原修订接收首份个人视图，改名写入失败时仍读取旧标题", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc234-title-first-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const key = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    assert.deepEqual(await store.renameConversation(key, "首个标题"), { ok: true, value: "首个标题" })
    const reopened = new PersonalStore(mock.state, ORIGIN, dir)
    const initial = await reopened.load(key)
    assert.equal(initial.ok && initial.value.revision, 0)
    assert.equal(initial.ok && (initial.value.data as ConversationPersonal).customTitle, "首个标题")
    assert.equal((await reopened.save(key, 1, sampleConversation)).ok, true)

    const root = join(dir, "personal-view-v2")
    await rename(root, join(dir, "moved"))
    await writeFile(root, "模拟保存路径不可用")
    assert.equal((await reopened.renameConversation(key, "写入失败的标题")).ok, false)
    assert.deepEqual(await reopened.load(key), {
      ok: true, value: { revision: 1, data: { ...sampleConversation, customTitle: "首个标题" } },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
