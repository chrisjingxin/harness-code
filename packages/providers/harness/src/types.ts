/**
 * Harness Provider 公共描述符与能力提示类型。
 *
 * 【功能定义】定义本机 ACP Provider 的启动探测结果、宿主能力和描述符契约，
 * 供上层注册表在不了解具体 Agent 源码的前提下按统一格式组装多代理运行时。
 * 【协作边界】仅引用 `@workbench/acp-runtime` 公开类型，不依赖其他 Provider 包或桌面内部模块。
 */
import type { AgentCommand, LocalAcpHostOptions } from "@workbench/acp-runtime"

/** 宿主在创建 LocalAcpHost 时需要启用的客户端协议能力提示。 */
export type LocalAcpProviderHostHints = Pick<
  LocalAcpHostOptions,
  "enableClientFs" | "enableClientTerminal" | "enableElicitation" | "restorePolicy"
>

/** 可选的外部环境与探测路径覆盖选项，便于单测注入隔离目录或禁用系统 PATH 兜底。 */
export type LocalAcpProviderDiscoveryOptions = {
  readonly searchFrom?: readonly string[]
  readonly extraPathDirs?: readonly string[]
  readonly homeDir?: string
  readonly userHomeDir?: string
  readonly includeDefaultGuiPath?: boolean
}

/** Provider 启动命令探测结果：可用时携带绝对路径与完整环境变量，不可用时给出原因说明。 */
export type LocalAcpProviderResolution =
  | {
      readonly available: true
      readonly command: AgentCommand
      readonly source: string
    }
  | {
      readonly available: false
      readonly reason: string
    }

/** 单个本机 ACP Provider 的声明与启动入口描述符。 */
export type LocalAcpProviderDescriptor = {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly family: string
  readonly hostHints: LocalAcpProviderHostHints
  resolveCommand(env?: NodeJS.ProcessEnv, options?: LocalAcpProviderDiscoveryOptions): LocalAcpProviderResolution
}
