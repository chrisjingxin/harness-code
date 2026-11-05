/** `harness acp` 透传的黑盒测试：真实 CLI + 假 sidecar，验证字节与退出码。 */

import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"


const CLI_ROOT = resolve(import.meta.dir, "..")
const isWindows = process.platform === "win32"

/** 写一个假的 sidecar：`#!/bin/sh` 脚本，记录 argv 并把 stdin 原样转发。 */
async function fakeSidecar(body: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-acp-passthrough-"))
  const path = resolve(directory, "python")
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8")
  await chmod(path, 0o755)
  return path
}

/** 用 `HARNESS_AGENT_PYTHON` 指向假 sidecar 启动真实 CLI。 */
function spawnCli(args: string[], env: Record<string, string>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, resolve(CLI_ROOT, "src/index.ts"), ...args], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
}

/** 读完整个流；不允许漏掉尾部字节。 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

describe.skipIf(isWindows)("harness acp 透传", () => {
  test("argv、stdin 与 stdout 一字节不改地交给 sidecar", async () => {
    const sidecar = await fakeSidecar('echo "argv:$@" >&2\ncat')
    const workspace = await mkdtemp(resolve(tmpdir(), "harness-acp-ws-"))
    const child = spawnCli(["acp", "--cwd", workspace], { HARNESS_AGENT_PYTHON: sidecar })
    const payload = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
    child.stdin.write(payload)
    await child.stdin.end()
    const [stdout, , exitCode] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ])
    expect(new TextDecoder().decode(stdout)).toBe(payload)
    expect(exitCode).toBe(0)
  })

  test("sidecar 看到的 argv 以 `-m harness_agent acp` 结尾", async () => {
    const sidecar = await fakeSidecar('printf "%s" "$*" >&2')
    const workspace = await mkdtemp(resolve(tmpdir(), "harness-acp-ws-"))
    const child = spawnCli(["acp", "--cwd", workspace], { HARNESS_AGENT_PYTHON: sidecar })
    await child.stdin.end()
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("-m harness_agent acp")
  })

  test("sidecar 的退出码原样透传", async () => {
    const sidecar = await fakeSidecar("exit 7")
    const workspace = await mkdtemp(resolve(tmpdir(), "harness-acp-ws-"))
    const child = spawnCli(["acp", "--cwd", workspace], { HARNESS_AGENT_PYTHON: sidecar })
    await child.stdin.end()
    expect(await child.exited).toBe(7)
  })

  test("SIGTERM 转发给 sidecar，正常收尾时退出码 0", async () => {
    // trap 收到 TERM 后自己退出 0：证明信号确实转发到了子进程。
    // 装好 trap 之后才往 stderr 写 ready；测试等到 ready 再发信号，避免固定睡眠带来的偶发失败。
    const sidecar = await fakeSidecar(
      "trap 'exit 0' TERM\necho ready >&2\nwhile true; do sleep 0.05; done",
    )
    const workspace = await mkdtemp(resolve(tmpdir(), "harness-acp-ws-"))
    const child = spawnCli(["acp", "--cwd", workspace], { HARNESS_AGENT_PYTHON: sidecar })
    const reader = (child.stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("ready")) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    expect(seen).toContain("ready")
    child.kill("SIGTERM")
    expect(await child.exited).toBe(0)
  })

  test("工作区不存在时以 1 退出且 sidecar 根本没启动", async () => {
    const marker = await mkdtemp(resolve(tmpdir(), "harness-acp-marker-"))
    const sidecar = await fakeSidecar(`echo started > ${resolve(marker, "started")}`)
    const missing = resolve(marker, "does-not-exist")
    const child = spawnCli(["acp", "--cwd", missing], { HARNESS_AGENT_PYTHON: sidecar })
    await child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      readAll(child.stdout),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(1)
    expect(stdout.byteLength).toBe(0)
    expect(stderr).toContain("Workspace does not exist")
    expect(await Bun.file(resolve(marker, "started")).exists()).toBe(false)
  })
})
