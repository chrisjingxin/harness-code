/** 双设备冒烟。DevTools 操作已构建窗口，并从 Java 访问日志核对实际请求。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as pause } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const desktop = join(repo, "desktop")
const binary = join(repo, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const python = resolve(process.env.HC218_SMOKE_PYTHON)
const [origin, run] = process.argv.slice(2)
assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
const actors = ["A", "B"].map((key, index) => ({
  key,
  userNo: String(80278667 + index),
  profile: join(run, key, "profile"),
  cwd: join(run, key, "workspace"),
  configHome: join(run, key, "agent"),
  temp: join(run, key, "tmp"),
}))
const [a, b] = actors
const projectName = "零售核心架构演进"
const projectId = "00000000-0000-4000-8000-0000000000a1"
const newTitle = "双端联调 " + randomUUID().slice(0, 8)
const prompt = "回答一句测试文本。不要使用工具。"
const actions = process.env.HC197_SMOKE_ACTIONS === "1"
const deniedPrompt = "HC197: request a disposable file and deny it."
const resumePrompt = "HC197: continue the same native session."
const cancelPrompt = "HC197: stream until the user clicks stop."
const answer = "Hello from dual desktop."
const fixtureBrief = "本轮双设备冒烟已生成两条定稿消息"
const readOnly = "Array.from(document.querySelectorAll('.wb-composer-textarea, [aria-label=发送消息]')).every(control => control.disabled || !control.getClientRects().length)"
const evidence = { origin, title: newTitle, projectId }
let restoredModelContext = false

const model = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end()
    return
  }
  try {
    const input = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8"))
    if (!input.stream) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        id: "dual-title", object: "chat.completion", created: 0, model: "dual-local-model",
        choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }],
      }))
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const frame = (delta, finish_reason = null) => !res.destroyed && res.write("data: " + JSON.stringify({
      id: "dual-text", object: "chat.completion.chunk", created: 0, model: "dual-local-model",
      choices: [{ index: 0, delta, finish_reason }],
    }) + "\n\n")
    const userIndex = input.messages.findLastIndex(message => message.role === "user")
    const latest = input.messages[userIndex]?.content
    if (latest === resumePrompt) {
      restoredModelContext = input.messages.slice(0, userIndex).some(message => message.role === "user" && message.content === prompt)
    }
    if (actions && (latest === deniedPrompt || latest === prompt)
      && !input.messages.slice(userIndex + 1).some(message => message.role === "tool")) {
      const filename = latest === deniedPrompt ? "deny-smoke.txt" : "allow-smoke.txt"
      frame({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + filename,
        type: "function", function: { name: "write_file", arguments: JSON.stringify({ file_path: "/" + filename, content: "local smoke" }) } }] })
      frame({}, "tool_calls")
      res.end("data: [DONE]\n\n")
      return
    }
    frame({ role: "assistant", content: latest === cancelPrompt ? "Interrupted" : "Hello" })
    if (latest === cancelPrompt) {
      // 保持模型流打开直到收到停止；即使停止通知失败，最多等待这一个定时器。
      await Promise.race([once(res, "close"), pause(12_000)])
      if (!res.destroyed) res.end()
      return
    }
    await pause(250)
    frame({ content: answer.slice("Hello".length) })
    await pause(250)
    frame({}, "stop")
    res.end("data: [DONE]\n\n")
  } catch {
    if (!res.headersSent) res.writeHead(400)
    res.end()
  }
})
model.listen(0, "127.0.0.1")
await once(model, "listening")
const modelOrigin = "http://127.0.0.1:" + model.address().port

async function prepare(actor) {
  const agentConfig = join(actor.configHome, ".harness")
  await Promise.all([actor.cwd, agentConfig, actor.temp].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  await writeFile(join(agentConfig, "config.toml"), [
    "[config]", "version = 1", ...(actions ? ["[approval]", 'mode = "default"'] : []), "[models]", 'default_profile = "smoke"', "[models.profiles.smoke]",
    'provider = "openai-compatible"', 'model = "dual-local-model"', 'base_url = "' + modelOrigin + '/v1"',
    'api_key_env = "DUAL_LOOPBACK_KEY"', "context_window_tokens = 128000",
    'capabilities = ["tool-calling", "streaming"]',
  ].join("\n"))
}
const agentEntry = [
  "import asyncio, os",
  "from pathlib import Path",
  "from harness_agent.host.acp.stdio import claim_protocol_fds, run_acp_stdio",
  "protocol = claim_protocol_fds()",
  "from harness_agent.host.agent_host import AgentHost",
  "async def run():",
  "    host = AgentHost(workspace=Path.cwd(), config_home=Path(os.environ['DUAL_AGENT_CONFIG_HOME']), allow_echo=False)",
  "    return await run_acp_stdio(host, fds=protocol)",
  "raise SystemExit(asyncio.run(run()))",
].join("\n")
const electron = "process.getBuiltinModule('module').createRequire(" + JSON.stringify(join(desktop, "package.json")) + ")('electron')"

async function connect(url) {
  const ws = new WebSocket(url)
  await once(ws, "open")
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const reply = JSON.parse(event.data)
    const handler = pending.get(reply.id)
    if (!handler) return
    pending.delete(reply.id)
    if (reply.error) handler.reject(Error(reply.error.message))
    else handler.resolve(reply.result)
  }
  return {
    call(method, params) {
      const request = { id: ++id, method, params }
      let timeout
      return new Promise((resolve, reject) => {
        pending.set(request.id, { resolve, reject })
        timeout = setTimeout(() => reject(Error("DevTools timeout: " + method)), 10_000)
        ws.send(JSON.stringify(request))
      }).finally(() => { clearTimeout(timeout); pending.delete(request.id) })
    },
    async evaluate(expression) {
      const reply = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
      if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails))
      return reply.result.value
    },
    close() { ws.close() },
  }
}
async function start(actor) {
  const env = {
    PATH: process.env.PATH,
    WORKBENCH_SERVICE_ORIGIN: origin, WORKBENCH_ACP_EXECUTABLE: python,
    WORKBENCH_ACP_ARGS_JSON: JSON.stringify(["-c", agentEntry]), DUAL_AGENT_CONFIG_HOME: actor.configHome,
    TMPDIR: actor.temp, DUAL_LOOPBACK_KEY: "dummy-loopback-only", NO_PROXY: "127.0.0.1", PYTHONSAFEPATH: "1",
    PYTHONPATH: join(repo, "agent"),
  }
  const child = spawn(binary, [
    "--user-data-dir=" + actor.profile, "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", "--inspect=0", desktop,
  ], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] })
  actor.child = child
  actor.exited = once(child, "exit")
  actor.stderr = ""
  child.stderr.setEncoding("utf8").on("data", chunk => { actor.stderr += chunk })
  await once(child, "spawn")
  const attempt = async (test, label) => {
    const end = Date.now() + 45_000
    while (Date.now() < end) {
      const value = await test()
      if (value) return value
      if (child.exitCode !== null || child.signalCode) throw Error(actor.key + " exited " + actor.stderr)
      await pause(60)
    }
    throw Error(actor.key + " timeout: " + label)
  }
  const inspect = await attempt(() => actor.stderr.match(/Debugger listening on (ws:\/\/[^\r\n]+)/)?.[1], "main")
  actor.main = await connect(inspect)
  const actualProfile = await actor.main.evaluate(electron + ".app.getPath('userData')")
  assert.equal(await realpath(actualProfile), await realpath(actor.profile))
  const debug = await attempt(() => readFile(join(actor.profile, "DevToolsActivePort"), "utf8").catch(() => ""), "DevTools")
  const port = Number(debug.split("\n")[0])
  const page = await attempt(async () => {
    const list = await fetch("http://127.0.0.1:" + port + "/json/list").then(res => res.json()).catch(() => [])
    return list.find(item => item.type === "page" && item.url.endsWith("/renderer/index.html"))
  }, "renderer")
  actor.ui = await connect(page.webSocketDebuggerUrl)
  actor.wait = (expression, label) => attempt(() => actor.ui.evaluate(expression), label)
  actor.click = async selector => {
    const element = "document.querySelector(" + JSON.stringify(selector) + ")"
    await actor.wait(element + " && !" + element + ".disabled", selector)
    await actor.ui.evaluate(element + ".click()")
  }
  actor.button = async label => {
    const match = "Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === " + JSON.stringify(label) + " && button.offsetWidth)"
    await actor.wait("Boolean(" + match + " && !" + match + ".disabled)", label)
    await actor.ui.evaluate(match + ".click()")
  }
}
async function login(actor) {
  await actor.click(".desktop-empty button.wb-button-primary")
  const select = "document.querySelector('.identity-panel select')"
  await actor.wait("Boolean(" + select + "?.querySelector('option[value=\"" + actor.userNo + "\"]'))", "demo account available")
  await actor.ui.evaluate("(" + select + ".value = " + JSON.stringify(actor.userNo) + ", " + select + ".dispatchEvent(new Event('change', { bubbles: true })))")
  await actor.click(".identity-panel button.primary")
  await actor.wait("Boolean(document.querySelector('.session-new-page'))", "signed-in project workbench")
  if (!await actor.ui.evaluate("Boolean(document.querySelector('.collaboration-modal'))")) {
    await actor.click("button[aria-label=设置]")
  }
}

async function stop(actor) {
  actor.ui?.close()
  if (!actor.child) return
  if (actor.main) {
    await actor.main.evaluate("(setTimeout(() => " + electron + ".app.quit(), 0), true)").catch(() => actor.child.kill())
    actor.main.close()
  } else actor.child.kill()
  await Promise.race([actor.exited, pause(3500)]).catch(() => {})
  if (actor.child.exitCode === null && !actor.child.signalCode) actor.child.kill()
}

async function registerDevice(actor) {
  // 只替换原生目录选择框的返回值。登记、路径校验、写账本和 IPC 走正式入口。
  await actor.main.evaluate(`(globalThis.smokeDialog = ${electron}.dialog.showOpenDialog,
    ${electron}.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(actor.cwd)}] }), true)`)
  await actor.button("选择目录并登记")
  await actor.wait("document.querySelector('[data-testid=device-state]')?.innerText.includes('已登记')", "device registered")
  await actor.click("[aria-label=关闭设置]")

  const currentProject = await actor.ui.evaluate("document.querySelector('.pnav-project-switch')?.innerText.trim()")
  if (currentProject !== projectName) {
    await actor.click(".pnav-project-switch")
    const target = `Array.from(document.querySelectorAll('[role=menuitemradio]')).find(row => row.innerText.trim() === ${JSON.stringify(projectName)})`
    await actor.wait(`Boolean(${target})`, "demo project")
    await actor.ui.evaluate(target + ".click()")
  }

  const state = await actor.ui.evaluate("window.devices.getState()")
  const identity = await actor.ui.evaluate("window.collaboration.getState()")
  assert.equal(state.value.status, "registered")
  assert.equal(identity.value.status, "signedIn")
  return { deviceId: state.value.deviceId, ownerUserId: identity.value.user.id }
}

function fixtureCredential(actor, expectedDeviceId) {
  // 只有显式补传模式才从本轮测试账本取密钥，正式链路使用安全的窗口设备视图。
  const path = join(actor.profile, "runner", createHash("sha256").update(origin).digest("hex"), "runner.sqlite")
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const device = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'device'").get().value)
    assert.equal(device.origin, origin)
    assert.equal(device.registered, true)
    assert.equal(device.deviceId, expectedDeviceId)
    return device
  } finally {
    db.close()
  }
}
async function sendFromA() {
  await a.button("新对话")
  await a.click(".session-new-controls button")
  await a.wait("document.querySelector('.session-new-controls button')?.textContent.includes('workspace')", "new conversation directory")
  await a.ui.evaluate("document.querySelector('.session-new-page textarea').focus()")
  await a.ui.call("Input.insertText", { text: newTitle })
  await a.click(".session-new-send button")
  await a.wait("Boolean(document.querySelector('.wb-composer-textarea'))", "conversation created")
  await a.click(".session-directory-button")
  await a.wait("document.querySelector('.session-directory-button')?.textContent.includes('workspace')", "execution directory confirmed")
  await a.main.evaluate(`(${electron}.dialog.showOpenDialog = globalThis.smokeDialog, true)`)
  await a.ui.evaluate(`globalThis.smokeEvents = []
    window.localExecution.onNotice(event => globalThis.smokeEvents.push(event))`)
  if (actions) {
    await sendCurrent(deniedPrompt)
    await a.wait("Boolean(document.querySelector('.wb-interaction-option-negative:not(:disabled)'))", "tool denial offered")
    await a.click(".wb-interaction-option-negative")
    await a.wait("globalThis.smokeEvents.some(event => event.kind === 'finished')", "denied turn finished")
    const denied = await a.ui.evaluate("globalThis.smokeEvents")
    assert.equal(denied.filter(event => event.kind === "finished").length, 1)
    await assert.rejects(readFile(join(a.cwd, "deny-smoke.txt")), { code: "ENOENT" })

    await sendCurrent(cancelPrompt)
    await a.wait("globalThis.smokeEvents.some(event => event.kind === 'text')", "text before cancel")
    await a.click("[aria-label=取消当前任务]")
    await a.wait("globalThis.smokeEvents.some(event => event.kind === 'finished')", "cancelled turn finished")
    const cancelled = await a.ui.evaluate("globalThis.smokeEvents")
    assert.equal(cancelled.filter(event => event.kind === "finished").length, 1)
    assert.equal(cancelled.at(-1).failure, "本轮已停止。")
    evidence.actions = { denied, cancelled }
  }
  const occurredAtMs = Date.now()
  await sendCurrent(prompt)
  if (actions) {
    await a.wait("Boolean(document.querySelector('.wb-interaction-option-positive:not(:disabled)'))", "tool approval offered")
    await a.button("允许一次")
    await a.click(".wb-interaction-submit")
  }
  await a.wait("globalThis.smokeEvents.some(event => event.kind === 'finished')", "ACP terminal event")
  if (actions) assert.equal(await readFile(join(a.cwd, "allow-smoke.txt"), "utf8"), "local smoke")
  const events = await a.ui.evaluate("globalThis.smokeEvents")
  if (actions) assert.ok(events.some(event => event.kind === "tool" && event.tool.status === "completed"))
  const [accepted] = events
  const finished = events.at(-1)
  const textEvents = events.filter(event => event.kind === "text")
  assert.equal(accepted.kind, "accepted")
  assert.equal(accepted.text, prompt)
  assert.equal(finished.kind, "finished")
  assert.equal(finished.failure, undefined, finished.failure)
  assert.ok(textEvents.length >= 2)
  assert.ok(events.every(event => event.turnId === accepted.turnId))
  assert.deepEqual(events.slice(1).map(event => event.sequence), events.slice(1).map((_, index) => index + 1))
  const finalText = textEvents.map(event => event.text).join("")
  assert.equal(finalText, answer)
  await a.wait(`Array.from(document.querySelectorAll('.wb-conversation-message-assistant')).some(entry => entry.innerText.includes(${JSON.stringify(answer)}))`, "reply rendered")
  return { scope: accepted.scope, turnId: accepted.turnId, userText: accepted.text, finalText, occurredAtMs, textChunks: textEvents.length }
}
async function sendCurrent(text) {
  await a.wait("Boolean(document.querySelector('[aria-label=发送消息]'))", "composer ready")
  await a.ui.evaluate(`globalThis.smokeEvents = []
    document.querySelector('.wb-composer-textarea').focus()
    document.querySelector('.wb-composer-textarea').select()`)
  await a.ui.call("Input.insertText", { text })
  await a.wait("Boolean(document.querySelector('[aria-label=发送消息]:not(:disabled)'))", "send enabled")
  await a.click("[aria-label=发送消息]")
}
async function access(where) {
  const log = await readFile(join(run, "access", "http.log"), "utf8")
  return log.trim().split("\n").filter(where)
}
async function fixtureUpload(path, device, turn) {
  const messages = [
    { sequence: 1, type: "user", occurredAtMs: turn.occurredAtMs, payload: JSON.stringify({ text: turn.userText }) },
    { sequence: 2, type: "assistant", occurredAtMs: Date.now(), payload: JSON.stringify({ text: turn.finalText }) },
  ]
  const response = await fetch(origin + path, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: {
      "Authorization": `Bearer ${device.deviceId}.${device.secret}`,
      "Origin": origin,
      "Content-Type": "application/json",
      "X-Workbench-Protocol-Version": "1",
      "X-HC218-Smoke": "fixture-upload",
    },
    body: JSON.stringify({ messages, brief: { status: "idle", briefText: fixtureBrief, briefSource: "rule" } }),
  })
  assert.equal(response.status, 200, "Java 拒绝测试上传")
  const result = await response.json()
  assert.equal(result.returnCode, "SUC0000")
  assert.equal(result.body.syncedSequence, 2)
  return { httpStatus: response.status, syncedSequence: result.body.syncedSequence }
}

try {
  await Promise.all(actors.map(prepare))
  const starts = await Promise.allSettled(actors.map(start))
  for (const result of starts) if (result.status === "rejected") throw result.reason
  console.log("两个正式 Electron 使用独立目录启动")
  await login(a)
  const aDevice = await registerDevice(a)
  const turn = await sendFromA()
  const { workspaceId, conversationId } = turn.scope
  assert.equal(turn.scope.deviceId, aDevice.deviceId)
  assert.equal(turn.scope.projectId, projectId)
  evidence.A = { userNo: a.userNo, deviceId: aDevice.deviceId, ...turn }
  console.log(`A 已登记会话 ${conversationId}，收到 ${turn.textChunks} 段 ACP 正文和成功终态`)

  const conversationPath = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/conversations/${conversationId}`
  const syncPath = `/api/v1/device/conversations/${conversationId}/sync`
  const uploads = () => access(line => line.startsWith(`POST ${syncPath} `))
  const reads = () => access(line => line.startsWith(`GET ${conversationPath}/history?`))
  const allowFixture = process.env.HC218_SMOKE_FIXTURE_UPLOAD === "1"
  const uploadStartedAt = Date.now()
  if (allowFixture) await pause(2000)
  else {
    // 正式上传异步进行。以 Java 的 HTTP 200 为准，忽略模型或窗口自身的终态时间。
    while (Date.now() - uploadStartedAt < 15_000) {
      if ((await uploads()).some(line => line.endsWith(" 200 -"))) break
      await pause(100)
    }
  }
  const realUploads = (await uploads()).filter(line => !line.endsWith(" fixture-upload"))
  const detail = await a.ui.evaluate(`window.projectConversations.getConversation(${JSON.stringify(workspaceId)}, ${JSON.stringify(projectId)}, ${JSON.stringify(conversationId)})`)
  assert.equal(detail.ok, true, JSON.stringify(detail))
  evidence.productUpload = { observationMs: Date.now() - uploadStartedAt, requests: realUploads, syncedSequence: detail.value.conversation.syncedSequence }
  console.log(`A 正式入口的 sync 请求 ${realUploads.length} 条，服务端水位 ${evidence.productUpload.syncedSequence}`)

  if (evidence.productUpload.syncedSequence === 0 && allowFixture) {
    assert.equal(realUploads.length, 0, "正式上传失败时保留原始失败证据")
    evidence.fixtureUpload = await fixtureUpload(syncPath, fixtureCredential(a, aDevice.deviceId), turn)
    console.log("测试脚本用 A 设备凭据上传本轮定稿，Java 返回 HTTP 200、水位 2")
  } else {
    if (actions) assert.deepEqual(realUploads, [`POST ${syncPath} 200 -`])
    assert.ok(realUploads.some(line => line.endsWith(" 200 -")), "Java 尚未确认正式定稿上传")
    assert.equal(evidence.productUpload.syncedSequence, 2)
    assert.ok(detail.value.conversation.briefText.includes(turn.userText) && detail.value.conversation.briefText.includes(turn.finalText))
  }
  const summary = evidence.fixtureUpload ? fixtureBrief : detail.value.conversation.briefText
  assert.ok(summary, "Java 应提供会话简报")

  await login(b)
  const bDevice = await registerDevice(b)
  await b.main.evaluate(`(${electron}.dialog.showOpenDialog = globalThis.smokeDialog, true)`)
  assert.notEqual(bDevice.deviceId, aDevice.deviceId)
  assert.notEqual(bDevice.ownerUserId, aDevice.ownerUserId)
  await b.click(`.pnav-member-toggle[aria-controls="pnav-member-${aDevice.ownerUserId}"]`)
  await b.click(`.pnav-session[title="${newTitle}"]`)
  await b.wait(`document.querySelector('.session-brief-text')?.textContent === ${JSON.stringify(summary)}`, "Java brief visible in B")
  await b.wait("document.body.innerText.includes('正文尚未同步到这台电脑')", "history awaits explicit sync")
  assert.equal(await b.ui.evaluate(readOnly), true)
  assert.equal(await b.ui.evaluate("Boolean(document.querySelector('.wb-conversation-message-user, .wb-conversation-message-assistant'))"), false)
  const before = await reads()
  evidence.B = { userNo: b.userNo, deviceId: bDevice.deviceId, summary, historyRequestsBeforeClick: before }
  assert.equal(before.length, 0)

  await b.button("同步会话")
  await b.wait(`document.querySelector('.wb-conversation-message-assistant')?.innerText.includes(${JSON.stringify(turn.finalText)})`, "B sees the final reply")
  await b.wait(`document.querySelector('.wb-conversation-message-user')?.innerText.includes(${JSON.stringify(turn.userText)})`, "B sees the original prompt")
  assert.equal(await b.ui.evaluate(readOnly), true)
  const after = await reads()
  evidence.B.historyRequestsAfterClick = after
  assert.equal(after.length, 1)
  assert.match(after[0], /afterSequence=0.* 200 /)
  evidence.B.readOnly = true
  evidence.B.visibleMessages = [turn.userText, turn.finalText]
  evidence.uploadRequestsThroughEnd = await uploads()
  if (actions) assert.deepEqual(evidence.uploadRequestsThroughEnd, [`POST ${syncPath} 200 -`])
  evidence.registrationRequests = await access(line => line.includes(`POST /api/v1/workspaces/${workspaceId}/`) && line.includes(" 201 "))
  if (evidence.fixtureUpload) {
    assert.deepEqual(evidence.uploadRequestsThroughEnd, [`POST ${syncPath} 200 fixture-upload`])
  }
  evidence.result = evidence.fixtureUpload ? "fixture-upload-and-explicit-read-pass" : "product-upload-and-explicit-read-pass"
  console.log("B 已通过主动同步只读显示本轮两条正文，点击前历史请求 0 条，点击后 1 条")
  if (actions && !allowFixture) {
    await stop(a)
    assert.equal(a.child.exitCode, 0, "正式 Electron A 未确认正常退出")
    await rm(join(a.profile, "DevToolsActivePort"), { force: true })
    await start(a)
    await login(a)
    await a.click("[aria-label=关闭设置]")
    await a.click(`.pnav-session[title="${newTitle}"]`)
    await a.main.evaluate(`(${electron}.dialog.showOpenDialog = async () => ({
      canceled: false, filePaths: [${JSON.stringify(a.cwd)}]
    }), true)`)
    await a.click(".session-directory-button")
    await a.wait("document.querySelector('.session-directory-button')?.textContent.includes('workspace')", "original directory reconfirmed")
    await a.ui.evaluate("globalThis.smokeEvents = []; window.localExecution.onNotice(event => globalThis.smokeEvents.push(event))")
    await sendCurrent(resumePrompt)
    await a.wait("globalThis.smokeEvents.some(event => event.kind === 'finished')", "restored ACP terminal")
    const events = await a.ui.evaluate("globalThis.smokeEvents")
    assert.equal(events[0].scope.conversationId, conversationId)
    assert.equal(events.at(-1).failure, undefined)
    assert.ok(restoredModelContext, "重开后的模型请求缺少先前输入")
    assert.deepEqual(events.filter(event => event.kind === "text").map(event => event.text), ["Hello", answer.slice(5)])
    const secondDeadline = Date.now() + 15_000
    while (Date.now() < secondDeadline && (await uploads()).length < 2) await pause(100)
    const uploadRequests = await uploads()
    assert.deepEqual(uploadRequests, [`POST ${syncPath} 200 -`, `POST ${syncPath} 200 -`])
    const resumedDetail = await a.ui.evaluate(`window.projectConversations.getConversation(${JSON.stringify(workspaceId)}, ${JSON.stringify(projectId)}, ${JSON.stringify(conversationId)})`)
    assert.equal(resumedDetail.value.conversation.syncedSequence, 4)
    evidence.resume = { restoredModelContext, events, uploadRequests, syncedSequence: 4 }
    console.log("A 重开后继续同一个 Harness 原生会话，回放未进当前轮，Java 仅新增两条定稿")
  }
} catch (error) {
  evidence.error = error.message
  for (const actor of actors) {
    if (actor.ui) console.error(actor.key + " UI:", await actor.ui.evaluate("document.body.innerText.slice(-1600)").catch(() => "unavailable"))
    if (actor.stderr) console.error(actor.key + " stderr:", actor.stderr.split("\n").slice(-8).join("\n"))
  }
  throw error
} finally {
  await Promise.allSettled(actors.map(stop))
  model.closeAllConnections()
  await new Promise(resolveClose => model.close(resolveClose))
  await writeFile(join(run, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
}
