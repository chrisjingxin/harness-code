/** 本机 ACP 执行入口。受信任的宿主绑定用户已选目录，每个会话独占一个 Agent 连接。 */
import { realpath, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { BoundSession } from "./session.js"

export type AgentCommand = {
  readonly executable: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

/** 五个标识共同区分属于不同账号、设备或项目的同名会话。由受信任的宿主提供。 */
export type LocalAcpScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly deviceId: string
  readonly conversationId: string
}

export type UnavailableReason = "agent-not-configured" | "session-busy" | "session-closed" | "agent-disconnected"
export type LocalAcpAvailability = { readonly available: true } | { readonly available: false; readonly reason: UnavailableReason }
export type LocalAcpSendResult =
  | { readonly status: "accepted"; readonly turnId: string }
  | { readonly status: "rejected"; readonly reason: UnavailableReason | "empty-text" }

type Failure = {
  readonly reason: "directory-unavailable" | "agent-start-failed" | "agent-disconnected" | "prompt-failed" | "session-closed"
} | {
  readonly reason: "agent-stopped"
  readonly stopReason: "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
}

/** 同一轮从 1 连续编号。失败发生在部分正文之后时，已交付的正文仍然有效。 */
export type LocalAcpEvent = {
  readonly turnId: string
  readonly sequence: number
} & (
  | { readonly type: "text-delta"; readonly text: string; readonly messageId?: string }
  | { readonly type: "completed" }
  | ({ readonly type: "failed" } & Failure)
)

export interface LocalAcpSession {
  /** 空闲时可以提交文本。冷启动的实际结果通过事件交付。 */
  getAvailability(): LocalAcpAvailability
  /** 受理后宿主接管该轮。消费者应先订阅，以便接到首段正文和终态。 */
  send(text: string): LocalAcpSendResult
  /** 只订阅此句柄的后续事件。返回的函数解除订阅。 */
  subscribe(listener: (event: LocalAcpEvent) => void): () => void
  /** 结束执行、释放绑定，等待 Agent 进程确认退出。 */
  close(): Promise<void>
}

export class LocalAcpHost {
  readonly #command?: AgentCommand
  readonly #sessions = new Map<string, BoundSession>()
  #closing?: Promise<void>

  /** 命令、参数和环境由主进程配置并复制，后续用户文本只进入 ACP prompt。 */
  constructor(command?: AgentCommand) {
    if (command && !isAbsolute(command.executable)) throw new Error("本机 Agent 可执行文件必须使用绝对路径。")
    this.#command = command && {
      executable: command.executable,
      args: [...command.args ?? []],
      env: { ...command.env ?? process.env },
    }
  }

  /** cwd 必须来自主进程认可的目录选择。绑定后改变目录需先关闭旧句柄。 */
  async bind(scope: LocalAcpScope, cwd: string): Promise<LocalAcpSession> {
    const ids = [scope.accountId, scope.workspaceId, scope.projectId, scope.deviceId, scope.conversationId]
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
    const bound = new BoundSession(root, identity.dev, identity.ino, this.#command, () => this.#sessions.delete(key))
    this.#sessions.set(key, bound)
    return bound
  }

  /** 应用退出时关闭所有绑定。单个账号切换可以只关闭对应句柄。 */
  close(): Promise<void> {
    return this.#closing ??= Promise.all([...this.#sessions.values()].map(session => session.close())).then(() => undefined)
  }
}
