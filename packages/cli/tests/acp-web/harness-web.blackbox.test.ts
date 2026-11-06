/** `harness web` 黑盒用例：真实 CLI + `sh` 假 sidecar。 */

import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const CLI_ROOT = resolve(import.meta.dir, "../..")
const isWindows = process.platform === "win32"

describe.skipIf(isWindows)("harness web 黑盒", () => {
  test("启动 → 兑换 → 回显 → SIGINT 干净退出", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "harness-web-bb-"))
    const pidsFile = join(directory, "pids")
    const sidecar = join(directory, "python")
    await writeFile(sidecar, `#!/bin/sh\necho $$ >> ${pidsFile}\nexec cat\n`, "utf8")
    await chmod(sidecar, 0o755)
    const workspace = await mkdtemp(resolve(tmpdir(), "harness-web-ws-"))
    const child = Bun.spawn([process.execPath, resolve(CLI_ROOT, "src/index.ts"), "web", "--cwd", workspace, "--no-open"], {
      cwd: CLI_ROOT,
      env: { ...process.env, HARNESS_AGENT_PYTHON: sidecar },
      stdout: "pipe", stderr: "pipe",
    })
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let out = ""
      const deadline = Date.now() + 15_000
      while (!out.includes("#c=") && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        out += decoder.decode(value)
      }
      expect(out).toContain("ACP 过渡版本，部分功能暂不可用")
      const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/#c=(\S+)/)
      expect(match).toBeTruthy()
      const [, port, bootCode] = match!
      const origin = `http://127.0.0.1:${port}`
      const redeemed = await fetch(`${origin}/acp/boot`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ code: bootCode }),
      })
      expect(redeemed.status).toBe(200)
      const { wsToken } = await redeemed.json() as { wsToken: string }
      const ws = new WebSocket(`${origin.replace("http", "ws")}/acp/ws?t=${wsToken}`, { headers: { origin } } as never)
      const echo = await new Promise<string>((resolve, reject) => {
        ws.addEventListener("open", () => ws.send('{"jsonrpc":"2.0","id":1,"method":"x"}'), { once: true })
        ws.addEventListener("message", event => resolve(String(event.data)), { once: true })
        ws.addEventListener("error", () => reject(new Error("ws failed")), { once: true })
        setTimeout(() => reject(new Error("timeout")), 10_000)
      })
      expect(echo).toBe('{"jsonrpc":"2.0","id":1,"method":"x"}')
      child.kill("SIGINT")
      const exitCode = await Promise.race([child.exited, new Promise<number>((_, reject) => setTimeout(() => reject(new Error("未在 3 秒内退出")), 3_000))])
      expect(exitCode).toBe(0)
      const pids = readFileSync(pidsFile, "utf8").trim().split("\n").map(Number)
      expect(pids.length).toBeGreaterThan(0)
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      try {
        for (const pid of readFileSync(pidsFile, "utf8").trim().split("\n").map(Number)) {
          try { process.kill(pid, "SIGKILL") } catch { /* 已死 */ }
        }
      } catch { /* pids 文件可能还没写 */ }
    }
  }, 30_000)

  test("harness web extra → 非零退出 + Usage，不启动 TUI", async () => {
    const child = Bun.spawn([process.execPath, resolve(CLI_ROOT, "src/index.ts"), "web", "extra"], {
      cwd: CLI_ROOT,
      env: { ...process.env, HARNESS_AGENT_PYTHON: "/nonexistent" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Usage: harness web")
  }, 30_000)
})
