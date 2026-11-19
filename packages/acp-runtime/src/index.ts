/**
 * 【功能定义】第 3 层通用 ACP 运行时入口（`@workbench/acp-runtime`）。
 * 【协作边界】零 Electron、零特定 Agent 硬编码；提供标准 ACP 会话绑定、沙箱反向 RPC、通用进程探测与多代理注册表。
 */
import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { prepareSessionSetup } from "./session-setup.js"
import type { ListSessionsResponse } from "@agentclientprotocol/sdk"
import { buildNativeBindingIdentity, nativeBinding } from "./native-binding.js"
import { BoundSession } from "./session.js"
import type {
  AgentCommand,
  LocalAcpAvailability,
  LocalAcpDiagnostic,
  LocalAcpElicitationAnswer,
  LocalAcpEvent,
  LocalAcpHostOptions,
  LocalAcpPromptBlock,
  LocalAcpScope,
  LocalAcpSendResult,
  LocalAcpSessionState,
  LocalAcpSessionUpdateEvent,
} from "./types.js"

export * from "./types.js"
export * from "./descriptor.js"
export * from "./discovery.js"
export {
  AcpAgentRegistry,
  createCommandAgentDescriptor,
  createCustomAgentDescriptor,
  parseCustomAcpCommand,
  type AcpAgentRegistryOptions,
  type CommandAgentDescriptorOptions,
  type ResolvedAgentHost,
} from "./registry.js"
export {
  runAcpConformanceSuite,
  type AcpConformanceCheck,
  type AcpConformanceCheckStatus,
  type AcpConformanceOptions,
  type AcpConformanceReport,
} from "./conformance.js"

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
  sendPrompt(blocks: readonly LocalAcpPromptBlock[], historyOnReset?: readonly LocalAcpPromptBlock[]): LocalAcpSendResult
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

  /** cwd 必须来自受信任宿主的目录选择。绑定后改变目录需先关闭旧句柄。 */
  async bind(scope: LocalAcpScope, cwd: string, setup?: import("./types.js").LocalAcpSessionSetup): Promise<LocalAcpSession> {
    const ids = [scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId]
    if (ids.some(id => !id.trim())) throw new Error("缺少本机会话标识。")
    if (!isAbsolute(cwd)) throw new Error("本机工作目录必须使用绝对路径。")
    const root = await realpath(cwd)
    const identity = await stat(root, { bigint: true })
    if (!identity.isDirectory()) throw new Error("本机工作目录不可用。")
    if (this.#closing) throw new Error("本机执行宿主已关闭。")
    const key = JSON.stringify(ids)
    const preparedSetup = await prepareSessionSetup(root, {
      additionalDirectories: setup?.additionalDirectories ?? this.options.additionalDirectories,
      mcpServers: setup?.mcpServers ?? this.options.mcpServers,
    })
    if (this.#closing) throw new Error("本机执行宿主已关闭。")
    const existing = this.#sessions.get(key)
    if (existing) {
      existing.assertBinding(root, identity.dev, identity.ino)
      existing.assertSessionSetup(preparedSetup)
      return existing
    }
    const native = nativeBinding(
      this.options.bindingDirectory,
      buildNativeBindingIdentity(this.options.bindingNamespace, scope, root, identity.dev, identity.ino, this.#command),
    )
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
      preparedSetup,
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
