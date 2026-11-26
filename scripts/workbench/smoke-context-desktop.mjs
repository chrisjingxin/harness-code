/** HC-233 正式桌面入口冒烟：使用隔离userData打开已构建窗口，只核对页面和受限端口，不登入真实账号。 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const binary = require("electron")
const repo = fileURLToPath(new URL("../..", import.meta.url))
const profile = await mkdtemp(join(tmpdir(), "hc233-desktop-"))
const child = spawn(binary, ["--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--inspect=0", join(repo, "desktop")], { env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, stdio: ["ignore", "pipe", "pipe"] })
let logs = "", main, ui
child.stderr.on("data", chunk => { logs += chunk.toString() })
child.stdout.on("data", chunk => { logs += chunk.toString() })
async function until(action, label) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`桌面提前退出:${logs.slice(-1600)}`)
    const value = await action().catch(() => null)
    if (value) return value
    await pause(200)
  }
  throw new Error(`等待${label}超时:${logs.slice(-1600)}`)
}
async function connect(url) {
  const ws = new WebSocket(url)
  await once(ws, "open")
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const response = JSON.parse(event.data), listener = pending.get(response.id)
    if (!listener) return
    pending.delete(response.id)
    response.error ? listener.reject(Error(JSON.stringify(response.error))) : listener.resolve(response.result)
  }
  return {
    async evaluate(expression) {
      let timer
      try {
        const result = await new Promise((resolve, reject) => {
          const current = ++id
          pending.set(current, { resolve, reject })
          timer = setTimeout(() => { pending.delete(current); reject(Error("DevTools请求超时")) }, 5000)
          ws.send(JSON.stringify({ id: current, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }))
        })
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
        return result.result.value
      } finally { clearTimeout(timer) }
    },
    close() { ws.close() },
  }
}
try {
  const mainUrl = await until(async () => /Debugger listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1], "主进程")
  const browserUrl = await until(async () => /DevTools listening on (ws:\/\/[^\s]+)/.exec(logs)?.[1], "渲染进程")
  main = await connect(mainUrl)
  const pages = await until(async () => { const r = await fetch(new URL("/json/list", browserUrl.replace("ws:", "http:"))); const v = await r.json(); return v.find(p => p.type === "page" && p.url.startsWith("file:")) }, "正式窗口页面")
  ui = await connect(pages.webSocketDebuggerUrl)
  const state = await until(() => ui.evaluate("document.readyState === 'complete' && window.workbenchContext && ({ title: document.title, text: document.body.innerText, methods: Object.keys(window.workbenchContext) })"), "正式入口")
  assert.ok(state.text.length > 10)
  assert.deepEqual(state.methods.sort(), ["readMemory", "updateMemory"])
  assert.ok(!logs.includes("桌面启动失败") && !logs.includes("桌面页面加载失败"), logs.slice(-1600))
  console.log(JSON.stringify({ result: "PASS", entry: "已构建正式Electron窗口", page: state.title, contextPort: state.methods, boundary: "仅正常入口与受限端口；未登入账号，业务接线另验" }, null, 2))
} finally {
  const electron = "process.getBuiltinModule('module').createRequire(" + JSON.stringify(join(repo, "desktop/package.json")) + ")('electron')"
  await main?.evaluate(`(setTimeout(() => ${electron}.app.quit(), 0), true)`).catch(() => {})
  ui?.close(); main?.close()
  const ended = child.exitCode !== null ? true : await Promise.race([once(child, "exit").then(() => true), pause(3000).then(() => false)])
  if (!ended) { child.kill("SIGTERM"); await once(child, "exit") }
  await rm(profile, { recursive: true, force: true })
}
