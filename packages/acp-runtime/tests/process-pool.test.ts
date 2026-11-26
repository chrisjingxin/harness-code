/**
 * 验证 `@workbench/acp-runtime` 的共享进程复用、能力缓存、空闲超时回收与全局 LRU 预算淘汰。
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  AcpAgentRegistry,
  LocalAcpHost,
  type AcpAgentDescriptor,
  type LocalAcpEvent,
  type LocalAcpSession,
} from "../dist/index.js"

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")

const poolAgentScript = `
import fs from "node:fs"
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from ${JSON.stringify(sdkUrl)}

const tracePath = process.env.POOL_TRACE
const failResumeIds = new Set((process.env.FAIL_RESUME_IDS || "").split(",").filter(Boolean))
const log = (type, extra = {}) => {
  if (!tracePath) return
  fs.appendFileSync(tracePath, JSON.stringify({ pid: process.pid, type, ...extra }) + "\\n")
}

let seq = 0
const liveSessions = new Map()
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))

log("boot")
process.on("exit", () => log("exit"))

new AgentSideConnection(connection => ({
  async initialize() {
    log("initialize")
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "pool-mock", version: "1.0.0" },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          resume: {},
          close: {},
        },
      },
    }
  },
  async newSession() {
    const sessionId = "sess-" + process.pid + "-" + (++seq)
    liveSessions.set(sessionId, { mode: "default" })
    log("session/new", { sessionId })
    void connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "压缩上下文" }],
      },
    })
    return {
      sessionId,
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "默认" }, { id: "plan", name: "计划" }] },
    }
  },
  async resumeSession(params) {
    log("session/resume", { sessionId: params.sessionId })
    if (failResumeIds.has(params.sessionId)) {
      throw RequestError.invalidParams("session not found")
    }
    liveSessions.set(params.sessionId, { mode: "default" })
    return {
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "默认" }, { id: "plan", name: "计划" }] },
    }
  },
  async loadSession(params) {
    log("session/load", { sessionId: params.sessionId })
    liveSessions.set(params.sessionId, { mode: "default" })
    return {
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "默认" }] },
    }
  },
  async closeSession(params) {
    log("session/close", { sessionId: params.sessionId })
    liveSessions.delete(params.sessionId)
    return {}
  },
  async prompt(params) {
    const text = params.prompt.filter(b => b.type === "text").map(b => b.text).join("\\n")
    log("prompt", { sessionId: params.sessionId, text })
    if (text === "ask-permission") {
      const decision = await connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "perm-" + params.sessionId, title: "允许操作 " + params.sessionId, kind: "edit" },
        options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
      })
      const chosen = decision.outcome.outcome === "selected" ? decision.outcome.optionId : "cancelled"
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.sessionId + ":" + chosen } },
      })
      return { stopReason: "end_turn" }
    }
    if (text.startsWith("slow:")) {
      const ms = Number(text.slice(5)) || 200
      await new Promise(resolve => setTimeout(resolve, ms))
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "slow-done:" + process.pid } },
      })
      return { stopReason: "end_turn" }
    }
    if (text === "use-terminal") {
      const term = await connection.createTerminal({
        sessionId: params.sessionId,
        command: process.execPath,
        args: ["-e", "process.stdout.write('term-' + process.pid)"],
      })
      await term.waitForExit()
      const out = await term.currentOutput()
      await term.release()
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "term:" + out.output } },
      })
      return { stopReason: "end_turn" }
    }
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.sessionId + "@" + process.pid + ":" + text } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {},
}), stream)
`

type TraceEntry = { pid: number; type: string; sessionId?: string; text?: string }

async function readTrace(tracePath: string): Promise<TraceEntry[]> {
  const raw = await readFile(tracePath, "utf8").catch(() => "")
  return raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as TraceEntry)
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("等待条件超时")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function sendAndCollect(session: LocalAcpSession, text: string): Promise<{ events: LocalAcpEvent[]; reply: string }> {
  return new Promise((resolve, reject) => {
    const events: LocalAcpEvent[] = []
    let reply = ""
    const timer = setTimeout(() => reject(new Error(`turn timeout: ${text}`)), 5_000)
    const unsub = session.subscribe(event => {
      events.push(event)
      if (event.type === "text-delta") reply += event.text
      if (event.type === "completed") {
        clearTimeout(timer)
        unsub()
        resolve({ events, reply })
      }
      if (event.type === "failed" || event.type === "cancelled") {
        clearTimeout(timer)
        unsub()
        reject(new Error(`turn ended unexpectedly: ${JSON.stringify(event)}`))
      }
    })
    const receipt = session.send(text)
    if (receipt.status !== "accepted") {
      clearTimeout(timer)
      unsub()
      reject(new Error(`send rejected: ${receipt.reason}`))
    }
  })
}

function makePoolDescriptor(
  id: string,
  tracePath: string,
  shareProcessPerWorkspace: boolean,
): AcpAgentDescriptor {
  return {
    id,
    label: id,
    description: `${id} test agent`,
    family: id,
    hostHints: {
      enableElicitation: true,
      enableClientFs: true,
      enableClientTerminal: true,
      restorePolicy: "fallback-new",
      shareProcessPerWorkspace,
    },
    resolveCommand(env = process.env) {
      return {
        available: true,
        source: "test",
        command: {
          executable: process.execPath,
          args: ["--input-type=module", "-e", poolAgentScript],
          env: { ...env, POOL_TRACE: tracePath },
        },
      }
    },
  }
}

test("shareProcessPerWorkspace 同目录多会话复用同一进程、隔离权限与终端、缓存能力且 close 不误杀", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-pool-share-"))
  const cwd = join(root, "ws")
  const bindings = join(root, "bindings")
  const trace = join(root, "trace.jsonl")
  await Promise.all([mkdir(cwd), mkdir(bindings)])

  const host = new LocalAcpHost(
    { executable: process.execPath, args: ["--input-type=module", "-e", poolAgentScript], env: { ...process.env, POOL_TRACE: trace } },
    { bindingDirectory: bindings, shareProcessPerWorkspace: true, enableClientTerminal: true, enableClientFs: true },
  )
  const baseScope = { accountId: "acc-1", workspaceId: null, projectId: null }
  try {
    const s1 = await host.bind({ ...baseScope, conversationId: "conv-1" }, cwd)
    const s2 = await host.bind({ ...baseScope, conversationId: "conv-2" }, cwd)

    const [st1, st2] = await Promise.all([s1.connect(), s2.connect()])
    assert.equal(st1.connected, true)
    assert.equal(st2.connected, true)
    assert.ok(st1.sessionId && st2.sessionId && st1.sessionId !== st2.sessionId)

    // 第 3 个会话 bind 时立即命中同工作区能力缓存，且不泄露 connected / sessionId
    const s3 = await host.bind({ ...baseScope, conversationId: "conv-3" }, cwd)
    const preState3 = s3.getState()
    assert.equal(preState3.connected, false)
    assert.equal(preState3.sessionId, undefined)
    assert.equal(preState3.modes?.currentModeId, "default")
    assert.equal(preState3.availableCommands[0]?.name, "compact")

    // 两个会话并发请求权限审批，互相隔离互不串线
    let perm1TurnId = ""
    let perm2TurnId = ""
    const waitPerm1 = new Promise<void>(resolve => {
      const unsub = s1.subscribe(ev => {
        if (ev.type === "permission" && ev.request) {
          assert.match(ev.request.title, new RegExp(st1.sessionId!))
          assert.equal(s1.answerPermission(perm1TurnId, ev.request.id, "allow"), true)
        }
        if (ev.type === "completed") { unsub(); resolve() }
      })
    })
    const waitPerm2 = new Promise<void>(resolve => {
      const unsub = s2.subscribe(ev => {
        if (ev.type === "permission" && ev.request) {
          assert.match(ev.request.title, new RegExp(st2.sessionId!))
          assert.equal(s2.answerPermission(perm2TurnId, ev.request.id, "allow"), true)
        }
        if (ev.type === "completed") { unsub(); resolve() }
      })
    })
    const r1 = s1.send("ask-permission")
    const r2 = s2.send("ask-permission")
    assert.equal(r1.status === "accepted" && r2.status === "accepted", true)
    if (r1.status === "accepted") perm1TurnId = r1.turnId
    if (r2.status === "accepted") perm2TurnId = r2.turnId
    await Promise.all([waitPerm1, waitPerm2])

    const termRes = await sendAndCollect(s1, "use-terminal")
    assert.match(termRes.reply, /^term:term-/)

    // 关闭 s1：仅发送 session/close，不会杀死共享进程，s2 仍在同一 pid 上工作
    await s1.close()
    const res2 = await sendAndCollect(s2, "still-alive")
    assert.match(res2.reply, new RegExp(`^${st2.sessionId}@\\d+:still-alive$`))

    const entries = await readTrace(trace)
    assert.equal(entries.filter(e => e.type === "boot").length, 1)
    assert.equal(entries.filter(e => e.type === "initialize").length, 1)
    assert.deepEqual(entries.filter(e => e.type === "session/close").map(e => e.sessionId), [st1.sessionId])

    await host.close()
    await waitFor(async () => (await readTrace(trace)).some(e => e.type === "exit"))
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("共享进程下单个会话 resume 失败不杀共享进程，在同一进程平滑重建会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-pool-resume-fallback-"))
  const cwd = join(root, "ws")
  const bindings = join(root, "bindings")
  const trace = join(root, "trace.jsonl")
  await Promise.all([mkdir(cwd), mkdir(bindings)])

  const scope1 = { accountId: "acc-1", workspaceId: null, projectId: null, conversationId: "conv-ok" }
  const scope2 = { accountId: "acc-1", workspaceId: null, projectId: null, conversationId: "conv-stale" }

  const host1 = new LocalAcpHost(
    { executable: process.execPath, args: ["--input-type=module", "-e", poolAgentScript], env: { ...process.env } },
    { bindingDirectory: bindings, shareProcessPerWorkspace: true },
  )
  let staleId = ""
  try {
    const a = await host1.bind(scope1, cwd)
    const b = await host1.bind(scope2, cwd)
    await a.connect()
    staleId = (await b.connect()).sessionId!
  } finally {
    await host1.close()
  }

  const host2 = new LocalAcpHost(
    {
      executable: process.execPath,
      args: ["--input-type=module", "-e", poolAgentScript],
      env: { ...process.env, POOL_TRACE: trace, FAIL_RESUME_IDS: staleId },
    },
    { bindingDirectory: bindings, shareProcessPerWorkspace: true },
  )
  try {
    const a2 = await host2.bind(scope1, cwd)
    const stateA = await a2.connect()
    assert.equal(stateA.restoreStatus.kind, "restored")

    const b2 = await host2.bind(scope2, cwd)
    const stateB = await b2.connect()
    assert.equal(stateB.restoreStatus.kind, "reset")

    // a2 仍然在同一共享进程上正常运行
    const replyA = await sendAndCollect(a2, "after-reset")
    assert.match(replyA.reply, /:after-reset$/)

    const entries = await readTrace(trace)
    assert.equal(entries.filter(e => e.type === "boot").length, 1)
    assert.equal(entries.filter(e => e.type === "exit").length, 0)
  } finally {
    await host2.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("空闲超时自动回收进程且运行中轮次不被打断，再次发送自动 resume 续接", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-pool-idle-"))
  const cwd = join(root, "ws")
  const bindings = join(root, "bindings")
  const trace = join(root, "trace.jsonl")
  await Promise.all([mkdir(cwd), mkdir(bindings)])

  const host = new LocalAcpHost(
    { executable: process.execPath, args: ["--input-type=module", "-e", poolAgentScript], env: { ...process.env, POOL_TRACE: trace } },
    { bindingDirectory: bindings, shareProcessPerWorkspace: true, idleTimeoutMs: 120 },
  )
  try {
    const s = await host.bind({ accountId: "acc-1", workspaceId: null, projectId: null, conversationId: "conv-idle" }, cwd)
    const slow = await sendAndCollect(s, "slow:260")
    const firstPid = Number(slow.reply.split(":")[1])
    assert.ok(Number.isInteger(firstPid))

    // 轮次结束后超过 idleTimeoutMs (120ms)，进程应自动退出并回退到未连接态
    await waitFor(async () => {
      const entries = await readTrace(trace)
      return entries.some(e => e.type === "exit" && e.pid === firstPid)
    })
    assert.equal(s.getState().connected, false)

    // 再次发送自动重启新进程并走 session/resume 无感恢复
    const resumed = await sendAndCollect(s, "second-round")
    const entries = await readTrace(trace)
    const boots = entries.filter(e => e.type === "boot")
    assert.equal(boots.length, 2)
    assert.notEqual(boots[1]!.pid, firstPid)
    assert.equal(entries.some(e => e.type === "session/resume" && e.pid === boots[1]!.pid), true)
    assert.match(resumed.reply, new RegExp(`@${boots[1]!.pid}:second-round$`))
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("AcpAgentRegistry 全局 maxLiveProcesses LRU 淘汰最早空闲进程且不淘汰活跃轮次", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-pool-lru-"))
  const trace = join(root, "trace.jsonl")
  const ws1 = join(root, "ws1")
  const ws2 = join(root, "ws2")
  const ws3 = join(root, "ws3")
  const ws4 = join(root, "ws4")
  const bindings = join(root, "bindings")
  await Promise.all([mkdir(ws1), mkdir(ws2), mkdir(ws3), mkdir(ws4), mkdir(bindings)])

  const registry = new AcpAgentRegistry({
    env: process.env,
    bindingDirectory: bindings,
    includeCustomFromEnv: false,
    maxLiveProcesses: 2,
    idleTimeoutMs: 60_000,
    descriptors: [
      makePoolDescriptor("shared-agent", trace, true),
      makePoolDescriptor("std-agent", trace, false),
    ],
  })
  const baseScope = { accountId: "acc-1", workspaceId: null, projectId: null }
  try {
    const hShared = registry.getHost("shared-agent").host
    const hStd = registry.getHost("std-agent").host

    // 1. ws1 启动并挂起一个等待审批的活跃轮次（不可淘汰）
    const s1 = await hShared.bind({ ...baseScope, conversationId: "c1" }, ws1)
    let s1TurnId = ""
    let s1PermId = ""
    const s1PermSeen = new Promise<void>(resolve => {
      const unsub = s1.subscribe(ev => {
        if (ev.type === "permission" && ev.request) { s1PermId = ev.request.id; resolve() }
        if (ev.type === "completed") unsub()
      })
    })
    const s1Done = new Promise<void>((resolve, reject) => {
      const unsub = s1.subscribe(ev => {
        if (ev.type === "completed") { unsub(); resolve() }
        if (ev.type === "failed") { unsub(); reject(new Error(ev.reason)) }
      })
    })
    const rec1 = s1.send("ask-permission")
    assert.equal(rec1.status, "accepted")
    if (rec1.status === "accepted") s1TurnId = rec1.turnId
    await s1PermSeen

    // 2. ws2 完成一轮后空闲（pid2）
    const s2 = await hShared.bind({ ...baseScope, conversationId: "c2" }, ws2)
    await sendAndCollect(s2, "hi-ws2")
    let entries = await readTrace(trace)
    assert.equal(entries.filter(e => e.type === "boot").length, 2)
    const pid1 = entries.filter(e => e.type === "boot")[0]!.pid
    const pid2 = entries.filter(e => e.type === "boot")[1]!.pid

    // 3. ws3 启动：由于 s1 正在跑轮次且有挂起审批，必须淘汰空闲的 ws2 (pid2)，绝不淘汰 ws1 (pid1)
    const s3 = await hShared.bind({ ...baseScope, conversationId: "c3" }, ws3)
    await sendAndCollect(s3, "hi-ws3")
    entries = await readTrace(trace)
    assert.equal(entries.some(e => e.type === "exit" && e.pid === pid2), true)
    assert.equal(entries.some(e => e.type === "exit" && e.pid === pid1), false)

    // 4. 放行 s1 让其空闲，随后在另一 Provider 上打开 ws4：此时 pid1 比 pid3 更早活跃，应淘汰 pid1
    assert.equal(s1.answerPermission(s1TurnId, s1PermId, "allow"), true)
    await s1Done
    await new Promise(resolve => setTimeout(resolve, 25))
    await sendAndCollect(s3, "touch-ws3")

    const s4 = await hStd.bind({ ...baseScope, conversationId: "c4" }, ws4)
    await sendAndCollect(s4, "hi-ws4")
    entries = await readTrace(trace)
    assert.equal(entries.some(e => e.type === "exit" && e.pid === pid1), true)
    const pid3 = entries.filter(e => e.type === "boot")[2]!.pid
    assert.equal(entries.some(e => e.type === "exit" && e.pid === pid3), false)

    await registry.close()
  } finally {
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})
