/**
 * 桌面本机 ACP 执行宿主装配器。
 *
 * 【功能定义】将通用 `@workbench/acp-runtime` 的 `AcpAgentRegistry` 与默认实例 `@workbench/harness-acp`
 * （及显式配置的外部 ACP Agent / `WORKBENCH_ACP_EXECUTABLE`）装配为桌面主进程可执行运行时。
 * 【协作边界】仅在桌面主进程运行，不硬编码具体第三方 Agent 包，也不向渲染层泄露子进程命令。
 */
import { join } from "node:path"
import {
  AcpAgentRegistry,
  LocalAcpHost,
  parseCustomAcpCommand,
  type AcpAgentDescriptor,
  type AcpAgentDiscoveryOptions,
  type AcpAgentHostHints,
  type AcpAgentResolution,
  type AgentCommand,
} from "@workbench/acp-runtime"
import { harnessAcpDescriptor } from "@workbench/harness-acp"
import type { LocalExecutionRuntime } from "./local-execution-coordinator.js"

export type {
  AcpAgentDescriptor,
  AcpAgentDiscoveryOptions,
  AcpAgentHostHints,
  AcpAgentResolution,
}

export type DesktopLocalAgentRegistryOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly bindingDirectory?: string
  readonly descriptors?: readonly AcpAgentDescriptor[]
  readonly discoveryOptions?: AcpAgentDiscoveryOptions
}

/** 创建桌面默认多代理注册表：默认注入 Harness 实例，并在设置 `WORKBENCH_ACP_EXECUTABLE` 时自动启用 `custom`。 */
export function createDesktopLocalAgentRegistry(options: DesktopLocalAgentRegistryOptions = {}): AcpAgentRegistry {
  return new AcpAgentRegistry({
    env: options.env,
    bindingDirectory: options.bindingDirectory,
    descriptors: options.descriptors ?? [harnessAcpDescriptor],
    discoveryOptions: options.discoveryOptions,
  })
}

/** 解析单实例本机 ACP 命令入口：优先读取 `WORKBENCH_ACP_EXECUTABLE`，否则探测 Harness Agent。 */
export function resolveDesktopLocalAcpCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  discoveryOptions?: AcpAgentDiscoveryOptions,
): AgentCommand | undefined {
  if (env.WORKBENCH_ACP_EXECUTABLE?.trim()) {
    return parseCustomAcpCommand(env)
  }
  const resolved = harnessAcpDescriptor.resolveCommand(env, discoveryOptions)
  return resolved.available ? resolved.command : undefined
}

/** 创建单实例本机 `LocalAcpHost`（主要供独立 CLI 冒烟脚本复用），默认开启 elicitation 与工作区文件能力。 */
export function createDesktopLocalAcpHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
  bindingDirectory?: string,
): LocalAcpHost {
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
  env: Readonly<Record<string, string | undefined>>,
  userDataDir: string,
  options?: Omit<DesktopLocalAgentRegistryOptions, "env" | "bindingDirectory">,
): DesktopLocalExecutionRuntime {
  const registry = createDesktopLocalAgentRegistry({
    env,
    bindingDirectory: join(userDataDir, "local-acp-bindings"),
    ...options,
  })
  return {
    localExecution: { registry },
    dispose: () => registry.close(),
  }
}
