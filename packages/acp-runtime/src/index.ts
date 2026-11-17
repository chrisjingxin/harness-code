/** 本机 ACP 执行入口。受信任的宿主绑定用户已选目录，每个会话独占一个 Agent 连接。 */
import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { nativeBinding } from "./native-binding.js"
import { BoundSession } from "./session.js"

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

/** 选项来自 Agent，界面只传回该请求的选项标识。 */
export type LocalAcpPermission = {
  readonly id: string
  readonly title: string
  readonly options: readonly { readonly id: string; readonly label: string; readonly allows: boolean }[]
}

/** 标准 ACP 工具通知。工具仅展示来自 Agent 的标题和状态。 */
export type LocalAcpTool = {
  readonly id: string
  readonly title?: string
  readonly status?: "pending" | "in_progress" | "completed" | "failed"
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
  | { readonly type: "tool"; readonly tool: LocalAcpTool }
  | { readonly type: "permission"; readonly request: LocalAcpPermission | null }
  | { readonly type: "completed"; readonly shareable: boolean }
  | { readonly type: "cancelled" }
  | ({ readonly type: "failed" } & Failure)
)

export interface LocalAcpSession {
  /** 空闲时可以提交文本。冷启动的实际结果通过事件交付。 */
  getAvailability(): LocalAcpAvailability
  /** 受理后宿主接管该轮。消费者应先订阅，以便接到首段正文和终态。 */
  send(text: string): LocalAcpSendResult
  /** 停止当前轮。返回表示已匹配轮次，实际结果由终态事件交付。 */
  cancel(turnId: string): boolean
  /** 仅回答匹配的待处理审批。 */
  answerPermission(turnId: string, requestId: string, optionId: string): boolean
  /** 只订阅此句柄的后续事件。返回的函数解除订阅。 */
  subscribe(listener: (event: LocalAcpEvent) => void): () => void
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
export type LocalAcpHostOptions = {
  readonly bindingDirectory?: string
  readonly bindingNamespace?: string
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
    const bound = new BoundSession(root, identity.dev, identity.ino, this.#command, native, () => this.#sessions.delete(key),
      (pid, turnId, stderr) => {
        const event = Object.freeze({ scope: diagnosticScope, pid, turnId, stderr })
        for (const listener of this.#diagnostics) {
          try { listener(event) } catch { /* 诊断消费者无法干扰 Agent。 */ }
        }
      })

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
