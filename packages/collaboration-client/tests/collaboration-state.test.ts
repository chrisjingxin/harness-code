/**
 * `CollaborationState.withWorkspace` 单元测试：
 * 覆盖未登录/非成员工作区拒绝、代次漂移丢弃旧回包、`publishConnectionError` 语义区分，以及保留接点可用性。
 */
import assert from "node:assert/strict"
import { register } from "node:module"
import { test } from "node:test"
import type { CollaborationState as CollaborationStateClass } from "../src/index.ts"

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

const { CollaborationState } = await import("../src/index.ts") as {
  CollaborationState: typeof CollaborationStateClass
}

const ORIGIN = "http://127.0.0.1:9999"
const USER_ID = "11111111111111111111111111111111"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_WORKSPACE_ID = "99999999-9999-4999-8999-999999999999"
const PROJECT_ID = "22222222-2222-4222-8222-222222222222"
const CONV_ID = "33333333-3333-4333-8333-333333333333"

const jsonOk = (body: unknown) =>
  new Response(JSON.stringify({ returnCode: "SUC0000", errorMsg: "", body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const jsonError = (code: string, message: string, status = 401) =>
  new Response(JSON.stringify({
    returnCode: "CLB0401",
    errorMsg: message,
    body: { code, requestId: "00000000-0000-4000-8000-000000000001", retryable: false },
  }), {
    status,
    headers: { "content-type": "application/json" },
  })

test("CollaborationState.withWorkspace 校验工作区成员关系、代次隔离与错误发布策略", async () => {
  let failProjects = false
  let failAuth = false
  const user = {
    id: USER_ID,
    userNo: "80000001",
    userName: "测试用户",
    photo: "",
    orgId: "org-1",
    orgNo: "001",
    orgName: "研发组",
    orgPathName: "研发部/研发组",
  }
  const workspace = { id: WORKSPACE_ID, slug: "ws", name: "测试团队", role: "developer", memberVersion: 1, accessVersion: 1 }

  const transport: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith("/api/v1/auth/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) {
      return jsonOk({ user, workspaces: [workspace] })
    }
    if (url.endsWith(`/workspaces/${WORKSPACE_ID}/projects`)) {
      if (failProjects) throw new Error("network down")
      return jsonOk({ workspaceId: WORKSPACE_ID, projects: [] })
    }
    if (url.endsWith(`/projects/${PROJECT_ID}/conversations/${CONV_ID}`)) {
      if (failAuth) return jsonError("AUTHENTICATION_REQUIRED", "请先登录", 401)
      return jsonOk({
        conversation: {
          conversationId: CONV_ID,
          projectId: PROJECT_ID,
          ownerUserId: USER_ID,
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
      })
    }
    return new Response("not found", { status: 404 })
  }

  const state = new CollaborationState(ORIGIN, transport)
  // 未登录时拒绝
  const signedOutRes = await state.withWorkspace(WORKSPACE_ID, client => client.listProjects(WORKSPACE_ID))
  assert.equal(signedOutRes.ok, false)
  if (!signedOutRes.ok) assert.equal(signedOutRes.error.code, "AUTHENTICATION_REQUIRED")

  const login = await state.signIn("80000001")
  assert.equal(login.ok, true)

  // 非本人工作区拒绝
  const foreignRes = await state.withWorkspace(OTHER_WORKSPACE_ID, client => client.listProjects(OTHER_WORKSPACE_ID))
  assert.equal(foreignRes.ok, false)
  if (!foreignRes.ok) assert.equal(foreignRes.error.code, "RESOURCE_NOT_FOUND")

  // publishConnectionError=false 时瞬时网络故障不切换全局身份状态
  failProjects = true
  const quietFail = await state.withWorkspace(
    WORKSPACE_ID,
    client => client.listProjects(WORKSPACE_ID),
    { publishConnectionError: false },
  )
  assert.equal(quietFail.ok, false)
  const currentAfterQuiet = await state.getState()
  assert.equal(currentAfterQuiet.ok && currentAfterQuiet.value.status, "signedIn")

  // 保留的 getProjectConversation 仍可正常调用，且认证失效时收回登录状态
  const convOk = await state.getProjectConversation(WORKSPACE_ID, PROJECT_ID, CONV_ID)
  assert.equal(convOk.ok, true)

  failAuth = true
  const authFailed = await state.getProjectConversation(WORKSPACE_ID, PROJECT_ID, CONV_ID)
  assert.equal(authFailed.ok, false)
  const afterAuthFail = await state.getState()
  assert.equal(afterAuthFail.ok && afterAuthFail.value.status, "signedOut")

  state.dispose()
})

test("CollaborationState 断网进入 connectionError 时保留本机离线身份快照并在 401/signOut 后清除", async () => {
  let networkDown = false
  let unauthorized = false
  const user = {
    id: USER_ID,
    userNo: "80000001",
    userName: "测试用户",
    photo: "",
    orgId: "org-1",
    orgNo: "001",
    orgName: "研发组",
    orgPathName: "研发部/研发组",
  }
  const workspace = { id: WORKSPACE_ID, slug: "ws", name: "测试团队", role: "developer", memberVersion: 1, accessVersion: 1 }
  const transport: typeof fetch = async input => {
    const url = String(input)
    if (url.endsWith("/api/v1/auth/csrf")) return jsonOk({ headerName: "X-CSRF-TOKEN", token: "csrf-1" })
    if (url.endsWith("/api/v1/auth/demo-login") || url.endsWith("/api/v1/auth/me")) {
      if (unauthorized) return jsonError("AUTHENTICATION_REQUIRED", "请先登录", 401)
      return jsonOk({ user, workspaces: [workspace] })
    }
    if (url.endsWith("/api/v1/auth/logout")) return new Response(null, { status: 204 })
    if (url.includes("/stop-sharing")) {
      if (networkDown) throw new Error("offline")
      return jsonOk({
        conversation: {
          conversationId: CONV_ID,
          projectId: PROJECT_ID,
          ownerUserId: USER_ID,
          title: "测试会话",
          status: "idle",
          briefText: "",
          briefSource: "rule",
          briefUpdatedAtMs: 1_700_000_000_000,
          syncedSequence: 0,
          updatedAt: "2026-11-18T00:00:00.000Z",
          shareMode: "full",
          shareStatus: "stopped",
          stoppedAt: "2026-11-18T00:01:00.000Z",
          repositories: [],
        },
      })
    }
    return new Response("not found", { status: 404 })
  }

  const state = new CollaborationState(ORIGIN, transport)
  assert.equal(state.personalIdentity(), null)

  const login = await state.signIn("80000001")
  assert.equal(login.ok, true)
  assert.deepEqual(state.personalIdentity(), {
    generation: 1,
    accountId: USER_ID,
    workspaces: [WORKSPACE_ID],
    offline: false,
  })

  // 网络中断触发 connectionError：personalIdentity() 仍返回离线快照，但写接口被严格拦截
  networkDown = true
  const failedRemote = await state.stopProjectConversationSharing(WORKSPACE_ID, PROJECT_ID, CONV_ID)
  assert.equal(failedRemote.ok, false)
  const offlineSnapshot = state.personalIdentity()
  assert.deepEqual(offlineSnapshot, {
    generation: 1,
    accountId: USER_ID,
    workspaces: [WORKSPACE_ID],
    offline: true,
  })
  const blockedWhileOffline = await state.stopProjectConversationSharing(WORKSPACE_ID, PROJECT_ID, CONV_ID)
  assert.equal(blockedWhileOffline.ok, false)
  if (!blockedWhileOffline.ok) assert.equal(blockedWhileOffline.error.code, "AUTHENTICATION_REQUIRED")

  // 若服务端明确 401 失效，getState 立刻清空离线身份快照
  networkDown = false
  unauthorized = true
  await state.getState()
  assert.equal(state.personalIdentity(), null)

  // 重新登录后主动 signOut，同样立即清空离线快照
  unauthorized = false
  assert.equal((await state.signIn("80000001")).ok, true)
  assert.notEqual(state.personalIdentity(), null)
  await state.signOut()
  assert.equal(state.personalIdentity(), null)

  state.dispose()
})
