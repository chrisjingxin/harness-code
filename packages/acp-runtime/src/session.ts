/**
 * 单会话执行：绑定目录 → 受理一轮 → 首次启动并握手 → 提交文本 → 按序交付增量和终态。
 * LocalAcpHost 管理绑定；本模块把子进程和标准 ACP 的细节留在宿主内。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { Writable } from "node:stream"
import { ClientSideConnection, ndJsonStream, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk"
import { setTimeout as delay } from "node:timers/promises"
import { agentStdout } from "./agent-stdio.js"
import { toLocalAcpTool } from "./tool-update.js"
import type { NativeBinding } from "./native-binding.js"
import type { AgentCommand, LocalAcpAvailability, LocalAcpEvent, LocalAcpSendResult, LocalAcpSession } from "./index.js"

type EventData<T = LocalAcpEvent> = T extends LocalAcpEvent ? Omit<T, "turnId" | "sequence"> : never
type Turn = {
  id: string
  sequence: number
  prompting: boolean
  cancelling?: boolean
  denied?: boolean
  cancelTimer?: ReturnType<typeof setTimeout>
}
type Permission = {
  turn: Turn
  id: string
  options: RequestPermissionRequest["options"]
  resolve: (reply: RequestPermissionResponse) => void
}
type RestoreFailure = "session-restore-unsupported" | "session-restore-failed"
class RestoreError extends Error {
  constructor(readonly reason: RestoreFailure) { super(reason) }
}
const declined: RequestPermissionResponse = { outcome: { outcome: "cancelled" } }

type Agent = {
  child: ChildProcessWithoutNullStreams
  exited: Promise<void>
  connection: ClientSideConnection
  sessionId?: string
  disconnected: boolean
  stopping?: Promise<void>
  exitedConfirmed?: boolean
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
  readonly #outbox: LocalAcpEvent[] = []
  #emitting = false
  #active?: Turn
  #agent?: Agent
  #permission?: Permission
  #closing?: Promise<void>

  constructor(
    private readonly root: string,
    private readonly device: bigint,
    private readonly inode: bigint,
    private readonly command: AgentCommand | undefined,
    private readonly nativeBinding: NativeBinding,
    private readonly release: () => void,
    private readonly diagnostic: (pid: number, turnId: string | undefined, stderr: string) => void,
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
    if (this.#agent?.disconnected && this.#agent.stopping && !this.#agent.exitedConfirmed) return { available: false, reason: "agent-disconnected" }
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

  cancel(turnId: string): boolean {
    const turn = this.#active
    if (!turn || turn.id !== turnId || this.#closing) return false
    if (turn.cancelling) return true
    turn.cancelling = true
    const agent = this.#agent
    if (!turn.prompting || !agent?.sessionId) return true
    // ACP 的取消是通知，只有 prompt 的返回值能确认 Agent 停在何处。
    void agent.connection.cancel({ sessionId: agent.sessionId }).catch(() => this.abortUnconfirmed(turn, agent))
    turn.cancelTimer = setTimeout(() => this.abortUnconfirmed(turn, agent), 10_000)
    this.resolvePermission(turn, declined)
    return true
  }

  private abortUnconfirmed(turn: Turn, agent: Agent): void {
    if (this.#active !== turn) return
    agent.disconnected = true
    void this.stopAgent(agent).catch(() => {}).then(() => {
      this.finish(turn, { type: "failed", reason: "agent-disconnected" })
    })
  }

  answerPermission(turnId: string, requestId: string, optionId: string): boolean {
    const pending = this.#permission
    if (!pending || pending.turn.id !== turnId || pending.id !== requestId || pending.turn.cancelling || this.#closing) return false
    const option = pending.options.find(option => option.optionId === optionId)
    if (!option) return false
    pending.turn.denied ||= option.kind.startsWith("reject_")
    this.resolvePermission(pending.turn, { outcome: { outcome: "selected", optionId } })
    return true
  }

  private requestPermission(agent: Agent, input: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const turn = this.#active
    if (this.#agent !== agent || agent.sessionId !== input.sessionId || !turn?.prompting || turn.cancelling || this.#closing) {
      return Promise.resolve(declined)
    }
    if (this.#permission || !input.options.length || new Set(input.options.map(option => option.optionId)).size !== input.options.length) {
      // 输入区只展示一个请求。遇到并发或畸形请求时拒绝它，原请求仍等用户。
      turn.denied = true
      return Promise.resolve(declined)
    }
    return new Promise(resolve => {
      const id = randomUUID()
      this.#permission = { turn, id, options: input.options, resolve }
      this.emit(turn, { type: "permission", request: {
        id, title: input.toolCall.title || "Agent 请求工具权限",
        // 附带规范化工具细节（diff、参数、关联位置），供桌面审批卡片呈现决策上下文。
        tool: toLocalAcpTool(input.toolCall),
        options: input.options.map(option => ({
          id: option.optionId, label: option.name, allows: option.kind.startsWith("allow_"),
        })),
      } })
    })
  }

  private resolvePermission(turn: Turn, response: RequestPermissionResponse): void {
    const pending = this.#permission
    if (!pending || pending.turn !== turn) return
    this.#permission = undefined
    pending.resolve(response)
    this.emit(turn, { type: "permission", request: null })
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
    if (turn.cancelling) { this.finish(turn, { type: "cancelled" }); return }
    let agent = this.#agent
    if (!agent || agent.disconnected) {
      try {
        if (agent) await this.stopAgent(agent)
        if (this.#active !== turn) return
        agent = this.launchAgent(this.command!)
        this.#agent = agent
        await this.openSession(agent)
      } catch (error) {
        if (agent) {
          try {
            await this.stopAgent(agent)
            // 只有未取得原生会话的启动失败才可以在下一次发送重新尝试。
            if (this.#agent === agent) this.#agent = undefined
          } catch {
            agent.disconnected = true
          }
        }
        this.finish(turn, { type: "failed", reason: agent && this.#agent === agent ? "agent-disconnected"
          : error instanceof RestoreError ? error.reason : "agent-start-failed" })
        return
      }
    }

    if (this.#active !== turn) return
    if (turn.cancelling) { this.finish(turn, { type: "cancelled" }); return }
    turn.prompting = true
    try {
      const result = await agent.connection.prompt({
        sessionId: agent.sessionId!,
        prompt: [{ type: "text", text }],
      })
      this.finish(turn, result.stopReason === "end_turn"
        ? { type: "completed", shareable: !turn.cancelling && !turn.denied && this.#permission?.turn !== turn }
        : result.stopReason === "cancelled" ? { type: "cancelled" }
        : { type: "failed", reason: "agent-stopped", stopReason: result.stopReason })
    } catch {
      const disconnected = agent.disconnected || agent.connection.signal.aborted
      if (disconnected) await this.stopAgent(agent).catch(() => {})
      this.finish(turn, { type: "failed", reason: disconnected ? "agent-disconnected" : "prompt-failed" })
    }
  }

  private launchAgent(command: AgentCommand): Agent {
    const child = spawn(command.executable, command.args ?? [], {
      cwd: this.root, env: command.env, stdio: "pipe", windowsHide: true, shell: false, detached: process.platform !== "win32",
    })
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()))
    // stderr 不进入协议、对话正文、窗口或上传。诊断消费者只接收受限大小的分片。
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (child.pid !== undefined) this.diagnostic(child.pid, this.#agent === agent ? this.#active?.id : undefined, chunk.slice(0, 8192))
    })
    const stream = ndJsonStream(Writable.toWeb(child.stdin), new ReadableStream({ start(controller) { controller.close() } }))
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: async notification => this.onUpdate(agent, notification),
      requestPermission: input => this.requestPermission(agent, input),
    }), { readable: agentStdout(child.stdout), writable: stream.writable })

    const agent: Agent = { child, exited, connection, disconnected: false }
    const disconnected = () => {
      agent.disconnected = true
      const turn = this.#agent === agent && agent.sessionId ? this.#active : undefined
      void this.stopAgent(agent).catch(() => {}).then(() => {
        if (turn) this.finish(turn, { type: "failed", reason: "agent-disconnected" })
      })
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
    let nativeId: string | undefined
    try { nativeId = await this.nativeBinding.read() }
    catch { throw new RestoreError("session-restore-failed") }
    if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
    if (nativeId) {
      if (!initialized.agentCapabilities?.loadSession) throw new RestoreError("session-restore-unsupported")
      try {
        // 回放期间尚未绑定 sessionId，也未派发 prompt。旧更新不能进入当前轮。
        await within(connection.loadSession({ sessionId: nativeId, cwd: this.root, mcpServers: [] }), 15_000)
      } catch { throw new RestoreError("session-restore-failed") }
    } else {
      const opened = await within(connection.newSession({ cwd: this.root, mcpServers: [] }), 15_000)
      nativeId = opened.sessionId
      if (!nativeId) throw new Error("无法创建本机 Agent 会话。")
      if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
      await this.nativeBinding.write(nativeId)
    }
    if (agent.disconnected || this.#closing) throw new Error("本机 Agent 已断开。")
    agent.sessionId = nativeId
  }

  private onUpdate(agent: Agent, { sessionId, update }: SessionNotification): void {
    if (!this.#active?.prompting || this.#agent !== agent || agent.sessionId !== sessionId || agent.disconnected) return
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.emit(this.#active, { type: "tool", tool: toLocalAcpTool(update) })
      return
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text" && update.content.text) {
        this.emit(this.#active, { type: "thought-delta", text: update.content.text })
      }
      return
    }
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text" || !update.content.text) return
    this.emit(this.#active, { type: "text-delta", text: update.content.text, messageId: update.messageId ?? undefined })
  }

  private finish(turn: Turn, event: EventData): void {
    if (this.#active !== turn) return
    clearTimeout(turn.cancelTimer)
    this.resolvePermission(turn, declined)
    // 终态回调查询可用性时已经空闲。过期请求不能清理下一轮的状态。
    this.#active = undefined
    this.emit(turn, event)
  }

  private emit(turn: Turn, event: EventData): void {
    const value = Object.freeze({ ...event, turnId: turn.id, sequence: ++turn.sequence })
    // 订阅者可能同步回答审批。先向所有订阅者交付当前序号，再交付由回答触发的事件。
    this.#outbox.push(value)
    if (this.#emitting) return
    this.#emitting = true
    try {
      while (this.#outbox.length) {
        const next = this.#outbox.shift()!
        for (const listener of [...this.#listeners]) {
          try { listener(next) } catch { /* 消费方异常不会打断协议和其他订阅。 */ }
        }
      }
    } finally {
      this.#emitting = false
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
    return agent.stopping ??= this.waitForExit(agent).then(() => { agent.exitedConfirmed = true })
  }

  private async waitForExit(agent: Agent): Promise<void> {
    const { child, exited } = agent
    child.stdin.end()
    const pid = child.pid
    const group = pid !== undefined && process.platform !== "win32" ? -pid : undefined
    function groupAlive(): boolean {
      if (group === undefined) return false
      try { process.kill(group, 0); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
        throw error
      }
    }
    function signal(name: NodeJS.Signals): void {
      if (group === undefined) { child.kill(name); return }
      try { process.kill(group, name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
    }
    const wait = async () => {
      const deadline = Date.now() + 2_000
      await within(exited, 2_000)
      while (groupAlive()) {
        if (Date.now() >= deadline) throw new Error("Agent 进程组仍在运行。")
        await delay(30)
      }
    }
    // 先给 Agent 正常处理 EOF 的机会，再逐步结束同一进程组。每轮等待都会停止自己的检查。
    for (const name of [undefined, "SIGTERM", "SIGKILL"] as const) {
      if (name) signal(name)
      try { await wait(); return }
      catch { if (name === "SIGKILL") throw new Error("未确认本机 Agent 进程退出。") }
    }
  }
}
