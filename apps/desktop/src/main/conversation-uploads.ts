/**
 * 本机文本定稿上传。成功终态 → 写入本机待传文件 → 固定连续序号 → 用户会话 POST → 确认后移除。
 * 只保存待传数据，回复与发送按钮不等待网络。
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { CollaborationError, CollaborationResult, ConversationSyncRequest, ConversationSyncResponse, SyncMessage } from "@workbench/contracts"
import { localExecutionKey, type LocalExecutionScope, type LocalExecutionUploadNotice } from "../local-execution-host.js"

export const syncPayloadLimit = 32 * 1024
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const canRetry = (error: CollaborationError) =>
  error.retryable || ["NETWORK_UNAVAILABLE", "SERVICE_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(error.code)

export type FinalizedTurn = {
  turnId: string
  userText: string
  referenceIds?: readonly string[]
  reply: string | undefined
  acceptedAtMs: number
  completedAtMs: number
}

type WaitingTurn = {
  turnId: string
  messages: Omit<SyncMessage, "sequence">[]
  briefText: string
  firstSequence?: number
}

type Pending = {
  scope: LocalExecutionScope
  turns: WaitingTurn[]
}

interface ConversationUploadPort {
  watermark(scope: LocalExecutionScope, signal: AbortSignal): Promise<CollaborationResult<number>>
  upload(scope: LocalExecutionScope, request: ConversationSyncRequest, signal: AbortSignal): Promise<CollaborationResult<ConversationSyncResponse>>
}

class UploadFailure extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message) }
}

function unwrap<T>(result: CollaborationResult<T>): T {
  if (!result.ok) throw new UploadFailure(result.error.message, canRetry(result.error))
  return result.value
}

function briefExcerpt(text: string): string {
  return text.slice(0, 800).replace(/\s+/g, " ").trim().slice(0, 240)
}

/** 待传文件按账号隔离。切换账号时取消旧网络请求，保留其本机文件。 */
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
    private readonly notify: (notice: LocalExecutionUploadNotice) => void,
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

  /** 只接收已完成的文本轮。超出单条载荷上限时保留本机显示并报告共享失败。 */
  async enqueue(scope: LocalExecutionScope, turn: FinalizedTurn): Promise<void> {
    const { turnId, userText, reply, acceptedAtMs, completedAtMs } = turn
    const messages: WaitingTurn["messages"] = [
      { type: "user", occurredAtMs: acceptedAtMs,
        payload: JSON.stringify({ text: userText, ...(turn.referenceIds?.length ? { referenceIds: turn.referenceIds } : {}) }) },
      { type: "assistant", occurredAtMs: completedAtMs, payload: JSON.stringify({ text: reply }) },
    ]
    if (reply === undefined || messages.some(message => Buffer.byteLength(message.payload, "utf8") > syncPayloadLimit)) {
      this.#report(scope, turnId, "本轮正文超出单条共享消息的 32 KiB 上限。")
      return
    }
    const path = join(this.root, scope.accountId, scope.conversationId + ".json")
    try {
      await this.#mutate(async () => {
        const pending = await this.#read(path) ?? { scope, turns: [] }
        if (localExecutionKey(pending.scope) !== localExecutionKey(scope)) throw new Error("会话范围不一致")
        if (pending.turns.some(item => item.turnId === turnId)) return
        pending.turns.push({ turnId, messages, briefText: `诉求：${briefExcerpt(userText)}\n回复：${briefExcerpt(reply)}` })
        await this.#write(path, pending)
      })
      this.#wake()
    } catch {
      this.#report(scope, turnId, "无法保存待上传的本轮定稿。")
    }
  }

  /** 关窗只等待已受理的落盘，已固定序号的批次可由下一次登录重发。 */
  flush(): Promise<void> { return this.#writing }

  #report(scope: LocalExecutionScope, turnId: string, failure?: string): void {
    this.notify({ scope, turnId, kind: "upload", failure: failure ? `会话共享失败：${failure}` : undefined })
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

  async #send(path: string, scope: LocalExecutionScope, turn: WaitingTurn, signal: AbortSignal): Promise<void> {
    const watermark = unwrap(await this.port.watermark(scope, signal))
    signal.throwIfAborted()
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
    if (receipt.syncedSequence !== finalSequence) throw new UploadFailure("Java 未确认本轮的完整同步水位。", false)
    signal.throwIfAborted()

    await this.#editHead(path, turn.turnId, pending => { pending.turns.shift() })
    if (!signal.aborted) this.#report(scope, turn.turnId)
  }
}
