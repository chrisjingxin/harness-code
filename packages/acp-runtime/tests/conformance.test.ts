/** HC-226：标准 ACP 一致性测试套件（runAcpConformanceSuite）正例与反例验证。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { runAcpConformanceSuite } from "../dist/index.js"

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")

const buildMockAgentScript = (options: { loadSession: boolean; failCancel?: boolean }) => `
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)}

let cancelRequested = false
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(connection => ({
  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "conformance-mock", version: "1.0.0" },
      agentCapabilities: { loadSession: ${options.loadSession ? "true" : "false"} },
    }
  },
  async newSession() {
    return { sessionId: "conf-sess-" + Math.random().toString(36).slice(2, 7) }
  },
  async loadSession(params) {
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed-user" } },
    })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed-agent" } },
    })
    return {}
  },
  async prompt(params) {
    const text = params.prompt.filter(b => b.type === "text").map(b => b.text).join("\\n")
    if (text === "tool") {
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Inspect", kind: "read", status: "in_progress" },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed", rawOutput: "ok" },
      })
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool-done" } },
      })
      return { stopReason: "end_turn" }
    }
    if (text === "permission") {
      const res = await connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "p-1", title: "Write file", kind: "edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      })
      const picked = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perm:" + picked } },
      })
      return { stopReason: "end_turn" }
    }
    if (text === "slow") {
      cancelRequested = false
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working..." } },
      })
      for (let i = 0; i < 40; i++) {
        if (cancelRequested) {
          return { stopReason: ${options.failCancel ? '"end_turn"' : '"cancelled"'} }
        }
        await new Promise(r => setTimeout(r, 25))
      }
      return { stopReason: "end_turn" }
    }
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello:" + text } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {
    cancelRequested = true
  },
}), stream)
`

test("runAcpConformanceSuite 对支持 loadSession 的标准 mock Agent 全项通过", async () => {
  const report = await runAcpConformanceSuite({
    executable: process.execPath,
    args: ["--input-type=module", "-e", buildMockAgentScript({ loadSession: true })],
    env: process.env,
  })
  assert.equal(report.passed, true, JSON.stringify(report.checks, null, 2))
  assert.equal(report.summary.fail, 0)
  assert.equal(report.protocolVersion, 1)
  assert.equal(report.agentInfo?.name, "conformance-mock")
  assert.ok(report.checks.length >= 7)
})

test("runAcpConformanceSuite 对不支持 loadSession 的 Agent 验证回退恢复并全项通过", async () => {
  const report = await runAcpConformanceSuite({
    executable: process.execPath,
    args: ["--input-type=module", "-e", buildMockAgentScript({ loadSession: false })],
    env: process.env,
  })
  assert.equal(report.passed, true, JSON.stringify(report.checks, null, 2))
  const restoreCheck = report.checks.find(c => c.id === "session-restore-or-fallback")
  assert.equal(restoreCheck?.status, "pass")
  assert.ok(restoreCheck?.detail?.includes("reset"))
})

test("runAcpConformanceSuite 能准确检出违反 cancel 终态语义的缺陷 Agent", async () => {
  const report = await runAcpConformanceSuite({
    executable: process.execPath,
    args: ["--input-type=module", "-e", buildMockAgentScript({ loadSession: true, failCancel: true })],
    env: process.env,
  })
  assert.equal(report.passed, false)
  const cancelCheck = report.checks.find(c => c.id === "cancel-turn")
  assert.equal(cancelCheck?.status, "fail")
})
