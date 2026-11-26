/**
 * 【功能定义】通用 ACP Agent 描述符、能力提示与探测结果唯一契约定义。
 * 【协作边界】纯 TypeScript 类型定义，零 Node/Electron/特定 Agent 运行时依赖；供各 Agent 适配桥与桌面层共用。
 */
import type { AgentCommand, LocalAcpHostOptions } from "./types.js"

/** 宿主在创建 `LocalAcpHost` 时需要启用的标准客户端协议能力提示。 */
export type AcpAgentHostHints = Pick<
  LocalAcpHostOptions,
  "enableClientFs" | "enableClientTerminal" | "enableElicitation" | "restorePolicy" | "extraClientCapabilitiesMeta" | "sessionLoadReplayIdleMs" | "promptTurnIdMetaKey" | "shareProcessPerWorkspace"
>

/** 可选的外部环境与探测路径覆盖选项，便于单测注入隔离目录或禁用系统 PATH 兜底。 */
export type AcpAgentDiscoveryOptions = {
  readonly searchFrom?: readonly string[]
  readonly extraPathDirs?: readonly string[]
  readonly homeDir?: string
  readonly userHomeDir?: string
  readonly includeDefaultGuiPath?: boolean
}

/** 启动命令探测结果：可用时携带绝对路径与完整环境变量，不可用时给出清晰原因说明。 */
export type AcpAgentResolution =
  | {
      readonly available: true
      readonly command: AgentCommand
      readonly source: string
    }
  | {
      readonly available: false
      readonly reason: string
    }

/** 单个标准 ACP Agent 实例的声明与启动入口描述符。 */
export type AcpAgentDescriptor = {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly family: string
  readonly hostHints: AcpAgentHostHints
  resolveCommand(env?: Readonly<Record<string, string | undefined>>, options?: AcpAgentDiscoveryOptions): AcpAgentResolution
}

/** 暴露给上层界面的只读 Agent 摘要信息（不含底层可执行路径或环境变量）。 */
export type AcpAgentInfo = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly available: boolean
  readonly reason?: string
}

/** 已注册 Agent 列表与当前自动选中的默认 Agent 标识。 */
export type AcpAgentList = {
  readonly providers: readonly AcpAgentInfo[]
  readonly defaultProviderId: string | null
}
