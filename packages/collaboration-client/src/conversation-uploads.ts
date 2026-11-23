/**
 * 【功能定义】会话定稿磁盘待传账本与重试队列：
 * 成功终态 → 写入本机待传文件 → 固定连续序号 → 会话 sync POST → 服务端确认水位后移除。
 *
 * 【协作边界】
 * - 零 Electron 依赖、零反向耦合桌面执行宿主；作用域由自有 `CollaborationConversationScope` 约束。
 * - 只保存待传数据，前端输入区与回复展示不等待上传网络结果。
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type {
  CollaborationError, CollaborationResult, ConversationShareMode, ConversationSyncRequest, ConversationSyncResponse, SyncMessage,
} from "./types/index.js"
import {
  collaborationConversationKey,
  type CollaborationConversationScope,
  type ConversationUploadNotice,
} from "./scope.js"

export const syncPayloadLimit = 32 * 1024
const MAX_TOOL_SUMMARIES = 50
const BATCH_PAYLOAD_BUDGET = 900 * 1024
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const canRetry = (error: CollaborationError) =>
  error.retryable || ["NETWORK_UNAVAILABLE", "SERVICE_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(error.code)

export type FinalizedToolSummary = {
  readonly label: string
  readonly name?: string
  readonly summary?: string
  readonly status: "completed" | "failed"
  readonly tone: "read" | "write" | "neutral"
  readonly occurredAtMs: number
}

export type FinalizedAttachmentSummary = {
  readonly label: string
  readonly kind: "file" | "directory"
  readonly path?: string
}

export type FinalizedTurn = {
  turnId: string
  userText: string
  shareMode?: ConversationShareMode
  briefText?: string
  referenceIds?: readonly string[]
  attachments?: readonly FinalizedAttachmentSummary[]
  followUps?: readonly { readonly text: string; readonly occurredAtMs: number }[]
  tools?: readonly FinalizedToolSummary[]
  reply: string | undefined
  acceptedAtMs: number
  completedAtMs: number
}

type WaitingTurn = {
  turnId: string
  shareMode?: ConversationShareMode
  messages: Omit<SyncMessage, "sequence">[]
  briefText: string
  firstSequence?: number
}

type Pending = {
  scope: CollaborationConversationScope
  turns: WaitingTurn[]
}

export interface ConversationUploadPort {
  watermark(scope: CollaborationConversationScope, signal: AbortSignal): Promise<CollaborationResult<number>>
  upload(scope: CollaborationConversationScope, request: ConversationSyncRequest, signal: AbortSignal): Promise<CollaborationResult<ConversationSyncResponse>>
}

class UploadFailure extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code?: CollaborationError["code"]) { super(message) }
}

function unwrap<T>(result: CollaborationResult<T>): T {
  if (!result.ok) throw new UploadFailure(result.error.message, canRetry(result.error), result.error.code)
  return result.value
}

function briefExcerpt(text: string): string {
  return text.slice(0, 800).replace(/\s+/g, " ").trim().slice(0, 240)
}

function fitJsonStringField(
  value: string,
  limitBytes: number,
  render: (candidate: string | undefined) => string,
): string | undefined {
  if (!value) return undefined
  if (Buffer.byteLength(render(value), "utf8") <= limitBytes) return value
  const chars = [...value]
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = (low + high + 1) >> 1
    const candidate = mid > 0 ? `${chars.slice(0, mid).join("")}…` : undefined
    if (Buffer.byteLength(render(candidate), "utf8") <= limitBytes) low = mid
    else high = mid - 1
  }
  return low > 0 ? `${chars.slice(0, low).join("")}…` : undefined
}

function buildToolSummaryPayload(tool: FinalizedToolSummary, maxBytes: number): string | null {
  const status = tool.status === "failed" ? "failed" : "completed"
  const tone = tool.tone === "read" || tool.tone === "write" ? tool.tone : "neutral"
  const render = (label: string, name?: string, summary?: string) => JSON.stringify({
    label,
    ...(name ? { name } : {}),
    ...(summary ? { summary } : {}),
    status,
    tone,
  })
  const rawLabel = tool.label || "Agent 工具"
  const full = render(rawLabel, tool.name, tool.summary)
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full

  // 超限先保住标签，再分别裁剪 name 与 summary；若仍超限则跳过，避免阻断整轮文本定稿同步。
  const safeLabel = fitJsonStringField(rawLabel, Math.min(512, maxBytes), candidate => render(candidate ?? "工具"))
    ?? "工具"
  if (Buffer.byteLength(render(safeLabel), "utf8") > maxBytes) return null
  const nameLimit = tool.summary ? Math.min(2048, Math.floor(maxBytes / 4)) : maxBytes
  const safeName = tool.name
    ? fitJsonStringField(tool.name, nameLimit, candidate => render(safeLabel, candidate))
    : undefined
  const safeSummary = tool.summary
    ? fitJsonStringField(tool.summary, maxBytes, candidate => render(safeLabel, safeName, candidate))
    : undefined
  const bounded = render(safeLabel, safeName, safeSummary)
  return Buffer.byteLength(bounded, "utf8") <= maxBytes ? bounded : null
}

/** 待传文件按账号隔离。切换账号时取消旧网络请求，保留其本机待传文件。 */
export class ConversationUploads {
  #account: { id: string; controller: AbortController } | null = null
  #writing: Promise<void> = Promise.resolve()
  #running = false
  #wakeRequested = false
  #timer?: ReturnType<typeof setTimeout>
  readonly #blocked = new Set<string>()

  constructor(
    private readonly root: string,
    private readonly port: ConversationUploadPort,
    private readonly notify: (notice: ConversationUploadNotice) => void,
  ) {}

  useAccount(id: string | null): void {
    if (id === (this.#account?.id ?? null)) return
    this.#account?.controller.abort()
    this.#account = id ? { id, controller: new AbortController() } : null
    this.#blocked.clear()
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#wake()
  }

  /** 只接收已完成的文本轮（含本轮已终态工具摘要）。summary_only 仅组装简报而不保存或发送对话正文。 */
  async enqueue(scope: CollaborationConversationScope, turn: FinalizedTurn): Promise<void> {
    const { turnId, userText, reply, acceptedAtMs, completedAtMs } = turn
    const shareMode: ConversationShareMode = turn.shareMode ?? "full"
    const trimmedExplicitBrief = turn.briefText?.trim()
    const requestPreview = userText.trim()
      ? userText
      : (turn.attachments?.length ? turn.attachments.map(item => item.label).join(" ") : userText)
    const fallbackBrief = `诉求：${briefExcerpt(requestPreview)}\n回复：${briefExcerpt(reply ?? "")}`
    const briefText = (trimmedExplicitBrief ? trimmedExplicitBrief : fallbackBrief).slice(0, 2000)

    let messages: WaitingTurn["messages"] = []
    if (shareMode === "full") {
      const userMessage: Omit<SyncMessage, "sequence"> = {
        type: "user",
        occurredAtMs: acceptedAtMs,
        payload: JSON.stringify({
          text: userText,
          ...(turn.referenceIds?.length ? { referenceIds: turn.referenceIds } : {}),
          ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
        }),
      }
      const assistantMessage: Omit<SyncMessage, "sequence"> = {
        type: "assistant",
        occurredAtMs: completedAtMs,
        payload: JSON.stringify({ text: reply }),
      }
      const userBytes = Buffer.byteLength(userMessage.payload, "utf8")
      const assistantBytes = Buffer.byteLength(assistantMessage.payload, "utf8")
      if (reply === undefined || userBytes > syncPayloadLimit || assistantBytes > syncPayloadLimit) {
        this.#report(scope, turnId, "本轮正文超出单条共享消息的 32 KiB 上限。")
        return
      }
      const followUps: Omit<SyncMessage, "sequence">[] = (turn.followUps ?? []).map(({ text, occurredAtMs }) => ({
        type: "user", occurredAtMs, payload: JSON.stringify({ text }),
      }))
      const followUpBytes = followUps.map(message => Buffer.byteLength(message.payload, "utf8"))
      let remainingBatchBytes = BATCH_PAYLOAD_BUDGET - userBytes - assistantBytes - followUpBytes.reduce((a, b) => a + b, 0)
      if (followUpBytes.some(bytes => bytes > syncPayloadLimit) || remainingBatchBytes < 0) {
        this.#report(scope, turnId, "本轮追发消息超出共享载荷上限。")
        return
      }
      const toolMessages: Omit<SyncMessage, "sequence">[] = []
      for (const tool of (turn.tools ?? []).slice(0, MAX_TOOL_SUMMARIES)) {
        if (remainingBatchBytes <= 0) break
        const payload = buildToolSummaryPayload(tool, Math.min(syncPayloadLimit, remainingBatchBytes))
        if (!payload) continue
        const occurredAtMs = Number.isSafeInteger(tool.occurredAtMs) && tool.occurredAtMs >= 0
          ? tool.occurredAtMs
          : completedAtMs
        toolMessages.push({ type: "tool_summary", occurredAtMs, payload })
        remainingBatchBytes -= Buffer.byteLength(payload, "utf8")
      }
      messages = [userMessage, ...followUps, ...toolMessages, assistantMessage]
    }

    const path = join(this.root, scope.accountId, scope.conversationId + ".json")
    try {
      await this.#mutate(async () => {
        const pending = await this.#read(path) ?? { scope, turns: [] }
        if (collaborationConversationKey(pending.scope) !== collaborationConversationKey(scope)) throw new Error("会话范围不一致")
        if (pending.turns.some(item => item.turnId === turnId)) return
        pending.turns.push({ turnId, shareMode, messages, briefText })
        await this.#write(path, pending)
      })
      this.#wake()
    } catch {
      this.#report(scope, turnId, "无法保存待上传的本轮定稿。")
    }
  }

  /** 移除指定会话尚未排空的本机待传文件（例如停止共享后止损清理）。 */
  async cancelConversation(scope: CollaborationConversationScope): Promise<void> {
    const path = join(this.root, scope.accountId, scope.conversationId + ".json")
    await this.#mutate(async () => {
      await rm(path, { force: true })
    })
  }

  /** 关窗只等待已受理的落盘，已固定序号的批次可由下一次登录重发。 */
  flush(): Promise<void> { return this.#writing }

  #report(
    scope: CollaborationConversationScope,
    turnId: string,
    failure?: string,
    firstSequence?: number,
    syncedSequence?: number,
    sharingStopped?: boolean,
  ): void {
    this.notify({
      scope,
      turnId,
      kind: "upload",
      failure: failure ? `会话共享失败：${failure}` : undefined,
      ...(sharingStopped ? { sharingStopped: true } : {}),
      // 仅在上传成功确认后附带区间或水位：summary_only 只含 syncedSequence 而不含 firstSequence
      ...(!failure && firstSequence !== undefined ? { firstSequence } : {}),
      ...(!failure && syncedSequence !== undefined ? { syncedSequence } : {}),
    })
  }

  #mutate<T>(change: () => Promise<T>): Promise<T> {
    const pending = this.#writing.then(change)
    this.#writing = pending.then(() => {}, () => {})
    return pending
  }

  async #read(path: string): Promise<Pending | null> {
    try { return JSON.parse(await readFile(path, "utf8")) as Pending }
    catch (error) { if (missing(error)) return null; throw error }
  }

  async #write(path: string, pending: Pending): Promise<void> {
    if (!pending.turns.length) { await rm(path, { force: true }); return }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = path + "." + randomUUID()
    try {
      await writeFile(temp, JSON.stringify(pending), { flag: "wx", mode: 0o600, flush: true })
      await rename(temp, path)
    } finally { await rm(temp, { force: true }).catch(() => {}) }
  }

  #wake(): void {
    if (!this.#account || this.#timer) return
    if (this.#running) { this.#wakeRequested = true; return }
    this.#running = true
    this.#wakeRequested = false
    const { id, controller } = this.#account
    void this.#drain(id, controller.signal).catch(() => 5_000).then(delay => {
      this.#running = false
      if (this.#account?.controller !== controller) this.#wake()
      else if (delay !== undefined) {
        this.#timer = setTimeout(() => { this.#timer = undefined; this.#wake() }, delay)
        this.#timer.unref()
      } else if (this.#wakeRequested) this.#wake()
    })
  }

  async #drain(accountId: string, signal: AbortSignal): Promise<number | undefined> {
    const folder = join(this.root, accountId)
    const names = await readdir(folder).catch(error => { if (missing(error)) return []; throw error })
    let delay: number | undefined
    for (const name of names) {
      if (signal.aborted) return
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
      const path = join(folder, name)
      const pending = await this.#read(path).catch(() => null)
      const turn = pending?.turns[0]
      if (!pending || !turn || pending.scope.accountId !== accountId || pending.scope.conversationId + ".json" !== name
        || this.#blocked.has(turn.turnId)) continue
      try {
        await this.#send(path, pending.scope, turn, signal)
        delay = 2_000
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof UploadFailure && error.code === "CONVERSATION_SHARING_STOPPED") {
          // 服务端返回 409 CONVERSATION_SHARING_STOPPED：清空待传文件并通知上层停传，不安排重试
          await this.#mutate(async () => {
            await rm(path, { force: true })
          }).catch(() => {})
          this.#report(pending.scope, turn.turnId, error.message, undefined, undefined, true)
          continue
        }
        this.#report(pending.scope, turn.turnId, error instanceof UploadFailure ? error.message : "无法读写本机待传记录。")
        if (error instanceof UploadFailure && !error.retryable) this.#blocked.add(turn.turnId)
        else delay = Math.min(delay ?? 5_000, 5_000)
      }
    }
    return delay
  }

  async #editHead(path: string, turnId: string, edit: (pending: Pending) => void): Promise<void> {
    return this.#mutate(async () => {
      const pending = await this.#read(path)
      if (!pending || pending.turns[0]?.turnId !== turnId) throw new Error("待传队列已变化")
      edit(pending)
      await this.#write(path, pending)
    })
  }

  async #send(path: string, scope: CollaborationConversationScope, turn: WaitingTurn, signal: AbortSignal): Promise<void> {
    const watermark = unwrap(await this.port.watermark(scope, signal))
    signal.throwIfAborted()
    if (turn.messages.length === 0) {
      const receipt = unwrap(await this.port.upload(scope, {
        messages: [],
        brief: { status: "idle", briefSource: "rule", briefText: turn.briefText },
      }, signal))
      signal.throwIfAborted()
      await this.#editHead(path, turn.turnId, pending => { pending.turns.shift() })
      if (!signal.aborted) this.#report(scope, turn.turnId, undefined, undefined, receipt.syncedSequence)
      return
    }
    const firstSequence = turn.firstSequence ?? watermark + 1
    const finalSequence = firstSequence + turn.messages.length - 1
    if (!Number.isSafeInteger(finalSequence) || firstSequence < 1
      || (watermark !== firstSequence - 1 && watermark !== finalSequence)) {
      throw new UploadFailure("服务端水位与本机待传批次不一致。", false)
    }
    if (turn.firstSequence === undefined) {
      // 发出任何网络写入前保存批首。超时或重启后以原批次重发，让 Java 对重放确认同一水位。
      await this.#editHead(path, turn.turnId, pending => { pending.turns[0]!.firstSequence = firstSequence })
    }
    signal.throwIfAborted()
    const receipt = unwrap(await this.port.upload(scope, {
      messages: turn.messages.map((message, index) => ({ ...message, sequence: firstSequence + index })),
      brief: { status: "idle", briefSource: "rule", briefText: turn.briefText },
    }, signal))
    if (receipt.syncedSequence !== finalSequence) throw new UploadFailure("服务端未确认本轮的完整同步水位。", false)
    signal.throwIfAborted()

    await this.#editHead(path, turn.turnId, pending => { pending.turns.shift() })
    if (!signal.aborted) this.#report(scope, turn.turnId, undefined, firstSequence, finalSequence)
  }
}
