/** 用真实 Electron utility 子进程验证生产 Runner 入口、SQLite 提交重开和跨进程锁。 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { once } from "node:events"
import assert from "node:assert/strict"

const filename = fileURLToPath(import.meta.url)
const root = resolve(dirname(filename), "../..")
const entry = join(root, "apps/runner/dist/index.js")
const directory = process.argv.at(-1)

if (process.versions.electron) {
  const { app, utilityProcess } = await import("electron")
  app.setPath("userData", directory)
  void app.whenReady().then(async () => {
    const children = new Set()
    function launch(hold) {
      const child = utilityProcess.fork(entry, ["--self-test", directory, String(hold)], { stdio: "pipe" })
      children.add(child)
      const exited = once(child, "exit").then(([code]) => { children.delete(child); return code })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", chunk => { stdout += chunk })
      child.stderr.on("data", chunk => { stderr += chunk })
      const result = async () => ({ code: await exited, body: JSON.parse(stdout.trim()), stderr })
      return { child, exited, result, output: () => stdout }
    }
    const deadline = setTimeout(() => { throw new Error("Electron Runner 宿主冒烟超时") }, 20_000)
    try {
      const first = launch(10_000)
      for (let n = 0; !first.output().includes("\n"); n++) {
        assert.ok(n < 200, "首个 utility 进程未报告持锁探测结果")
        await new Promise(done => setTimeout(done, 20))
      }
      const initial = JSON.parse(first.output().trim())
      assert.equal(initial.journalMode, "wal")
      assert.equal(initial.synchronous, "2")
      assert.equal(initial.processType, "utility")
      const duplicate = await launch(0).result()
      assert.equal(duplicate.code, 1)
      assert.equal(duplicate.body.code, "LOCAL_RUNNER_ALREADY_ACTIVE")
      assert.equal(first.child.pid, initial.pid)
      process.kill(initial.pid, "SIGKILL")
      await first.exited
      const reopened = await launch(0).result()
      assert.equal(reopened.code, 0)
      assert.equal(reopened.body.previousProbe, initial.probeValue)
      const afterCleanExit = await launch(0).result()
      assert.equal(afterCleanExit.code, 0)
      assert.equal(afterCleanExit.body.previousProbe, reopened.body.probeValue)
      console.log(JSON.stringify({ ok: true, electron: process.versions.electron, utilityNode: initial.node,
        sqlite: initial.sqlite, journalMode: initial.journalMode, synchronous: initial.synchronous,
        contention: duplicate.body.code, reopenedAfterCrash: true, reopenedAfterExit: true, childrenExited: children.size === 0 }))
      app.exit(0)
    } catch (error) {
      console.error(error)
      for (const child of children) child.kill()
      app.exit(1)
    } finally { clearTimeout(deadline) }
  }).catch(error => { console.error(error); app.exit(1) })
} else {
  const data = await mkdtemp(join(tmpdir(), "hc196-electron-"))
  try {
    const executable = createRequire(import.meta.url)("electron")
    const child = spawn(executable, [filename, data], { cwd: dirname(entry), stdio: "inherit" })
    const deadline = setTimeout(() => child.kill(), 30_000)
    const [code] = await once(child, "exit").finally(() => clearTimeout(deadline))
    process.exitCode = code ?? 1
  } finally { await rm(data, { recursive: true, force: true }) }
}
