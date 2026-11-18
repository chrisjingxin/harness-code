/**
 * Pi Provider 公共描述符与能力提示类型。
 *
 * 【功能定义】定义 Pi ACP Provider 的描述符与探测选项，保持与其他 Provider 包零交叉依赖。
 * 【协作边界】仅引用 `@workbench/acp-runtime` 公开类型。
 */
import type { AgentCommand, LocalAcpHostOptions } from "@workbench/acp-runtime"

export type LocalAcpProviderHostHints = Pick<
  LocalAcpHostOptions,
  "enableClientFs" | "enableClientTerminal" | "enableElicitation" | "restorePolicy"
>

export type LocalAcpProviderDiscoveryOptions = {
  readonly searchFrom?: readonly string[]
  readonly extraPathDirs?: readonly string[]
  readonly homeDir?: string
  readonly userHomeDir?: string
  readonly includeDefaultGuiPath?: boolean
}

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

export type LocalAcpProviderDescriptor = {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly family: string
  readonly hostHints: LocalAcpProviderHostHints
  resolveCommand(env?: NodeJS.ProcessEnv, options?: LocalAcpProviderDiscoveryOptions): LocalAcpProviderResolution
}
