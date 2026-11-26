/**
 * HC-225 单元测试：验证 PersonalStore 权限校验的 60 秒 TTL 缓存、
 * 并发在途请求去重、身份代次切换淘汰以及授权失败清理。
 */
import assert from "node:assert/strict"
import { mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
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
import { LocalConversationStore } from "../src/main/local-conversation-store.ts"
import type { ConversationPersonal, ProjectNavigationPersonal, ProjectPersonalRecord } from "../src/shared/index.ts"

const ORIGIN = "http://127.0.0.1:9999"
const USER_A = "11111111111111111111111111111111"
const USER_B = "99999999999999999999999999999999"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"

type IdentitySnapshot = ReturnType<CollaborationState["personalIdentity"]>
type TestIdentityInput = (Omit<NonNullable<IdentitySnapshot>, "offline"> & { offline?: boolean }) | null

function normalizeTestIdentity(input: TestIdentityInput): IdentitySnapshot {
  return input ? { ...input, offline: input.offline ?? false } : null
}

function createFakeCollaborationState(initialIdentity: TestIdentityInput) {
  let identity: IdentitySnapshot = normalizeTestIdentity(initialIdentity)
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
        shareMode: "full",
        shareStatus: "active",
        stoppedAt: null,
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
    setIdentity(next: TestIdentityInput) { identity = normalizeTestIdentity(next) },
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
          shareMode: "full",
          shareStatus: "active",
          stoppedAt: null,
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
          shareMode: "full",
          shareStatus: "active",
          stoppedAt: null,
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

test("HC-237 draft.annotations 支持可选保存恢复并校验数量与长度边界", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc237-personal-annotations-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    assert.equal((await store.load(convKey)).ok, true)

    // 不含 annotations 的旧结构仍可正常保存
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, true)

    // 带 annotations（含可选 comment 与 sourceLabel）保存并重启恢复
    const withAnnotations: ConversationPersonal = {
      ...sampleConversation,
      draft: {
        ...sampleConversation.draft,
        revision: 2,
        annotations: [
          {
            id: "ann-1",
            selectedText: "const x = 1",
            comment: "这里需要确认边界",
            sourceLabel: "src/app.ts:L10-L12",
          },
          {
            id: "ann-2",
            selectedText: "时间线片段",
          },
        ],
      },
    }
    assert.equal((await store.save(convKey, 2, withAnnotations)).ok, true)

    const reopened = new PersonalStore(mock.state, ORIGIN, dir)
    const loaded = await reopened.load(convKey)
    assert.equal(loaded.ok, true)
    if (loaded.ok) {
      assert.deepEqual((loaded.value.data as ConversationPersonal).draft.annotations, withAnnotations.draft.annotations)
    }

    // 超出数量上限、单条长度上限或非法多余字段必须被拒绝
    const tooMany = Array.from({ length: 21 }, (_, idx) => ({ id: `a-${idx}`, selectedText: "x" }))
    assert.equal((await reopened.save(convKey, 3, {
      ...sampleConversation,
      draft: { ...sampleConversation.draft, annotations: tooMany },
    })).ok, false)

    assert.equal((await reopened.save(convKey, 3, {
      ...sampleConversation,
      draft: { ...sampleConversation.draft, annotations: [{ id: "a", selectedText: "字".repeat(4001) }] },
    })).ok, false)

    assert.equal((await reopened.save(convKey, 3, {
      ...sampleConversation,
      draft: { ...sampleConversation.draft, annotations: [{ id: "a", selectedText: "ok", comment: "" }] },
    })).ok, false)

    assert.equal((await reopened.save(convKey, 3, {
      ...sampleConversation,
      draft: { ...sampleConversation.draft, annotations: [{ id: "a", selectedText: "ok", comment: "评".repeat(2001) }] },
    })).ok, false)

    assert.equal((await reopened.save(convKey, 3, {
      ...sampleConversation,
      draft: { ...sampleConversation.draft, annotations: [{ id: "a", selectedText: "ok", extra: true } as unknown as { id: string; selectedText: string }] },
    })).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("HC-238 draft.images 与 sentImages 支持保存恢复并严格校验上限与多余字段", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc238-personal-images-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    assert.equal((await store.load(convKey)).ok, true)

    const sampleImg = {
      id: "pending-11111111-1111-4111-8111-111111111111",
      name: "shot.png",
      mimeType: "image/png" as const,
      sizeBytes: 2048,
      width: 800,
      height: 600,
    }
    const sentImg = {
      id: "sent-22222222-2222-4222-8222-222222222222",
      name: "sent.webp",
      mimeType: "image/webp" as const,
      sizeBytes: 4096,
    }
    const validRecord: ConversationPersonal = {
      ...sampleConversation,
      draft: {
        ...sampleConversation.draft,
        revision: 2,
        images: [sampleImg],
      },
      sentImages: {
        "12": [sentImg],
      },
    }
    assert.equal((await store.save(convKey, 1, validRecord)).ok, true)

    const reopened = new PersonalStore(mock.state, ORIGIN, dir)
    const loaded = await reopened.load(convKey)
    assert.equal(loaded.ok, true)
    if (loaded.ok) {
      const savedData = loaded.value.data as ConversationPersonal
      assert.deepEqual(savedData.draft.images, [sampleImg])
      assert.deepEqual(savedData.sentImages, { "12": [sentImg] })
    }

    // 渲染层临时字段 previewUrl / status 必须被 schema 拒绝，防止写入 Store
    assert.equal((await reopened.save(convKey, 2, {
      ...validRecord,
      draft: {
        ...validRecord.draft,
        images: [{ ...sampleImg, previewUrl: "blob:leak", status: "ready" } as unknown as typeof sampleImg],
      },
    })).ok, false)

    // 超出单轮 6 张上限拒绝保存
    assert.equal((await reopened.save(convKey, 2, {
      ...validRecord,
      draft: {
        ...validRecord.draft,
        images: Array.from({ length: 7 }, (_, i) => ({
          ...sampleImg,
          id: `pending-${String(i).repeat(8).slice(0, 8)}-1111-4111-8111-111111111111`,
        })),
      },
    })).ok, false)

    // 非法 sentImages 序号键或超出 50 条上限必须拒绝
    assert.equal((await reopened.save(convKey, 2, {
      ...validRecord,
      sentImages: { "0": [sentImg] },
    })).ok, false)
    assert.equal((await reopened.save(convKey, 2, {
      ...validRecord,
      sentImages: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i + 1), [sentImg]])),
    })).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("HC-239 PersonalStore 支持 AccountPersonal.activeView 与个人会话发布前后纯本机连续授权", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc239-personal-local-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID], offline: true })
    const localConversations = new LocalConversationStore(dir, ORIGIN)
    const store = new PersonalStore(mock.state, ORIGIN, dir, localConversations)

    const accountRes = await store.load({ kind: "account" })
    assert.equal(accountRes.ok, true)
    assert.equal((await store.save({ kind: "account" }, 1, { workspaceId: null, activeView: "solo" })).ok, true)

    const created = await localConversations.create(USER_A, { workspaceId: null, title: "离线个人草稿测试" })
    assert.equal(created.ok, true)
    if (!created.ok) return
    const convId = created.value.conversationId

    // 未发布会话（workspaceId: null, projectId: null）在断网下通过 LocalConversationStore 纯本机鉴权，零云端请求
    const soloKey = { kind: "conversation", workspaceId: null, projectId: null, conversationId: convId } as const
    const soloLoad = await store.load(soloKey)
    assert.equal(soloLoad.ok, true)
    assert.equal(mock.counts().getConversationCalls, 0)

    const saved = await store.save(soloKey, 1, {
      ...sampleConversation,
      localDirectoryPath: "/tmp/local-repo",
      draft: { ...sampleConversation.draft, text: "发布前已输入草稿", revision: 1 },
    })
    assert.equal(saved.ok, true)

    // 未加入目标团队时的非法匹配必须拒绝
    const wrongWorkspaceKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: null, conversationId: convId } as const
    assert.equal((await store.load(wrongWorkspaceKey)).ok, false)

    // 发布到 Project 后改用带 workspaceId/projectId 的 key 读取：无需再调云端且草稿与目录路径连续保留
    await localConversations.markPublished(USER_A, convId, {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      shareMode: "summary_only",
    })
    const publishedKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: convId } as const
    const publishedLoad = await new PersonalStore(mock.state, ORIGIN, dir, localConversations).load(publishedKey)
    assert.equal(publishedLoad.ok, true)
    assert.equal(mock.counts().getConversationCalls, 0)
    if (publishedLoad.ok) {
      const data = publishedLoad.value.data as ConversationPersonal
      assert.equal(data.localDirectoryPath, "/tmp/local-repo")
      assert.equal(data.draft.text, "发布前已输入草稿")
    }

    // 已发布到 Project 后，再以 projectId: null 读取应拒绝（要求走已绑定 Project 作用域）
    assert.equal((await new PersonalStore(mock.state, ORIGIN, dir, localConversations).load(wrongWorkspaceKey)).ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test("PersonalStore.removeConversation 删除会话三类文件并使内存缓存失效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc257-personal-remove-"))
  try {
    const mock = createFakeCollaborationState({ generation: 1, accountId: USER_A, workspaces: [WORKSPACE_ID] })
    const store = new PersonalStore(mock.state, ORIGIN, dir)
    const convKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    const panelKey = { kind: "sessionWorkspace", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID } as const
    const scope = { accountId: USER_A, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: CONV_ID }
    const otherConvId = "55555555-5555-4555-8555-555555555555"
    const otherKey = { kind: "conversation", workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, conversationId: otherConvId } as const
    const requestId = "44444444-4444-4444-8444-444444444444"

    const panelData: ProjectPersonalRecord = {
      personal: {
        view: {
          dockOpen: true,
          dockWidthPx: 320,
          panel: "files",
          selectedPath: null,
          fileTabs: [],
          activeFilePath: null,
          selectedChanges: [],
          commitMessage: "",
        },
        expanded: [],
        centralPaths: [],
        activeCentral: null,
        diffPath: null,
      },
      positions: [],
    }
    // save 依赖已确认授权缓存，先经 load 完成授权再写入
    assert.equal((await store.load(convKey)).ok, true)
    assert.equal((await store.load(panelKey)).ok, true)
    assert.equal((await store.load(otherKey)).ok, true)
    assert.equal((await store.save(convKey, 1, sampleConversation)).ok, true)
    assert.equal((await store.save(panelKey, 1, panelData)).ok, true)
    assert.equal((await store.save(otherKey, 1, sampleConversation)).ok, true)
    const queued = await store.conversationPromptQueue(scope, {
      items: [{ requestId, text: "待发消息", referenceIds: [], attachments: [] }],
    })
    assert.equal(queued.ok, true)
    assert.equal((await readdir(join(dir, "personal-view-v2"))).length, 4)

    await store.removeConversation(USER_A, CONV_ID)

    // 只剩另一个会话的文件；同键 load 返回空记录，另一会话不受影响
    assert.equal((await readdir(join(dir, "personal-view-v2"))).length, 1)
    assert.deepEqual(await store.load(convKey), { ok: true, value: { revision: 0, data: null } })
    assert.deepEqual(await store.load(panelKey), { ok: true, value: { revision: 0, data: null } })
    assert.deepEqual(await store.conversationPromptQueue(scope), { ok: true, value: { items: [] } })
    const kept = await store.load(otherKey)
    assert.equal(kept.ok && kept.value.revision, 1)

    // 幂等：重复删除与缺失文件都不报错
    await store.removeConversation(USER_A, CONV_ID)
    await store.removeConversation(USER_A, "66666666-6666-4666-8666-666666666666")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
