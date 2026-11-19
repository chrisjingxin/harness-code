/**
 * `@workbench/acp-runtime` 多代理注册表与标准外部命令接入测试：
 * 使用标准 `@agentclientprotocol/sdk` Mock 子进程验证多实例优先级、自动降级、
 * `createCommandAgentDescriptor` / `WORKBENCH_ACP_EXECUTABLE` 外部命令接入、无扩展纯标准 ACP 问答与统一关闭。
 */
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  AcpAgentRegistry,
  createCommandAgentDescriptor,
  parseCustomAcpCommand,
  type AcpAgentDescriptor,
} from "../dist/index.js"
import type { LocalAcpSessionState } from "../dist/types.js"

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")

const standardAcpMockScript = `
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)}
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(connection => ({
  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "standard-mock", version: "1.0.0" },
      agentCapabilities: { loadSession: false },
    }
  },
  async newSession() {
    return {
      sessionId: "std-session-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "默认" }, { id: "plan", name: "计划" }] },
    }
  },
  async setSessionMode() { return {} },
  async prompt(params) {
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "std:" + (process.env.MOCK_AGENT_TAG || "none") } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {},
}), stream)
`

function mockAgentDescriptor(id: string, label: string, available: boolean, tag = id): AcpAgentDescriptor {
  return {
    id,
    label,
    description: `${label} Mock 描述符`,
    family: id,
    hostHints: { enableElicitation: true, enableClientFs: true, restorePolicy: "fallback-new" },
    resolveCommand(env = process.env) {
      if (!available) return { available: false, reason: `${label} 不可用` }
      return {
        available: true,
        source: "mock",
        command: {
          executable: process.execPath,
          args: ["--input-type=module", "-e", standardAcpMockScript],
          env: { ...env, MOCK_AGENT_TAG: tag },
        },
      }
    },
  }
}

test("AcpAgentRegistry 支持多实例优先级、首选不可用自动降级与自定义命令优先", () => {
  const emptyRegistry = new AcpAgentRegistry({ env: { PATH: "" } })
  assert.deepEqual(emptyRegistry.listProviders(), { providers: [], defaultProviderId: null })
  assert.equal(emptyRegistry.getHost().available, false)

  const fallbackRegistry = new AcpAgentRegistry({
    env: {},
    descriptors: [
      mockAgentDescriptor("alpha", "Alpha", false),
      mockAgentDescriptor("beta", "Beta", true),
      mockAgentDescriptor("gamma", "Gamma", true),
    ],
  })
  const fallbackList = fallbackRegistry.listProviders()
  assert.deepEqual(fallbackList.providers.map(p => p.id), ["alpha", "beta", "gamma"])
  assert.equal(fallbackList.defaultProviderId, "beta")

  const customRegistry = new AcpAgentRegistry({
    env: {
      WORKBENCH_ACP_EXECUTABLE: process.execPath,
      WORKBENCH_ACP_ARGS_JSON: JSON.stringify(["--version"]),
    },
    descriptors: [mockAgentDescriptor("beta", "Beta", true)],
  })
  const customList = customRegistry.listProviders()
  assert.deepEqual(customList.providers.map(p => p.id), ["beta", "custom"])
  assert.equal(customList.defaultProviderId, "custom")
  assert.equal(customRegistry.hasProvider("custom"), true)
})

test("createCommandAgentDescriptor 与 parseCustomAcpCommand 支持路径探测并拦截非法配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hc231-acp-cmd-"))
  try {
    const binDir = join(dir, "bin")
    await mkdir(binDir, { recursive: true })
    const cmdName = process.platform === "win32" ? "external-acp.cmd" : "external-acp"
    const binPath = join(binDir, cmdName)
    await writeFile(binPath, "#!/bin/sh\nexit 0\n", "utf8")
    if (process.platform !== "win32") await chmod(binPath, 0o755)

    const byName = createCommandAgentDescriptor({
      id: "ext-cli",
      label: "外部 CLI",
      executable: "external-acp",
      args: ["--acp"],
    })
    const found = byName.resolveCommand({ PATH: binDir }, { includeDefaultGuiPath: false })
    assert.equal(found.available, true)
    if (found.available) {
      assert.deepEqual(found.command.args, ["--acp"])
    }

    const byAbs = createCommandAgentDescriptor({
      id: "ext-abs",
      label: "绝对路径 CLI",
      executable: binPath,
      args: ["--stdio"],
    })
    assert.equal(byAbs.resolveCommand({}, { includeDefaultGuiPath: false }).available, true)

    const traversal = createCommandAgentDescriptor({
      id: "bad-rel",
      label: "非法相对路径",
      executable: "../bin/external-acp",
    })
    assert.equal(traversal.resolveCommand({ PATH: binDir }, { includeDefaultGuiPath: false }).available, false)

    const parsed = parseCustomAcpCommand({
      WORKBENCH_ACP_EXECUTABLE: process.execPath,
      WORKBENCH_ACP_ARGS_JSON: '["--help"]',
    })
    assert.equal(parsed.executable, process.execPath)
    assert.deepEqual(parsed.args, ["--help"])

    assert.throws(() => parseCustomAcpCommand({ WORKBENCH_ACP_EXECUTABLE: "relative/bin" }))
    assert.throws(() => parseCustomAcpCommand({ WORKBENCH_ACP_EXECUTABLE: process.execPath, WORKBENCH_ACP_ARGS_JSON: "{}" }))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("AcpAgentRegistry 可切换纯标准无扩展 ACP 子进程并完成握手、问答、切模式与统一回收", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc231-acp-std-"))
  try {
    const workspace = join(root, "ws")
    const bindings = join(root, "bindings")
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(bindings, { recursive: true })])

    const registry = new AcpAgentRegistry({
      env: process.env,
      bindingDirectory: bindings,
      includeCustomFromEnv: false,
      descriptors: [
        mockAgentDescriptor("alpha", "Alpha", true, "alpha-agent"),
        mockAgentDescriptor("beta", "Beta", true, "beta-agent"),
      ],
    })
    const scope = {
      accountId: "11111111111111111111111111111111",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
    }

    const ask = async (providerId: string): Promise<{ reply: string; state: LocalAcpSessionState }> => {
      const resolved = registry.getHost(providerId)
      assert.equal(resolved.available, true)
      const session = await resolved.host.bind(scope, workspace)
      const state = await session.connect()
      assert.equal(state.connected, true)
      assert.equal(state.modes?.currentModeId, "default")
      await session.setMode("plan")
      assert.equal(session.getState().currentModeId, "plan")

      const done = new Promise<string>((resolve, reject) => {
        let text = ""
        const timer = setTimeout(() => reject(new Error("timeout")), 10_000)
        const unsub = session.subscribe(ev => {
          if (ev.type === "text-delta") text += ev.text
          if (ev.type === "completed") { clearTimeout(timer); unsub(); resolve(text) }
          if (ev.type === "failed" || ev.type === "cancelled") { clearTimeout(timer); unsub(); reject(new Error(ev.type)) }
        })
      })
      assert.equal(session.send("ping").status, "accepted")
      const reply = await done
      return { reply, state: session.getState() }
    }

    const resA = await ask("alpha")
    assert.equal(resA.reply, "std:alpha-agent")
    const resB = await ask("beta")
    assert.equal(resB.reply, "std:beta-agent")

    await registry.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
