/** 本机 ACP 执行入口。受信任的宿主绑定用户已选目录，每个会话独占一个 Agent 连接。 */
import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { AgentCapabilities, ElicitationContentValue, ElicitationSchema, ListSessionsResponse } from "@agentclientprotocol/sdk"
import { nativeBinding } from "./native-binding.js"
import { BoundSession } from "./session.js"
export {
  runAcpConformanceSuite,
  type AcpConformanceCheck,
  type AcpConformanceCheckStatus,
  type AcpConformanceOptions,
  type AcpConformanceReport,
} from "./conformance.js"

export type AgentCommand = {
  readonly executable: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
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

/** 选项来自 Agent，界面只传回该请求的选项标识。 */
export type LocalAcpPermission = {
  readonly id: string
  readonly title: string
  /** 触发权限审批的原工具细节（含 diff、参数与关联路径），供界面直接展示。 */
  readonly tool?: LocalAcpTool
  readonly options: readonly { readonly id: string; readonly label: string; readonly allows: boolean }[]
}

/** 工具携带的一处文件差异；文本可能按长度截断。 */
export type LocalAcpToolDiff = {
  readonly path: string
  readonly oldText?: string
  readonly newText: string
}

/** 标准 ACP 工具通知的显示投影：标题/状态之外，携带已整理的参数、输出、差异文本与终端引用。 */
export type LocalAcpTool = {
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
  | { readonly type: "text-delta"; readonly text: string; readonly messageId?: string }
  | { readonly type: "thought-delta"; readonly text: string }
  | { readonly type: "tool"; readonly tool: LocalAcpTool }
  | { readonly type: "permission"; readonly request: LocalAcpPermission | null }
  | { readonly type: "completed"; readonly shareable: boolean }
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

export type LocalAcpElicitationRequest = {
  readonly id: string
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly requestId?: string | number | null
  readonly message: string
  readonly requestedSchema: ElicitationSchema
}

export type LocalAcpElicitationAnswer =
  | { readonly action: "accept"; readonly content?: Readonly<Record<string, ElicitationContentValue>> }
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

export interface LocalAcpSession {
  /** 空闲时可以提交文本。冷启动的实际结果通过事件交付。 */
  getAvailability(): LocalAcpAvailability
  /** 返回当前已知会话能力、模式、模型、配置、命令表、计划与恢复状态快照。 */
  getState(): LocalAcpSessionState
  /** 主动建立连接并打开原生会话（幂等）；未显式调用时首轮 send 也会自动完成。 */
  connect(): Promise<LocalAcpSessionState>
  /** 受理后宿主接管该轮。消费者应先订阅，以便接到首段正文和终态。 */
  send(text: string): LocalAcpSendResult
  /** 发送结构化内容块（支持 text / resource / resource_link / image）。 */
  sendPrompt(blocks: readonly LocalAcpPromptBlock[]): LocalAcpSendResult
  /** 停止当前轮。返回表示已匹配轮次，实际结果由终态事件交付。 */
  cancel(turnId: string): boolean
  /** 仅回答匹配的待处理审批。 */
  answerPermission(turnId: string, requestId: string, optionId: string): boolean
  /** 回答由 `subscribeSession` 推送的待处理表单请求。 */
  answerElicitation(requestId: string, answer: LocalAcpElicitationAnswer): boolean
  /** 切换会话操作模式（如 default / plan / auto 等）。 */
  setMode(modeId: string): Promise<void>
  /** 设置会话配置项（如 model / thought_level / workflow）。 */
  setConfigOption(configId: string, value: string | boolean): Promise<void>
  /** 按 Agent 宣告的 authMethods 执行认证。 */
  authenticate(methodId: string): Promise<void>
  /** 列出 Agent 侧记录的会话列表（需要 Agent 支持 session/list）。 */
  listSessions(cursor?: string): Promise<ListSessionsResponse>
  /** 按已有原生会话 ID 恢复连接（需要 Agent 支持 session/resume）。 */
  resumeSession(sessionId: string): Promise<LocalAcpSessionState>
  /** 只订阅此句柄的后续轮次事件（严格保留 7 种类型且序号 1..N 连续）。返回的函数解除订阅。 */
  subscribe(listener: (event: LocalAcpEvent) => void): () => void
  /** 订阅会话级更新（计划、命令表、模式、配置、用量、会话重开回放与表单请求）。 */
  subscribeSession(listener: (event: LocalAcpSessionUpdateEvent) => void): () => void
  /** 结束执行、释放绑定，等待 Agent 进程确认退出。 */
  close(): Promise<void>
}

/** 诊断只送给主进程的订阅者。每个分片携带会话、进程及当前轮次归属。 */
export type LocalAcpDiagnostic = {
  readonly scope: LocalAcpScope
  readonly pid: number
  readonly turnId?: string
  readonly stderr: string
}

export type LocalAcpRestorePolicy = "fallback-new" | "strict"

export type LocalAcpHostOptions = {
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

export class LocalAcpHost {
  readonly #command?: AgentCommand
  readonly #sessions = new Map<string, BoundSession>()
  readonly #diagnostics = new Set<(event: LocalAcpDiagnostic) => void>()
  #closing?: Promise<void>

  /** 命令、参数和环境由主进程配置并复制，后续用户文本只进入 ACP prompt。 */
  constructor(command?: AgentCommand, private readonly options: LocalAcpHostOptions = {}) {
    if (command && !isAbsolute(command.executable)) throw new Error("本机 Agent 可执行文件必须使用绝对路径。")
    this.#command = command && {
      executable: command.executable,
      args: [...command.args ?? []],
      env: { ...command.env ?? process.env },
    }
  }

  /** cwd 必须来自主进程认可的目录选择。绑定后改变目录需先关闭旧句柄。 */
  async bind(scope: LocalAcpScope, cwd: string): Promise<LocalAcpSession> {
    const ids = [scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId]
    if (ids.some(id => !id.trim())) throw new Error("缺少本机会话标识。")
    if (!isAbsolute(cwd)) throw new Error("本机工作目录必须使用绝对路径。")
    const root = await realpath(cwd)
    const identity = await stat(root, { bigint: true })
    if (!identity.isDirectory()) throw new Error("本机工作目录不可用。")
    if (this.#closing) throw new Error("本机执行宿主已关闭。")
    const key = JSON.stringify(ids)
    const existing = this.#sessions.get(key)
    if (existing) {
      existing.assertBinding(root, identity.dev, identity.ino)
      return existing
    }
    const native = nativeBinding(this.options.bindingDirectory, [
      this.options.bindingNamespace ?? "", ...ids, root, String(identity.dev), String(identity.ino), this.#command?.executable ?? "",
      JSON.stringify(this.#command?.args ?? []), this.#command?.env?.HOME ?? this.#command?.env?.USERPROFILE ?? "",
    ])
    const diagnosticScope = Object.freeze({ ...scope })
    const bound = new BoundSession(
      root,
      identity.dev,
      identity.ino,
      this.#command,
      native,
      () => this.#sessions.delete(key),
      (pid, turnId, stderr) => {
        const event = Object.freeze({ scope: diagnosticScope, pid, turnId, stderr })
        for (const listener of this.#diagnostics) {
          try { listener(event) } catch { /* 诊断消费者无法干扰 Agent。 */ }
        }
      },
      this.options,
    )

    this.#sessions.set(key, bound)
    return bound
  }

  /** 受信任的宿主可订阅 stderr 分片。内容是 Agent 原始输出，应按本机敏感数据处理。 */
  subscribeDiagnostics(listener: (event: LocalAcpDiagnostic) => void): () => void {
    this.#diagnostics.add(listener)
    return () => { this.#diagnostics.delete(listener) }
  }

  /** 应用退出时关闭所有绑定。单个账号切换可以只关闭对应句柄。 */
  close(): Promise<void> {
    return this.#closing ??= Promise.all([...this.#sessions.values()].map(session => session.close())).then(() => undefined)
  }
}
