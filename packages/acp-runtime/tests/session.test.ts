/** 验证 BoundSession / LocalAcpHost 在权限审批请求中透传完整工具细节（diff、参数、locations）及应答生命周期。 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { LocalAcpHost } from "../dist/index.js"
import { buildNativeBindingIdentity } from "../dist/native-binding.js"

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")
const stubAgentScript = `
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(connection => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "perm-test", version: "0.0.1" } }
  },
  async newSession() {
    return { sessionId: "test-session-1" }
  },
  async authenticate() { return {} },
  async prompt(params) {
    const decision = await connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "perm-call-1",
        title: "edit_file secret.json",
        kind: "edit",
        rawInput: { path: "secret.json", mode: "patch" },
        locations: [{ path: "secret.json", line: 7 }],
        content: [{ type: "diff", path: "secret.json", oldText: "a", newText: "b" }],
      },
      options: [
        { optionId: "allow", name: "允许一次", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    })
    const picked = decision.outcome.outcome === "selected" ? decision.outcome.optionId : "cancelled"
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "decision:" + picked } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {},
}), stream)
`

test("permission 请求携带规范化工具 details（locations/diffs/input）并可正常应答完成", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-session-perm-"))
  const host = new LocalAcpHost({
    executable: process.execPath,
    args: ["--input-type=module", "-e", stubAgentScript],
    env: process.env,
  })
  try {
    const session = await host.bind({
      accountId: "acc-1",
      workspaceId: "ws-1",
      projectId: "proj-1",
      conversationId: "conv-1",
    }, workspace)
    const events: unknown[] = []
    let turnId = ""
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("permission smoke timeout")), 10_000)
      session.subscribe(event => {
        events.push(event)
        if (event.type === "permission" && event.request) {
          assert.equal(event.request.title, "edit_file secret.json")
          assert.equal(event.request.tool?.id, "perm-call-1")
          assert.equal(event.request.tool?.kind, "edit")
          assert.deepEqual(event.request.tool?.locations, [{ path: "secret.json", line: 7 }])
          assert.deepEqual(event.request.tool?.diffs, [{ path: "secret.json", oldText: "a", newText: "b" }])
          assert.ok(event.request.tool?.input?.includes('"secret.json"'))
          assert.equal(session.answerPermission(turnId, event.request.id, "allow"), true)
        }
        if (event.type === "completed") {
          clearTimeout(timer)
          resolve()
        }
        if (event.type === "failed" || event.type === "cancelled") {
          clearTimeout(timer)
          reject(new Error(`unexpected terminal: ${JSON.stringify(event)}`))
        }
      })
    })
    const receipt = session.send("请触发权限审批")
    assert.equal(receipt.status, "accepted")
    if (receipt.status !== "accepted") return
    turnId = receipt.turnId
    await finished
    const texts = events
      .filter((e): e is { type: "text-delta"; text: string } => (e as { type?: string }).type === "text-delta")
      .map(e => e.text)
      .join("")
    assert.equal(texts, "decision:allow")
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("LocalAcpHost 支持无团队与未发布会话，并在发布与停止共享前后复用同一原生绑定与内存会话", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "acp-scope-continuity-"))
  const bindings = await mkdtemp(join(tmpdir(), "acp-scope-bindings-"))
  const host = new LocalAcpHost(
    {
      executable: process.execPath,
      args: ["--input-type=module", "-e", stubAgentScript],
      env: process.env,
    },
    { bindingDirectory: bindings, bindingNamespace: "test-ns" },
  )
  try {
    const soloScope = {
      accountId: "acc-1",
      workspaceId: null,
      projectId: null,
      conversationId: "conv-continuity-1",
    }
    const teamPublishedScope = {
      accountId: "acc-1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      conversationId: "conv-continuity-1",
    }
    const teamPersonalScope = {
      accountId: "acc-1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: null,
      conversationId: "conv-continuity-1",
    }

    assert.deepEqual(
      buildNativeBindingIdentity("test-ns", soloScope, workspace, 1n, 2n),
      buildNativeBindingIdentity("test-ns", teamPublishedScope, workspace, 1n, 2n),
    )

    const s1 = await host.bind(soloScope, workspace)
    const s2 = await host.bind(teamPersonalScope, workspace)
    const s3 = await host.bind(teamPublishedScope, workspace)
    assert.equal(s1, s2)
    assert.equal(s2, s3)
  } finally {
    await host.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(bindings, { recursive: true, force: true })
  }
})
