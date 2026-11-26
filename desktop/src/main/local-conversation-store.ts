/**
 * 【功能定义】本机个人会话独立存储（`LocalConversationStore`）：
 * 按 `<userData>/workbench/local-conversations/<originSha256>/<accountId>/` 物理隔离保存
 * 当前账号的个人会话元数据索引（`index.json`）与单会话终态轮次详情（`conversations/<conversationId>.json`），
 * 彻底解耦于云端协作权限与 1 MB 上限的轻量 UI 偏好存储（`PersonalStore`）。
 *
 * 【协作边界】
 * - 上游调用方：`local-conversations-ipc.ts`、`PersonalStore`、`LocalExecutionCoordinator`。
 * - 下游依赖方：纯数据契约 `desktop/src/shared/local-conversations-host.ts` 与 Node 原子文件 API。
 *
 * 【安全与防损机制 (Why)】
 * 1. 所有写盘均经 `tmp + wx(0o600) + flush + rename` 原子替换，防止半写或断电损毁；
 * 2. 读取损坏文件直接返回错误并保留磁盘原件，绝不用空数组覆盖用户历史对话；
 * 3. 单会话详情超 4 MiB 时从最旧轮次起折叠摘录（保留最近 20 轮完整），单账号索引上限 500 条。
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { identityError } from "@workbench/collaboration-client"
import type { CollaborationResult, ConversationSummary } from "@workbench/collaboration-client/types"
import type {
  CreateLocalConversationInput,
  LocalConversationDetail,
  LocalConversationRecord,
  LocalConversationsListFilter,
  LocalConversationShareStatus,
  LocalConversationToolSummary,
  LocalConversationTurn,
  MarkLocalConversationPublishedInput,
  UpdateLocalConversationBindingPatch,
} from "../shared/index.js"

export const MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT = 500
export const MAX_CONVERSATION_DETAIL_BYTES = 4 * 1024 * 1024
export const KEEP_RECENT_TURNS = 20
export const FOLDED_USER_TEXT_CHARS = 240
export const FOLDED_REPLY_CHARS = 400

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEFAULT_TITLES = new Set(["新会话", "未命名会话"])
const SHARE_MODES = new Set(["full", "summary_only"])
const SHARE_STATUSES = new Set(["local_only", "active", "stopped"])
const CONV_STATUSES = new Set(["idle", "running", "waiting_approval", "error"])
const TURN_STATUSES = new Set(["completed", "cancelled", "failed"])

type IndexFile = {
  version: 1
  records: LocalConversationRecord[]
}

type DetailFile = {
  version: 1
  conversationId: string
  nextSequence: number
  historyTrimmed?: boolean
  turns: LocalConversationTurn[]
}

export type AppendLocalTurnInput = {
  readonly turnId: string
  readonly userText: string
  readonly referenceIds?: readonly string[]
  readonly attachments?: LocalConversationTurn["attachments"]
  readonly images?: LocalConversationTurn["images"]
  readonly followUps?: LocalConversationTurn["followUps"]
  readonly tools?: readonly LocalConversationToolSummary[]
  readonly reply: string
  readonly status: "completed" | "cancelled" | "failed"
  readonly failure?: string
  readonly acceptedAtMs: number
  readonly completedAtMs: number
}

class CorruptStoreError extends Error {
  constructor(message: string) {
    super(message)
  }
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT"

function ok<T>(value: T): CollaborationResult<T> {
  return { ok: true, value }
}

function sanitizeTitle(raw: string | undefined, fallback = "新会话"): string {
  const normalized = (raw ?? "").replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim()
  if (!normalized) return fallback
  return [...normalized].slice(0, 80).join("")
}

function validAccountId(accountId: string): boolean {
  return ACCOUNT_ID_PATTERN.test(accountId)
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

function validNullableUuid(value: unknown): value is string | null {
  return value === null || validUuid(value)
}

function isRecord(value: unknown): value is LocalConversationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<LocalConversationRecord>
  return validUuid(item.conversationId)
    && validNullableUuid(item.workspaceId)
    && validNullableUuid(item.projectId)
    && (item.projectId === null || item.workspaceId !== null)
    && (item.shareMode === null || (typeof item.shareMode === "string" && SHARE_MODES.has(item.shareMode)))
    && typeof item.shareStatus === "string" && SHARE_STATUSES.has(item.shareStatus)
    && typeof item.title === "string" && item.title.length >= 1 && item.title.length <= 80
    && (item.directoryPath === null || typeof item.directoryPath === "string")
    && (item.providerId === null || typeof item.providerId === "string")
    && typeof item.status === "string" && CONV_STATUSES.has(item.status)
    && typeof item.createdAtMs === "number" && Number.isFinite(item.createdAtMs)
    && typeof item.updatedAtMs === "number" && Number.isFinite(item.updatedAtMs)
    && (item.publishedAtMs === null || (typeof item.publishedAtMs === "number" && Number.isFinite(item.publishedAtMs)))
    && (item.stoppedAtMs === null || (typeof item.stoppedAtMs === "number" && Number.isFinite(item.stoppedAtMs)))
    && (item.archivedAtMs === undefined || (typeof item.archivedAtMs === "number" && Number.isFinite(item.archivedAtMs)))
    && (item.pinnedAtMs === undefined || (typeof item.pinnedAtMs === "number" && Number.isFinite(item.pinnedAtMs)))
    && typeof item.syncedSequence === "number" && Number.isSafeInteger(item.syncedSequence) && item.syncedSequence >= 0
}

function isTurn(value: unknown): value is LocalConversationTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Partial<LocalConversationTurn>
  return typeof item.turnId === "string" && item.turnId.length > 0 && item.turnId.length <= 128
    && typeof item.sequenceStart === "number" && Number.isSafeInteger(item.sequenceStart) && item.sequenceStart >= 1
    && typeof item.sequenceEnd === "number" && Number.isSafeInteger(item.sequenceEnd) && item.sequenceEnd >= item.sequenceStart
    && typeof item.userText === "string"
    && typeof item.reply === "string"
    && typeof item.status === "string" && TURN_STATUSES.has(item.status)
    && typeof item.acceptedAtMs === "number" && Number.isFinite(item.acceptedAtMs)
    && typeof item.completedAtMs === "number" && Number.isFinite(item.completedAtMs)
}

function clipChars(value: string, maxChars: number): string {
  const chars = [...value]
  if (chars.length <= maxChars) return value
  return `${chars.slice(0, maxChars).join("")}…`
}

function foldTurn(turn: LocalConversationTurn): LocalConversationTurn {
  return {
    turnId: turn.turnId,
    sequenceStart: turn.sequenceStart,
    sequenceEnd: turn.sequenceEnd,
    userText: clipChars(turn.userText, FOLDED_USER_TEXT_CHARS),
    reply: clipChars(turn.reply, FOLDED_REPLY_CHARS),
    status: turn.status,
    ...(turn.failure ? { failure: turn.failure } : {}),
    acceptedAtMs: turn.acceptedAtMs,
    completedAtMs: turn.completedAtMs,
  }
}

/** 将单会话详情控制在 4 MiB 以内：优先折叠旧轮次并保留最近 20 轮完整上下文，必要时淘汰最早已折叠轮次。 */
function enforceDetailBudget(detail: DetailFile): DetailFile {
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") <= MAX_CONVERSATION_DETAIL_BYTES) {
    return detail
  }

  let historyTrimmed = Boolean(detail.historyTrimmed)
  const turns = [...detail.turns]
  const protectedStart = Math.max(0, turns.length - KEEP_RECENT_TURNS)

  for (let i = 0; i < protectedStart; i++) {
    turns[i] = foldTurn(turns[i]!)
    historyTrimmed = true
    const candidate: DetailFile = {
      version: 1,
      conversationId: detail.conversationId,
      nextSequence: detail.nextSequence,
      historyTrimmed,
      turns,
    }
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_CONVERSATION_DETAIL_BYTES) {
      return candidate
    }
  }

  // 所有超出最近 20 轮的旧轮都折叠后仍超限：按最旧顺序移除旧轮次，保住最近 20 轮
  let olderCount = protectedStart
  while (olderCount > 0) {
    turns.shift()
    olderCount--
    historyTrimmed = true
    const candidate: DetailFile = {
      version: 1,
      conversationId: detail.conversationId,
      nextSequence: detail.nextSequence,
      historyTrimmed,
      turns,
    }
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_CONVERSATION_DETAIL_BYTES) {
      return candidate
    }
  }

  // 极端兜底：仅剩最近 <= 20 轮仍超 4 MiB 时，从最旧的保留轮起折叠，最后确保单轮不会撑破 4 MiB
  for (let i = 0; i < turns.length; i++) {
    turns[i] = foldTurn(turns[i]!)
    historyTrimmed = true
    const candidate: DetailFile = {
      version: 1,
      conversationId: detail.conversationId,
      nextSequence: detail.nextSequence,
      historyTrimmed,
      turns,
    }
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_CONVERSATION_DETAIL_BYTES) {
      return candidate
    }
  }

  // 单条消息极长导致最后 1 轮已折叠后仍接近上限时移除最旧轮次直至满足硬上限
  while (turns.length > 1 && Buffer.byteLength(JSON.stringify({
    version: 1,
    conversationId: detail.conversationId,
    nextSequence: detail.nextSequence,
    historyTrimmed: true,
    turns,
  }), "utf8") > MAX_CONVERSATION_DETAIL_BYTES) {
    turns.shift()
  }
  return {
    version: 1,
    conversationId: detail.conversationId,
    nextSequence: detail.nextSequence,
    historyTrimmed: true,
    turns,
  }
}

async function writeAtomicJson(target: string, dir: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(data), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      flush: true,
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export class LocalConversationStore {
  readonly #baseRoot: string
  readonly #queues = new Map<string, Promise<void>>()

  constructor(userData: string, origin: string) {
    const originHash = createHash("sha256").update(origin).digest("hex")
    this.#baseRoot = join(userData, "workbench", "local-conversations", originHash)
  }

  #accountDir(accountId: string): string {
    return join(this.#baseRoot, accountId)
  }

  #indexPath(accountId: string): string {
    return join(this.#accountDir(accountId), "index.json")
  }

  #conversationsDir(accountId: string): string {
    return join(this.#accountDir(accountId), "conversations")
  }

  #detailPath(accountId: string, conversationId: string): string {
    return join(this.#conversationsDir(accountId), `${conversationId}.json`)
  }

  #enqueue<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(accountId) ?? Promise.resolve()
    const current = previous.then(action, action)
    this.#queues.set(accountId, current.then(() => {}, () => {}))
    return current
  }

  async #readIndex(accountId: string): Promise<IndexFile> {
    let raw: string
    try {
      raw = await readFile(this.#indexPath(accountId), "utf8")
    } catch (error) {
      if (isMissing(error)) return { version: 1, records: [] }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new CorruptStoreError("本机会话索引文件已损坏，已保留原文件以防数据丢失。")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CorruptStoreError("本机会话索引结构无效。")
    }
    const obj = parsed as Partial<IndexFile>
    if (obj.version !== 1 || !Array.isArray(obj.records) || !obj.records.every(isRecord)) {
      throw new CorruptStoreError("本机会话索引版本或条目格式无效。")
    }
    return { version: 1, records: [...obj.records] }
  }

  async #readDetail(accountId: string, conversationId: string): Promise<DetailFile> {
    let raw: string
    try {
      raw = await readFile(this.#detailPath(accountId, conversationId), "utf8")
    } catch (error) {
      if (isMissing(error)) {
        return { version: 1, conversationId, nextSequence: 1, turns: [] }
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new CorruptStoreError("本机会话正文文件已损坏，已保留原文件以防数据丢失。")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CorruptStoreError("本机会话正文结构无效。")
    }
    const obj = parsed as Partial<DetailFile>
    if (obj.version !== 1
      || obj.conversationId !== conversationId
      || typeof obj.nextSequence !== "number"
      || !Number.isSafeInteger(obj.nextSequence)
      || obj.nextSequence < 1
      || !Array.isArray(obj.turns)
      || !obj.turns.every(isTurn)) {
      throw new CorruptStoreError("本机会话正文条目格式无效。")
    }
    return {
      version: 1,
      conversationId,
      nextSequence: obj.nextSequence,
      ...(obj.historyTrimmed ? { historyTrimmed: true } : {}),
      turns: [...obj.turns],
    }
  }

  #writeIndex(accountId: string, index: IndexFile): Promise<void> {
    return writeAtomicJson(this.#indexPath(accountId), this.#accountDir(accountId), index)
  }

  #writeDetail(accountId: string, detail: DetailFile): Promise<DetailFile> {
    const bounded = enforceDetailBudget(detail)
    return writeAtomicJson(
      this.#detailPath(accountId, detail.conversationId),
      this.#conversationsDir(accountId),
      bounded,
    ).then(() => bounded)
  }

  #wrapError(error: unknown, fallbackMessage: string): CollaborationResult<never> {
    if (error instanceof CorruptStoreError) {
      return identityError("INTERNAL_ERROR", error.message)
    }
    return identityError("INTERNAL_ERROR", fallbackMessage)
  }

  /** 供主进程授权校验与状态读取内部调用：损坏文件直接抛错，防止误判为不存在而覆盖原件。 */
  async getRecord(accountId: string, conversationId: string): Promise<LocalConversationRecord | null> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) return null
    return this.#enqueue(accountId, async () => {
      const index = await this.#readIndex(accountId)
      return index.records.find(item => item.conversationId === conversationId) ?? null
    })
  }

  async list(
    accountId: string,
    filter: LocalConversationsListFilter = {},
  ): Promise<CollaborationResult<readonly LocalConversationRecord[]>> {
    if (!validAccountId(accountId)) return identityError("INVALID_REQUEST", "账号标识无效。")
    if (filter.workspaceId !== undefined && !validNullableUuid(filter.workspaceId)) {
      return identityError("INVALID_REQUEST", "团队标识无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const records = index.records
          .filter(item => filter.workspaceId === undefined || item.workspaceId === filter.workspaceId)
          .filter(item => filter.includePublished !== false || item.shareStatus !== "active")
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.conversationId.localeCompare(a.conversationId))
        return ok(structuredClone(records))
      } catch (error) {
        return this.#wrapError(error, "无法读取本机会话列表。")
      }
    })
  }

  async get(accountId: string, conversationId: string): Promise<CollaborationResult<LocalConversationDetail>> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) {
      return identityError("INVALID_REQUEST", "会话标识无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const record = index.records.find(item => item.conversationId === conversationId)
        if (!record) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const detail = await this.#readDetail(accountId, conversationId)
        return ok(structuredClone({
          record,
          nextSequence: detail.nextSequence,
          ...(detail.historyTrimmed ? { historyTrimmed: true } : {}),
          turns: detail.turns,
        }))
      } catch (error) {
        return this.#wrapError(error, "无法读取本机会话正文。")
      }
    })
  }

  /** 保存已由协调器核对本人归属的旧 Project 会话；不发布、不上传，也不授予目录权限。 */
  async rememberProjectConversation(
    accountId: string,
    workspaceId: string,
    conversation: ConversationSummary,
    directoryPath: string,
    providerId: string,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || conversation.ownerUserId !== accountId
      || !validUuid(workspaceId) || !validUuid(conversation.projectId) || !validUuid(conversation.conversationId)
      || !SHARE_MODES.has(conversation.shareMode) || !SHARE_STATUSES.has(conversation.shareStatus)) {
      return identityError("INVALID_REQUEST", "本人项目会话归属或共享状态无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const existing = index.records.find(item => item.conversationId === conversation.conversationId)
        if (existing) return existing.workspaceId === workspaceId && existing.projectId === conversation.projectId
          ? ok(structuredClone(existing)) : identityError("CONVERSATION_CONFLICT", "本机会话已绑定其他范围。")
        if (index.records.length >= MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT) {
          return identityError("PAYLOAD_TOO_LARGE", `本机会话数量已达 ${MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT} 条上限。`)
        }
        const now = Date.now()
        const record: LocalConversationRecord = {
          conversationId: conversation.conversationId,
          workspaceId,
          projectId: conversation.projectId,
          title: sanitizeTitle(conversation.title, "新会话"),
          directoryPath,
          providerId,
          status: conversation.status,
          shareMode: conversation.shareMode,
          shareStatus: conversation.shareStatus,
          syncedSequence: conversation.syncedSequence,
          createdAtMs: now,
          updatedAtMs: now,
          publishedAtMs: now,
          stoppedAtMs: conversation.stoppedAt ? Date.parse(conversation.stoppedAt) : null,
        }
        index.records.push(record)
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(record))
      } catch (error) { return this.#wrapError(error, "无法保存本人项目会话记录。") }
    })
  }

  async create(
    accountId: string,
    input: CreateLocalConversationInput,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validNullableUuid(input.workspaceId)) {
      return identityError("INVALID_REQUEST", "账号或团队标识无效。")
    }
    if (input.conversationId !== undefined && !validUuid(input.conversationId)) {
      return identityError("INVALID_REQUEST", "会话标识无效。")
    }
    if (input.directoryPath !== undefined && input.directoryPath !== null && typeof input.directoryPath !== "string") {
      return identityError("INVALID_REQUEST", "工作目录路径无效。")
    }
    if (input.providerId !== undefined && input.providerId !== null && typeof input.providerId !== "string") {
      return identityError("INVALID_REQUEST", "Agent 类型无效。")
    }

    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        if (index.records.length >= MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT) {
          return identityError("PAYLOAD_TOO_LARGE", `本机会话数量已达 ${MAX_LOCAL_CONVERSATIONS_PER_ACCOUNT} 条上限，请清理后再新建。`)
        }
        const conversationId = input.conversationId ?? randomUUID()
        if (index.records.some(item => item.conversationId === conversationId)) {
          return identityError("CONVERSATION_CONFLICT", "本机会话标识已存在。")
        }
        const now = Date.now()
        const record: LocalConversationRecord = {
          conversationId,
          workspaceId: input.workspaceId,
          projectId: null,
          shareMode: null,
          shareStatus: "local_only",
          title: sanitizeTitle(input.title, "新会话"),
          directoryPath: input.directoryPath ?? null,
          providerId: input.providerId ?? null,
          status: "idle",
          createdAtMs: now,
          updatedAtMs: now,
          publishedAtMs: null,
          stoppedAtMs: null,
          syncedSequence: 0,
        }
        index.records.push(record)
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(record))
      } catch (error) {
        return this.#wrapError(error, "无法创建本机会话。")
      }
    })
  }

  async rename(accountId: string, conversationId: string, rawTitle: string): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId) || typeof rawTitle !== "string") {
      return identityError("INVALID_REQUEST", "重命名参数无效。")
    }
    const normalized = rawTitle.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim()
    if (!normalized || [...normalized].length > 80) {
      return identityError("INVALID_REQUEST", "请输入 1～80 个字符的会话标题。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const updated: LocalConversationRecord = {
          ...index.records[idx]!,
          title: normalized,
          updatedAtMs: Date.now(),
        }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法保存会话标题。")
      }
    })
  }

  async updateWorkspace(
    accountId: string,
    conversationId: string,
    workspaceId: string | null,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId) || !validNullableUuid(workspaceId)) {
      return identityError("INVALID_REQUEST", "团队上下文参数无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        if (existing.projectId !== null) {
          return identityError("INVALID_REQUEST", "已关联项目的会话无法修改团队上下文。")
        }
        const detail = await this.#readDetail(accountId, conversationId)
        if (detail.turns.length > 0) {
          return identityError("INVALID_REQUEST", "首条消息发出后团队上下文已锁定。")
        }
        const updated: LocalConversationRecord = {
          ...existing,
          workspaceId,
          updatedAtMs: Date.now(),
        }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法更新会话团队上下文。")
      }
    })
  }

  async updateBinding(
    accountId: string,
    conversationId: string,
    patch: UpdateLocalConversationBindingPatch,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) {
      return identityError("INVALID_REQUEST", "会话参数无效。")
    }
    if (patch.status !== undefined && !CONV_STATUSES.has(patch.status)) {
      return identityError("INVALID_REQUEST", "会话状态无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        const updated: LocalConversationRecord = {
          ...existing,
          directoryPath: patch.directoryPath !== undefined ? patch.directoryPath : existing.directoryPath,
          providerId: patch.providerId !== undefined ? patch.providerId : existing.providerId,
          status: patch.status !== undefined ? patch.status : existing.status,
          updatedAtMs: Date.now(),
        }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法更新会话绑定信息。")
      }
    })
  }

  async markPublished(
    accountId: string,
    conversationId: string,
    binding: MarkLocalConversationPublishedInput,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId)
      || !validUuid(conversationId)
      || !validUuid(binding.workspaceId)
      || !validUuid(binding.projectId)
      || !SHARE_MODES.has(binding.shareMode)) {
      return identityError("INVALID_REQUEST", "发布绑定参数无效。")
    }
    if (binding.syncedSequence !== undefined && (!Number.isSafeInteger(binding.syncedSequence) || binding.syncedSequence < 0)) {
      return identityError("INVALID_REQUEST", "同步序号无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        const now = Date.now()
        const updated: LocalConversationRecord = {
          ...existing,
          workspaceId: binding.workspaceId,
          projectId: binding.projectId,
          shareMode: binding.shareMode,
          shareStatus: "active",
          publishedAtMs: now,
          stoppedAtMs: null,
          syncedSequence: binding.syncedSequence !== undefined
            ? Math.max(existing.syncedSequence, binding.syncedSequence)
            : existing.syncedSequence,
          updatedAtMs: now,
        }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法保存会话发布绑定。")
      }
    })
  }

  async markSharingStopped(
    accountId: string,
    conversationId: string,
    stoppedAtMs?: number,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) {
      return identityError("INVALID_REQUEST", "会话标识无效。")
    }
    if (stoppedAtMs !== undefined && (!Number.isFinite(stoppedAtMs) || stoppedAtMs < 0)) {
      return identityError("INVALID_REQUEST", "停止时间无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        if (existing.shareStatus === "stopped") {
          return ok(structuredClone(existing))
        }
        const now = Date.now()
        const updated: LocalConversationRecord = {
          ...existing,
          shareStatus: "stopped" as LocalConversationShareStatus,
          stoppedAtMs: stoppedAtMs ?? now,
          updatedAtMs: now,
        }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法更新会话停止共享状态。")
      }
    })
  }

  async updateSyncedSequence(
    accountId: string,
    conversationId: string,
    syncedSequence: number,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId) || !Number.isSafeInteger(syncedSequence) || syncedSequence < 0) {
      return identityError("INVALID_REQUEST", "同步水位参数无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        if (syncedSequence <= existing.syncedSequence) {
          return ok(structuredClone(existing))
        }
        const updated: LocalConversationRecord = {
          ...existing,
          syncedSequence,
        }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法更新同步水位。")
      }
    })
  }

  /** 将已定稿的本机执行轮次写入单会话详情，并同步刷新索引时间与默认标题。 */
  async appendTurn(
    accountId: string,
    conversationId: string,
    turnInput: AppendLocalTurnInput,
  ): Promise<CollaborationResult<LocalConversationDetail>> {
    if (!validAccountId(accountId) || !validUuid(conversationId) || !turnInput.turnId) {
      return identityError("INVALID_REQUEST", "追加轮次参数无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        const detail = await this.#readDetail(accountId, conversationId)
        if (detail.turns.some(item => item.turnId === turnInput.turnId)) {
          return ok(structuredClone({
            record: existing,
            nextSequence: detail.nextSequence,
            ...(detail.historyTrimmed ? { historyTrimmed: true } : {}),
            turns: detail.turns,
          }))
        }

        const sequenceStart = detail.nextSequence
        const span = 2 + (turnInput.followUps?.length ?? 0) + (turnInput.tools?.length ?? 0)
        const sequenceEnd = sequenceStart + span - 1
        const turn: LocalConversationTurn = {
          turnId: turnInput.turnId,
          sequenceStart,
          sequenceEnd,
          userText: turnInput.userText,
          ...(turnInput.referenceIds?.length ? { referenceIds: [...turnInput.referenceIds] } : {}),
          ...(turnInput.attachments?.length ? { attachments: structuredClone(turnInput.attachments) } : {}),
          ...(turnInput.images?.length ? { images: structuredClone(turnInput.images) } : {}),
          ...(turnInput.followUps?.length ? { followUps: structuredClone(turnInput.followUps) } : {}),
          ...(turnInput.tools?.length ? { tools: structuredClone(turnInput.tools) } : {}),
          reply: turnInput.reply,
          status: turnInput.status,
          ...(turnInput.failure ? { failure: turnInput.failure } : {}),
          acceptedAtMs: turnInput.acceptedAtMs,
          completedAtMs: turnInput.completedAtMs,
        }

        // 先落盘单会话详情并强制 4 MiB 裁剪，确认成功后再写 index.json 推进更新时间与默认标题
        const writtenDetail = await this.#writeDetail(accountId, {
          version: 1,
          conversationId,
          nextSequence: sequenceEnd + 1,
          ...(detail.historyTrimmed ? { historyTrimmed: true } : {}),
          turns: [...detail.turns, turn],
        })

        let nextTitle = existing.title
        if (DEFAULT_TITLES.has(existing.title)) {
          const compact = turnInput.userText.replace(/\s+/g, " ").trim()
          if (compact) nextTitle = [...compact].slice(0, 24).join("")
        }
        // 归档中的会话收到新轮次即恢复为普通会话
        const { archivedAtMs: _archivedAtMs, ...recordRest } = existing
        const updatedRecord: LocalConversationRecord = {
          ...recordRest,
          title: nextTitle,
          status: turnInput.status === "failed" ? "error" : "idle",
          updatedAtMs: turnInput.completedAtMs,
        }
        index.records[idx] = updatedRecord
        await this.#writeIndex(accountId, index)

        return ok(structuredClone({
          record: updatedRecord,
          nextSequence: writtenDetail.nextSequence,
          ...(writtenDetail.historyTrimmed ? { historyTrimmed: true } : {}),
          turns: writtenDetail.turns,
        }))
      } catch (error) {
        return this.#wrapError(error, "无法保存本机会话轮次记录。")
      }
    })
  }

  /** 归档或恢复个人会话；运行中与已发布活跃会话拒绝，归档同时清除置顶，均不动 updatedAtMs。 */
  async setArchived(
    accountId: string,
    conversationId: string,
    archived: boolean,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) {
      return identityError("INVALID_REQUEST", "会话标识无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        if (!archived) {
          if (existing.archivedAtMs === undefined) return ok(structuredClone(existing))
          const { archivedAtMs: _archivedAtMs, ...restored } = existing
          index.records[idx] = restored
          await this.#writeIndex(accountId, index)
          return ok(structuredClone(restored))
        }
        if (existing.status === "running" || existing.status === "waiting_approval") {
          return identityError("EXECUTION_STATE_CONFLICT", "会话正在运行，请先停止后再归档。")
        }
        if (existing.shareStatus === "active") {
          return identityError("INVALID_REQUEST", "已发布到项目的会话请在团队空间处理。")
        }
        if (existing.archivedAtMs !== undefined) return ok(structuredClone(existing))
        const { pinnedAtMs: _pinnedAtMs, ...rest } = existing
        const updated: LocalConversationRecord = { ...rest, archivedAtMs: Date.now() }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法更新会话归档状态。")
      }
    })
  }

  /** 置顶或取消置顶个人会话；已归档与已发布活跃会话拒绝，均不动 updatedAtMs。 */
  async setPinned(
    accountId: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<CollaborationResult<LocalConversationRecord>> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) {
      return identityError("INVALID_REQUEST", "会话标识无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const idx = index.records.findIndex(item => item.conversationId === conversationId)
        if (idx < 0) return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        const existing = index.records[idx]!
        if (!pinned) {
          if (existing.pinnedAtMs === undefined) return ok(structuredClone(existing))
          const { pinnedAtMs: _pinnedAtMs, ...restored } = existing
          index.records[idx] = restored
          await this.#writeIndex(accountId, index)
          return ok(structuredClone(restored))
        }
        if (existing.archivedAtMs !== undefined) {
          return identityError("INVALID_REQUEST", "已归档会话不能置顶。")
        }
        if (existing.shareStatus === "active") {
          return identityError("INVALID_REQUEST", "已发布到项目的会话请在团队空间处理。")
        }
        if (existing.pinnedAtMs !== undefined) return ok(structuredClone(existing))
        const updated: LocalConversationRecord = { ...existing, pinnedAtMs: Date.now() }
        index.records[idx] = updated
        await this.#writeIndex(accountId, index)
        return ok(structuredClone(updated))
      } catch (error) {
        return this.#wrapError(error, "无法更新会话置顶状态。")
      }
    })
  }

  async remove(accountId: string, conversationId: string): Promise<CollaborationResult<null>> {
    if (!validAccountId(accountId) || !validUuid(conversationId)) {
      return identityError("INVALID_REQUEST", "会话标识无效。")
    }
    return this.#enqueue(accountId, async () => {
      try {
        const index = await this.#readIndex(accountId)
        const existing = index.records.find(item => item.conversationId === conversationId)
        if (!existing) {
          return identityError("RESOURCE_NOT_FOUND", "本机会话不存在。")
        }
        if (existing.status === "running" || existing.status === "waiting_approval") {
          return identityError("EXECUTION_STATE_CONFLICT", "会话正在运行，请先停止后再删除。")
        }
        if (existing.shareStatus !== "local_only") {
          return identityError("INVALID_REQUEST", "该会话在团队侧仍有记录，暂不能删除。")
        }
        index.records = index.records.filter(item => item.conversationId !== conversationId)
        await this.#writeIndex(accountId, index)
        await rm(this.#detailPath(accountId, conversationId), { force: true })
        return ok(null)
      } catch (error) {
        return this.#wrapError(error, "无法删除本机会话。")
      }
    })
  }
}
