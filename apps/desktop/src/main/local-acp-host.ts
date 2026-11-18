/**
 * 本机 ACP 多代理注册表与主进程运行时装配。
 *
 * 【功能定义】
 * 1. 按优先级注册通用 Provider 描述符（`harness` → `pi` → `qwen`，以及设置 `WORKBENCH_ACP_EXECUTABLE` 时的 `"custom"`）；
 * 2. 统一为各 Provider 创建开启 `enableElicitation`、`enableClientFs` 与 `restorePolicy: "fallback-new"` 的 `LocalAcpHost`；
 * 3. 提供应用退出时的全量托管宿主关闭句柄。
 * 【协作边界】仅在桌面主进程运行，消费 `@workbench/*-provider` 与 `@workbench/acp-runtime`，不向渲染层泄露子进程命令。
 */
import { isAbsolute, join } from "node:path"
import { LocalAcpHost, type AgentCommand, type LocalAcpHostOptions } from "@workbench/acp-runtime"
import {
  harnessProviderDescriptor,
  type LocalAcpProviderDescriptor,
  type LocalAcpProviderDiscoveryOptions,
  type LocalAcpProviderHostHints,
  type LocalAcpProviderResolution,
} from "@workbench/harness-provider"
import { piProviderDescriptor } from "@workbench/pi-provider"
import { qwenProviderDescriptor } from "@workbench/qwen-provider"
import type { LocalExecutionProviderInfo, LocalExecutionProviderList } from "../local-execution-host.js"
import type { LocalExecutionRuntime } from "./local-execution-ipc.js"

export type {
  LocalAcpProviderDescriptor,
  LocalAcpProviderDiscoveryOptions,
  LocalAcpProviderHostHints,
  LocalAcpProviderResolution,
}

function parseCustomAcpCommand(env: NodeJS.ProcessEnv): AgentCommand {
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

/** 根据显式环境变量构造 `"custom"` Provider 描述符；未设置时不应注册该入口。 */
export function createCustomProviderDescriptor(env: NodeJS.ProcessEnv = process.env): LocalAcpProviderDescriptor {
  return {
    id: "custom",
    label: "自定义 Agent",
    description: "由 WORKBENCH_ACP_EXECUTABLE 环境变量指定的外部 ACP Agent",
    family: "custom",
    hostHints: {
      enableElicitation: true,
      enableClientFs: true,
      restorePolicy: "fallback-new",
    },
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

export type LocalAcpProviderRegistryOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly bindingDirectory?: string
  readonly descriptors?: readonly LocalAcpProviderDescriptor[]
  readonly discoveryOptions?: LocalAcpProviderDiscoveryOptions
}

export type ResolvedProviderHost = {
  readonly providerId: string | null
  readonly host: LocalAcpHost
  readonly available: boolean
  readonly reason?: string
}

/**
 * 桌面端多代理 Provider 注册表：管理多个 ACP Provider 的可用性探测、默认选择与独立 `LocalAcpHost` 生命周期。
 */
export class LocalAcpProviderRegistry {
  readonly #env: NodeJS.ProcessEnv
  readonly #bindingDirectory?: string
  readonly #discoveryOptions?: LocalAcpProviderDiscoveryOptions
  readonly #descriptors = new Map<string, LocalAcpProviderDescriptor>()
  readonly #hosts = new Map<string, LocalAcpHost>()
  #unconfiguredHost?: LocalAcpHost

  constructor(options: LocalAcpProviderRegistryOptions = {}) {
    this.#env = options.env ?? process.env
    this.#bindingDirectory = options.bindingDirectory
    this.#discoveryOptions = options.discoveryOptions

    const baseDescriptors = options.descriptors ?? [
      harnessProviderDescriptor,
      piProviderDescriptor,
      qwenProviderDescriptor,
    ]
    for (const descriptor of baseDescriptors) {
      this.#descriptors.set(descriptor.id, descriptor)
    }
    if (!options.descriptors && this.#env.WORKBENCH_ACP_EXECUTABLE?.trim()) {
      this.#descriptors.set("custom", createCustomProviderDescriptor(this.#env))
    }
  }

  hasProvider(providerId: string): boolean {
    return this.#descriptors.has(providerId)
  }

  /** 列举已注册 Provider 及当前默认选中 ID（`custom` 优先，其次按注册顺序取首个可用）。 */
  listProviders(): LocalExecutionProviderList {
    const providers: LocalExecutionProviderInfo[] = []
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

  /** 按指定或默认 Provider 获取复用的 `LocalAcpHost`，开启标准表单、工作区文件能力与新建兜底策略。 */
  getHost(providerId?: string): ResolvedProviderHost {
    const catalog = this.listProviders()
    const targetId = providerId ?? catalog.defaultProviderId
    if (!targetId) {
      return {
        providerId: null,
        host: this.getFallbackHost(),
        available: false,
        reason: "尚未配置本机 Agent。请确认已安装 harness-agent / pi-acp / qwen，或设置 WORKBENCH_ACP_EXECUTABLE 后重试。",
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
      }
      host = new LocalAcpHost(resolution.command, hostOptions)
      this.#hosts.set(targetId, host)
    }
    return { providerId: targetId, host, available: true }
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

/** 向后兼容的默认命令解析入口：优先读取 `WORKBENCH_ACP_EXECUTABLE`，否则依次探测已注册的本机 Agent。 */
export function resolveDesktopLocalAcpCommand(env: NodeJS.ProcessEnv = process.env): AgentCommand | undefined {
  if (env.WORKBENCH_ACP_EXECUTABLE?.trim()) {
    return parseCustomAcpCommand(env)
  }
  for (const descriptor of [harnessProviderDescriptor, piProviderDescriptor, qwenProviderDescriptor]) {
    const resolved = descriptor.resolveCommand(env)
    if (resolved.available) return resolved.command
  }
  return undefined
}

/** 向后兼容的单宿主创建入口，默认开启 elicitation、工作区 fs 与 fallback-new 恢复策略。 */
export function createDesktopLocalAcpHost(env: NodeJS.ProcessEnv = process.env, bindingDirectory?: string): LocalAcpHost {
  const command = resolveDesktopLocalAcpCommand(env)
  if (!command) return new LocalAcpHost()
  return new LocalAcpHost(command, {
    bindingDirectory,
    bindingNamespace: env.WORKBENCH_SERVICE_ORIGIN,
    enableElicitation: true,
    enableClientFs: true,
    restorePolicy: "fallback-new",
  })
}

export type DesktopLocalExecutionRuntime = {
  readonly localExecution: LocalExecutionRuntime
  readonly dispose: () => Promise<void>
}

/** 创建应用级多代理本机执行运行时及退出收口句柄。 */
export function createDesktopLocalExecutionRuntime(
  env: NodeJS.ProcessEnv,
  userDataDir: string,
): DesktopLocalExecutionRuntime {
  const registry = new LocalAcpProviderRegistry({
    env,
    bindingDirectory: join(userDataDir, "local-acp-bindings"),
  })
  return {
    localExecution: { registry },
    dispose: () => registry.close(),
  }
}
