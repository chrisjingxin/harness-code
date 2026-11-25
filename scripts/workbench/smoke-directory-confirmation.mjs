/** 目录确认定点冒烟：独立 Electron profile、正式页面/Hook 与受控宿主，不登录或访问模型。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"
import { build } from "esbuild"

const require = createRequire(import.meta.url)
const repo = fileURLToPath(new URL("../..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "hc218-confirm-click-"))
let child, socket
let logs = ""

try {
  await build({
    stdin: {
      resolveDir: repo,
      sourcefile: "directory-confirmation-fixture.tsx",
      loader: "tsx",
      contents: `
        import { useState } from "react"
        import { createRoot } from "react-dom/client"
        import { LocalSessionPage } from "./desktop/src/renderer/features/session/local-session-page.tsx"
        import { useLocalExecution } from "./desktop/src/renderer/features/session/use-local-execution.ts"
        import { EMPTY_PERSONAL_STATE } from "./desktop/src/renderer/features/session/session-model.ts"
        import { useProjectSessions } from "./desktop/src/renderer/features/session/use-project-sessions.ts"
        import { createSessionPageProvider } from "./desktop/src/renderer/features/session/session-provider.tsx"
        import "./desktop/src/ui/theme.css"
        import "./desktop/src/renderer/features/session/session.css"
        const scope = { namespace: "controlled", accountId: "controlled-user", workspaceId: null, projectId: null }
        const conversation = { conversationId: "controlled-conversation", projectId: null, ownerUserId: scope.accountId,
          title: "目录确认受控冒烟", status: "idle", briefText: "", briefSource: "rule", briefUpdatedAtMs: 0,
          syncedSequence: 0, updatedAt: "2026-11-25T00:00:00Z", shareMode: "full", shareStatus: "active", repositories: [] }
        let config, granted, calls, latest, generation = 0
        const host = {
          onNotice: () => () => {},
          promptQueue: async () => ({ ok: true, value: {} }),
          prepare: async () => {
            calls.prepare++
            return granted
              ? { ok: true, directoryStatus: "ready", value: { bindingId: "controlled-binding", providerId: "controlled", available: true } }
              : { ok: false, directoryStatus: "confirmation-required", error: { code: "PROJECT_PATH_INVALID", message: "请确认已保存目录。" } }
          },
          confirmDirectory: async receivedScope => {
            calls.confirm++
            calls.scopes.push(receivedScope)
            if (!config.directory) return { ok: false, error: { code: "PROJECT_PATH_INVALID", message: "该会话尚未保存工作目录，请选择目录。" } }
            if (config.answer === "throw") throw Error("受控 IPC 断开")
            if (config.answer === "failure") return { ok: false, error: { code: "PROJECT_ROOT_CHANGED", message: "工作目录已变化，请重新选择。" } }
            if (config.answer === "cancel") return { ok: true, value: false }
            granted = true
            return { ok: true, value: true }
          },
        }
        function Fixture() {
          const [personal] = useState({ ...EMPTY_PERSONAL_STATE, draft: { ...EMPTY_PERSONAL_STATE.draft,
            text: "目录确认前保留的草稿", revision: 7, selectionStart: 11, selectionEnd: 11, referenceIds: ["fixed-reference"] } })
          const execution = useLocalExecution(host, scope, conversation.conversationId, config.directory, 0, "本人", () => { calls.accepted++ })!
          latest = config.answer === "port-throw" ? { ...execution, confirmDirectory: async () => { throw Error("受控页面确认异常") } } : execution
          return <LocalSessionPage scope={{ ...scope, workspaceId: "__solo__", conversationId: conversation.conversationId }}
            executionScope={scope} visible={true} conversation={conversation} directoryPath={config.directory}
            entries={[]} contentRevision={0} personal={personal} execution={latest} rendering={{}}
            onPersonalChange={() => { calls.draftChanges++ }} onChooseDirectory={() => { calls.choose++ }} />
        }
        const projectScope = { ...scope, workspaceId: "controlled-team", projectId: "controlled-project" }
        const projectConversation = { ...conversation, projectId: projectScope.projectId }
        const projectHost = {
          listConversations: async () => ({ ok: true, value: { projectId: projectScope.projectId, conversations: [projectConversation] } }),
        }
        const localHistory = {
          get: async () => ({ ok: true, value: {
            record: { ...projectConversation, workspaceId: projectScope.workspaceId }, nextSequence: 3,
            turns: [{ turnId: "persisted-failed-turn", userText: "重开后保留的失败原文", reply: "已收到的部分回复",
              status: "failed", failure: "真实失败状态", acceptedAtMs: 1000, completedAtMs: 2000, sequenceStart: 1, sequenceEnd: 2 }],
          } }),
        }
        const persistence = { load: async () => ({ ok: true, value: { data: null } }), save() {} }
        const desktop = { copyText: async () => {}, openExternal: async () => {} }
        const unavailable = { getAvailability: () => ({ available: false, reason: "受控阅读" }) }
        function ProjectHistoryFixture() {
          const { pageController } = useProjectSessions({ host: desktop, projectConversations: projectHost,
            localConversations: localHistory, persistence, scope: projectScope, projectName: "受控项目", userId: scope.accountId,
            members: [], selectedConversationId: conversation.conversationId, execution: unavailable })
          return createSessionPageProvider(pageController).render({ scope: projectScope,
            page: { kind: "conversation", conversationId: conversation.conversationId }, visible: true, navigator: { openPage() {} } })
        }
        const root = createRoot(document.getElementById("root")!)
        window.fixture = {
          show(next) {
            config = next; granted = false
            calls = { confirm: 0, choose: 0, prepare: 0, accepted: 0, draftChanges: 0, scopes: [] }
            root.render(<Fixture key={++generation} />)
          },
          state: () => ({ calls, availability: latest?.getAvailability(conversation.conversationId),
            text: document.body.innerText, draft: document.querySelector("textarea")?.value }),
          showHistory: () => root.render(<ProjectHistoryFixture key={++generation} />),
        }
        window.fixture.show({ directory: null, answer: "accept" })
      `,
    },
    outdir: root,
    entryNames: "fixture",
    bundle: true,
    format: "esm",
    platform: "browser",
    loader: { ".jpg": "dataurl", ".png": "dataurl", ".svg": "dataurl" },
    jsx: "automatic",
    logLevel: "error",
  })
  await writeFile(join(root, "index.html"), '<!doctype html><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
  await writeFile(join(root, "main.cjs"), `
    const { app, BrowserWindow } = require("electron")
    app.setPath("userData", ${JSON.stringify(join(root, "profile"))})
    app.whenReady().then(() => {
      const window = new BrowserWindow({ show: false, width: 1100, height: 850,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
      window.loadFile(${JSON.stringify(join(root, "index.html"))})
    })
    app.on("window-all-closed", () => app.quit())
  `)
  const env = { PATH: process.env.PATH, TMPDIR: tmpdir() }
  child = spawn(require("electron"), ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", join(root, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", data => { logs += data })
  child.stderr.on("data", data => { logs += data })

  async function until(action, label) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw Error(`受控窗口提前退出: ${logs.slice(-1200)}`)
      const value = await action()
      if (value) return value
      await pause(100)
    }
    throw Error(`等待${label}超时: ${logs.slice(-1200)}`)
  }
  const browser = await until(async () => /DevTools listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1], "受控 DevTools")
  const page = await until(async () => {
    const response = await fetch(new URL("/json/list", browser.replace("ws:", "http:")))
    return (await response.json()).find(item => item.type === "page")
  }, "受控页面")
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await once(socket, "open")
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const result = JSON.parse(event.data)
    if (result.method === "Runtime.exceptionThrown") logs += JSON.stringify(result.params.exceptionDetails)
    if (result.method === "Runtime.consoleAPICalled") logs += JSON.stringify(result.params.args)
    const listener = pending.get(result.id)
    if (!listener) return
    pending.delete(result.id)
    result.error ? listener.reject(Error(JSON.stringify(result.error))) : listener.resolve(result.result)
  }
  socket.send(JSON.stringify({ id: -1, method: "Runtime.enable" }))
  async function evaluate(expression) {
    const id = ++sequence
    let timer
    try {
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        timer = setTimeout(() => { pending.delete(id); reject(Error("受控页面请求超时")) }, 5000)
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }))
      })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    } finally { clearTimeout(timer) }
  }
  async function clickText(text) {
    await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find(item => item.textContent.trim().startsWith(${JSON.stringify(text)}))
      if (!button || button.disabled) throw Error("受控按钮不可用: " + ${JSON.stringify(text)})
      button.click()
    })()`)
  }
  await until(async () => {
    const state = await evaluate(`({ ready: Boolean(window.fixture && document.querySelector('[data-context-trigger=directory]')), text: document.body?.innerText ?? "" })`)
    if (!state.ready && state.text) logs = logs.slice(-1200) + state.text.slice(0, 400)
    return state.ready
  }, "目录页面渲染")
  await evaluate("document.querySelector('[data-context-trigger=directory]')?.click()")
  await until(() => evaluate("Boolean(document.querySelector('[role=menu]'))"), "目录菜单")
  const noDirectory = await evaluate("window.fixture.state()")
  assert.doesNotMatch(noDirectory.text, /确认并授权此目录|确认目录/)
  assert.notEqual(noDirectory.availability.directoryStatus, "confirmation-required")
  await clickText("选择本机文件夹…")
  assert.equal((await evaluate("window.fixture.state()")).calls.choose, 1)
  const outcomes = []
  for (const [answer, entry, expected] of [
    ["cancel", "确认并授权此目录", /已取消.*目录确认/],
    ["accept", "确认目录", /ready/],
    ["accept", "确认并授权此目录", /ready/],
    ["failure", "确认目录", /工作目录已变化/],
    ["throw", "确认目录", /无法确认目录/],
    ["port-throw", "确认目录", /受控页面确认异常/],
  ]) {
    await evaluate(`window.fixture.show(${JSON.stringify({ directory: "/controlled/old-directory", answer })})`)
    await until(() => evaluate("window.fixture.state().availability.directoryStatus === 'confirmation-required'"), "旧目录待确认")
    if (entry === "确认并授权此目录") {
      await evaluate("document.querySelector('[data-context-trigger=directory]').click()")
      await until(() => evaluate("Boolean(document.querySelector('[role=menu]'))"), "确认菜单")
    }
    const before = await evaluate("window.fixture.state()")
    await clickText(entry)
    const state = await until(async () => {
      const value = await evaluate("window.fixture.state()")
      return (answer === "accept" ? value.availability.directoryStatus === "ready" : expected.test(value.text)) && value
    }, `确认结果 ${answer}/${entry}`)
    assert.equal(state.draft, "目录确认前保留的草稿")
    assert.equal(state.calls.draftChanges, before.calls.draftChanges)
    assert.equal(state.calls.accepted, 0)
    assert.equal(state.calls.confirm, answer === "port-throw" ? 0 : 1)
    if (state.calls.confirm) assert.deepEqual(state.calls.scopes[0], { accountId: "controlled-user", workspaceId: null, projectId: null, conversationId: "controlled-conversation" })
    outcomes.push({ answer, entry, status: state.availability.directoryStatus, draftPreserved: true })
  }
  await evaluate("window.fixture.showHistory()")
  await until(() => evaluate("document.body.innerText.includes('重开后保留的失败原文') && document.body.innerText.includes('真实失败状态')"), "Project 本人本机失败历史")
  console.log(JSON.stringify({ result: "PASS", noDirectory: "只引导选择，无确认入口", outcomes,
    projectHistory: "正式 Project Hook 与页面读取本机原文、部分回复及失败状态",
    boundary: "正式页面与 Hook 真实点击，宿主/原生确认响应受控；未操作用户实例、未执行模型或发送草稿" }, null, 2))
} catch (error) {
  console.error(logs.slice(-2500))
  throw error
} finally {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit")
    child.kill("SIGTERM")
    await Promise.race([exited, pause(2000)])
  }
  await rm(root, { recursive: true, force: true })
}
