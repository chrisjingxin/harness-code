/**
 * Runner 主动连接固定服务。Java 请求账本，Runner 补持久来源，收到 ready 后才首次调用。
 * 连接取代只变更外层 ID，原命令、决定、来源与指纹不变。
 */
import WebSocket from "ws"
import { randomUUID } from "node:crypto"
import type { DeviceEnvelope, DeviceMessage, ExecutionRunnerMessage, ProjectReadCommand, ProjectReadReply, ResumeRecord } from "@workbench/contracts"
import { fitProjectReply, isProjectReadAction, type ProjectReadPort } from "./project-read.js"
import type { Ledger } from "./ledger.js"
import type { CommandHandler } from "./command-handler.js"

export interface DeviceConnectionOptions {
  server: string
  secret: string
  deviceId: string
  workspaceId: string
  ledgerId: string
  ledger: Ledger
  handler: CommandHandler
  projectRead?: ProjectReadPort
  onState?: (state: "reconciling" | "ready" | "offline") => void
}

export class DeviceConnection {
  readonly #options: DeviceConnectionOptions
  readonly #origin: string
  #socket: WebSocket | null = null
  #connectionId: string | null = null
  #resumeId: string | null = null
  #ready = false
  #stopped = false
  #attempt = 0
  #reconnectTimer: NodeJS.Timeout | null = null
  #deadline: NodeJS.Timeout | null = null
  #flush: NodeJS.Timeout | null = null
  #projectReads = 0
  #projectReadIds = new Set<string>()

  constructor(options: DeviceConnectionOptions) {
    this.#options = options
    const url = new URL(options.server)
    if (options.server !== url.origin || !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
      throw new Error("REQUEST_SOURCE_REJECTED")
    }
    this.#origin = url.origin
  }

  start(): void {
    this.connect()
    this.#flush = setInterval(() => {
      this.#options.handler.resendOutstanding()
      if (this.#ready) this.resumeDecisions()
    }, 5_000)
  }

  stop(): void {
    this.#stopped = true
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    if (this.#deadline) clearTimeout(this.#deadline)
    if (this.#flush) clearInterval(this.#flush)
    this.#ready = false
    const socket = this.#socket
    this.#socket = null
    socket?.terminate()
  }

  private connect(): void {
    if (this.#stopped) return
    this.#options.onState?.("reconciling")
    const url = this.#origin.replace(/^http/, "ws") + "/api/v1/device/channel"
    const socket = new WebSocket(url, "workbench.device.v1", {
      headers: { Authorization: `Bearer ${this.#options.deviceId}.${this.#options.secret}`, Origin: this.#origin,
        "X-Workbench-Protocol-Version": "1", ...(this.#options.projectRead ? { "X-Workbench-Device-Capabilities": "project.read" } : {}) },
      followRedirects: false, perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: 10_000,
    })
    this.#socket = socket
    socket.on("open", () => { if (this.#socket === socket) this.refreshDeadline(socket) })
    socket.on("ping", () => { if (this.#socket === socket && this.#ready) this.refreshDeadline(socket) })
    socket.on("message", (data, binary) => {
      if (this.#socket !== socket) return
      try {
        if (binary) throw new Error("INVALID_CONTROL_FRAME")
        this.receive(JSON.parse(data.toString()) as DeviceEnvelope)
        this.refreshDeadline(socket)
      } catch { socket.close(1008, "invalid control frame") }
    })
    socket.on("unexpected-response", (_request, response) => {
      response.resume()
      if ([401, 403, 426].includes(response.statusCode ?? 0)) this.#stopped = true
      socket.terminate()
    })
    socket.on("close", () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#connectionId = null
      this.#resumeId = null
      this.#ready = false
      if (this.#deadline) clearTimeout(this.#deadline)
      this.#options.onState?.("offline")
      if (!this.#stopped) this.#reconnectTimer = setTimeout(() => this.connect(), Math.min(15_000, 1000 * 2 ** this.#attempt++) + Math.random() * 250)
    })
    socket.on("error", error => {
      if ("code" in error && typeof error.code === "string" && /CERT|TLS|SELF_SIGNED|ISSUER/.test(error.code)) this.#stopped = true
    })
  }

  private refreshDeadline(socket: WebSocket): void {
    if (this.#deadline) clearTimeout(this.#deadline)
    this.#deadline = setTimeout(() => socket.terminate(), this.#ready ? 45_000 : 30_000)
  }

  private receive(envelope: DeviceEnvelope): void {
    const { connectionId, message } = envelope
    if (!isId(connectionId) || !message || message.protocolVersion !== 1 || !isId(message.messageId)) throw new Error("INVALID_CONTROL_FRAME")
    if (message.type === "device.welcome") {
      const payload = message.payload
      if (this.#connectionId || payload.ledgerId !== this.#options.ledgerId || payload.deviceId !== this.#options.deviceId
        || payload.workspaceId !== this.#options.workspaceId || !isId(payload.resumeId)) throw new Error("LEDGER_MISMATCH")
      this.#connectionId = connectionId
      this.#resumeId = payload.resumeId
      return
    }
    if (connectionId !== this.#connectionId || this.#resumeId === null) throw new Error("INVALID_CONTROL_FRAME")
    switch (message.type) {
      case "device.resume.request": {
        const payload = message.payload
        if (payload.resumeId !== this.#resumeId || this.#ready) throw new Error("INVALID_CONTROL_FRAME")
        const records = this.#options.ledger.recoveryRecords()
        const common = { resumeId: this.#resumeId, requestMessageId: message.messageId, ledgerId: this.#options.ledgerId }
        if (payload.kind === "lookup") {
          const record = records.find(item => key(item) === payload.startCommandId)
          this.sendControl("device.command.status", { ...common, startCommandId: payload.startCommandId,
            ...(record ? { result: "found", record } : { result: "notFound" }) })
        } else if (payload.kind === "inventory") {
          const after = payload.afterStartCommandId
          const eligible = records.filter(item => (after === null || key(item) > after)
            && (!item.terminal || BigInt(item.lastRunnerSequence) > BigInt(item.lastCommittedRunnerSequence)))
            .sort((a, b) => key(a).localeCompare(key(b)))
          const page: ResumeRecord[] = []
          let bytes = 1024
          for (const record of eligible) {
            bytes += Buffer.byteLength(JSON.stringify(record)) + 1
            if (page.length === 100 || bytes > 256 * 1024) break
            page.push(record)
          }
          if (eligible.length && !page.length) throw new Error("PAYLOAD_TOO_LARGE")
          this.sendControl("device.resume", { ...common, afterStartCommandId: after, records: page,
            nextAfterStartCommandId: eligible.length > page.length ? key(page.at(-1)!) : null })
        } else throw new Error("INVALID_CONTROL_FRAME")
        this.#options.handler.resendOutstanding()
        return
      }
      case "device.ready":
        if (message.payload.resumeId !== this.#resumeId || message.payload.ledgerId !== this.#options.ledgerId) throw new Error("LEDGER_MISMATCH")
        this.#ready = true
        this.#attempt = 0
        this.#options.onState?.("ready")
        this.resumeDecisions()
        return
      case "device.project.changed": {
        const { projectId, shareEnabled, shareVersion, resumeId } = message.payload
        if (resumeId !== null && resumeId !== this.#resumeId) throw new Error("INVALID_CONTROL_FRAME")
        const existing = this.#options.ledger.project(projectId)
        if (existing) {
          const version = BigInt(shareVersion)
          const previous = BigInt(existing.shareVersion)
          if (version < previous || (version === previous && existing.shareEnabled !== shareEnabled)) throw new Error("SHARE_VERSION_CONFLICT")
          if (version > previous) this.#options.ledger.saveProject({ ...existing, shareEnabled, shareVersion })
        }
        this.sendControl("device.project.saved", { projectId, shareVersion, resumeId, requestMessageId: message.messageId,
          result: existing ? "applied" : "notRegistered" })
        return
      }
      case "project.read":
        this.handleProjectRead(message)
        return
      case "execution.events.ack":
        this.#options.ledger.acknowledge(message.payload.executionId, message.payload.lastCommittedRunnerSequence)
        return
      case "execution.start":
        this.verifyTarget(message)
        this.#options.handler.handleStart(message)
        return
      case "execution.start.decision":
        this.verifyTarget(message)
        if (this.#ready) this.applyDecision(message)
        else this.#options.handler.storeDecision(message)
        return
      case "execution.cancel":
        this.verifyTarget(message)
        this.#options.handler.handleCancel(message)
        return
      case "device.execution.problem":
        if (message.payload.kind === "gap") this.#options.handler.resendOutstanding()
        else throw new Error("COMMAND_CONFLICT")
        return
      default: throw new Error("INVALID_CONTROL_FRAME")
    }
  }

  /** 项目只读即时执行，连接切换或超过时限后丢弃旧结果。 */
  private handleProjectRead(message: ProjectReadCommand): void {
    const { workspaceId, deviceId, projectId, shareVersion, action } = message.payload
    const port = this.#options.projectRead
    if (!this.#ready || !port || deviceId !== this.#options.deviceId || workspaceId !== this.#options.workspaceId
      || !isId(projectId) || !/^(?:0|[1-9][0-9]{0,18})$/.test(shareVersion) || !isProjectReadAction(action)) {
      throw new Error("INVALID_CONTROL_FRAME")
    }
    if (this.#projectReadIds.has(message.messageId)) throw new Error("INVALID_CONTROL_FRAME")
    const socket = this.#socket
    const connectionId = this.#connectionId
    const startedAt = Date.now()
    const reply = (result: ProjectReadReply["payload"]["result"]) => {
      if (!socket || this.#socket !== socket || !connectionId || connectionId !== this.#connectionId
        || !this.#ready || Date.now() - startedAt >= 8000) return
      const answer: ProjectReadReply = {
        protocolVersion: 1, messageId: randomUUID(), type: "project.read.result", occurredAt: new Date().toISOString(),
        payload: { requestMessageId: message.messageId, workspaceId, deviceId, projectId, shareVersion, kind: action.kind, result },
      }
      this.sendEnvelope({ message: fitProjectReply(connectionId, answer) })
    }
    if (this.#projectReads >= 4) {
      reply({ status: "error", code: "PROJECT_BUSY" })
      return
    }
    this.#projectReads++
    this.#projectReadIds.add(message.messageId)
    void port.read(projectId, shareVersion, action)
      .then(result => {
        if (result.status === "ok" && result.response.kind !== action.kind) {
          reply({ status: "error", code: "PROJECT_READ_FAILED" })
        } else reply(result)
      })
      .catch(() => reply({ status: "error", code: "PROJECT_READ_FAILED" }))
      .finally(() => { this.#projectReads--; this.#projectReadIds.delete(message.messageId) })
  }

  private verifyTarget(message: Extract<DeviceMessage, { type: "execution.start" | "execution.cancel" | "execution.start.decision" }>): void {
    if (message.payload.deviceId !== this.#options.deviceId || message.payload.workspaceId !== this.#options.workspaceId
      || !this.#options.ledger.project(message.payload.projectId)) throw new Error("COMMAND_CONFLICT")
  }

  private resumeDecisions(): void {
    for (const record of this.#options.ledger.unresolved()) {
      if (record.state === "decisionStored" && record.decision) this.applyDecision(record.decision)
    }
  }

  private applyDecision(message: Extract<DeviceMessage, { type: "execution.start.decision" }>): void {
    const socket = this.#socket
    void this.#options.handler.handleDecision(message, () => this.#socket === socket && this.#ready)
      .catch(() => socket?.close(1008, "execution conflict"))
  }

  /** 按执行传送已持久的来源，不发送空批次或伪造确认。 */
  send(message: ExecutionRunnerMessage): void {
    this.sendEnvelope({ messages: [message] })
  }

  private sendControl(type: string, payload: object): void {
    this.sendEnvelope({ message: { protocolVersion: 1, messageId: randomUUID(), type, occurredAt: new Date().toISOString(), payload } })
  }

  private sendEnvelope(content: { message: object } | { messages: ExecutionRunnerMessage[] }): void {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.#connectionId) return
    const bytes = JSON.stringify({ connectionId: this.#connectionId, ...content })
    if (Buffer.byteLength(bytes) > 256 * 1024 || socket.bufferedAmount > 512 * 1024) { socket.terminate(); return }
    socket.send(bytes, error => { if (error) socket.terminate() })
  }
}

function key(record: ResumeRecord): string {
  return record.kind === "execution" ? record.start.messageId : record.cancel.payload.startCommandId
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}
