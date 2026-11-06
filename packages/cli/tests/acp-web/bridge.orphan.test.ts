/**
 * 孤儿回收用例：桥进程被 kill -9 时，子进程的 stdin 管道随之关闭，
 * cat 读到 EOF 自行退出——不依赖桥自己的清理代码。
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const RUNNER = resolve(import.meta.dir, "support", "bridge-runner.ts")
const isWindows = process.platform === "win32"

describe.skipIf(isWindows)("桥被 kill -9", () => {
  test("子进程在 3 秒内消失（stdin EOF 兜底）", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-orphan-"))
    const pidFile = join(directory, "pid")
    const runner = Bun.spawn([process.execPath, RUNNER, pidFile], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const reader = (runner.stdout as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let readyLine = ""
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        readyLine += decoder.decode(value)
        if (readyLine.includes("\n")) break
      }
      const match = readyLine.match(/^READY (\d+) (\S+) (\d+)/)
      expect(match).toBeTruthy()
      const childPid = Number(match![3])
      expect(childPid).toBeGreaterThan(0)

      process.kill(runner.pid!, "SIGKILL")
      await runner.exited

      // 3 秒内子进程应当读到 EOF 退出。
      let alive = true
      const killDeadline = Date.now() + 3_000
      while (Date.now() < killDeadline) {
        try {
          process.kill(childPid, 0)
          await new Promise(resolve => setTimeout(resolve, 50))
        } catch {
          alive = false
          break
        }
      }
      expect(alive).toBe(false)
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGKILL")
      }
      // 兜底：万一断言失败，pidfile 里的子进程也要收掉，不给仓库留孤儿。
      try {
        const pid = Number(readFileSync(pidFile, "utf8").trim())
        if (pid) process.kill(pid, "SIGKILL")
      } catch {
        // 文件不存在或进程已死。
      }
    }
  })
})
