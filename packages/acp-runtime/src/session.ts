/**
 * 单会话执行：绑定目录 → 受理一轮 → 首次启动并握手 → 提交文本 → 按序交付增量和终态。
 * LocalAcpHost 管理绑定；本模块把子进程和标准 ACP 的细节留在宿主内。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { Readable, Writable } from "node:stream"
import { ClientSideConnection, ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentCommand, LocalAcpAvailability, LocalAcpEvent, LocalAcpSendResult, LocalAcpSession } from "./index.js"

type EventData<T = LocalAcpEvent> = T extends LocalAcpEvent ? Omit<T, "turnId" | "sequence"> : never
type Turn = { id: string; sequence: number; prompting: boolean }
type Agent = {
  child: ChildProcessWithoutNullStreams
  exited: Promise<void>
  connection: ClientSideConnection
  sessionId?: string
  disconnected: boolean
  stopping?: Promise<void>
}

/** 启动和关闭时限各自只约束子进程生命周期，正常回复可持续流式输出。 */
async function within<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("等待本机 Agent 响应超时。")), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class BoundSession implements LocalAcpSession {
  readonly #listeners = new Set<(event: LocalAcpEvent) => void>()
  #active?: Turn
  #agent?: Agent
  #closing?: Promise<void>

  constructor(
    private readonly root: string,
    private readonly device: bigint,
    private readonly inode: bigint,
    private readonly command: AgentCommand | undefined,
    private readonly release: () => void,
  ) {}

  assertBinding(root: string, device: bigint, inode: bigint): void {
    if (root !== this.root || device !== this.device || inode !== this.inode) {
      throw new Error("本机会话绑定的工作目录已变更，请释放后重新绑定。")
    }
  }

  getAvailability(): LocalAcpAvailability {
    if (this.#closing) return { available: false, reason: "session-closed" }
    if (!this.command) return { available: false, reason: "agent-not-configured" }
    if (this.#active) return { available: false, reason: "session-busy" }
    if (this.#agent?.disconnected) return { available: false, reason: "agent-disconnected" }
    return { available: true }
  }

  subscribe(listener: (event: LocalAcpEvent) => void): () => void {
    if (this.#closing) throw new Error("本机会话已关闭。")
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  send(text: string): LocalAcpSendResult {
    const availability = this.getAvailability()
    if (!availability.available) return { status: "rejected", reason: availability.reason }
    if (!text.trim()) return { status: "rejected", reason: "empty-text" }
    const turn = { id: randomUUID(), sequence: 0, prompting: false }
    this.#active = turn
    // 留出当前调用栈，确保消费者先拿到受理结果和 turnId。
    queueMicrotask(() => void this.run(turn, text))
    return { status: "accepted", turnId: turn.id }
  }

  private async run(turn: Turn, text: string): Promise<void> {
    try {
      const root = await realpath(this.root)
      const identity = await stat(root, { bigint: true })
      if (!identity.isDirectory()) throw new Error("本机工作目录不可用。")
      this.assertBinding(root, identity.dev, identity.ino)
    } catch {
      this.finish(turn, { type: "failed", reason: "directory-unavailable" })
      return
    }
    if (this.#active !== turn) return
    let agent = this.#agent
    if (!agent) {
      try {
        agent = this.launchAgent(this.command!)
        this.#agent = agent
        await this.openSession(agent)
      } catch {
        if (agent) {
          try {
            await this.stopAgent(agent)
            // 只有未取得原生会话的启动失败才可以在下一次发送重新尝试。
            if (this.#agent === agent) this.#agent = undefined
          } catch {
            agent.disconnected = true
          }
        }
        this.finish(turn, { type: "failed", reason: "agent-start-failed" })
        return
      }
    }

    if (this.#active !== turn) return
    turn.prompting = true
    try {
      const result = await agent.connection.prompt({
        sessionId: agent.sessionId!,
        prompt: [{ type: "text", text }],
      })
      this.finish(turn, result.stopReason === "end_turn"
        ? { type: "completed" }
        : { type: "failed", reason: "agent-stopped", stopReason: result.stopReason })
    } catch {
      this.finish(turn, { type: "failed", reason: agent.disconnected ? "agent-disconnected" : "prompt-failed" })
    }
  }

  private launchAgent(command: AgentCommand): Agent {
    const child = spawn(command.executable, command.args ?? [], {
      cwd: this.root, env: command.env, stdio: "pipe", windowsHide: true, shell: false,
    })
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()))
    // stderr 与协议分开。首轮只转发归类后的错误，保留 Agent 自身的诊断路径。
    child.stderr.resume()
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: async notification => this.onUpdate(notification),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))

    const agent: Agent = { child, exited, connection, disconnected: false }
    const disconnected = () => {
      agent.disconnected = true
      if (this.#agent === agent && agent.sessionId && this.#active) {
        this.finish(this.#active, { type: "failed", reason: "agent-disconnected" })
      }
    }
    child.on("error", disconnected)
    void exited.then(disconnected)
    void connection.closed.then(disconnected, disconnected)
    return agent
  }

  private async openSession(agent: Agent): Promise<void> {
    const { connection } = agent
    const initialized = await within(connection.initialize({ protocolVersion: 1, clientCapabilities: {} }), 15_000)
    if (initialized.protocolVersion !== 1 || agent.disconnected || this.#closing) throw new Error("本机 Agent 握手失败。")
    const opened = await within(connection.newSession({ cwd: this.root, mcpServers: [] }), 15_000)
    if (!opened.sessionId || agent.disconnected || this.#closing) throw new Error("无法创建本机 Agent 会话。")
    agent.sessionId = opened.sessionId
  }

  private onUpdate({ sessionId, update }: SessionNotification): void {
    if (!this.#active?.prompting || this.#agent?.sessionId !== sessionId) return
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text" || !update.content.text) return
    this.emit(this.#active, { type: "text-delta", text: update.content.text, messageId: update.messageId ?? undefined })
  }

  private finish(turn: Turn, event: EventData): void {
    if (this.#active !== turn) return
    // 终态回调查询可用性时已经空闲。过期请求不能清理下一轮的状态。
    this.#active = undefined
    this.emit(turn, event)
  }

  private emit(turn: Turn, event: EventData): void {
    const value = Object.freeze({ ...event, turnId: turn.id, sequence: ++turn.sequence })
    for (const listener of [...this.#listeners]) {
      try { listener(value) } catch { /* 消费方异常不会打断同一 ACP 连接和其他订阅。 */ }
    }
  }

  close(): Promise<void> {
    // 先登记关闭，终态回调便不能重新发送或递归关闭。
    return this.#closing ??= Promise.resolve().then(async () => {
      if (this.#active) this.finish(this.#active, { type: "failed", reason: "session-closed" })
      this.#listeners.clear()
      if (this.#agent) await this.stopAgent(this.#agent)
      this.release()
    })
  }

  private stopAgent(agent: Agent): Promise<void> {
    return agent.stopping ??= this.waitForExit(agent)
  }

  private async waitForExit(agent: Agent): Promise<void> {
    agent.child.stdin.end()
    try {
      await within(agent.exited, 2_000)
    } catch {
      agent.child.kill("SIGTERM")
      try {
        await within(agent.exited, 2_000)
      } catch {
        agent.child.kill("SIGKILL")
        await within(agent.exited, 2_000)
      }
    }
  }
}
