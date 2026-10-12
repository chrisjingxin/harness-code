#!/usr/bin/env bun
/**
 * Harness Code (za38) CLI 启动入口与主流程调度
 *
 * 【这是做什么的？】
 * 本文件是整个命令行工具的执行起点。负责解析用户输入的命令行参数，
 * 启动后台的 Python AI 核心进程（sidecar），通过标准输入输出（stdio）
 * 建立双向 JSON-RPC 通信通道，并根据运行模式进入终端全屏界面（TUI）、
 * 启动 Web 界面或直接无头执行单次任务。
 *
 * 【整体运行流程】
 * ┌──────────────┐
 * │ 用户执行命令  │ (例如直接运行 za38，或运行 za38 -n "帮我重构代码")
 * └──────┬───────┘
 *        ▼
 * ┌──────────────┐
 * │ 1. 参数解析  │ parseArgs(argv) -> 识别出是交互终端、单次对话还是配置管理
 * └──────┬───────┘
 *        ▼
 * ┌──────────────┐
 * │ 2. 检查工作区│ 确保目标目录存在且是合法文件夹，并计算项目唯一指纹
 * └──────┬───────┘
 *        ▼
 * ┌──────────────┐
 * │ 3. 启动后台  │ startAgent() -> 拉起 Python 核心进程，建立双向 stdio 管道
 * └──────┬───────┘
 *        ▼
 * ┌──────────────┐
 * │ 4. 协议握手  │ initialize 握手，告知后台前端支持哪些功能（审批、提问、目录信任等）
 * └──────┬───────┘
 *        ▼
 *    模式分流判断 ───┬───────────────────┬─────────────────────┐
 *                    │                   │                     │
 *                    ▼                   ▼                     ▼
 *             【交互式终端模式】    【无头单次执行】        【配置/插件管理】
 *             进入 OpenTUI 界面    执行一段对话并流式输出    直接请求并打印结果后退出
 *             支持随时切换到网页    打印完后优雅退出
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { existsSync, statSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { delimiter } from "node:path"
import { createInterface } from "node:readline"
import { TextDecoder } from "node:util"
import {
  Capability,
  EventType,
  PROTOCOL_VERSION,
  isClientMethod,
  type InteractionRequestEnvelope,
  type InteractionResponse,
  type OperationName,
} from "@za38/protocol"

import { CLI_USAGE, parseArgs, type Command } from "./args"
import { CLI_INSTALL_ROOT_ENV, resolveAgentProcessBinding, resolveCliInstallRoot } from "./runtime-binding"
import { createDiagnosticLog, defaultProcessFields, type DiagnosticLog } from "./diagnostic-log/runtime"
import { SidecarStderrDrain } from "./diagnostic-log/runtime/stderr-drain"
import { runLogsQuery } from "./diagnostic-log/query"
import { AgentClient, JsonRpcRemoteError } from "./ipc/client"
import { bindPluginCommands } from "./ipc/command-binding"
import { StdioRpcTransport } from "./ipc/stdio-transport"
import { runTui } from "./tui/app"
import { CLI_VERSION, createInteractiveRuntime, type InteractiveRuntime } from "./interactive/runtime"
import { createCommandRegistry } from "./interactive/commands"
import { createInteractiveController } from "./interactive/controller"
import type { InteractiveController } from "./interactive/types"
import { AgentClientGateway } from "./infrastructure/agent-client-gateway"
import { detectGitWorkspace } from "./infrastructure/git-workspace"
import { createSystemBrowserOpener } from "./web/browser"
import { browserBundle } from "./web/bundle"
import { webHtml } from "./web/html"
import { createWorkspaceExplorer } from "./workspace/explorer"
import type { WorkspaceExplorer } from "./workspace/types"
import {
  createPresentationCoordinator,
  createWebUiGateway,
  type PresentationCoordinator,
  type WebUiGateway,
} from "./presentation-coordinator"
import { createWebServer } from "./web/server"

type RunningAgent = {
  client: AgentClient
  runtime: InteractiveRuntime
  log: DiagnosticLog
  stop: () => Promise<void>
}

type ExecuteDependencies = {
  startAgent?: (command: Command) => Promise<RunningAgent>
  readSettingValue?: (secretStdin: boolean) => Promise<string>
}

type TerminalStream = { isTTY?: boolean }

/** 插件安装确认所需的终端输入输出流。只有在真实的终端下才允许用户确认安装，避免脚本静默安装不受信任的插件。 */
export type PluginConsentTerminalState = {
  stdin: TerminalStream
  stdout: TerminalStream
  stderr: TerminalStream
}

/** 供插件安装确认读取器使用的可读/可写终端流。 */
export type PluginConsentTerminal = {
  stdin: NodeJS.ReadableStream & TerminalStream
  stdout: NodeJS.WritableStream & TerminalStream
  stderr: NodeJS.WritableStream & TerminalStream
}

function processPluginConsentTerminal(): PluginConsentTerminal {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

/** 检查当前环境是否为真实的交互式终端（非重定向管道），确保安装外部插件时用户能亲眼看到风险提示并手动输入确认。 */
export function hasPluginConsentTerminal(
  terminal: PluginConsentTerminalState = processPluginConsentTerminal(),
): boolean {
  return terminal.stdin.isTTY === true
    && terminal.stdout.isTTY === true
    && terminal.stderr.isTTY === true
}

/** 根据本次执行的命令类型，计算并声明前端支持的功能清单（例如是否支持取消运行、多线程、修改配置、工具审批等），并在初始化握手时告知后台 Python。 */
export function clientCapabilities(command: Command): string[] {
  const capabilities: string[] = [Capability.RUN_CANCEL, Capability.RUN_MULTITHREAD, Capability.CONFIG_READ]
  if (command.kind === "run" && !command.nonInteractive) capabilities.push(
    Capability.CONFIG_WRITE,
    Capability.THREADS_READ,
    Capability.CONTEXT_MANAGE,
    Capability.MODELS_READ,
    Capability.MODELS_SELECT,
    Capability.MCP_READ,
    Capability.MCP_MANAGE,
    Capability.AGENTS_READ,
    Capability.TEAMS_READ,
    Capability.TEAMS_MANAGE,
    Capability.FUSION_READ,
    Capability.FUSION_MANAGE,
    Capability.GOAL_READ,
    Capability.GOAL_MANAGE,
    Capability.CODE_INDEX_READ,
    Capability.CODE_INDEX_MANAGE,
    Capability.RUN_APPROVAL_MODE,
  )
  if (command.kind.startsWith("skills.") || (command.kind === "run" && !command.nonInteractive)) capabilities.push(Capability.SKILLS_READ)
  if (command.kind === "skills.set_enabled" || command.kind === "skills.install" || command.kind === "skills.update" || command.kind === "skills.remove") {
    capabilities.push(Capability.SKILLS_MANAGE)
  }
  if (command.kind.startsWith("plugins.")) capabilities.push(Capability.PLUGINS_READ)
  if (command.kind === "plugins.install" || command.kind === "plugins.update" || command.kind === "plugins.set_enabled" || command.kind === "plugins.remove") {
    capabilities.push(Capability.PLUGINS_MANAGE)
  }
  if (command.kind === "plugins.settings.list" || command.kind === "plugins.settings.set" || command.kind === "plugins.settings.remove") {
    capabilities.push(Capability.SETTINGS_READ)
  }
  if (command.kind === "plugins.settings.set" || command.kind === "plugins.settings.remove") {
    capabilities.push(Capability.SETTINGS_MANAGE)
  }
  return capabilities
}

/** 声明当前界面支持处理的人机交互类型（如：审批工具调用、向用户提问、工作区目录信任、执行计划确认等）。无交互模式下返回空列表。 */
export function clientInteractionHandles(
  command: Command,
  terminal: PluginConsentTerminalState = processPluginConsentTerminal(),
): Array<"approval" | "question" | "directory_trust" | "plan" | "plugin_consent" | "goal"> {
  if (
    (command.kind === "plugins.install" || command.kind === "plugins.update")
    && hasPluginConsentTerminal(terminal)
  ) return ["plugin_consent"]
  return command.kind === "run" && !command.nonInteractive ? ["approval", "question", "directory_trust", "plan", "goal"] : []
}

/** 在终端向用户展示插件将要执行的操作并等待用户确认输入（输入 y/yes 继续，其余输入或中断均视为取消）。 */
export async function readPluginConsent(
  request: Extract<InteractionRequestEnvelope, { type: "plugin_consent" }>,
  terminal: PluginConsentTerminal = processPluginConsentTerminal(),
): Promise<InteractionResponse> {
  if (!hasPluginConsentTerminal(terminal)) {
    throw new Error("PLUGIN_CONSENT_REQUIRED")
  }
  const operation = request.payload.operation
  terminal.stderr.write(`Plugin ${operation} preview:\n${JSON.stringify(request.payload.preview, null, 2)}\n`)
  const input = createInterface({ input: terminal.stdin, output: terminal.stderr })
  try {
    const answer = await new Promise<string>((resolveAnswer, rejectAnswer) => {
      let settled = false
      const rejectAtEof = () => {
        if (settled) return
        settled = true
        rejectAnswer(new Error("PLUGIN_CONSENT_REQUIRED"))
      }
      input.once("close", rejectAtEof)
      input.question("Continue? [y/N] ", answerLine => {
        if (settled) return
        settled = true
        resolveAnswer(answerLine)
      })
    })
    return {
      request_id: request.request_id,
      type: "plugin_consent",
      decision: ["y", "yes"].includes(answer.trim().toLowerCase()) ? "accept" : "cancel",
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PLUGIN_CONSENT_REQUIRED") throw error
    return { request_id: request.request_id, type: "plugin_consent", decision: "cancel" }
  } finally {
    input.close()
  }
}

/** 启动后台 Python 核心进程，通过标准输入输出（stdio）建立 JSON-RPC 消息通道，完成握手初始化，并返回包含通信客户端和清理关闭方法的运行句柄。 */
async function startAgent(command: Exclude<Command, { kind: "logs" } | { kind: "version" } | { kind: "help" }>): Promise<RunningAgent> {
  validateWorkspace(command.cwd)
  const startedAtMs = Date.now()
  const startedAt = performance.now()
  const projectFingerprint = await workspaceFingerprint(command.cwd)
  const { log, lifecycle } = createDiagnosticLog({
    component: "cli",
    projectFingerprint,
    startedAtMs,
  })
  log.info("process.started", defaultProcessFields(command.kind))
  const binding = resolveAgentProcessBinding({
    moduleDir: import.meta.dir,
    env: process.env,
  })
  const sandboxEnvironment = command.kind === "run" && command.sandbox !== undefined
    // CLI 显式参数必须高于用户环境变量；sidecar 仅把这个内部字段当作
    // 最后一层覆盖，不对外暴露为可长期配置的环境变量。
    ? { HARNESS_CLI_SANDBOX: command.sandbox ? "remote" : "false" }
    : {}
  const [executable, ...agentArgs] = binding.argv
  const child = spawn(executable, agentArgs, {
    cwd: command.cwd,
    env: {
      ...process.env,
      ...sandboxEnvironment,
      HARNESS_COMMAND_KIND: command.kind,
      [CLI_INSTALL_ROOT_ENV]: resolveCliInstallRoot(import.meta.dir),
      ...(command.configPath ? { HARNESS_AGENT_CONFIG_PATH: command.configPath } : {}),
      ...(binding.pythonPath
        ? { PYTHONPATH: process.env.PYTHONPATH ? `${binding.pythonPath}${delimiter}${process.env.PYTHONPATH}` : binding.pythonPath }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (!child.stdin || !child.stdout || !child.stderr) {
    log.error("process.stopped", {
      outcome: "failed",
      exit_code: child.exitCode,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    })
    child.kill()
    await lifecycle.close()
    throw new Error("Unable to create agent stdio pipes")
  }
  const stderrDrain = new SidecarStderrDrain()
  child.stderr.on("data", chunk => {
    stderrDrain.push(chunk)
  })
  const client = new AgentClient(new StdioRpcTransport(child.stdin, child.stdout), log)
  child.on("exit", code => {
    if (code && code !== 0) client.emit("agentExit", new Error(`Agent exited with code ${code}`))
  })
  try {
    const requested = clientCapabilities(command)
    const consentTerminal = processPluginConsentTerminal()
    const initialized = await client.initialize({
      protocol: { major: PROTOCOL_VERSION.major, min_minor: 0, max_minor: PROTOCOL_VERSION.minor },
      client: { name: "harness-cli", version: CLI_VERSION, kind: command.kind === "run" && !command.nonInteractive ? "tui" : "cli" },
      capabilities: {
        requests: requested,
        handles: clientInteractionHandles(command, consentTerminal),
      },
    })
    if (
      (command.kind === "plugins.install" || command.kind === "plugins.update")
      && hasPluginConsentTerminal(consentTerminal)
    ) {
      client.handleInteractions(request => {
        if (request.type !== "plugin_consent") {
          throw new Error("Plugin management client received an unsupported interaction")
        }
        return readPluginConsent(request, consentTerminal)
      })
    }
    log.info("ipc.initialize.completed", {
      side: "client",
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      protocol_minor: initialized.protocol.minor,
    })
    lifecycle.reconfigure({
      level: initialized.diagnostics.level,
      retentionDays: initialized.diagnostics.retention_days,
      maxTotalBytes: initialized.diagnostics.max_total_mib * 1024 * 1024,
      maxFileBytes: initialized.diagnostics.max_file_mib * 1024 * 1024,
    })
    // Registry 只在 CLI 构造一次：同一份 resolved name 同时登记给 Host 和交给 UI。
    const commandRegistry = createCommandRegistry(initialized.agent_commands)
    if (command.kind === "run") {
      await bindPluginCommands(
        client,
        initialized.protocol.minor,
        initialized.skills_snapshot.id,
        commandRegistry.definitions
          .filter(definition => definition.source.type === "plugin")
          .map(definition => ({ id: definition.id, name: definition.name })),
      )
    }
    const runtime = createInteractiveRuntime(initialized, command.cwd, {
      gitWorkspace: await detectGitWorkspace(command.cwd),
      cliVersion: CLI_VERSION,
      commandRegistry,
    })
    let stopped = false
    return {
      client,
      runtime,
      log,
      stop: async () => {
        if (stopped) return
        stopped = true
        const stderr = stderrDrain.snapshot()
        if (stderr.bytes > 0) log.warn("sidecar.stderr_observed", {
          bytes: stderr.bytes,
          lines: stderr.lines,
          truncated: stderr.truncated,
        })
        log.info("process.stopped", {
          outcome: "completed",
          exit_code: 0,
          duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        })
        await client.close()
        if (child.exitCode === null && child.signalCode === null) {
          await Promise.race([
            once(child, "exit"),
            new Promise(resolve => setTimeout(resolve, 2_000)),
          ])
        }
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await lifecycle.close()
      },
    }
  } catch (error) {
    log.error("process.stopped", {
      outcome: "failed",
      exit_code: child.exitCode,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    })
    await client.close().catch(() => undefined)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await lifecycle.close()
    throw error
  }
}

/** 使用平台真实路径 API 生成与 Python 一致的 workspace 不可逆身份。 */
export async function workspaceFingerprint(workspace: string): Promise<string> {
  const canonical = await realpath(workspace)
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/** 在启动子进程前校验工作区，避免把无效 cwd 误报为 Python 可执行文件不存在。 */
export function validateWorkspace(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`Workspace does not exist: ${cwd}. Create it first or pass an existing directory with --cwd.`)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${cwd}`)
  }
}

export { resolveAgentProcessBinding, resolveAgentRuntimeLocations } from "./runtime-binding"

/** OpenTUI 必须独占真实终端；管道或任务复用器会让控制序列进入普通文本流。 */
export function validateInteractiveTerminal(stdinIsTty: boolean | undefined, stdoutIsTty: boolean | undefined): void {
  if (!stdinIsTty || !stdoutIsTty) {
    throw new Error("Interactive TUI requires a real terminal. Run the root command directly, or use -n for non-interactive mode.")
  }
}

const MAX_SETTING_VALUE_BYTES = 65_536

/** 读取 Settings value；非 TTY 只能用显式 stdin，TTY 输入关闭回显。 */
export async function readSettingValue(secretStdin: boolean): Promise<string> {
  if (secretStdin) return readSettingStdin(process.stdin)
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("SETTINGS_INPUT_NONINTERACTIVE")
  }
  const input = process.stdin
  const output = process.stdout
  output.write("Settings value: ")
  input.setRawMode(true)
  input.setEncoding("utf8")
  input.resume()
  return new Promise<string>((resolveValue, reject) => {
    let value = ""
    const cleanup = () => {
      input.setRawMode?.(false)
      input.removeListener("data", onData)
      output.write("\n")
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const finish = () => {
      cleanup()
      try {
        resolveValue(validateSettingValue(value))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish()
          return
        }
        if (character === "\u0003") {
          fail(new Error("SETTINGS_INPUT_CANCELLED"))
          return
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1)
          continue
        }
        value += character
        if (Buffer.byteLength(value, "utf8") > MAX_SETTING_VALUE_BYTES) {
          fail(new Error("SETTINGS_VALUE_TOO_LARGE"))
          return
        }
      }
    }
    input.on("data", onData)
  })
}

/** 读取单条有界 UTF-8 stdin record；不允许多行/NUL/隐式 trim。 */
async function readSettingStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
    size += bytes.length
    // 允许一个 framing newline；去除 newline 后的 value 仍由同一 validator
    // 检查 65536-byte 上限。多余字节继续 fail closed。
    if (size > MAX_SETTING_VALUE_BYTES + 2) throw new Error("SETTINGS_VALUE_TOO_LARGE")
    chunks.push(bytes)
  }
  let value: string
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new Error("SETTINGS_VALUE_INVALID")
  }
  if (value.endsWith("\n")) {
    value = value.slice(0, -1)
    if (value.endsWith("\r")) value = value.slice(0, -1)
  }
  if (value.includes("\n") || value.includes("\r")) throw new Error("SETTINGS_VALUE_INVALID")
  return validateSettingValue(value)
}

/** 与 Agent Settings validator 同步的 CLI value 校验。 */
function validateSettingValue(value: string): string {
  if (value.includes("\u0000")) throw new Error("SETTINGS_VALUE_INVALID")
  if (Buffer.byteLength(value, "utf8") > MAX_SETTING_VALUE_BYTES) throw new Error("SETTINGS_VALUE_TOO_LARGE")
  return value
}

/** 无头非交互模式（-n）：向后台发起一轮对话，实时拼接并输出 AI 回复的文本流，直到 AI 完成本轮回答并返回最终 Token 使用量。 */
async function runTurn(client: AgentClient, message: string, threadId?: string): Promise<{ text: string; threadId: string; runId: string; usage: unknown }> {
  let text = ""
  const run = client.startRun({ input: { kind: "user", message }, mode: "build", threadId })
  await run.accepted
  for await (const event of run.events) {
    if (event.type === EventType.CONTENT_DELTA) text += event.payload.text
  }
  const completion = await run.completion
  if (completion.outcome === "cancelled") throw new Error(completion.event.payload.reason)
  if (completion.outcome === "failed") {
    const error = completion.event.payload.error
    throw new Error(`${error.code}: ${error.message}`)
  }
  return {
    text,
    threadId: run.ref.threadId,
    runId: run.ref.runId,
    usage: completion.event.payload.usage,
  }
}

/** 将命令行解析出的动作名，映射为后台 Python 识别的标准 RPC 方法名（如把 plugins.settings.list 映射为 settings.list）。 */
export function clientMethodForCommand(command: Command): OperationName | undefined {
  if (command.kind === "plugins.settings.list") return "settings.list"
  if (command.kind === "plugins.settings.set") return "settings.set"
  if (command.kind === "plugins.settings.remove") return "settings.remove"
  return isClientMethod(command.kind) ? command.kind : undefined
}

/** 执行非对话类的后台管理命令（如查询模型列表、读取配置、管理插件等），直接向后台发起请求并返回结果。 */
export async function dispatchClientCommand(
  command: Exclude<Command, { kind: "run" } | { kind: "logs" } | { kind: "version" } | { kind: "help" }>,
  request: (method: OperationName, params: Record<string, unknown>) => Promise<unknown>,
  readValue: (secretStdin: boolean) => Promise<string> = readSettingValue,
): Promise<unknown> {
  const method = clientMethodForCommand(command)
  if (method === undefined) throw new Error(`Unsupported command operation: ${command.kind}`)
  const params = command.params ?? {}
  if (command.kind === "plugins.settings.set") {
    return request(method, {
      ...params,
      value: await readValue(command.secretStdin === true),
    })
  }
  return request(method, params)
}

/** 核心执行流程：根据命令类型分流处理。如果是单次任务就运行一轮对话后退出；如果是普通启动则拉起完整的终端/网页交互界面。 */
export async function execute(
  command: Command,
  dependencies: ExecuteDependencies = {},
): Promise<void> {
  if (command.kind === "version") {
    console.log(CLI_VERSION)
    return
  }
  if (command.kind === "help") {
    console.log(CLI_USAGE)
    return
  }
  if (command.kind === "logs") {
    // 日志查询完全离线短路：不创建 logger、不启动 Python 后台、不连接 SQLite
    await runLogsQuery(command)
    return
  }
  if (command.kind === "run" && !command.nonInteractive) {
    validateInteractiveTerminal(process.stdin.isTTY, process.stdout.isTTY)
  }
  const agent = await (dependencies.startAgent ?? startAgent)(command)
  try {
    if (command.kind !== "run") {
      const result = await dispatchClientCommand(
        command,
        (method, params) => agent.client.request(method, params),
        dependencies.readSettingValue,
      )
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (command.nonInteractive) {
      const result = await runTurn(agent.client, command.message!)
      if (command.json) console.log(JSON.stringify(result))
      else process.stdout.write(`${result.text}\n`)
      return
    }

    let presentationCoordinator: PresentationCoordinator | undefined
    let webUiGateway: WebUiGateway | undefined
    let workspaceExplorer: WorkspaceExplorer | undefined
    let controller: InteractiveController | undefined
    try {
      // 创建全局唯一的交互控制器（InteractiveController）。整个应用运行期间只有这一个控制器实例，终端界面（TUI）和网页界面（Web）共享它来管理会话状态。
      const gateway = new AgentClientGateway(agent.client)
      controller = createInteractiveController({
        gateway,
        baseRuntime: agent.runtime,
      })
      if (!command.nonInteractive) {
        // 工作区文件浏览独立于 Interactive Core；根解析失败时 explorer 自身进入 error 状态。
        workspaceExplorer = await createWorkspaceExplorer(command.cwd)
        const server = createWebServer({
          html: webHtml,
          getAssets: browserBundle,
          isActiveHandoff: handoffId =>
            presentationCoordinator !== undefined && presentationCoordinator.isHandoffActive(handoffId),
          validateUiToken: (id, token, origin) =>
            presentationCoordinator!.validateUiToken(id, token, origin),
          attachRenderer: (id, token, channel) =>
            presentationCoordinator!.attachRenderer(id, token, channel),
        })
        presentationCoordinator = createPresentationCoordinator({
          server,
          openBrowser: createSystemBrowserOpener(),
          dispatch: intent => controller!.dispatch(intent),
          onRendererConnected: (channel, reconnectToken) => webUiGateway!.connectRenderer(channel, reconnectToken),
          diagnostics: agent.log,
        })
        webUiGateway = createWebUiGateway({
          coordinator: presentationCoordinator,
          controller,
          workspaceExplorer,
          diagnostics: agent.log,
        })
      }
      await runTui({
        controller,
        gateway,
        workspaceExplorer,
        resume: command.resume,
        webHandoff: presentationCoordinator,
        openWeb: () => presentationCoordinator!.open(),
      })
    } finally {
      // 退出时按从上到下的顺序依次优雅关闭各层组件：网页网关 -> 文件资源树 -> 多端协调器 -> 交互控制器 -> 停止后台 Python 进程。
      await webUiGateway?.close()
      await workspaceExplorer?.close()
      await presentationCoordinator?.close()
      await controller?.close()
    }
  } finally {
    await agent.stop()
  }
}

/** CLI 主入口：解析参数后执行；version/help/logs 在 execute 内短路。 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  await execute(parseArgs(argv))
}

if (import.meta.main) {
  main().catch(error => {
    // 旧 sidecar 仍可能只把 THREAD_STORE_UNAVAILABLE 放在 message 中、将
    // 真正的迁移诊断码放在 JSON-RPC data.code；启动失败时把这个稳定码透传，
    // 避免用户只能看到无法行动的笼统错误。
    const message = error instanceof JsonRpcRemoteError
      && error.message === "THREAD_STORE_UNAVAILABLE"
      && typeof error.data === "object"
      && error.data !== null
      && "code" in error.data
      && typeof error.data.code === "string"
      ? `${error.message}: ${error.data.code}`
      : error instanceof Error ? error.message : String(error)
    console.error(`za38: ${message}`)
    process.exitCode = 1
  })
}
