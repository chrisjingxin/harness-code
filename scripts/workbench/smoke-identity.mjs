/** 真实身份冒烟：只调用 main 的生产客户端；父进程通过 stdin 协调隔离 DB/Java 生命周期。
 * 原始 Cookie/token 只用于内存中的失效负例；输出只有检查名称和成功标记。
 */
import assert from "node:assert/strict"
import { createInterface } from "node:readline"
import { CollaborationClient } from "../../apps/desktop/src/main/collaboration-client.ts"

const origin = process.env.HC194_SMOKE_ORIGIN
assert(origin, "必须显式提供本轮服务 origin")
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const report = value => process.stdout.write(JSON.stringify(value) + "\n")
let checks = 0
const checked = name => { checks++; report({ check: name, ok: true }) }
async function control(command) {
  report({ control: command })
  const line = await input.next()
  assert(!line.done && JSON.parse(line.value).ok === true, "隔离进程控制失败")
}
function value(result) { assert(result.ok, result.ok ? "" : `业务失败 ${result.error.code}`); return result.value }
function error(result, code) { assert(!result.ok, "预期安全错误"); assert.equal(result.error.code, code) }
async function negative(path, { cookie, token, method = "GET" } = {}) {
  const headers = { Origin: origin, "X-Workbench-Protocol-Version": "1" }
  if (cookie) headers.Cookie = cookie
  if (token) headers["X-CSRF-TOKEN"] = token
  const response = await fetch(origin + path, { method, headers, redirect: "manual" })
  const data = await response.json()
  return { status: response.status, code: data.error?.code }
}

try {
  const client = new CollaborationClient(origin)
  error(await client.getCurrentUser(), "AUTHENTICATION_REQUIRED")
  assert.deepEqual(value(await client.listDemoUsers()).users.map(u => u.username), ["user01", "user02", "user03"])
  checked("anonymous-and-preset-users")
  let workspace, originalUser
  for (const username of ["user01", "user02", "user03"]) {
    const me = value(await client.signIn(username))
    assert.equal(me.user.username, username)
    workspace ??= me.workspaces[0].id
    originalUser ??= me.user.id
    assert.equal(value(await client.getCurrentUser()).user.id, me.user.id)
    assert.equal(value(await client.listWorkspaces()).workspaces[0].id, workspace)
    assert.equal(value(await client.listMembers(workspace)).members.length, 3)
    value(await client.signOut())
    error(await client.getCurrentUser(), "AUTHENTICATION_REQUIRED")
    checked(`real-login-me-workspace-members-logout-${username}`)
  }
  error(await client.signIn("missing01"), "DEMO_LOGIN_REJECTED")
  error(await client.signIn("User01"), "INVALID_REQUEST")
  await control("disable-user03")
  error(await client.signIn("user03"), "DEMO_LOGIN_REJECTED")
  assert.deepEqual(value(await client.listDemoUsers()).users.map(u => u.username), ["user01", "user02"])
  await control("restore-user03")
  value(await client.signIn("user03"))
  await control("disable-user03")
  error(await client.getCurrentUser(), "AUTHENTICATION_REQUIRED")
  await control("restore-user03")
  checked("unknown-disabled-and-current-user-revalidation")
  await control("remove-member03")
  assert.equal(value(await client.signIn("user03")).workspaces.length, 0)
  error(await client.listMembers(workspace), "RESOURCE_NOT_FOUND")
  error(await client.listMembers("99999999-9999-4999-8999-999999999999"), "RESOURCE_NOT_FOUND")
  error(await client.listMembers("invalid"), "INVALID_REQUEST")
  await control("restore-member03")
  assert.equal(value(await client.listMembers(workspace)).members.length, 3)
  value(await client.signOut())
  checked("member-removal-no-implicit-rejoin-and-404")

  let loginPosts = 0, logoutPosts = 0, preCookie, preToken, liveCookie, oldHeader = false
  const traced = new CollaborationClient(origin, async (url, init) => {
    assert.equal(init.redirect, "manual")
    if (String(url).endsWith("/demo-login")) { loginPosts++; preCookie = init.headers.Cookie; preToken = init.headers["X-CSRF-TOKEN"] }
    if (loginPosts && String(url).endsWith("/csrf")) liveCookie = init.headers.Cookie
    if (String(url).endsWith("/logout")) {
      logoutPosts++
      if (oldHeader) init.headers["X-CSRF-TOKEN"] = preToken
    }
    return fetch(url, init)
  })
  value(await traced.signIn("user01"))
  assert(preCookie && liveCookie && preCookie !== liveCookie, "登录必须轮换会话ID")
  const before = await negative("/api/v1/auth/me", { cookie: preCookie })
  assert.equal(before.status, 401)
  assert.equal(value(await traced.getCurrentUser()).user.id, originalUser)
  error(await traced.signIn("user02"), "ALREADY_AUTHENTICATED")
  assert.equal(value(await traced.getCurrentUser()).user.username, "user01")
  // 第二次被拒登录会更新探针变量，重新用首次匿名token验证旧token失效。
  const loggedOutCookie = liveCookie
  value(await traced.signOut())
  assert.equal((await negative("/api/v1/auth/me", { cookie: loggedOutCookie })).status, 401, "成功退出必须使原服务会话失效")
  loginPosts = 0
  value(await traced.signIn("user01"))
  oldHeader = true
  const priorPosts = logoutPosts
  error(await traced.signOut(), "CSRF_INVALID")
  assert.equal(logoutPosts, priorPosts + 1, "错误CSRF不能自动重放退出")
  oldHeader = false
  error(await traced.getCurrentUser(), "AUTHENTICATION_REQUIRED")
  assert.equal((await negative("/api/v1/auth/me", { cookie: liveCookie })).status, 200, "本机退出失败不能冒称服务端撤销")
  checked("session-id-rotation-old-token-and-no-write-replay")

  let omit = true
  const noToken = new CollaborationClient(origin, (url, init) => {
    if (omit && String(url).endsWith("/demo-login")) delete init.headers["X-CSRF-TOKEN"]
    return fetch(url, init)
  })
  error(await noToken.signIn("user01"), "CSRF_INVALID")
  omit = false
  value(await noToken.signIn("user01"))
  value(await noToken.signOut())
  checked("missing-csrf-refresh-and-explicit-retry")

  let alter = "origin"
  const invalid = new CollaborationClient(origin, (url, init) => {
    if (alter === "origin") init.headers.Origin = "https://untrusted.invalid"
    if (alter === "version") init.headers["X-Workbench-Protocol-Version"] = "2"
    if (String(url).endsWith("/demo-login")) {
      if (alter === "extra") init.body = JSON.stringify({ username: "user01", userId: originalUser })
      if (alter === "json") init.body = '{"username":'
      if (alter === "media") init.headers["Content-Type"] = "text/plain"
      if (alter === "size") init.body = "x".repeat(16385)
    }
    return fetch(url, init)
  })
  error(await invalid.getMeta(), "REQUEST_SOURCE_REJECTED")
  alter = "version"; error(await invalid.getMeta(), "PROTOCOL_VERSION_UNSUPPORTED")
  for (const [kind, code] of [["extra", "INVALID_REQUEST"], ["json", "INVALID_REQUEST"], ["media", "UNSUPPORTED_MEDIA_TYPE"], ["size", "PAYLOAD_TOO_LARGE"]]) {
    alter = kind; error(await invalid.signIn("user01"), code)
  }
  checked("origin-version-json-media-size-and-actor-rejection")

  let dropped = false, attempts = 0
  const uncertain = new CollaborationClient(origin, async (url, init) => {
    const response = await fetch(url, init)
    if (String(url).endsWith("/demo-login")) {
      attempts++
      if (!dropped) {
        dropped = true
        await response.body.cancel()
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("simulated-response-loss")) } }), { status: 200, headers: response.headers })
      }
    }
    return response
  })
  value(await uncertain.signIn("user02"))
  assert.equal(attempts, 1, "登录响应丢失不能重发登录")
  value(await uncertain.signOut())
  checked("lost-login-body-confirmed-with-same-jar-me")

  value(await client.signIn("user01"))
  await control("stop-db")
  error(await client.getCurrentUser(), "SERVICE_UNAVAILABLE")
  await control("start-db")
  assert.equal(value(await client.getCurrentUser()).user.id, originalUser)
  checked("database-down-503-session-retained-and-recovered")
  await control("stop-java")
  error(await client.getCurrentUser(), "NETWORK_UNAVAILABLE")
  await control("start-java")
  error(await client.getCurrentUser(), "AUTHENTICATION_REQUIRED")
  const afterRestart = value(await client.signIn("user01"))
  assert.equal(afterRestart.user.id, originalUser)
  assert.equal(afterRestart.workspaces[0].id, workspace)
  value(await client.signOut())
  checked("real-connection-failure-java-restart-relogin-stable-data")

  let fail = false
  const offline = new CollaborationClient(origin, (url, init) => {
    if (fail && String(url).endsWith("/logout")) throw new TypeError("simulated-disconnect")
    return fetch(url, init)
  })
  value(await offline.signIn("user01"))
  fail = true
  const out = await offline.signOut()
  error(out, "NETWORK_UNAVAILABLE")
  assert(out.error.message.includes("本机已退出") && out.error.message.includes("未确认"))
  fail = false
  error(await offline.getCurrentUser(), "AUTHENTICATION_REQUIRED")
  assert.equal(value(await offline.signIn("user02")).user.username, "user02")
  value(await offline.signOut())
  checked("failed-logout-clears-only-local-credentials")

  const redirected = new CollaborationClient(origin, async () => new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid" } }))
  error(await redirected.getMeta(), "INVALID_SERVER_RESPONSE")
  const widened = new CollaborationClient(origin, async (url, init) => {
    const response = await fetch(url, init)
    const headers = new Headers(response.headers)
    headers.append("Set-Cookie", "WBSESSION=fixture; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Strict")
    return new Response(response.body, { status: response.status, headers })
  })
  error(await widened.listDemoUsers(), "INVALID_SERVER_RESPONSE")
  checked("redirect-and-cookie-domain-widening-rejected")
  report({ result: "passed", checks })
} finally { await input.return?.() }
