/** CLI 启动层测试：验证工作区错误能在启动 Python 前得到清晰诊断。 */
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"
import { PassThrough, Readable } from "node:stream"

import {
  clientCapabilities,
  clientInteractionHandles,
  dispatchClientCommand,
  execute,
  readSettingValue,
  resolveAgentRuntimeLocations,
  validateInteractiveTerminal,
  validateWorkspace,
  workspaceFingerprint,
} from "../src/index"
import { AgentClient } from "../src/ipc/client"
import { StdioRpcTransport } from "../src/ipc/stdio-transport"
import { Capability } from "@za38/protocol"
import {
  bindPluginCommands,
  COMMANDS_BIND_MIN_MINOR,
} from "../src/ipc/command-binding"
import { parseArgs } from "../src/args"
import { CLI_VERSION } from "../src/interactive/runtime"
import { runtime as baseTestRuntime } from "./interactive/harness"

/** 只实现 request；订阅类方法（on / setRequestHandler 等）统一返回空取消函数。 */
function fakeAgentClient() {
  return new Proxy({}, {
    get: (_target, key) => (key === "then" ? undefined : key === "request" ? async () => ({}) : () => () => {}),
  })
}

/** 构造最小 fake Agent：只记录 stop 调用，其余交给真实的 controller / coordinator。 */
function interactiveFakeAgent(events: string[]) {
  return async () => ({
    client: fakeAgentClient() as never,
    runtime: { ...baseTestRuntime } as never,
    log: { event: () => {}, close: async () => {} } as never,
    stop: async () => {
      events.push("agent.stop")
    },
  })
}

/** 在交互模式下伪装成真实终端，避免 validateInteractiveTerminal 拒绝启动。 */
async function withFakeTty<T>(run: () => Promise<T>): Promise<T> {
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  try {
    return await run()
  } finally {
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
}

test("CLI shutdown 顺序：runTui 返回后 explorer → coordinator → controller 依次关闭，agent.stop 最后", async () => {
  const events: string[] = []
  const root = await mkdtemp(resolve(tmpdir(), "za38-shutdown-test-"))
  await withFakeTty(() =>
    execute(parseArgs([], root), {
      startAgent: interactiveFakeAgent(events),
      runTui: async options => {
        const spy = (name: string, target: { close: () => Promise<void> | void } | undefined) => {
          const original = target!.close.bind(target)
          target!.close = async () => {
            events.push(`${name}.close`)
            await original()
          }
        }
        spy("explorer", options.workspaceExplorer as never)
        spy("coordinator", options.webHandoff as never)
        spy("controller", options.controller as never)
        events.push("runTui.return")
      },
    }),
  )
  expect(events).toEqual([
    "runTui.return",
    "explorer.close",
    "coordinator.close",
    "controller.close",
    "agent.stop",
  ])
})

test("CLI shutdown：runTui 抛错时仍然关闭各层并停止 agent，错误原样抛出", async () => {
  const events: string[] = []
  const root = await mkdtemp(resolve(tmpdir(), "za38-shutdown-error-test-"))
  await expect(
    withFakeTty(() =>
      execute(parseArgs([], root), {
        startAgent: interactiveFakeAgent(events),
        runTui: async options => {
          const original = options.controller.close.bind(options.controller)
          options.controller.close = async () => {
            events.push("controller.close")
            await original()
          }
          throw new Error("tui boom")
        },
      }),
    ),
  ).rejects.toThrow("tui boom")
  expect(events).toEqual(["controller.close", "agent.stop"])
})

test("不存在的工作区会给出明确错误", () => {
  const missing = resolve(tmpdir(), `za38-missing-${crypto.randomUUID()}`)
  expect(() => validateWorkspace(missing)).toThrow("Workspace does not exist")
})

test("工作区必须是目录", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "za38-workspace-test-"))
  const file = resolve(root, "file.txt")
  await writeFile(file, "not a directory")
  expect(() => validateWorkspace(file)).toThrow("Workspace is not a directory")
})

test("CLI workspace fingerprint 使用平台真实路径且不暴露路径", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "za38-fingerprint-test-"))
  expect(await workspaceFingerprint(root)).toBe(
    createHash("sha256").update(await realpath(root)).digest("hex"),
  )
})

test("生产日志路径不再使用同步文件写入或旧 debug 目录", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/diagnostic-log/runtime/index.ts"), "utf8")
  expect(source).not.toContain("writeSync")
  expect(source).not.toContain('.harness", "debug')
})

test("sidecar stderr 使用有界 drain，不拼接原文", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/index.ts"), "utf8")
  expect(source).toContain("SidecarStderrDrain")
  expect(source).not.toContain("stderr += ")
  expect(source).not.toContain("stderrChunks")
})

test("交互界面拒绝经过管道或任务复用器启动", () => {
  expect(() => validateInteractiveTerminal(undefined, true)).toThrow("requires a real terminal")
  expect(() => validateInteractiveTerminal(true, false)).toThrow("requires a real terminal")
  expect(() => validateInteractiveTerminal(true, true)).not.toThrow()
})

test("开发形态：源码与 dist CLI 都解析到 packages/agent sidecar", () => {
  const packageDir = resolve(import.meta.dir, "..")
  const agentDir = resolve(packageDir, "../agent")
  const source = resolveAgentRuntimeLocations(resolve(packageDir, "src"))
  const dist = resolveAgentRuntimeLocations(resolve(packageDir, "dist"))

  expect(source.agentDirectories).toContain(agentDir)
  expect(dist.agentDirectories).toContain(agentDir)
  expect(source.pythonExecutables).toContain(resolve(agentDir, ".venv/bin/python"))
  expect(dist.pythonExecutables).toContain(resolve(agentDir, ".venv/bin/python"))
})

test("根 dev 命令按统一 npm 入口转入 CLI 的 Bun 运行边界并转发参数", async () => {
  const rootPackage = JSON.parse(await readFile(resolve(import.meta.dir, "../../../package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  const cliPackage = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  expect(rootPackage.scripts.dev).toBe("npm --workspace @za38/cli run dev --")
  expect(cliPackage.scripts.dev).toBe("bun src/index.ts")
})

test("无头 CLI 不声明 Interaction handler", () => {
  const headless = parseArgs(["-n", "读取 README"])
  const interactive = parseArgs([])
  expect(clientCapabilities(headless)).toEqual([
    "run.cancel",
    "run.multithread",
    "config.read",
  ])
  expect(clientInteractionHandles(headless)).toEqual([])
  expect(clientInteractionHandles(interactive)).toEqual(["approval", "question", "directory_trust", "plan", "goal"])
  expect(clientCapabilities(interactive)).toContain("threads.read")
  expect(clientCapabilities(interactive)).toContain("context.manage")
  // ZC-114：内置 Web 不再直连 Host，CLI 不声明 attachment/control 能力。
  expect(clientCapabilities(interactive)).not.toContain("host.attach")
  expect(clientCapabilities(interactive)).not.toContain("host.control")
  expect(clientCapabilities(interactive)).toContain("mcp.read")
  expect(clientCapabilities(interactive)).toContain("mcp.manage")
  expect(clientCapabilities(interactive)).toContain("agents.read")
  expect(clientCapabilities(interactive)).toContain("teams.read")
  expect(clientCapabilities(interactive)).toContain("teams.manage")
  expect(clientCapabilities(interactive)).toContain("run.approval_mode")
})

test("生产交互握手声明 run.approval_mode 后可发送活动 Run 切换 RPC", async () => {
  const command = parseArgs([])
  const requested = clientCapabilities(command)
  expect(requested).toContain(Capability.RUN_APPROVAL_MODE)
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const client = new AgentClient(new StdioRpcTransport(stdin, stdout))
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  stdin.on("data", chunk => {
    const message = JSON.parse(chunk.toString()) as { id: string; method: string; params: Record<string, unknown> }
    requests.push(message)
    if (message.method === "initialize") {
      stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocol: { major: 3, minor: 8 },
          server: { name: "fake-agent", version: "test" },
          connection: { id: "connection-1", role: "owner", project: { id: "project-1", label: "project" } },
          capabilities: { available: requested, enabled: requested, handles: [] },
          agent_commands: [],
          skills_snapshot: { id: "skills-1", count: 0 },
          skill_diagnostics: [],
          limits: { max_frame_bytes: 8 * 1024 * 1024, max_tool_payload_bytes: 1024 * 1024 },
          diagnostics: { level: "info", retention_days: 7, max_total_mib: 16, max_file_mib: 1 },
          config_summary: null,
          startup_error: null,
        },
      }) + "\n")
      return
    }
    stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread_id: "thread-1", run_id: "run-1", approval_mode: "yolo", revision: 1 },
    }) + "\n")
  })
  try {
    await client.initialize({
      protocol: { major: 3, min_minor: 0, max_minor: 8 },
      client: { name: "harness-cli", version: "test", kind: "tui" },
      capabilities: { requests: requested, handles: [] },
    })
    const result = await client.setApprovalMode("thread-1", "run-1", "yolo")
    expect(result).toEqual({ thread_id: "thread-1", run_id: "run-1", approval_mode: "yolo", revision: 1 })
    expect(requests.map(request => request.method)).toEqual(["initialize", "run.set_approval_mode"])
    expect(requests[0]?.params.capabilities).toMatchObject({ requests: expect.arrayContaining([Capability.RUN_APPROVAL_MODE]) })
  } finally {
    await client.close()
  }
})

test("Plugin CLI 按操作声明最小读写能力", () => {
  const validation = parseArgs(["plugins", "validate", "./plugin"])
  const install = parseArgs(["plugins", "install", "./plugin"])
  expect(clientCapabilities(validation)).toContain("plugins.read")
  expect(clientCapabilities(validation)).not.toContain("plugins.manage")
  expect(clientCapabilities(install)).toContain("plugins.read")
  expect(clientCapabilities(install)).toContain("plugins.manage")
})

test("version 与 help 不启动 sidecar，stdout 为版本或用法", async () => {
  let started = 0
  const startAgent = async () => {
    started += 1
    throw new Error("startAgent must not run")
  }
  const printed: string[] = []
  const originalLog = console.log
  console.log = (message?: unknown) => {
    printed.push(String(message ?? ""))
  }
  try {
    await execute(parseArgs(["--version"]), { startAgent })
    await execute(parseArgs(["--help"]), { startAgent })
  } finally {
    console.log = originalLog
  }
  expect(started).toBe(0)
  expect(printed[0]).toBe(CLI_VERSION)
  expect(printed[1] ?? "").toContain("harness")
  expect(printed[1] ?? "").toContain("-n")
})

test("harness logs 命令路由在 startAgent 之前，不创建 sidecar、不调用 spawn", async () => {
  const logsCmd = parseArgs(["logs", "--run", "r1"])
  expect(logsCmd.kind).toBe("logs")

  // 行为证据：真实走一遍 execute，startAgent 一次都不能被调用（即不会 spawn sidecar）。
  let started = 0
  const originalLog = console.log
  const originalWrite = process.stdout.write.bind(process.stdout)
  console.log = () => {}
  process.stdout.write = (() => true) as never
  try {
    await execute(logsCmd, {
      startAgent: async () => {
        started += 1
        throw new Error("startAgent must not run for logs")
      },
    }).catch(() => {}) // 日志文件不存在时查询可能报错，这里只关心是否启动了 sidecar
  } finally {
    console.log = originalLog
    process.stdout.write = originalWrite
  }
  expect(started).toBe(0)

  const querySource = readFileSync(resolve(import.meta.dir, "../src/diagnostic-log/query.ts"), "utf8")
  expect(querySource).not.toContain("child_process")
  expect(querySource).not.toContain("Bun.spawn")
  expect(querySource).not.toContain("Database")
  expect(querySource).not.toContain("sqlite")
})

test("Plugin Settings commands negotiate settings capabilities", () => {
  const list = parseArgs(["plugins", "settings", "list"], "/work")
  const set = parseArgs([
    "plugins", "settings", "set", "Review-Tools", "ZA38_TOKEN",
    "--secret-stdin",
  ], "/work")
  expect(clientCapabilities(list)).toContain("settings.read")
  expect(clientCapabilities(list)).not.toContain("settings.manage")
  expect(clientCapabilities(set)).toContain("settings.read")
  expect(clientCapabilities(set)).toContain("settings.manage")
})

test("Plugin Settings CLI 经过 parse→dispatch 向 Agent 发出 canonical RPC", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    return { ok: true }
  }
  const readValue = async (_secretStdin: boolean) => "generated-fake-secret"

  await dispatchClientCommand(
    parseArgs(["plugins", "settings", "list"], "/work"),
    request,
    readValue,
  )
  await dispatchClientCommand(
    parseArgs([
      "plugins", "settings", "set", "Review-Tools", "ZA38_TOKEN",
      "--secret-stdin",
    ], "/work"),
    request,
    readValue,
  )
  await dispatchClientCommand(
    parseArgs([
      "plugins", "settings", "remove", "Review-Tools", "ZA38_TOKEN",
    ], "/work"),
    request,
    readValue,
  )

  expect(calls.map(call => call.method)).toEqual([
    "settings.list",
    "settings.set",
    "settings.remove",
  ])
  expect(calls[1]?.params.value).toBe("generated-fake-secret")
  expect(calls[0]?.params).toEqual({ scope: "user" })
})

test("Plugin Settings/Plugin removal CLI 经过 parse→execute→fake Agent request 完成管理命令", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const startAgent = async () => ({
    client: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        return { method }
      },
    } as never,
    runtime: undefined as never,
    stop: async () => {},
  })

  await execute(parseArgs(["plugins", "settings", "list"], "/work"), { startAgent })
  await execute(
    parseArgs(
      [
        "plugins", "settings", "set", "Review-Tools", "ZA38_TOKEN", "--secret-stdin",
      ],
      "/work",
    ),
    { startAgent, readSettingValue: async () => "generated-fake-secret" },
  )
  await execute(
    parseArgs(
      [
        "plugins", "settings", "remove", "Review-Tools", "ZA38_TOKEN",
      ],
      "/work",
    ),
    { startAgent },
  )
  await execute(
    parseArgs(["plugins", "remove", "Review-Tools", "--purge-data"], "/work"),
    { startAgent },
  )

  expect(calls.map(call => call.method)).toEqual([
    "settings.list",
    "settings.set",
    "settings.remove",
    "plugins.remove",
  ])
  expect(calls.at(-1)?.params).toEqual({
    name: "Review-Tools",
    purge_data: true,
  })
})

test("CLI stdin validator accepts one framing newline after the maximum value", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: Readable.from([Buffer.from("x".repeat(65_536) + "\n")]),
  })
  try {
    await expect(readSettingValue(true)).resolves.toBe("x".repeat(65_536))
  } finally {
    if (original) Object.defineProperty(process, "stdin", original)
  }
})

test("CLI stdin validator accepts maximum value followed by CRLF", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: Readable.from([Buffer.from("x".repeat(65_536) + "\r\n")]),
  })
  try {
    await expect(readSettingValue(true)).resolves.toBe("x".repeat(65_536))
  } finally {
    if (original) Object.defineProperty(process, "stdin", original)
  }
})

test("Plugin Command binding 遵守协商 minor，不向 v5 Agent 调用未知方法", async () => {
  expect(COMMANDS_BIND_MIN_MINOR).toBe(6)
  const calls: unknown[] = []
  const client = {
    bindCommandRegistry: async (params: unknown) => {
      calls.push(params)
      return { snapshot_id: "snapshot-v6", accepted: true as const }
    },
  }

  await bindPluginCommands(client, 6, "snapshot-v6", [
    { id: "plugin/za38/command/sdd", name: "za38-sdd" },
  ])
  expect(calls).toEqual([{
    snapshot_id: "snapshot-v6",
    bindings: [{ id: "plugin/za38/command/sdd", name: "za38-sdd" }],
  }])

  await expect(
    bindPluginCommands(client, 5, "snapshot-v5", [
      { id: "plugin/za38/command/sdd", name: "za38-sdd" },
    ]),
  ).rejects.toThrow("COMMANDS_BIND_PROTOCOL_MINOR_REQUIRED")
  expect(calls).toHaveLength(1)

  await bindPluginCommands(client, 5, "snapshot-v5", [])
  expect(calls).toHaveLength(1)
})

test("harness acp 在 startAgent 与 TTY 校验之前短路", async () => {
  const acpCommand = parseArgs(["acp"], process.cwd())
  expect(acpCommand.kind).toBe("acp")
  let started = 0
  const seen: string[] = []
  await execute(acpCommand, {
    startAgent: async () => {
      started += 1
      throw new Error("startAgent must not run for acp")
    },
    runAcp: async command => {
      seen.push(command.kind)
      return 0
    },
  })
  expect(started).toBe(0)
  expect(seen).toEqual(["acp"])
})

test("harness acp 的 buildAcpSpawnPlan 以 acp 结尾并注入 sidecar 环境", async () => {
  const { buildAcpSpawnPlan } = await import("../src/acp-command")
  const command = { kind: "acp" as const, cwd: "/work", configPath: "/cfg.toml" }

  const viaOverride = buildAcpSpawnPlan(command, {
    moduleDir: resolve(import.meta.dir, "../src"),
    env: { HARNESS_AGENT_PYTHON: "/venv/bin/python" },
  })
  expect(viaOverride.executable).toBe("/venv/bin/python")
  expect(viaOverride.args).toEqual(["-m", "harness_agent", "acp"])
  expect(viaOverride.cwd).toBe("/work")
  expect(viaOverride.env.HARNESS_COMMAND_KIND).toBe("acp")
  expect(viaOverride.env.HARNESS_AGENT_CONFIG_PATH).toBe("/cfg.toml")
  expect(viaOverride.env.HARNESS_CLI_INSTALL_ROOT).toBeTruthy()

  const directory = await mkdtemp(resolve(tmpdir(), "harness-acp-binding-"))
  const agentDirectory = resolve(directory, "packages", "agent")
  await mkdir(resolve(agentDirectory, ".venv", "bin"), { recursive: true })
  await writeFile(resolve(agentDirectory, ".venv", "bin", "python"), "")
  // resolveCliInstallRoot 会 realpath 模块目录，假目录必须先存在。
  await mkdir(resolve(directory, "packages", "cli", "src"), { recursive: true })
  const viaDevelopment = buildAcpSpawnPlan(
    { kind: "acp", cwd: "/work" },
    {
      moduleDir: resolve(directory, "packages", "cli", "src"),
      env: { PYTHONPATH: "/existing" },
    },
  )
  expect(viaDevelopment.args).toEqual(["-m", "harness_agent", "acp"])
  expect(viaDevelopment.env.PYTHONPATH).toBe(`${agentDirectory}:${"/existing"}`)
  expect(viaDevelopment.env.HARNESS_AGENT_CONFIG_PATH).toBeUndefined()
})
