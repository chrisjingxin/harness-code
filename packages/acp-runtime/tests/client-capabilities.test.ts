/** HC-226：工作区隔离 fs/* 与可选 terminal/* 反向 RPC 的功能、越界拒绝与进程清理测试。 */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { LocalAcpHost, type LocalAcpEvent } from "../dist/index.js"

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")

const capabilityAgentScript = `
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)}

let clientCaps = {}
let createdTerminalId = null

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(connection => ({
  async initialize(params) {
    clientCaps = params.clientCapabilities ?? {}
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "cap-agent", version: "0.1.0" } }
  },
  async newSession() {
    return { sessionId: "cap-sess-1" }
  },
  async prompt(params) {
    const text = params.prompt.filter(b => b.type === "text").map(b => b.text).join("\\n")
    const out = { clientCaps }
    if (text === "test-fs") {
      const target = process.env.TEST_TARGET_IN
      const outside = process.env.TEST_OUTSIDE
      const symlinkEscape = process.env.TEST_SYMLINK_ESCAPE
      const symlinkDirEscape = process.env.TEST_SYMLINK_DIR_ESCAPE
      const symlinkDangling = process.env.TEST_SYMLINK_DANGLING
      const traversalPath = process.env.TEST_TRAVERSAL
      const nestedWrite = process.env.TEST_NESTED_WRITE
      out.readOk = await connection.readTextFile({ sessionId: params.sessionId, path: target, line: 2, limit: 2 })
      await connection.writeTextFile({ sessionId: params.sessionId, path: nestedWrite, content: "written-ok\\nline2" })
      out.readBack = await connection.readTextFile({ sessionId: params.sessionId, path: nestedWrite })
      for (const [label, badPath, mode] of [
        ["outsideRead", outside, "read"],
        ["outsideWrite", outside, "write"],
        ["traversalRead", traversalPath, "read"],
        ["symlinkRead", symlinkEscape, "read"],
        ["symlinkDirWrite", symlinkDirEscape, "write"],
        ["symlinkDanglingWrite", symlinkDangling, "write"],
      ]) {
        try {
          if (mode === "read") await connection.readTextFile({ sessionId: params.sessionId, path: badPath })
          else await connection.writeTextFile({ sessionId: params.sessionId, path: badPath, content: "pwn" })
          out[label] = "UNEXPECTED_OK"
        } catch (err) {
          out[label] = "REJECTED:" + (err?.code ?? err?.message)
        }
      }
    } else if (text === "test-fs-disabled") {
      try {
        await connection.readTextFile({ sessionId: params.sessionId, path: process.env.TEST_TARGET_IN })
        out.readDisabled = "UNEXPECTED_OK"
      } catch (err) {
        out.readDisabled = "REJECTED:" + (err?.code ?? "")
      }
      try {
        await connection.writeTextFile({ sessionId: params.sessionId, path: process.env.TEST_TARGET_IN, content: "x" })
        out.writeDisabled = "UNEXPECTED_OK"
      } catch (err) {
        out.writeDisabled = "REJECTED:" + (err?.code ?? "")
      }
    } else if (text === "test-terminal") {
      const term = await connection.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write('hello-中文-terminal-output')"],
        outputByteLimit: 18,
      })
      createdTerminalId = term.id
      const exit = await term.waitForExit()
      const termOut = await term.currentOutput()
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "term-tool-1",
          title: "Run node",
          kind: "execute",
          status: "completed",
          content: [{ type: "terminal", terminalId: term.id }],
        },
      })
      await term.release()
      try {
        await connection.createTerminal({
          sessionId: params.sessionId,
          command: process.execPath,
          args: ["-e", "console.log(1)"],
          cwd: process.env.TEST_OUTSIDE_DIR,
        })
        out.outsideCwd = "UNEXPECTED_OK"
      } catch (err) {
        out.outsideCwd = "REJECTED:" + (err?.code ?? "")
      }
      out.exit = exit
      out.termOut = termOut
    } else if (text === "test-terminal-leak") {
      const term = await connection.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ["-e", "const fs=require('fs'); fs.writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000);"],
      })
      out.spawnedId = term.id
      // 等待子进程写出 PID 后直接结束 turn，不调用 release()，验证运行时自动清理。
      await new Promise(r => setTimeout(r, 250))
    } else if (text === "test-terminal-disabled") {
      try {
        await connection.createTerminal({ sessionId: params.sessionId, command: process.execPath, args: ["-e", "1"] })
        out.termDisabled = "UNEXPECTED_OK"
      } catch (err) {
        out.termDisabled = "REJECTED:" + (err?.code ?? "")
      }
    }

    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(out) } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {},
}), stream)
`

const scope = {
  accountId: "acc-cap",
  workspaceId: "ws-cap",
  projectId: "proj-cap",
  conversationId: "conv-cap",
}

async function runTurn(session: { subscribe: (fn: (e: LocalAcpEvent) => void) => () => void; send: (t: string) => { status: string } }, text: string): Promise<{ events: LocalAcpEvent[]; json: Record<string, any> }> {
  const events: LocalAcpEvent[] = []
  let unsub = () => {}
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cap turn timeout")), 10_000)
    unsub = session.subscribe(ev => {
      events.push(ev)
      if (ev.type === "completed" || ev.type === "failed" || ev.type === "cancelled") {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  try {
    const res = session.send(text)
    assert.equal(res.status, "accepted")
    await done
    const raw = events
      .filter((e): e is Extract<LocalAcpEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map(e => e.text)
      .join("")
    return { events, json: raw ? JSON.parse(raw) : {} }
  } finally {
    unsub()
  }
}

test("fs/* 默认启用且严格沙箱在工作区内（含 line/limit、符号链接逃逸与悬空链接写入拦截）", async () => {
  const base = await mkdtemp(join(tmpdir(), "acp-fs-jail-"))
  const workspace = join(base, "ws")
  const outsideDir = join(base, "outside")
  const outsideFile = join(outsideDir, "secret.txt")
  const inFile = join(workspace, "sample.txt")
  const nestedWrite = join(workspace, "nested", "dir", "created.txt")
  const symlinkEscape = join(workspace, "escape-link.txt")
  const symlinkDir = join(workspace, "escape-dir")
  const symlinkDirEscape = join(symlinkDir, "sub", "pwn.txt")
  const symlinkDangling = join(workspace, "dangling-link.txt")
  const traversalPath = join(workspace, "..", "outside", "secret.txt")

  try {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(workspace, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(inFile, "line1\nline2\nline3\nline4", "utf8")
    await writeFile(outsideFile, "TOP_SECRET", "utf8")
    await symlink(outsideFile, symlinkEscape)
    await symlink(outsideDir, symlinkDir)
    await symlink(join(outsideDir, "dangling.txt"), symlinkDangling)

    const host = new LocalAcpHost({
      executable: process.execPath,
      args: ["--input-type=module", "-e", capabilityAgentScript],
      env: {
        ...process.env,
        TEST_TARGET_IN: inFile,
        TEST_OUTSIDE: outsideFile,
        TEST_TRAVERSAL: traversalPath,
        TEST_SYMLINK_ESCAPE: symlinkEscape,
        TEST_SYMLINK_DIR_ESCAPE: symlinkDirEscape,
        TEST_SYMLINK_DANGLING: symlinkDangling,
        TEST_NESTED_WRITE: nestedWrite,
      },
    })
    try {
      const session = await host.bind(scope, workspace)
      const { events, json } = await runTurn(session, "test-fs")
      assert.equal(events.at(-1)?.type, "completed")
      assert.deepEqual(json.clientCaps.fs, { readTextFile: true, writeTextFile: true })
      assert.equal(Boolean(json.clientCaps.terminal), false)
      assert.deepEqual(json.readOk, { content: "line2\nline3" })
      assert.deepEqual(json.readBack, { content: "written-ok\nline2" })
      assert.equal(await readFile(nestedWrite, "utf8"), "written-ok\nline2")
      assert.ok(String(json.outsideRead).startsWith("REJECTED:"))
      assert.ok(String(json.outsideWrite).startsWith("REJECTED:"))
      assert.ok(String(json.traversalRead).startsWith("REJECTED:"))
      assert.ok(String(json.symlinkRead).startsWith("REJECTED:"))
      assert.ok(String(json.symlinkDirWrite).startsWith("REJECTED:"))
      assert.ok(String(json.symlinkDanglingWrite).startsWith("REJECTED:"))
      assert.equal(await readFile(outsideFile, "utf8"), "TOP_SECRET")
    } finally {
      await host.close()
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("enableClientFs=false 与 enableClientTerminal=false 时不声明能力且拒绝反向 RPC", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-cap-off-"))
  const file = join(workspace, "a.txt")
  await writeFile(file, "hello", "utf8")
  const host = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", capabilityAgentScript],
    env: { ...process.env, TEST_TARGET_IN: file },
  }, { enableClientFs: false, enableClientTerminal: false })

  try {
    const session = await host.bind(scope, workspace)
    const fsRes = await runTurn(session, "test-fs-disabled")
    assert.equal(Boolean(fsRes.json.clientCaps.fs?.readTextFile), false)
    assert.equal(Boolean(fsRes.json.clientCaps.fs?.writeTextFile), false)
    assert.equal(Boolean(fsRes.json.clientCaps.terminal), false)
    assert.equal(fsRes.json.readDisabled, "REJECTED:-32601")
    assert.equal(fsRes.json.writeDisabled, "REJECTED:-32601")

    const termRes = await runTurn(session, "test-terminal-disabled")
    assert.equal(termRes.json.termDisabled, "REJECTED:-32601")
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("enableClientTerminal=true 支持终端生命周期、UTF-8 截断、工作区 cwd 校验与轮次结束自动清理", async () => {
  const base = await mkdtemp(join(tmpdir(), "acp-term-"))
  const workspace = join(base, "ws")
  const outsideDir = join(base, "outside")
  const pidFile = join(workspace, "spawned.pid")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(workspace, { recursive: true })
  await mkdir(outsideDir, { recursive: true })

  const host = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", capabilityAgentScript],
    env: { ...process.env, TEST_OUTSIDE_DIR: outsideDir, PID_FILE: pidFile },
  }, { enableClientTerminal: true })

  try {
    const session = await host.bind(scope, workspace)
    const { events, json } = await runTurn(session, "test-terminal")
    assert.equal(events.at(-1)?.type, "completed")
    assert.equal(json.clientCaps.terminal, true)
    assert.equal(json.exit.exitCode, 0)
    assert.equal(json.termOut.truncated, true)
    assert.ok(Buffer.byteLength(json.termOut.output, "utf8") <= 18)
    assert.equal(json.termOut.output.includes("\uFFFD"), false)
    assert.ok(String(json.outsideCwd).startsWith("REJECTED:"))
    const toolEv = events.find((e): e is Extract<LocalAcpEvent, { type: "tool" }> => e.type === "tool")
    assert.ok(toolEv?.tool.terminalId)

    // 轮次结束未手动 release 的终端进程应被自动杀掉
    const leakRes = await runTurn(session, "test-terminal-leak")
    assert.equal(leakRes.events.at(-1)?.type, "completed")
    const pid = Number((await readFile(pidFile, "utf8")).trim())
    assert.ok(Number.isInteger(pid) && pid > 0)
    await new Promise(r => setTimeout(r, 150))
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    assert.equal(alive, false, `leaked terminal pid ${pid} should have been killed on turn finish`)
  } finally {
    await host.close()
    await rm(base, { recursive: true, force: true })
  }
})
