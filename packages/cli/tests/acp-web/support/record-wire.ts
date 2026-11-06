/**
 * 录制真实 Python Agent（acp_scripted_main.py）的 agent→client 帧到
 * `tests/acp-web/support/wire/<scenario>.jsonl`，供 translate/replay/
 * permission 测试与 replay-wire 回放夹具使用。SDK 升级或 Python 帧形状变化
 * 时重跑：`bun tests/acp-web/support/record-wire.ts`。
 *
 * 每行一条 JSON：{ "dir": "a→c", "frame": <原始 JSON-RPC 帧> }。
 * dir 全是 a→c（记录的是 Agent 发出的帧，含 response、notification、request）。
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { makePythonWorkspace, pythonAgentPlan, pythonAvailable, type AcpScenario } from "./python-agent"

const OUT_DIR = join(import.meta.dir, "wire")

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

async function record(scenario: AcpScenario, script: (io: Io) => Promise<void>): Promise<void> {
  const workspace = makePythonWorkspace()
  const plan = pythonAgentPlan(scenario, workspace)
  const child = Bun.spawn([plan.executable, ...plan.args], {
    cwd: plan.cwd,
    env: plan.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  const frames: string[] = []
  const pending = new Map<number, Pending>()
  const requests: Array<{ id: number; frame: Record<string, unknown> }> = []
  let nextId = 1
  let lineBuffer = ""

  const io: Io = {
    send: (method, params) => {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
    },
    nextRequest: () =>
      new Promise(resolve => {
        const poll = setInterval(() => {
          if (requests.length) {
            clearInterval(poll)
            resolve(requests.shift()!)
          }
        }, 5)
      }),
    respond: (id, result) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
    },
    sessionId: "",
    workspace,
  }

  const decoder = new TextDecoder()
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lineBuffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, idx).trim()
        lineBuffer = lineBuffer.slice(idx + 1)
        if (!line.startsWith("{")) continue
        frames.push(JSON.stringify({ dir: "a→c", frame: JSON.parse(line) }))
        const frame = JSON.parse(line) as Record<string, unknown>
        if ("id" in frame && "method" in frame) {
          requests.push({ id: frame.id as number, frame })
        } else if ("id" in frame) {
          const p = pending.get(frame.id as number)
          if (p) {
            pending.delete(frame.id as number)
            "error" in frame ? p.reject(frame.error) : p.resolve(frame.result)
          }
        }
      }
    }
  })()

  try {
    const init = await io.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { _meta: { harnessCode: { version: 1, capabilities: ["approval", "runSummary"] } } },
      clientInfo: { name: "harness-web", title: "Harness Code Web", version: "0.0.0" },
    }) as { agentCapabilities: Record<string, unknown> }
    const session = await io.send("session/new", { cwd: workspace, mcpServers: [] }) as { sessionId: string }
    io.sessionId = session.sessionId
    // 等 available_commands_update 落定（有则收，没有不等）。
    await new Promise(resolve => setTimeout(resolve, 600))
    await script(io)
    await new Promise(resolve => setTimeout(resolve, 300))
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, `${scenario}.jsonl`), `${frames.join("\n")}\n`)
    console.log(`${scenario}: ${frames.length} frames → wire/${scenario}.jsonl`)
  } finally {
    child.stdin.end()
    await Promise.race([child.exited, new Promise(r => setTimeout(r, 3000))])
    child.kill(9)
    await pump.catch(() => {})
  }
}

type Io = {
  workspace: string
  send(method: string, params: Record<string, unknown>): Promise<unknown>
  notify(method: string, params: Record<string, unknown>): void
  nextRequest(): Promise<{ id: number; frame: Record<string, unknown> }>
  respond(id: number, result: unknown): void
  sessionId: string
}

const promptText = { sessionId: "", prompt: [{ type: "text", text: "你好" }] }

async function main(): Promise<void> {
  if (!pythonAvailable) throw new Error("packages/agent/.venv 不存在，无法录制")
  // 用法：bun record-wire.ts [场景…]，缺省录全部。
  const only = new Set(process.argv.slice(2))
  const wants = (name: string) => only.size === 0 || only.has(name)

  if (wants("host")) await record("host", async io => {
    await io.send("session/prompt", { ...promptText, sessionId: io.sessionId })
  })
  if (wants("tools")) await record("tools", async io => {
    await io.send("session/prompt", { ...promptText, sessionId: io.sessionId })
  })
  if (wants("approval")) await record("approval", async io => {
    const pending = io.send("session/prompt", { ...promptText, sessionId: io.sessionId })
    const req = await io.nextRequest()
    const options = ((req.frame.params as { options?: Array<{ optionId: string }> }).options ?? [])
    const first = options.find(o => o.optionId === "approve_once") ?? options[0]
    io.respond(req.id, { outcome: { outcome: "selected", optionId: first?.optionId ?? "approve_once" } })
    await pending
  })
  if (wants("trust")) await record("trust", async io => {
    const pending = io.send("session/prompt", { ...promptText, sessionId: io.sessionId })
    const req = await io.nextRequest()
    const options = ((req.frame.params as { options?: Array<{ optionId: string }> }).options ?? [])
    io.respond(req.id, { outcome: { outcome: "selected", optionId: options.find(o => o.optionId === "allow_session")?.optionId ?? options[0]?.optionId ?? "deny" } })
    await pending
  })
  if (wants("commands")) await record("commands", async io => {
    await io.send("session/prompt", { ...promptText, sessionId: io.sessionId })
  })
  if (wants("history")) await record("history", async io => {
    await io.send("session/load", { sessionId: "history-seed", cwd: io.workspace, mcpServers: [] })
  })
}
await main()
