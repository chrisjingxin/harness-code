/**
 * 【功能定义】`@workbench/acp-runtime/types` 纯前端安全 DTO 子出口。
 * 【协作边界】严禁导入 Node 内建模块、`child_process` 或 Electron，供桌面渲染层与 Preload 按契约安全引用。
 */
import type { AgentCapabilities, McpServer } from "@agentclientprotocol/sdk"

export type * from "./descriptor.js"

export type AgentCommand = {
  readonly executable: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** 四个标识共同区分属于不同账号、团队、项目或会话的本地执行作用域。由受信任的宿主提供。 */
export type LocalAcpScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
}

export type UnavailableReason = "agent-not-configured" | "session-busy" | "session-closed" | "agent-disconnected"
export type LocalAcpAvailability = { readonly available: true } | { readonly available: false; readonly reason: UnavailableReason }
export type LocalAcpSendResult =
  | { readonly status: "accepted"; readonly turnId: string }
  | { readonly status: "rejected"; readonly reason: UnavailableReason | "empty-text" }

/** 工具关联的工作区文件与行号，供工具卡片摘要和审批预览展示。 */
export type LocalAcpToolLocation = {
  readonly path: string
  readonly line?: number
}

/** Agent 附加的协议元数据，由受信任宿主按协商结果解释。 */
export type LocalAcpMeta = Readonly<Record<string, unknown>>

/** 选项来自 Agent，界面只传回该请求的选项标识。 */
export type LocalAcpPermission = {
  readonly rawMeta?: LocalAcpMeta
  readonly id: string
  readonly title: string
  /** 触发权限审批的原工具细节（含 diff、参数与关联路径），供界面直接展示。 */
  readonly tool?: LocalAcpTool
  readonly options: readonly { readonly id: string; readonly label: string; readonly allows: boolean; readonly rawMeta?: LocalAcpMeta }[]
}

/** 工具携带的一处文件差异；文本可能按长度截断。 */
export type LocalAcpToolDiff = {
  readonly path: string
  readonly oldText?: string
  readonly newText: string
}

/** 标准 ACP 工具通知的显示投影：标题/状态之外，携带已整理的参数、输出、差异文本与终端引用。 */
export type LocalAcpTool = {
  readonly rawMeta?: LocalAcpMeta
  readonly id: string
  readonly title?: string
  readonly status?: "pending" | "in_progress" | "completed" | "failed"
  readonly kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"
  readonly input?: string
  readonly output?: string
  readonly diffs?: readonly LocalAcpToolDiff[]
  readonly locations?: readonly LocalAcpToolLocation[]
  readonly terminalId?: string
}

type Failure = {
  readonly reason: "directory-unavailable" | "agent-start-failed" | "agent-disconnected" | "prompt-failed" | "session-closed" | "session-restore-unsupported" | "session-restore-failed"
} | {
  readonly reason: "agent-stopped"
  readonly stopReason: "max_tokens" | "max_turn_requests" | "refusal"
}

/** 同一轮从 1 连续编号。失败发生在部分正文之后时，已交付的正文仍然有效。 */
export type LocalAcpEvent = {
  readonly turnId: string
  readonly sequence: number
} & (
  | { readonly type: "text-delta"; readonly text: string; readonly messageId?: string; readonly rawMeta?: LocalAcpMeta }
  | { readonly type: "thought-delta"; readonly text: string }
  | { readonly type: "tool"; readonly tool: LocalAcpTool }
  | { readonly type: "permission"; readonly request: LocalAcpPermission | null }
  | { readonly type: "completed"; readonly shareable: boolean; readonly rawMeta?: LocalAcpMeta }
  | { readonly type: "cancelled" }
  | ({ readonly type: "failed" } & Failure)
)

export type LocalAcpImplementation = {
  readonly name: string
  readonly title?: string
  readonly version: string
}

export type LocalAcpAuthMethod = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly type: "agent" | "env_var" | "terminal"
  readonly args?: readonly string[]
  readonly link?: string
  readonly vars?: readonly {
    readonly name: string
    readonly label?: string
    readonly secret?: boolean
    readonly optional?: boolean
  }[]
}

export type LocalAcpMode = {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export type LocalAcpModesState = {
  readonly currentModeId: string
  readonly availableModes: readonly LocalAcpMode[]
}

export type LocalAcpModelInfo = {
  readonly modelId: string
  readonly name: string
  readonly description?: string
}

export type LocalAcpModelsState = {
  readonly currentModelId?: string
  readonly availableModels: readonly LocalAcpModelInfo[]
}

export type LocalAcpConfigSelectOption = {
  readonly value: string
  readonly name: string
  readonly description?: string
  readonly group?: string
  readonly groupName?: string
}

export type LocalAcpConfigOption =
  | {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly category?: string
      readonly type: "select"
      readonly currentValue: string
      readonly options: readonly LocalAcpConfigSelectOption[]
    }
  | {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly category?: string
      readonly type: "boolean"
      readonly currentValue: boolean
    }

export type LocalAcpCommand = {
  readonly name: string
  readonly description: string
  readonly inputHint?: string
  readonly meta?: Readonly<Record<string, unknown>>
}

export type LocalAcpPlanEntry = {
  readonly content: string
  readonly priority: "high" | "medium" | "low"
  readonly status: "pending" | "in_progress" | "completed"
}

export type LocalAcpPlanState =
  | { readonly kind: "entries"; readonly id?: string; readonly entries: readonly LocalAcpPlanEntry[] }
  | { readonly kind: "markdown"; readonly id: string; readonly content: string }
  | { readonly kind: "file"; readonly id: string; readonly uri: string }

export type LocalAcpSessionInfo = {
  readonly rawMeta?: LocalAcpMeta
  readonly title?: string | null
  readonly updatedAt?: string | null
}

export type LocalAcpSessionUsage = {
  readonly used: number
  readonly size: number
  readonly cost?: { readonly amount: number; readonly currency: string }
}

export type LocalAcpRestoreReason = "session-restore-unsupported" | "session-restore-failed"

export type LocalAcpRestoreStatus =
  | { readonly kind: "none" }
  | { readonly kind: "restored"; readonly sessionId: string }
  | { readonly kind: "new"; readonly sessionId: string }
  | {
      readonly kind: "reset"
      readonly reason: LocalAcpRestoreReason
      readonly previousSessionId: string
      readonly sessionId: string
    }

export type LocalAcpSessionState = {
  readonly connected: boolean
  readonly sessionId?: string
  readonly protocolVersion?: number
  readonly agentInfo?: LocalAcpImplementation
  readonly agentCapabilities?: AgentCapabilities
  readonly authMethods: readonly LocalAcpAuthMethod[]
  readonly modes?: LocalAcpModesState
  readonly currentModeId?: string
  readonly models?: LocalAcpModelsState
  readonly configOptions: readonly LocalAcpConfigOption[]
  readonly availableCommands: readonly LocalAcpCommand[]
  readonly plans: readonly LocalAcpPlanState[]
  readonly sessionInfo?: LocalAcpSessionInfo
  readonly usage?: LocalAcpSessionUsage
  readonly restoreStatus: LocalAcpRestoreStatus
  readonly setupDiagnostics?: readonly string[]
}

export type LocalAcpPromptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "resource"
      readonly resource:
        | { readonly uri: string; readonly text: string; readonly mimeType?: string }
        | { readonly uri: string; readonly blob: string; readonly mimeType?: string }
    }
  | {
      readonly type: "resource_link"
      readonly uri: string
      readonly name: string
      readonly title?: string
      readonly description?: string
      readonly mimeType?: string
      readonly size?: number
    }
  | {
      readonly type: "image"
      readonly data: string
      readonly mimeType: string
      readonly uri?: string
    }

export type LocalAcpReplayFrame =
  | { readonly kind: "user-text"; readonly text: string; readonly messageId?: string }
  | { readonly kind: "user-block"; readonly block: LocalAcpPromptBlock; readonly messageId?: string }
  | { readonly kind: "agent-text"; readonly text: string; readonly messageId?: string }
  | { readonly kind: "agent-thought"; readonly text: string; readonly messageId?: string }
  | { readonly kind: "agent-block"; readonly block: LocalAcpPromptBlock; readonly messageId?: string }
  | { readonly kind: "tool"; readonly tool: LocalAcpTool }

export type LocalAcpElicitationValue = string | number | boolean | readonly string[]

export type LocalAcpElicitationRequest = {
  readonly id: string
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly requestId?: string | number | null
  readonly message: string
  readonly requestedSchema: Readonly<Record<string, unknown>>
}

export type LocalAcpElicitationAnswer =
  | { readonly action: "accept"; readonly content?: Readonly<Record<string, LocalAcpElicitationValue>> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" }

/** 会话级增量通知：与轮次事件通道隔离，供新界面消费模式、配置、命令、计划、回放与表单请求。 */
export type LocalAcpSessionUpdateEvent =
  | { readonly type: "initialized"; readonly state: LocalAcpSessionState }
  | { readonly type: "session-opened"; readonly state: LocalAcpSessionState }
  | {
      readonly type: "session-reset"
      readonly reason: LocalAcpRestoreReason
      readonly previousSessionId: string
      readonly sessionId: string
    }
  | { readonly type: "plan"; readonly plans: readonly LocalAcpPlanState[] }
  | { readonly type: "available-commands"; readonly commands: readonly LocalAcpCommand[] }
  | { readonly type: "current-mode"; readonly currentModeId: string }
  | { readonly type: "config-options"; readonly configOptions: readonly LocalAcpConfigOption[] }
  | { readonly type: "session-info"; readonly sessionInfo: LocalAcpSessionInfo }
  | { readonly type: "usage"; readonly usage: LocalAcpSessionUsage }
  | { readonly type: "replay"; readonly frame: LocalAcpReplayFrame }
  | { readonly type: "elicitation"; readonly request: LocalAcpElicitationRequest | null }

export type LocalAcpDiagnostic = {
  readonly scope: LocalAcpScope
  readonly pid: number
  readonly turnId?: string
  readonly stderr: string
}

export type LocalAcpRestorePolicy = "fallback-new" | "strict"

/** 由受信任宿主配置。目录必须已经获得宿主授权，MCP 不从 Agent 文本或页面消息读取。 */
export type LocalAcpSessionSetup = {
  readonly additionalDirectories?: readonly string[]
  readonly mcpServers?: readonly McpServer[]
}

export type LocalAcpHostOptions = LocalAcpSessionSetup & {
  readonly extraClientCapabilitiesMeta?: LocalAcpMeta
  /** 由 Agent 描述符为其已协商的 prompt 扩展填写客户端轮次标识。 */
  readonly promptTurnIdMetaKey?: string
  /** 启用后从第一条有效回放帧计时，静默超时仍视为恢复失败。 */
  readonly sessionLoadReplayIdleMs?: number
  readonly bindingDirectory?: string
  readonly bindingNamespace?: string
  /** 原生会话恢复失败或 Agent 不支持时的策略；默认 `"fallback-new"` 自动清理旧绑定并重建会话。 */
  readonly restorePolicy?: LocalAcpRestorePolicy
  /** 是否开启工作区沙箱 `fs/read_text_file` 与 `fs/write_text_file` 反向 RPC，默认 `true`。 */
  readonly enableClientFs?: boolean
  /** 是否开启工作区沙箱 `terminal/*` 反向 RPC，默认 `false`。 */
  readonly enableClientTerminal?: boolean
  /** 是否声明 `elicitation: { form: {} }` 并接管表单请求，默认 `false` 防止未接通表单的调用方卡死。 */
  readonly enableElicitation?: boolean
  /** `fs/*` 单文件读写字节上限，默认 1 MiB。 */
  readonly maxFsFileBytes?: number
  /** 初始化与建会话握手超时（毫秒），默认 15000。 */
  readonly handshakeTimeoutMs?: number
}
