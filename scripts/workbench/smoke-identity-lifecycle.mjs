/** 真实身份并发冒烟：仅传输闸门延迟旧响应，状态/网络实现均来自生产编译结果。 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { CollaborationState } from "../../apps/desktop/dist/lifecycle/src/main/collaboration-state.js"
import { verifyDesktopSource } from "../../apps/desktop/dist/lifecycle/src/main/trusted-source.js"

const origin = process.env.HC194_SMOKE_ORIGIN
assert(origin, "必须提供本轮origin")
let checks = 0
const checked = check => { checks++; console.log(JSON.stringify({ check, ok: true })) }
const value = result => { assert(result.ok, result.ok ? "" : `业务失败 ${result.error.code}`); return result.value }
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("闸门未就绪")), 10000) })]) }
  finally { clearTimeout(timer) }
}

const mainFrame = { url: "file:///trusted/index.html" }, contents = { mainFrame }
const window = { isDestroyed: () => false, webContents: contents }
verifyDesktopSource(window, mainFrame.url, { sender: contents, senderFrame: mainFrame })
for (const event of [{ sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: { url: mainFrame.url } }, { sender: contents, senderFrame: { url: "https://untrusted.invalid" } }]) assert.throws(() => verifyDesktopSource(window, mainFrame.url, event))
const absent = new CollaborationState()
assert.equal(value(await absent.getState()).status, "connectionError")
assert.equal((await absent.listDemoUsers()).ok, false)
absent.dispose()
checked("shared-window-source-and-unconfigured-state")

for (const kind of ["members", "member-error", "login", "csrf", "me"]) {
  let release, enter, gateUsed = false, postedUser01 = false
  const waiting = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const traces = [], events = []
  const identity = new CollaborationState(origin, async (url, init) => {
    const path = new URL(url).pathname
    traces.push({ path, cookie: init.headers.Cookie }) // 仅内存断言，绝不输出Cookie。
    const user01 = path.endsWith("demo-login") && JSON.parse(init.body).username === "user01"
    if (user01) postedUser01 = true
    const hold = !gateUsed && ((kind.startsWith("member") && path.endsWith("/members")) || (kind === "login" && user01) || (kind === "csrf" && postedUser01 && path.endsWith("/csrf")) || (kind === "me" && postedUser01 && path.endsWith("/me")))
    const response = await fetch(url, init)
    if (!hold) return response
    gateUsed = true
    const bytes = await response.arrayBuffer(), headers = new Headers(response.headers)
    // 故意携带旧账号Cookie，证明迟到的响应头也不能更新新Jar。
    if (init.headers.Cookie) headers.append("Set-Cookie", `${init.headers.Cookie}; Path=/; HttpOnly; SameSite=Strict`)
    enter(); await gate
    if (kind === "member-error") return new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "服务连接暂不可用", requestId: randomUUID(), retryable: true } }), { status: 503, headers })
    return new Response(bytes, { status: response.status, headers })
  })
  const unsubscribe = identity.onStateChanged(state => events.push(state))
  try {
    let old
    if (kind.startsWith("member")) {
      const me = value(await identity.signIn("user01"))
      old = identity.listMembers(me.workspaces[0].id)
    } else old = identity.signIn("user01")
    await bounded(waiting)
    const exiting = identity.signOut()
    assert.equal((await identity.listMembers("99999999-9999-4999-8999-999999999999")).ok, false, "退出开始立即阻止业务")
    await exiting // 挂起登录时远端退出可能403；本地隔离必须完成。
    const next = value(await identity.signIn("user02"))
    const workspace = next.workspaces[0].id
    const fresh = value(await identity.listMembers(workspace))
    const newCookie = traces.at(-1).cookie
    assert(newCookie, "新账号必须使用自己的会话")
    const requestsBefore = traces.length, notificationsBefore = events.length
    release()
    assert.equal((await bounded(old)).ok, false, "旧代响应不得交付业务数据")
    assert.equal(traces.length, requestsBefore, "迟到登录不得继续在新Jar上取csrf/me")
    assert.equal(events.length, notificationsBefore, "迟到成功/错误不得发布身份")
    assert.equal(value(await identity.getState()).user.username, "user02")
    assert.deepEqual(value(await identity.listMembers(workspace)), fresh)
    assert(traces.at(-1).cookie === newCookie, "旧Set-Cookie不得覆盖新Jar")
    value(await identity.signOut())
    checked(`late-${kind}-cannot-change-new-user-cookie-or-state`)
  } finally { release(); unsubscribe(); identity.dispose() }
}

let release, enter, notifications = 0, detached = 0
const gate = new Promise(resolve => { release = resolve }), waiting = new Promise(resolve => { enter = resolve })
const closed = new CollaborationState(origin, async (url, init) => {
  const response = await fetch(url, init)
  if (!String(url).endsWith("/members")) return response
  const bytes = await response.arrayBuffer(); enter(); await gate
  return new Response(bytes, { status: response.status, headers: response.headers })
})
const off = closed.onStateChanged(() => notifications++)
const detach = closed.onStateChanged(() => detached++)
detach()
try {
  const first = value(await closed.signIn("user01"))
  const pending = closed.listMembers(first.workspaces[0].id)
  await bounded(waiting)
  const before = notifications
  closed.dispose(); release()
  assert.equal((await bounded(pending)).ok, false)
  assert.equal(notifications, before)
  assert.equal(detached, 0)
  assert.equal((await closed.getState()).ok, false)
  let firstCookie
  const reopened = new CollaborationState(origin, (url, init) => { firstCookie ??= { value: init.headers.Cookie }; return fetch(url, init) })
  try {
    assert.equal(value(await reopened.getState()).status, "signedOut")
    value(await reopened.signIn("user03"))
    assert(firstCookie.value === undefined, "新窗口必须从空Jar开始")
    value(await reopened.signOut())
  } finally { reopened.dispose() }
  checked("dispose-unsubscribe-and-reopen-fresh-session")
} finally { release(); off(); closed.dispose() }
console.log(JSON.stringify({ result: "passed", checks }))
