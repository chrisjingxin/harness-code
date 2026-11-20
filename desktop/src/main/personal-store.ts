/**
 * 个人视图存储：认证范围 → 独立记录 → 校验字段与修订 → 容量裁剪 → 原子替换。
 * 文件仅存本账号在各工作区/项目/会话下的个人状态与已主动拉取的正文缓存；每次加载均通过服务端重新核验访问权限。
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import { EMPTY_CONVERSATION_PERSONAL } from "../shared/personal.js"
import {
  MAX_DRAFT_ANNOTATIONS,
  MAX_DRAFT_ANNOTATION_COMMENT_CHARS,
  MAX_DRAFT_ANNOTATION_SOURCE_CHARS,
  MAX_DRAFT_ANNOTATION_TEXT_CHARS,
  MAX_PROMPT_QUEUE_BYTES, MAX_QUEUED_PROMPTS,
  type ConversationPersonal, type LocalExecutionScope, type PersonalKey, type PersonalRead, type PersonalResult, type PersonalValue,
  type PromptQueueRecord,
} from "../shared/index.js"
import type { CollaborationState } from "@workbench/collaboration-client"

type Identity = NonNullable<ReturnType<CollaborationState["personalIdentity"]>>
type Entry = { revision: number; flushed: number; data: PersonalValue | PromptQueueRecord | null; writing: Promise<void> | null }
type Authorized = { identity: Identity; name: string; ownsConversation: boolean }
type CachedPermission = Authorized & { expiresAtMs: number }
const PERMISSION_TTL_MS = 60_000
const fail = (message: string): PersonalResult<never> => ({ ok: false, message })
const ok = <T>(value: T): PersonalResult<T> => ({ ok: true, value })
const id = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }
const userId = { type: "string", pattern: "^[0-9a-f]{32}$" }
const nullableId = { anyOf: [id, { type: "null" }] }
const text = { type: "string", maxLength: 4096 }
const nullableText = { anyOf: [text, { type: "null" }] }
const strings = { type: "array", maxItems: 2000, items: text }
const coord = { type: "number", minimum: 0, maximum: 100000000 }
const panel = {
  type: "object",
  additionalProperties: false,
  required: ["open", "width"],
  properties: {
    open: { type: "boolean" },
    width: { type: "number", minimum: 0, maximum: 10000 },
  },
}
const SAFE_CACHE_BYTES = 800_000
const HARD_RECORD_BYTES = 1_000_000
const object = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
})

const historyMessageSchema = object(["sequence", "type", "occurredAtMs", "payload"], {
  sequence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  type: { enum: ["user", "assistant", "tool_summary", "status"] },
  occurredAtMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  payload: { type: "string", maxLength: 1_048_576 },
})

const syncCacheSchema = {
  type: "object",
  additionalProperties: false,
  required: ["syncedSequence", "syncedAtMs", "messages"],
  properties: {
    syncedSequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    syncedAtMs: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    messages: { type: "array", maxItems: 5000, items: historyMessageSchema },
    cacheTruncated: { type: "boolean" },
  },
}

const schemas: Record<PersonalKey["kind"], object> = {
  account: object(["workspaceId"], { workspaceId: nullableId }),
  workspace: object(["projectId", "panels"], {
    projectId: nullableId,
    panels: object(["left", "right"], { left: panel, right: panel }),
  }),
  projectNavigation: object(["page", "expandedMembers", "selfCollapsed"], {
    page: {
      oneOf: [
        object(["kind"], { kind: { enum: ["new", "board", "tasks", "info", "knowledge"] } }),
        object(["kind", "conversationId"], { kind: { const: "conversation" }, conversationId: id }),
        object(["kind", "taskId"], { kind: { const: "task" }, taskId: id }),
      ],
    },
    expandedMembers: { type: "array", maxItems: 2000, items: userId },
    selfCollapsed: { type: "boolean" },
  }),
  projectDraft: object(["directoryPath", "draftText"], {
    directoryPath: nullableText,
    draftText: { type: "string", maxLength: 262144 },
    referenceIds: strings,
    revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    selectionStart: { type: "integer", minimum: 0, maximum: 262144 },
    selectionEnd: { type: "integer", minimum: 0, maximum: 262144 },
  }),
  conversation: object(["scroll", "expandedTools", "expandedOutputs", "draft", "localDirectoryPath", "syncCache"], {
    scroll: object(["anchorEntryId", "offsetPx", "following", "seenContentRevision"], {
      anchorEntryId: nullableText,
      offsetPx: { type: "number", minimum: -100000000, maximum: 100000000 },
      following: { type: "boolean" },
      seenContentRevision: { anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] },
    }),
    expandedTools: strings,
    expandedOutputs: strings,
    draft: object(["text", "selectionStart", "selectionEnd", "revision", "referenceIds", "attachmentIds"], {
      text: { type: "string", maxLength: 262144 },
      selectionStart: { type: "integer", minimum: 0, maximum: 262144 },
      selectionEnd: { type: "integer", minimum: 0, maximum: 262144 },
      revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      referenceIds: strings,
      attachmentIds: strings,
      annotations: {
        type: "array",
        maxItems: MAX_DRAFT_ANNOTATIONS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "selectedText"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
            selectedText: { type: "string", minLength: 1, maxLength: MAX_DRAFT_ANNOTATION_TEXT_CHARS },
            comment: { type: "string", minLength: 1, maxLength: MAX_DRAFT_ANNOTATION_COMMENT_CHARS },
            sourceLabel: { type: "string", minLength: 1, maxLength: MAX_DRAFT_ANNOTATION_SOURCE_CHARS },
          },
        },
      },
    }),
    localDirectoryPath: nullableText,
    customTitle: { type: "string", minLength: 1, maxLength: 80 },
    providerId: { anyOf: [{ type: "string", minLength: 1, maxLength: 64 }, { type: "null" }] },
    syncCache: { anyOf: [syncCacheSchema, { type: "null" }] },
  }),
  sessionWorkspace: object(["personal", "positions"], {
    personal: object(["view", "expanded", "centralPaths", "activeCentral", "diffPath"], {
      view: object(["dockOpen", "dockWidthPx", "panel", "selectedPath", "fileTabs", "activeFilePath", "selectedChanges", "commitMessage"], {
        dockOpen: { type: "boolean" },
        dockWidthPx: { type: "number", minimum: 0, maximum: 10000 },
        panel: { enum: ["files", "changes"] },
        selectedPath: nullableText,
        activeFilePath: nullableText,
        fileTabs: { type: "array", maxItems: 12, items: object(["path", "name"], { path: text, name: text }) },
        selectedChanges: { type: "array", maxItems: 2000, items: object(["path", "version"], { path: text, version: text }) },
        commitMessage: { type: "string", maxLength: 262144 },
      }),
      expanded: strings,
      centralPaths: strings,
      activeCentral: nullableText,
      diffPath: nullableText,
    }),
    positions: {
      type: "array",
      maxItems: 2000,
      items: object(["area", "path", "top", "left"], {
        area: { enum: ["central", "dock", "tree"] },
        path: text,
        top: coord,
        left: coord,
      }),
    },
  }),
}

const ajv = new Ajv2020({ strict: true })
const validators = {
  account: ajv.compile(schemas.account),
  workspace: ajv.compile(schemas.workspace),
  projectNavigation: ajv.compile(schemas.projectNavigation),
  projectDraft: ajv.compile(schemas.projectDraft),
  conversation: ajv.compile(schemas.conversation),
  sessionWorkspace: ajv.compile(schemas.sessionWorkspace),
}
const validatePromptQueue = ajv.compile<PromptQueueRecord>(object(["items"], {
  items: { type: "array", maxItems: MAX_QUEUED_PROMPTS, items: object(["requestId", "text", "referenceIds", "attachments"], {
    requestId: id,
    text: { type: "string", maxLength: 16_384 },
    referenceIds: strings,
    attachments: strings,
  }) },
  starting: id,
}))
const keyValidators = {
  account: ajv.compile(object(["kind"], { kind: { const: "account" } })),
  workspace: ajv.compile(object(["kind", "workspaceId"], { kind: { const: "workspace" }, workspaceId: id })),
  projectNavigation: ajv.compile(object(["kind", "workspaceId", "projectId"], { kind: { const: "projectNavigation" }, workspaceId: id, projectId: id })),
  projectDraft: ajv.compile(object(["kind", "workspaceId", "projectId"], { kind: { const: "projectDraft" }, workspaceId: id, projectId: id })),
  conversation: ajv.compile(object(["kind", "workspaceId", "projectId", "conversationId"], { kind: { const: "conversation" }, workspaceId: id, projectId: id, conversationId: id })),
  sessionWorkspace: ajv.compile(object(["kind", "workspaceId", "projectId", "conversationId"], { kind: { const: "sessionWorkspace" }, workspaceId: id, projectId: id, conversationId: id })),
}

function validKey(value: unknown): value is PersonalKey {
  if (!value || typeof value !== "object" || !("kind" in value)) return false
  const kind = value.kind
  return typeof kind === "string" && Object.hasOwn(keyValidators, kind) && keyValidators[kind as PersonalKey["kind"]](value)
}

/** 超过安全阈值时从最旧消息起裁剪正文缓存，保证阅读位置与草稿永远可正常落盘。 */
function enforceConversationBudget(value: ConversationPersonal): ConversationPersonal {
  const cloned = structuredClone(value)
  if (!cloned.syncCache || cloned.syncCache.messages.length === 0) return cloned
  if (Buffer.byteLength(JSON.stringify(cloned), "utf8") <= SAFE_CACHE_BYTES) return cloned
  const messages = [...cloned.syncCache.messages]
  let truncated = Boolean(cloned.syncCache.cacheTruncated)
  while (messages.length > 0) {
    const candidate: ConversationPersonal = {
      ...cloned,
      syncCache: { ...cloned.syncCache, messages, cacheTruncated: true },
    }
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= SAFE_CACHE_BYTES) {
      return candidate
    }
    // 按步进加速裁剪长历史，避免超多条消息下重复 JSON 序列化阻塞事件循环。
    const drop = messages.length > 200 ? Math.ceil(messages.length / 4) : 1
    messages.splice(0, drop)
    truncated = true
  }
  return {
    ...cloned,
    syncCache: { ...cloned.syncCache, messages: [], cacheTruncated: truncated },
  }
}

/** 每个窗口持有独立授权代次；数据文件名由宿主对服务域和完整范围计算。 */
export class PersonalStore {
  readonly #entries = new Map<string, Promise<Entry>>()
  readonly #permissions = new Map<string, CachedPermission>()
  readonly #authorizing = new Map<string, Promise<PersonalResult<Authorized>>>()
  readonly #root: string

  constructor(private readonly identity: CollaborationState, private readonly origin: string, userData: string) {
    this.#root = join(userData, "personal-view-v2")
  }
  #current(identity: Identity): boolean {
    const current = this.identity.personalIdentity()
    return Boolean(current && current.generation === identity.generation && current.accountId === identity.accountId)
  }
  #permissionKey(key: PersonalKey): string { return JSON.stringify(key) }
  #cacheKey(identity: Identity, key: PersonalKey): string {
    return `${identity.generation}:${identity.accountId}:${this.#permissionKey(key)}`
  }
  #evictStalePermissions(currentIdentity: Identity | null): void {
    for (const [cacheKey, cached] of this.#permissions) {
      if (!currentIdentity
        || cached.identity.generation !== currentIdentity.generation
        || cached.identity.accountId !== currentIdentity.accountId) {
        this.#permissions.delete(cacheKey)
      }
    }
  }
  #name(parts: readonly string[]): string { return createHash("sha256").update(JSON.stringify([this.origin, ...parts])).digest("hex") }

  async #authorize(key: PersonalKey): Promise<PersonalResult<Authorized>> {
    const identity = this.identity.personalIdentity()
    this.#evictStalePermissions(identity)
    if (!identity) return fail("请重新登录后恢复个人视图。")
    if (key.kind !== "account" && !identity.workspaces.includes(key.workspaceId)) {
      return fail("当前账号无法访问该工作区。")
    }

    const cacheKey = this.#cacheKey(identity, key)
    const now = Date.now()
    const cached = this.#permissions.get(cacheKey)
    if (cached) {
      if (!this.#current(cached.identity)) {
        this.#permissions.delete(cacheKey)
      } else if (cached.expiresAtMs > now) {
        return ok(cached)
      }
      // 若仅是 TTL 过期（仍属当前身份代次），保留 cached 占位至重验完成或失败，
      // 避免在途 HTTP 核验期间并发到达的 save() 读不到缓存而误报未确认范围。
    }

    // 合并同一授权范围的并发在途校验，避免打开多会话或连续加载时重复打满服务端权限接口。
    const inFlight = this.#authorizing.get(cacheKey)
    if (inFlight) {
      const result = await inFlight
      if (!result.ok || !this.#current(identity)) {
        this.#permissions.delete(cacheKey)
        return result.ok ? fail("账号已变化，请重试。") : result
      }
      return result
    }

    let request!: Promise<PersonalResult<Authorized>>
    request = (async (): Promise<PersonalResult<Authorized>> => {
      try {
        const parts = [identity.accountId, key.kind]
        let ownsConversation = false
        if (key.kind === "workspace") parts.push(key.workspaceId)
        if (key.kind === "projectNavigation" || key.kind === "projectDraft") {
          // 项目记录与准备页草稿只给仍可访问该项目的账号读写；被移出后旧选择随之失效。
          const detail = await this.identity.withWorkspace(
            key.workspaceId,
            client => client.getProject(key.workspaceId, key.projectId),
            { publishConnectionError: false },
          )
          if (!detail.ok || !this.#current(identity) || detail.value.project.projectId !== key.projectId) {
            this.#permissions.delete(cacheKey)
            return fail("无法确认项目访问权限，请重试。")
          }
          parts.push(key.workspaceId, key.projectId)
        }
        if (key.kind === "conversation" || key.kind === "sessionWorkspace") {
          const detail = await this.identity.withWorkspace(
            key.workspaceId,
            client => client.getProjectConversation(key.workspaceId, key.projectId, key.conversationId),
          )
          if (!detail.ok || !this.#current(identity)) {
            this.#permissions.delete(cacheKey)
            return fail("无法确认会话访问权限，请重试。")
          }
          const conversation = detail.value.conversation
          if (conversation.projectId !== key.projectId || conversation.conversationId !== key.conversationId) {
            this.#permissions.delete(cacheKey)
            return fail("会话范围已变化，请重试。")
          }
          ownsConversation = conversation.ownerUserId === identity.accountId
          parts.push(key.workspaceId, key.projectId, key.conversationId)
        }
        if (!this.#current(identity)) {
          this.#permissions.delete(cacheKey)
          return fail("账号已变化，请重新登录。")
        }
        const authorization: CachedPermission = {
          identity,
          name: this.#name(parts),
          ownsConversation,
          expiresAtMs: Date.now() + PERMISSION_TTL_MS,
        }
        this.#permissions.set(cacheKey, authorization)
        return ok(authorization)
      } catch {
        this.#permissions.delete(cacheKey)
        return fail("无法确认访问权限，请重试。")
      } finally {
        if (this.#authorizing.get(cacheKey) === request) this.#authorizing.delete(cacheKey)
      }
    })()

    this.#authorizing.set(cacheKey, request)
    return request
  }

  #entry(name: string, kind: PersonalKey["kind"] | "promptQueue"): Promise<Entry> {
    let promise = this.#entries.get(name)
    if (promise) return promise
    promise = (async () => {
      let bytes: Buffer
      try { bytes = await readFile(join(this.#root, `${name}.json`)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, flushed: 0, data: null, writing: null }
        throw error
      }
      if (bytes.length > (kind === "promptQueue" ? MAX_PROMPT_QUEUE_BYTES + 128 : 1_048_576)) throw new Error("个人记录过大")
      const record: unknown = JSON.parse(bytes.toString("utf8"))
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("个人记录格式无效")
      const value = record as Record<string, unknown>
      if (Object.keys(value).sort().join(",") !== "data,revision,version" || value.version !== 1 || !Number.isSafeInteger(value.revision)
        || (value.revision as number) < 0
        || !(kind === "promptQueue" ? validatePromptQueue : validators[kind])(value.data)) throw new Error("个人记录格式无效")
      return { revision: value.revision as number, flushed: value.revision as number, data: value.data as Entry["data"], writing: null }
    })()
    this.#entries.set(name, promise)
    // 读取失败不能变成空记录，否则随后的保存会覆盖原数据；允许用户重试。
    void promise.catch(() => { if (this.#entries.get(name) === promise) this.#entries.delete(name) })
    return promise
  }

  async load(key: unknown): Promise<PersonalResult<PersonalRead>> {
    if (!validKey(key)) return fail("个人视图范围无效。")
    const authorized = await this.#authorize(key)
    if (!authorized.ok) return authorized
    try {
      const entry = await this.#entry(authorized.value.name, key.kind)
      if (!this.#current(authorized.value.identity)) return fail("账号已变化，请重新登录。")
      return ok({ revision: entry.revision, data: structuredClone(entry.data as PersonalValue | null) })
    } catch { return fail("无法读取个人视图，请检查应用数据目录后重试。") }
  }

  async save(key: unknown, revision: unknown, value: unknown): Promise<PersonalResult<null>> {
    if (!validKey(key) || !Number.isSafeInteger(revision) || (revision as number) < 1 || !validators[key.kind](value)) return fail("个人视图数据无效。")
    const identity = this.identity.personalIdentity()
    this.#evictStalePermissions(identity)
    if (!identity) return fail("当前账号尚未确认该个人视图范围。")
    const cacheKey = this.#cacheKey(identity, key)
    const cached = this.#permissions.get(cacheKey)
    if (!cached || !this.#current(cached.identity)) {
      this.#permissions.delete(cacheKey)
      return fail("当前账号尚未确认该个人视图范围。")
    }
    let authorized: Authorized = cached
    if (cached.expiresAtMs <= Date.now()) {
      const refreshed = await this.#authorize(key)
      if (!refreshed.ok) return refreshed
      authorized = refreshed.value
    }
    if (key.kind !== "account" && !authorized.identity.workspaces.includes(key.workspaceId)) return fail("当前账号无法访问该工作区。")
    if (key.kind === "account" && (value as { workspaceId: string | null }).workspaceId !== null
      && !authorized.identity.workspaces.includes((value as { workspaceId: string }).workspaceId)) return fail("工作区不可用。")
    if (key.kind === "conversation" && Object.hasOwn(value as ConversationPersonal, "customTitle")) {
      return fail("请通过会话重命名保存标题。")
    }
    const candidate = key.kind === "conversation"
      ? enforceConversationBudget(value as ConversationPersonal)
      : structuredClone(value as PersonalValue)
    try {
      const entry = await this.#entry(authorized.name, key.kind)
      if (!this.#current(authorized.identity)) return fail("账号已变化，个人视图未保存。")
      if ((revision as number) < entry.revision) return ok(null)
      if ((revision as number) > entry.revision) {
        const title = key.kind === "conversation" ? (entry.data as ConversationPersonal | null)?.customTitle : undefined
        const next = title ? { ...candidate, customTitle: title } : candidate
        if (Buffer.byteLength(JSON.stringify(next), "utf8") > HARD_RECORD_BYTES) return fail("个人视图过大，未能保存。")
        entry.revision = revision as number
        entry.data = next
      }
      while (entry.flushed < (revision as number)) await this.#write(authorized.name, entry)
      return ok(null)
    } catch { return fail("个人视图保存失败，请检查应用数据目录后重试。") }
  }

  /** 标题独立于渲染层的个人视图修订，写盘成功后才合并进最新记录。 */
  async renameConversation(key: unknown, rawTitle: unknown): Promise<PersonalResult<string>> {
    if (!validKey(key) || key.kind !== "conversation" || typeof rawTitle !== "string") return fail("会话标题无效。")
    const title = rawTitle.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim()
    if (!title || [...title].length > 80) return fail("请输入 1～80 个字符的会话标题。")
    const result = await this.#authorize(key)
    if (!result.ok) return result
    const { identity, name, ownsConversation } = result.value
    if (!ownsConversation) return fail("只能重命名自己的会话。")
    try {
      const entry = await this.#entry(name, key.kind)
      while (entry.writing) await entry.writing
      if (!this.#current(identity)) return fail("账号已变化，会话标题未保存。")
      const current = (entry.data as ConversationPersonal | null) ?? EMPTY_CONVERSATION_PERSONAL
      if (current.customTitle === title) return ok(title)

      const revision = entry.revision
      const data = { ...current, customTitle: title }
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > HARD_RECORD_BYTES) return fail("个人记录过大，会话标题未保存。")
      const write = this.#writeRecord(name, revision, data).then(() => {
        // 等待磁盘时可能收到新版草稿。只合并标题，让后续写盘保留两边的改动。
        entry.data = { ...(entry.data ?? current), customTitle: title }
        entry.flushed = revision
      })
      entry.writing = write.catch(() => {}).finally(() => { entry.writing = null })
      await write
      return this.#current(identity) ? ok(title) : fail("账号已变化，请重新读取会话。")
    } catch { return fail("会话标题保存失败，请重试。") }
  }

  /** 仅供主进程串行读写本人待发消息，复用原子落盘，独立于页面草稿修订。 */
  async conversationPromptQueue(scope: LocalExecutionScope, next?: PromptQueueRecord): Promise<PersonalResult<PromptQueueRecord>> {
    const key = { kind: "conversation" as const, workspaceId: scope.workspaceId, projectId: scope.projectId, conversationId: scope.conversationId }
    if (!validKey(key)) return fail("待发队列范围无效。")
    const result = await this.#authorize(key)
    if (!result.ok) return result
    const { identity, ownsConversation } = result.value
    if (!ownsConversation || identity.accountId !== scope.accountId) return fail("只能访问自己会话的待发队列。")
    const name = "prompt-queue-" + result.value.name
    try {
      const entry = await this.#entry(name, "promptQueue")
      if (!this.#current(identity)) return fail("账号已变化，请重新登录。")
      if (next === undefined) return ok(structuredClone((entry.data as PromptQueueRecord | null) ?? { items: [] }))
      if (!validatePromptQueue(next) || Buffer.byteLength(JSON.stringify(next)) > MAX_PROMPT_QUEUE_BYTES) {
        return fail("待发队列超出容量，请移除部分消息或附件。")
      }
      const revision = entry.revision + 1
      await this.#writeRecord(name, revision, next)
      entry.data = structuredClone(next)
      entry.revision = entry.flushed = revision
      return this.#current(identity) ? ok(next) : fail("账号已变化，请重新登录。")
    } catch { return fail("无法读写待发队列，请检查应用数据目录。") }
  }

  async #writeRecord(name: string, revision: number, data: Entry["data"]): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const target = join(this.#root, `${name}.json`), temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, revision, data }), {
        encoding: "utf8", mode: 0o600, flag: "wx", flush: name.startsWith("prompt-queue-"),
      })
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }

  async #write(name: string, entry: Entry): Promise<void> {
    if (entry.writing) return entry.writing
    entry.writing = (async () => {
      while (entry.flushed < entry.revision) {
        const revision = entry.revision
        await this.#writeRecord(name, revision, entry.data)
        entry.flushed = revision
      }
    })().finally(() => { entry.writing = null })
    return entry.writing
  }

  /** 只供主进程确认旧会话是否也记录了相同或重叠的目录。 */
  async otherConversationDirectories(scope: { accountId: string; workspaceId: string; projectId: string; conversationId: string }): Promise<readonly string[]> {
    const own = this.#name([scope.accountId, "conversation", scope.workspaceId, scope.projectId, scope.conversationId]) + ".json"
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    })
    const files = entries.filter(item => item.name !== own && /^[0-9a-f]{64}\.json$/.test(item.name))
    if (files.length > 5_000) throw new Error("个人记录过多，无法确认工作树隔离。")
    const directories: string[] = []
    for (const item of files) {
      if (!item.isFile()) throw new Error("个人记录格式无效，无法确认工作树隔离。")
      const value = JSON.parse(await readFile(join(this.#root, item.name), "utf8"))?.data?.localDirectoryPath
      if (typeof value === "string" && isAbsolute(value)) directories.push(value)
    }
    return directories
  }

  /** 关窗前等待所有已接收的最新修订；失败时保留待写内容供下一次重试。 */
  async flush(): Promise<boolean> {
    try {
      const entries = await Promise.all([...this.#entries.entries()].map(async ([name, promise]) => ({ name, entry: await promise })))
      await Promise.all(entries.map(async ({ name, entry }) => {
        while (entry.writing || entry.flushed < entry.revision) await this.#write(name, entry)
      }))
      return true
    } catch { return false }
  }
}
