/**
 * 本地命令处理：首次 start/决定/取消先落账本；accepted 确认但决定丢失仍可重传；
 * invoking 之后无终态保持 unknown，绝不自动重跑或重复调用执行端口。
 */
import type {
  ExecutionStartMessage, ExecutionStartDecisionMessage, ExecutionCancelMessage,
  ExecutionRunnerMessage, TerminalReasonCode,
} from "@workbench/contracts"
import type { Ledger } from "./ledger.js"
import type { ProjectRegistry } from "./project-registry.js"
import { accepted, cancelReceived, messageCreated, messageClosed, nativeBound, output, running, terminal, textAppended, verify } from "./execution-codec.js"

export interface ExecutionPort {
  available(input: { projectRoot: string; agentConfigId: string }): Promise<{ available: boolean; reason?: "PROJECT_ROOT_CHANGED" | "CAPABILITY_UNAVAILABLE" }>
  prepareSession(input: { executionId: string; nativeSessionId: string | null; agentConfigId: string; projectRoot: string; signal: AbortSignal }): Promise<string>
  invoke(input: {
    executionId: string
    text: string
    nativeSessionId: string | null
    agentConfigId: string
    projectRoot: string
    onRunning: () => void
    onMessageCreated: (messageId: string) => void
    onText: (messageId: string, text: string) => void
    onClose: (messageId: string, state: "completed" | "interrupted") => void
    signal: AbortSignal
  }): Promise<{ state: "succeeded" | "failed"; reasonCode?: TerminalReasonCode; nativeSessionId: string }>
  cancel(executionId: string): void
}

/** 未接入真实 ACP 时的生产能力：明确不可用，不返回假成功。 */
export class UnavailableExecutionPort implements ExecutionPort {
  async available(): Promise<{ available: boolean; reason: "CAPABILITY_UNAVAILABLE" }> {
    return { available: false, reason: "CAPABILITY_UNAVAILABLE" }
  }
  async invoke(): Promise<{ state: "failed"; reasonCode: TerminalReasonCode; nativeSessionId: string }> {
    throw new Error("CAPABILITY_UNAVAILABLE")
  }
  async prepareSession(): Promise<string> { throw new Error("CAPABILITY_UNAVAILABLE") }
  cancel(): void {}
}

export class CommandHandler {
  readonly #ledger: Ledger
  readonly #port: ExecutionPort
  readonly #registry: ProjectRegistry
  readonly #send: (message: ExecutionRunnerMessage) => void
  readonly #active = new Map<string, AbortController>()
  readonly #preflighting = new Set<string>()

  constructor(ledger: Ledger, port: ExecutionPort, registry: ProjectRegistry, send: (message: ExecutionRunnerMessage) => void) {
    this.#ledger = ledger; this.#port = port; this.#registry = registry; this.#send = send
  }

  /** 取消先到优先于迟到 start：不生成 accepted、不调用执行端口。 */
  handleStart(start: ExecutionStartMessage): void {
    if (!verify(start)) throw new Error("COMMAND_CONFLICT")
    const id = start.payload.executionId
    const pending = this.#ledger.cancelBeforeStart(id)
    if (pending) {
      if (!sameTarget(start, pending.cancel)) throw new Error("COMMAND_CONFLICT")
      this.#ledger.recordLateStart(start)
      this.resendOutstanding()
      return
    }
    const acceptedMessage = this.#ledger.transaction(() => {
      if (this.#ledger.recordStart(start) === "duplicate") return null
      const message = accepted(start, this.next(id))
      this.#ledger.append(id, message)
      this.#ledger.update(id, "accepted")
      return message
    })
    if (acceptedMessage) this.#send(acceptedMessage)
    else this.resendOutstanding()
  }

  /** 恢复中的决定先落盘，等待当前连接 ready 后才可能调用。 */
  storeDecision(decision: ExecutionStartDecisionMessage): void {
    const record = this.#ledger.execution(decision.payload.executionId)
    if (!verify(decision) || !record || !sameTarget(record.start, decision)) throw new Error("COMMAND_CONFLICT")
    if (record.decision || record.state === "accepted") this.#ledger.recordDecision(decision)
  }

  /** deny 只保存原决定并要求未调用终态；allow 才是首次调用的唯一入口。 */
  async handleDecision(decision: ExecutionStartDecisionMessage, mayInvoke: () => boolean = () => true): Promise<void> {
    if (!verify(decision)) throw new Error("COMMAND_CONFLICT")
    const id = decision.payload.executionId
    const record = this.#ledger.execution(id)
    if (!record || !sameTarget(record.start, decision)) throw new Error("COMMAND_CONFLICT")
    if (["terminalStored", "unknown", "invoking", "running"].includes(record.state)) return
    this.#ledger.recordDecision(decision)
    this.#ledger.acknowledge(id, record.lastCommittedSequence)
    if (!mayInvoke() || this.#preflighting.has(id)) return
    if (record.cancel || decision.payload.reasonCode === "CANCEL_REQUESTED") { this.finishBeforeInvocation(record.start, decision, "cancelled", "CANCELLED_BY_RUNNER"); return }
    if (decision.payload.decision === "deny") {
      this.finishBeforeInvocation(record.start, decision, "rejected", (decision.payload.reasonCode ?? "TARGET_INVALID") as TerminalReasonCode);
      return
    }
    let project = this.#registry.verify(record.start.payload.projectId, record.start.payload.shareVersion)
    if (!project.available) {
      this.finishBeforeInvocation(record.start, decision, "rejected", project.reason ?? "PROJECT_ROOT_CHANGED")
      return
    }
    this.#preflighting.add(id)
    let capability: Awaited<ReturnType<ExecutionPort["available"]>>
    try {
      capability = await this.#port.available({ projectRoot: project.root, agentConfigId: record.start.payload.agentConfigId })
    } finally { this.#preflighting.delete(id) }
    const current = this.#ledger.execution(id)
    // 等能力时可能收到取消或项目撤回。只允许仍未调用的原项越过边界。
    if (!current || current.state !== "decisionStored" || current.cancel || !mayInvoke()) return
    project = this.#registry.verify(record.start.payload.projectId, record.start.payload.shareVersion)
    if (!project.available) {
      this.finishBeforeInvocation(record.start, decision, "rejected", project.reason ?? "PROJECT_ROOT_CHANGED")
      return
    }
    if (!capability.available) {
      this.finishBeforeInvocation(record.start, decision, "rejected", capability.reason ?? "CAPABILITY_UNAVAILABLE")
      return
    }
    const occupied = this.#ledger.transaction(() => {
      if (!this.#ledger.occupy(project.root, id)) return false
      this.#ledger.update(id, "invoking")
      return true
    })
    if (!occupied) {
      // 同根已有执行：保持 accepted，不抢占；等现有执行结束后由恢复/重试继续。
      return
    }
    const controller = new AbortController()
    this.#active.set(id, controller)
    try {
      const bound = record.start.payload.nativeSessionId
      // 原生 ID 只能来自实际端口，准备会话也可能有副作用，须在 invoking 提交之后。
      const nativeSessionId = await this.#port.prepareSession({ executionId: id, nativeSessionId: bound,
        agentConfigId: record.start.payload.agentConfigId, projectRoot: project.root, signal: controller.signal })
      if (!nativeSessionId || (bound !== null && nativeSessionId !== bound)) throw new Error("NATIVE_SESSION_MISMATCH")
      const binding = nativeBound(record.start, decision, this.next(id), nativeSessionId)
      this.#ledger.transaction(() => {
        this.#ledger.update(id, "invoking", { nativeSessionId })
        this.#ledger.append(id, binding)
      })
      this.#send(binding)
      if (controller.signal.aborted) throw new Error("STOP_UNCONFIRMED")
      const text = record.start.payload.input.text
      const result = await this.#port.invoke({
        executionId: id, text, nativeSessionId, agentConfigId: record.start.payload.agentConfigId, projectRoot: project.root,
        signal: controller.signal,
        onRunning: () => {
          if (this.#ledger.execution(id)?.state !== "invoking") return
          const event = running(record.start, decision, this.next(id), nativeSessionId)
          this.#ledger.transaction(() => {
            this.#ledger.update(id, "running")
            this.#ledger.append(id, event)
          })
          this.#send(event)
        },
        onMessageCreated: messageId => {
          this.append(id, output(record.start, decision, this.next(id), messageCreated(messageId)))
        },
        onText: (messageId, delta) => {
          this.append(id, output(record.start, decision, this.next(id), textAppended(messageId, delta)))
        },
        onClose: (messageId, state) => {
          this.append(id, output(record.start, decision, this.next(id), messageClosed(messageId, state)))
        },
      })
      const terminalMessage = terminal(record.start, decision, this.next(id), result.state, result.reasonCode ?? null, "finished", result.nativeSessionId)
      if (result.nativeSessionId !== nativeSessionId) throw new Error("NATIVE_SESSION_MISMATCH")
      this.#ledger.transaction(() => {
        this.#ledger.append(id, terminalMessage)
        this.#ledger.update(id, "terminalStored", { terminal: terminalMessage, nativeSessionId: result.nativeSessionId })
        this.#ledger.release(project.root, id)
      })
      this.#send(terminalMessage)
    } catch {
      // 抛异常或取消信号本身不能证明端口已经停止，保留占用直到取得确切事实。
      this.#ledger.update(id, "unknown")
    } finally {
      this.#active.delete(id)
    }
  }

  /** 取消分两类：未 invoking 直接未调用终态；invoking 后等执行端口真实返回。 */
  handleCancel(cancel: ExecutionCancelMessage): void {
    if (!verify(cancel)) throw new Error("COMMAND_CONFLICT")
    const id = cancel.payload.executionId
    const record = this.#ledger.execution(id)
    if (!record) {
      const existing = this.#ledger.cancelBeforeStart(id)
      if (existing) {
        if (existing.cancel.messageId !== cancel.messageId || existing.cancel.payload.bodySha256 !== cancel.payload.bodySha256) throw new Error("COMMAND_CONFLICT")
        this.resendOutstanding()
        return
      }
      const received = cancelReceived(cancel, cancel, "1")
      const final = terminal(cancel, null, "2", "cancelled", "CANCELLED_BY_RUNNER", "notInvoked", null)
      this.#ledger.saveCancelBeforeStart({ kind: "cancelBeforeStart", cancel, lastRunnerSequence: "2", lastCommittedRunnerSequence: "0", terminal: final }, received)
      this.#send(received)
      this.#send(final)
      return
    }
    if (!sameTarget(record.start, cancel)) throw new Error("COMMAND_CONFLICT")
    if (record.state === "terminalStored") { this.resendOutstanding(); return }
    let received: ExecutionRunnerMessage | null = null
    this.#ledger.transaction(() => {
      if (this.#ledger.recordCancel(cancel)) {
        received = cancelReceived(record.start, cancel, this.next(id))
        this.#ledger.append(id, received)
      }
    })
    if (received) this.#send(received)
    if (["invoking", "running", "unknown"].includes(record.state)) {
      if (received && this.#active.has(id)) {
        this.#active.get(id)?.abort()
        this.#port.cancel(id)
      }
      return
    }
    this.finishBeforeInvocation(record.start, record.decision, "cancelled", "CANCELLED_BY_RUNNER")
  }

  /** 只追加未调用终态；已存在终态不覆盖。 */
  private finishBeforeInvocation(start: ExecutionStartMessage, decision: ExecutionStartDecisionMessage | null,
                                 state: "cancelled" | "rejected", reason: TerminalReasonCode): void {
    const id = start.payload.executionId
    const record = this.#ledger.execution(id)
    if (!record || record.state === "terminalStored") return
    const terminalMessage = terminal(start, decision, this.next(id), state, reason, "notInvoked", null)
    this.#ledger.transaction(() => {
      this.#ledger.append(id, terminalMessage)
      this.#ledger.update(id, "terminalStored", { terminal: terminalMessage })
    })
    this.#send(terminalMessage)
  }

  private next(id: string): string {
    const record = this.#ledger.execution(id)
    if (!record) throw new Error("EXECUTION_NOT_FOUND")
    return String(BigInt(record.lastRunnerSequence) + 1n)
  }

  private append(id: string, message: ExecutionRunnerMessage): void {
    this.#ledger.append(id, message)
    this.#send(message)
  }

  /** 重连后只补传账本中未确认的连续前缀；不重跑 invoking/unknown。 */
  resendOutstanding(): void {
    for (const item of this.#ledger.allOutstanding()) this.#send(item.message)
  }
}

/** 摘要必须引用此原命令，不能拿另一执行的决定或取消来启动本机端口。 */
function sameTarget(start: ExecutionStartMessage, message: ExecutionCancelMessage | ExecutionStartDecisionMessage): boolean {
  const payload = message.payload
  return payload.startCommandId === start.messageId && payload.startBodySha256 === start.payload.bodySha256
    && (["executionId", "workspaceId", "deviceId", "projectId", "conversationId", "inputId"] as const)
      .every(key => start.payload[key] === payload[key])
}
