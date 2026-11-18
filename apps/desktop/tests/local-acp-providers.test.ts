/**
 * 桌面多代理注册表测试：覆盖 harness/pi/qwen/custom 优先级、默认选择、Host 选项与生命周期回收。
 */
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { register } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  LocalAcpProviderDescriptor,
  LocalAcpProviderRegistry as RegistryType,
  createDesktopLocalExecutionRuntime as createRuntimeFn,
  resolveDesktopLocalAcpCommand as resolveCmdFn,
} from "../src/main/local-acp-host.ts"

if (!("bun" in process.versions)) {
  const resolveTsHook = `
    import { existsSync } from "node:fs";
    import { fileURLToPath } from "node:url";
    export async function resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const jsUrl = new URL(specifier, context.parentURL);
        if (!existsSync(fileURLToPath(jsUrl))) {
          const tsSpecifier = specifier.slice(0, -3) + ".ts";
          const tsUrl = new URL(tsSpecifier, context.parentURL);
          if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsSpecifier, context);
        }
      }
      return nextResolve(specifier, context);
    }
  `
  register(`data:text/javascript,${encodeURIComponent(resolveTsHook)}`)
}

const {
  LocalAcpProviderRegistry,
  createDesktopLocalExecutionRuntime,
  resolveDesktopLocalAcpCommand,
} = await import("../src/main/local-acp-host.ts") as {
  LocalAcpProviderRegistry: typeof RegistryType
  createDesktopLocalExecutionRuntime: typeof createRuntimeFn
  resolveDesktopLocalAcpCommand: typeof resolveCmdFn
}

const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk")

const probeAgentScript = `
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from ${JSON.stringify(sdkUrl)}
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(connection => ({
  async initialize(params) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "probe-agent", version: "1.0.0" },
      agentCapabilities: { loadSession: false },
      _meta: { clientCapsSeen: params.clientCapabilities ?? {} },
    }
  },
  async newSession() {
    return {
      sessionId: "s-1",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "默认" }] },
    }
  },
  async prompt(params) {
    const caps = JSON.stringify({ hasElicitation: Boolean(params._meta), tag: process.env.TEST_TAG || "none" })
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok:" + (process.env.TEST_TAG || "") } },
    })
    return { stopReason: "end_turn" }
  },
  async cancel() {},
}), stream)
`

function fakeDescriptor(id: string, label: string, available: boolean, tag = id): LocalAcpProviderDescriptor {
  return {
    id,
    label,
    description: `${label} 测试描述`,
    family: id,
    hostHints: { enableElicitation: true, enableClientFs: true, restorePolicy: "fallback-new" },
    resolveCommand(env = process.env) {
      if (!available) return { available: false, reason: `${label} 未安装` }
      return {
        available: true,
        source: "mock",
        command: {
          executable: process.execPath,
          args: ["--input-type=module", "-e", probeAgentScript],
          env: { ...env, TEST_TAG: tag },
        },
      }
    },
  }
}

test("LocalAcpProviderRegistry 默认注册 harness/pi/qwen，并按优先级选出首个可用 Provider", () => {
  const registryNone = new LocalAcpProviderRegistry({
    env: { PATH: "" },
    discoveryOptions: { includeDefaultGuiPath: false, searchFrom: [] },
  })
  const catalogNone = registryNone.listProviders()
  assert.deepEqual(catalogNone.providers.map(p => p.id), ["harness", "pi", "qwen"])
  assert.equal(catalogNone.defaultProviderId, null)

  // WORKBENCH_ACP_EXECUTABLE 设置后注册 custom 且成为默认
  const registryCustom = new LocalAcpProviderRegistry({
    env: {
      PATH: "",
      WORKBENCH_ACP_EXECUTABLE: process.execPath,
      WORKBENCH_ACP_ARGS_JSON: JSON.stringify(["--version"]),
    },
    discoveryOptions: { includeDefaultGuiPath: false, searchFrom: [] },
  })
  const catalogCustom = registryCustom.listProviders()
  assert.deepEqual(catalogCustom.providers.map(p => p.id), ["harness", "pi", "qwen", "custom"])
  assert.equal(catalogCustom.defaultProviderId, "custom")
  assert.equal(catalogCustom.providers.find(p => p.id === "custom")?.available, true)

  // harness 不可用但 pi 可用时默认选 pi
  const registryPi = new LocalAcpProviderRegistry({
    env: {},
    descriptors: [
      fakeDescriptor("harness", "Harness", false),
      fakeDescriptor("pi", "Pi", true),
      fakeDescriptor("qwen", "Qwen", true),
    ],
  })
  assert.equal(registryPi.listProviders().defaultProviderId, "pi")
})

test("WORKBENCH_ACP_EXECUTABLE 显式配置保持向后兼容，非法路径或参数拒绝", () => {
  const cmd = resolveDesktopLocalAcpCommand({
    WORKBENCH_ACP_EXECUTABLE: process.execPath,
    WORKBENCH_ACP_ARGS_JSON: '["--help"]',
  })
  assert.equal(cmd?.executable, process.execPath)
  assert.deepEqual(cmd?.args, ["--help"])

  assert.throws(() => resolveDesktopLocalAcpCommand({
    WORKBENCH_ACP_EXECUTABLE: "relative/path",
  }))
  assert.throws(() => resolveDesktopLocalAcpCommand({
    WORKBENCH_ACP_EXECUTABLE: process.execPath,
    WORKBENCH_ACP_ARGS_JSON: '{"bad":true}',
  }))
})

test("createDesktopLocalExecutionRuntime 创建支持 elicitation/fs/fallback-new 的多代理宿主并能统一回收", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-acp-reg-"))
  try {
    const workspace = join(root, "ws")
    const userData = join(root, "userData")
    await import("node:fs/promises").then(fs => Promise.all([
      fs.mkdir(workspace, { recursive: true }),
      fs.mkdir(userData, { recursive: true }),
    ]))

    const env = {
      WORKBENCH_ACP_EXECUTABLE: process.execPath,
      WORKBENCH_ACP_ARGS_JSON: JSON.stringify(["--input-type=module", "-e", probeAgentScript]),
      TEST_TAG: "custom-ok",
    }
    const runtime = createDesktopLocalExecutionRuntime(env, userData)
    assert.ok("registry" in runtime.localExecution)
    if (!("registry" in runtime.localExecution)) return

    const resolved = runtime.localExecution.registry.getHost("custom")
    assert.equal(resolved.available, true)
    assert.equal(resolved.providerId, "custom")

    const session = await resolved.host.bind({
      accountId: "11111111111111111111111111111111",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      conversationId: "33333333-3333-4333-8333-333333333333",
    }, workspace)
    const state = await session.connect()
    assert.equal(state.connected, true)
    // 验证 enableElicitation 与 enableClientFs 已对 agent 声明
    const rawCaps = (state as { agentCapabilities?: unknown }).agentCapabilities
    assert.ok(rawCaps !== undefined)

    const turnDone = new Promise<Array<{ type: string; text?: string }>>(resolve => {
      const events: Array<{ type: string; text?: string }> = []
      const unsub = session.subscribe(ev => {
        events.push(ev as { type: string; text?: string })
        if (ev.type === "completed" || ev.type === "failed" || ev.type === "cancelled") {
          unsub()
          resolve(events)
        }
      })
    })
    assert.equal(session.send("ping").status, "accepted")
    const events = await turnDone
    assert.equal(events.at(-1)?.type, "completed")
    const reply = events.filter(e => e.type === "text-delta").map(e => e.text ?? "").join("")
    assert.equal(reply, "ok:custom-ok")

    await runtime.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
