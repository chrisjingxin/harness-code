/**
 * 【功能定义】中立多代理 ACP 注册表与通用外部命令驱动工厂：
 * 1. 通过 `createCommandAgentDescriptor` 支持配置接入任意遵循标准 ACP stdio 的外部命令行 Agent；
 * 2. 通过 `createCustomAgentDescriptor` / `parseCustomAcpCommand` 支持 `WORKBENCH_ACP_EXECUTABLE` 环境变量覆盖；
 * 3. 通过 `AcpAgentRegistry` 管理调用方注入的描述符可用性探测、默认选择与 `LocalAcpHost` 生命周期回收。
 * 【协作边界】严禁硬编码或静态导入任何具体 Agent 实现包。
 */
import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type {
  AcpAgentDescriptor,
  AcpAgentDiscoveryOptions,
  AcpAgentHostHints,
  AcpAgentInfo,
  AcpAgentList,
} from "./descriptor.js"
import { buildAugmentedGuiPath, findInPath, isExecutableFile } from "./discovery.js"
import { LocalAcpHost } from "./index.js"
import { buildNativeBindingIdentity, nativeBinding } from "./native-binding.js"
import type { AgentCommand, LocalAcpHostOptions, LocalAcpMeta, LocalAcpScope } from "./types.js"

const DEFAULT_HOST_HINTS: AcpAgentHostHints = {
  enableElicitation: true,
  enableClientFs: true,
  restorePolicy: "fallback-new",
}

/** 解析 `WORKBENCH_ACP_EXECUTABLE` 与 `WORKBENCH_ACP_ARGS_JSON` 为安全的参数化启动命令。 */
export function parseCustomAcpCommand(env: Readonly<Record<string, string | undefined>> = process.env): AgentCommand {
  const executable = env.WORKBENCH_ACP_EXECUTABLE?.trim() ?? ""
  if (!isAbsolute(executable)) {
    throw new Error("WORKBENCH_ACP_EXECUTABLE 必须使用绝对路径。")
  }
  const args: unknown = JSON.parse(env.WORKBENCH_ACP_ARGS_JSON ?? "[]")
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
    throw new Error("WORKBENCH_ACP_ARGS_JSON 必须是字符串数组。")
  }
  return { executable, args, env }
}

/** 构造由 `WORKBENCH_ACP_EXECUTABLE` 驱动的 `"custom"` 标准 ACP 描述符。 */
export function createCustomAgentDescriptor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AcpAgentDescriptor {
  return {
    id: "custom",
    label: "自定义 Agent",
    description: "由 WORKBENCH_ACP_EXECUTABLE 环境变量指定的外部 ACP Agent",
    family: "custom",
    hostHints: DEFAULT_HOST_HINTS,
    resolveCommand(targetEnv = env) {
      if (!targetEnv.WORKBENCH_ACP_EXECUTABLE?.trim()) {
        return { available: false, reason: "未设置 WORKBENCH_ACP_EXECUTABLE。" }
      }
      try {
        return { available: true, source: "env", command: parseCustomAcpCommand(targetEnv) }
      } catch {
        return {
          available: false,
          reason: "本机 Agent 配置无效。请检查可执行文件的绝对路径及 WORKBENCH_ACP_ARGS_JSON 字符串数组。",
        }
      }
    },
  }
}

export type CommandAgentDescriptorOptions = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly family?: string
  /** 外部标准 ACP Agent 可执行文件的绝对路径或 PATH 中的纯命令名。 */
  readonly executable: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly hostHints?: AcpAgentHostHints
}

/** 根据静态配置或外部 CLI 命令构造通用标准 ACP 描述符（不通过 shell 拼接）。 */
export function createCommandAgentDescriptor(config: CommandAgentDescriptorOptions): AcpAgentDescriptor {
  const executableSpec = config.executable.trim()
  const baseArgs = [...(config.args ?? [])]
  return {
    id: config.id,
    label: config.label,
    description: config.description ?? `${config.label}（外部标准 ACP Agent）`,
    family: config.family ?? config.id,
    hostHints: config.hostHints ?? DEFAULT_HOST_HINTS,
    resolveCommand(env = process.env, options = {}) {
      if (!executableSpec || /[\u0000-\u001f\u007f]/.test(executableSpec)) {
        return { available: false, reason: `${config.label} 可执行命令配置无效。` }
      }
      const augmentedPath = buildAugmentedGuiPath(env, options)
      const mergedEnv = { ...env, PATH: augmentedPath, ...config.env }
      if (isAbsolute(executableSpec)) {
        if (!isExecutableFile(executableSpec)) {
          return { available: false, reason: `${config.label} 可执行文件不存在或不可执行：${executableSpec}` }
        }
        return {
          available: true,
          source: "config",
          command: { executable: executableSpec, args: baseArgs, env: mergedEnv },
        }
      }
      // 仅允许纯命令名走 PATH 检索，拒绝带相对目录前缀（如 ../）的模糊路径。
      if (executableSpec.includes("/") || executableSpec.includes("\\")) {
        return { available: false, reason: `${config.label} 必须提供绝对路径或纯命令名。` }
      }
      const isWin = process.platform === "win32"
      const candidates = isWin && !/\.(?:exe|cmd|bat)$/i.test(executableSpec)
        ? [`${executableSpec}.cmd`, `${executableSpec}.exe`, executableSpec]
        : [executableSpec]
      const resolved = findInPath(candidates, augmentedPath)
      if (!resolved) {
        return { available: false, reason: `未在 PATH 中检测到 ${executableSpec}。` }
      }
      return {
        available: true,
        source: "path",
        command: { executable: resolved, args: baseArgs, env: mergedEnv },
      }
    },
  }
}

export type AcpAgentRegistryOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly bindingDirectory?: string
  readonly descriptors?: readonly AcpAgentDescriptor[]
  readonly discoveryOptions?: AcpAgentDiscoveryOptions
  /** 默认在检测到 `WORKBENCH_ACP_EXECUTABLE` 时追加 `"custom"` 描述符并置为默认项。 */
  readonly includeCustomFromEnv?: boolean
}

export type ResolvedAgentHost = {
  readonly clientMeta?: LocalAcpMeta
  readonly providerId: string | null
  readonly host: LocalAcpHost
  readonly available: boolean
  readonly reason?: string
}

/**
 * 通用多代理 ACP 注册表：接收调用方注入的描述符与外部命令配置，管理可用性探测、默认选择与宿主关闭。
 */
export class AcpAgentRegistry {
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #bindingDirectory?: string
  readonly #discoveryOptions?: AcpAgentDiscoveryOptions
  readonly #descriptors = new Map<string, AcpAgentDescriptor>()
  readonly #hosts = new Map<string, LocalAcpHost>()
  #unconfiguredHost?: LocalAcpHost

  constructor(options: AcpAgentRegistryOptions = {}) {
    this.#env = options.env ?? process.env
    this.#bindingDirectory = options.bindingDirectory
    this.#discoveryOptions = options.discoveryOptions

    for (const descriptor of options.descriptors ?? []) {
      this.#descriptors.set(descriptor.id, descriptor)
    }
    if (
      options.includeCustomFromEnv !== false
      && !this.#descriptors.has("custom")
      && this.#env.WORKBENCH_ACP_EXECUTABLE?.trim()
    ) {
      this.#descriptors.set("custom", createCustomAgentDescriptor(this.#env))
    }
  }

  hasProvider(providerId: string): boolean {
    return this.#descriptors.has(providerId)
  }

  /**
   * 探测给定会话与本机目录是否已有唯一命中的磁盘原生绑定：
   * 用于历史未持久记录 `providerId` 的会话在新增默认代理后仍回到先前使用的 Agent。
   */
  async findBoundProvider(scope: LocalAcpScope, cwd: string): Promise<string | undefined> {
    if (!this.#bindingDirectory || !isAbsolute(cwd)) return undefined
    if ([scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId].some(id => !id.trim())) {
      return undefined
    }
    let root: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      root = await realpath(cwd)
      info = await stat(root, { bigint: true })
    } catch {
      return undefined
    }
    if (!info.isDirectory()) return undefined

    const origin = this.#env.WORKBENCH_SERVICE_ORIGIN ?? ""
    const matched: string[] = []
    for (const descriptor of this.#descriptors.values()) {
      const resolution = descriptor.resolveCommand(this.#env, this.#discoveryOptions)
      if (!resolution.available) continue
      const bindingNamespace = origin ? `${origin}:${descriptor.id}` : descriptor.id
      const identity = buildNativeBindingIdentity(
        bindingNamespace, scope, root, info.dev, info.ino, resolution.command,
      )
      try {
        const stored = await nativeBinding(this.#bindingDirectory, identity).read()
        if (stored) matched.push(descriptor.id)
      } catch {
        // 单条历史绑定文件异常时忽略，继续排查其他描述符。
      }
    }
    return matched.length === 1 ? matched[0] : undefined
  }

  /** 列举已注册 Agent 及当前默认选中 ID（`custom` 优先，其次按注册顺序取首个可用）。 */
  listProviders(): AcpAgentList {
    const providers: AcpAgentInfo[] = []
    let firstAvailableId: string | null = null
    for (const descriptor of this.#descriptors.values()) {
      const resolved = descriptor.resolveCommand(this.#env, this.#discoveryOptions)
      if (resolved.available && firstAvailableId === null) firstAvailableId = descriptor.id
      providers.push({
        id: descriptor.id,
        label: descriptor.label,
        description: descriptor.description,
        available: resolved.available,
        ...(resolved.available ? {} : { reason: resolved.reason }),
      })
    }
    const defaultProviderId = this.#descriptors.has("custom") ? "custom" : firstAvailableId
    return { providers, defaultProviderId }
  }

  /** 按指定或默认 Agent 获取复用的 `LocalAcpHost`，开启描述符声明的标准客户端能力。 */
  getHost(providerId?: string): ResolvedAgentHost {
    const catalog = this.listProviders()
    const targetId = providerId ?? catalog.defaultProviderId
    if (!targetId) {
      return {
        providerId: null,
        host: this.getFallbackHost(),
        available: false,
        reason: "尚未配置可用的本机 ACP Agent，或请设置 WORKBENCH_ACP_EXECUTABLE 后重试。",
      }
    }
    const descriptor = this.#descriptors.get(targetId)
    if (!descriptor) {
      return {
        providerId: targetId,
        host: this.getFallbackHost(),
        available: false,
        reason: `未知的本机 Agent 类型：${targetId}`,
      }
    }
    const resolution = descriptor.resolveCommand(this.#env, this.#discoveryOptions)
    if (!resolution.available) {
      return {
        providerId: targetId,
        host: this.getFallbackHost(),
        available: false,
        reason: resolution.reason,
      }
    }
    let host = this.#hosts.get(targetId)
    if (!host) {
      const origin = this.#env.WORKBENCH_SERVICE_ORIGIN ?? ""
      const hostOptions: LocalAcpHostOptions = {
        bindingDirectory: this.#bindingDirectory,
        bindingNamespace: origin ? `${origin}:${targetId}` : targetId,
        enableElicitation: descriptor.hostHints.enableElicitation ?? true,
        enableClientFs: descriptor.hostHints.enableClientFs ?? true,
        ...(descriptor.hostHints.enableClientTerminal !== undefined
          ? { enableClientTerminal: descriptor.hostHints.enableClientTerminal }
          : {}),
        restorePolicy: descriptor.hostHints.restorePolicy ?? "fallback-new",
        extraClientCapabilitiesMeta: descriptor.hostHints.extraClientCapabilitiesMeta,
        promptTurnIdMetaKey: descriptor.hostHints.promptTurnIdMetaKey,
        sessionLoadReplayIdleMs: descriptor.hostHints.sessionLoadReplayIdleMs,
      }
      host = new LocalAcpHost(resolution.command, hostOptions)
      this.#hosts.set(targetId, host)
    }
    return { providerId: targetId, host, available: true, clientMeta: descriptor.hostHints.extraClientCapabilitiesMeta }
  }

  private getFallbackHost(): LocalAcpHost {
    return this.#unconfiguredHost ??= new LocalAcpHost()
  }

  async close(): Promise<void> {
    const all = [...this.#hosts.values(), ...(this.#unconfiguredHost ? [this.#unconfiguredHost] : [])]
    this.#hosts.clear()
    this.#unconfiguredHost = undefined
    await Promise.all(all.map(host => host.close()))
  }
}
