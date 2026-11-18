/**
 * HC-225 单元测试：验证 PersonalStore 权限校验的 60 秒 TTL 缓存、
 * 并发在途请求去重、身份代次切换淘汰以及授权失败清理。
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  CollaborationResult,
  ConversationDetailResponse,
  ProjectDetailResponse,
} from "@workbench/contracts"
import type { CollaborationState } from "../src/main/collaboration-state.ts"
import { PersonalStore } from "../src/main/personal-store.ts"
import type { ConversationPersonal, ProjectNavigationPersonal } from "../src/personal-host.ts"

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

  const state = {
    personalIdentity: () => identity,
    async getProject(workspaceId: string, projectId: string) {
      getProjectCalls++
      return getProjectImpl(workspaceId, projectId)
    },
    async getProjectConversation(workspaceId: string, projectId: string, conversationId: string) {
      getConversationCalls++
      return getConversationImpl(workspaceId, projectId, conversationId)
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

test("PersonalStore 在 60 秒 TTL 内复用已校验授权，到期后重新向服务端核验", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hc225-personal-ttl-"))
  try {
    let nowMs = 1_700_000_000_000
    t.mock.method(Date, "now", () => nowMs)

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

test("PersonalStore 在身份代次变化、权限失效或过期撤销时淘汰缓存", async t => {
  const dir = await mkdtemp(join(tmpdir(), "hc225-personal-evict-"))
  try {
    let nowMs = 1_700_000_000_000
    t.mock.method(Date, "now", () => nowMs)

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
    await rm(dir, { recursive: true, force: true })
  }
})
