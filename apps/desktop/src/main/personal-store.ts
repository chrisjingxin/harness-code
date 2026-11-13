/**
 * 个人视图存储：认证范围 → 独立记录 → 校验字段与修订 → 合并写入 → 原子替换。
 * 文件只含个人选择；会话和项目的正文始终由各自的业务端口重新授权读取。
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import type { PersonalKey, PersonalRead, PersonalResult, PersonalValue } from "../personal-host.js"
import type { CollaborationState } from "./collaboration-state.js"

type Identity = NonNullable<ReturnType<CollaborationState["personalIdentity"]>>
type Entry = { revision: number; flushed: number; data: PersonalValue | null; writing: Promise<void> | null }
type Authorized = { identity: Identity; name: string; project?: { deviceId: string; projectId: string } }
const fail = (message: string): PersonalResult<never> => ({ ok: false, message })
const ok = <T>(value: T): PersonalResult<T> => ({ ok: true, value })
const id = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }
const nullableId = { anyOf: [id, { type: "null" }] }
const text = { type: "string", maxLength: 4096 }
const nullableText = { anyOf: [text, { type: "null" }] }
const strings = { type: "array", maxItems: 2000, items: text }
const coord = { type: "number", minimum: 0, maximum: 100000000 }
const panel = { type: "object", additionalProperties: false, required: ["open", "width"], properties: {
  open: { type: "boolean" }, width: { type: "number", minimum: 0, maximum: 10000 },
} }
const object = (required: string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required, properties })
const schemas: Record<PersonalKey["kind"], object> = {
  account: object(["workspaceId"], { workspaceId: nullableId }),
  workspace: object(["projectId", "panels"], {
    projectId: nullableId, panels: object(["left", "right"], { left: panel, right: panel }),
  }),
  projectNavigation: object(["page", "expandedMembers", "selfCollapsed"], {
    page: { oneOf: [
      object(["kind"], { kind: { enum: ["new", "board", "tasks", "info", "knowledge"] } }),
      object(["kind", "conversationId"], { kind: { const: "conversation" }, conversationId: id }),
      object(["kind", "taskId"], { kind: { const: "task" }, taskId: id }),
    ] },
    expandedMembers: { type: "array", maxItems: 2000, items: id }, selfCollapsed: { type: "boolean" },
  }),
  conversation: object(["scroll", "expandedTools", "expandedOutputs", "draft"], {
    scroll: object(["anchorEntryId", "offsetPx", "following", "seenContentRevision"], {
      anchorEntryId: nullableText, offsetPx: { type: "number", minimum: -100000000, maximum: 100000000 },
      following: { type: "boolean" }, seenContentRevision: { anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] },
    }),
    expandedTools: strings, expandedOutputs: strings,
    draft: object(["text", "selectionStart", "selectionEnd", "revision", "referenceIds", "attachmentIds"], {
      text: { type: "string", maxLength: 262144 }, selectionStart: { type: "integer", minimum: 0, maximum: 262144 },
      selectionEnd: { type: "integer", minimum: 0, maximum: 262144 }, revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      referenceIds: strings, attachmentIds: strings,
    }),
  }),
  project: object(["personal", "positions"], {
    personal: object(["view", "expanded", "centralPaths", "activeCentral", "diffPath"], {
      view: object(["dockOpen", "dockWidthPx", "panel", "selectedPath", "fileTabs", "activeFilePath", "selectedChanges", "commitMessage"], {
        dockOpen: { type: "boolean" }, dockWidthPx: { type: "number", minimum: 0, maximum: 10000 },
        panel: { enum: ["files", "changes"] }, selectedPath: nullableText, activeFilePath: nullableText,
        fileTabs: { type: "array", maxItems: 12, items: object(["path", "name"], { path: text, name: text }) },
        selectedChanges: { type: "array", maxItems: 2000, items: object(["path", "version"], { path: text, version: text }) },
        commitMessage: { type: "string", maxLength: 262144 },
      }),
      expanded: strings, centralPaths: strings, activeCentral: nullableText, diffPath: nullableText,
    }),
    positions: { type: "array", maxItems: 2000, items: object(["area", "path", "top", "left"], {
      area: { enum: ["central", "dock", "tree"] }, path: text, top: coord, left: coord,
    }) },
  }),
}
const ajv = new Ajv2020({ strict: true })
const validators = {
  account: ajv.compile(schemas.account), workspace: ajv.compile(schemas.workspace), projectNavigation: ajv.compile(schemas.projectNavigation),
  conversation: ajv.compile(schemas.conversation), project: ajv.compile(schemas.project),
}
const keyValidators = {
  account: ajv.compile(object(["kind"], { kind: { const: "account" } })),
  workspace: ajv.compile(object(["kind", "workspaceId"], { kind: { const: "workspace" }, workspaceId: id })),
  projectNavigation: ajv.compile(object(["kind", "workspaceId", "projectId"], { kind: { const: "projectNavigation" }, workspaceId: id, projectId: id })),
  conversation: ajv.compile(object(["kind", "workspaceId", "conversationId"], { kind: { const: "conversation" }, workspaceId: id, conversationId: id })),
  project: ajv.compile(object(["kind", "workspaceId", "conversationId"], { kind: { const: "project" }, workspaceId: id, conversationId: id })),
}

function validKey(value: unknown): value is PersonalKey {
  if (!value || typeof value !== "object" || !("kind" in value)) return false
  const kind = value.kind
  return typeof kind === "string" && Object.hasOwn(keyValidators, kind) && keyValidators[kind as PersonalKey["kind"]](value)
}

/** 每个窗口持有独立授权代次；数据文件名由宿主对服务域和完整范围计算。 */
export class PersonalStore {
  readonly #entries = new Map<string, Promise<Entry>>()
  readonly #permissions = new Map<string, Authorized>()
  readonly #root: string

  constructor(private readonly identity: CollaborationState, private readonly origin: string, userData: string) {
    this.#root = join(userData, "personal-view-v2")
  }
  #current(identity: Identity): boolean {
    const current = this.identity.personalIdentity()
    return Boolean(current && current.generation === identity.generation && current.accountId === identity.accountId)
  }
  #permissionKey(key: PersonalKey): string { return JSON.stringify(key) }
  #name(parts: readonly string[]): string { return createHash("sha256").update(JSON.stringify([this.origin, ...parts])).digest("hex") }

  async #authorize(key: PersonalKey): Promise<PersonalResult<Authorized>> {
    this.#permissions.delete(this.#permissionKey(key))
    const identity = this.identity.personalIdentity()
    if (!identity) return fail("请重新登录后恢复个人视图。")
    if (key.kind !== "account" && !identity.workspaces.includes(key.workspaceId)) return fail("当前账号无法访问该工作区。")
    const parts = [identity.accountId, key.kind]
    if (key.kind === "workspace") parts.push(key.workspaceId)
    if (key.kind === "projectNavigation") {
      // 项目记录只给仍可访问该项目的账号读写；被移出后旧选择随之失效。
      const detail = await this.identity.getProject(key.workspaceId, key.projectId)
      if (!detail.ok || !this.#current(identity) || detail.value.project.projectId !== key.projectId) return fail("无法确认项目访问权限，请重试。")
      parts.push(key.workspaceId, key.projectId)
    }
    let project: Authorized["project"]
    if (key.kind === "conversation" || key.kind === "project") {
      const detail = await this.identity.getConversation(key.workspaceId, key.conversationId)
      if (!detail.ok || !this.#current(identity)) return fail("无法确认会话访问权限，请重试。")
      const conversation = detail.value.conversation
      if (conversation.workspaceId !== key.workspaceId || conversation.conversationId !== key.conversationId) return fail("会话范围已变化，请重试。")
      parts.push(key.workspaceId)
      if (key.kind === "conversation") parts.push(key.conversationId)
      else {
        const allowed = await this.identity.readProject(key.workspaceId, key.conversationId, { kind: "listDirectory", directory: "" })
        if (!allowed.ok || !this.#current(identity)) return fail("无法确认原项目访问权限，请重试。")
        const confirmed = await this.identity.getConversation(key.workspaceId, key.conversationId)
        if (!confirmed.ok || !this.#current(identity) || confirmed.value.conversation.deviceId !== conversation.deviceId
          || confirmed.value.conversation.projectId !== conversation.projectId) return fail("原项目范围已变化，请重试。")
        project = { deviceId: conversation.deviceId, projectId: conversation.projectId }
        parts.push(project.deviceId, project.projectId)
      }
    }
    const authorization = { identity, name: this.#name(parts), ...(project ? { project } : {}) }
    this.#permissions.set(this.#permissionKey(key), authorization)
    return ok(authorization)
  }

  #entry(name: string, kind: PersonalKey["kind"]): Promise<Entry> {
    let promise = this.#entries.get(name)
    if (promise) return promise
    promise = (async () => {
      let bytes: Buffer
      try { bytes = await readFile(join(this.#root, `${name}.json`)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, flushed: 0, data: null, writing: null }
        throw error
      }
      if (bytes.length > 1_048_576) throw new Error("个人记录过大")
      const record: unknown = JSON.parse(bytes.toString("utf8"))
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("个人记录格式无效")
      const value = record as Record<string, unknown>
      if (Object.keys(value).sort().join(",") !== "data,revision,version" || value.version !== 1 || !Number.isSafeInteger(value.revision)
        || (value.revision as number) < 1 || !validators[kind](value.data)) throw new Error("个人记录格式无效")
      return { revision: value.revision as number, flushed: value.revision as number, data: value.data as PersonalValue, writing: null }
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
      return ok({ revision: entry.revision, data: structuredClone(entry.data), ...(authorized.value.project ? { project: authorized.value.project } : {}) })
    } catch { return fail("无法读取个人视图，请检查应用数据目录后重试。") }
  }

  async save(key: unknown, revision: unknown, value: unknown): Promise<PersonalResult<null>> {
    if (!validKey(key) || !Number.isSafeInteger(revision) || (revision as number) < 1 || !validators[key.kind](value)) return fail("个人视图数据无效。")
    const authorized = this.#permissions.get(this.#permissionKey(key))
    if (!authorized || !this.#current(authorized.identity)) return fail("当前账号尚未确认该个人视图范围。")
    if (key.kind !== "account" && !authorized.identity.workspaces.includes(key.workspaceId)) return fail("当前账号无法访问该工作区。")
    if (key.kind === "account" && (value as { workspaceId: string | null }).workspaceId !== null
      && !authorized.identity.workspaces.includes((value as { workspaceId: string }).workspaceId)) return fail("工作区不可用。")
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_000_000) return fail("个人视图过大，未能保存。")
    try {
      const entry = await this.#entry(authorized.name, key.kind)
      if (!this.#current(authorized.identity)) return fail("账号已变化，个人视图未保存。")
      if ((revision as number) < entry.revision) return ok(null)
      if ((revision as number) > entry.revision) {
        entry.revision = revision as number
        entry.data = structuredClone(value as PersonalValue)
      }
      while (entry.flushed < (revision as number)) await this.#write(authorized.name, entry)
      return ok(null)
    } catch { return fail("个人视图保存失败，请检查应用数据目录后重试。") }
  }

  async #write(name: string, entry: Entry): Promise<void> {
    if (entry.writing) return entry.writing
    entry.writing = (async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      while (entry.flushed < entry.revision) {
        const revision = entry.revision
        const data = JSON.stringify({ version: 1, revision, data: entry.data })
        const target = join(this.#root, `${name}.json`), temporary = `${target}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" })
          await rename(temporary, target)
        } finally { await rm(temporary, { force: true }).catch(() => {}) }
        entry.flushed = revision
      }
    })().finally(() => { entry.writing = null })
    return entry.writing
  }

  /** 关窗前等待所有已接收的最新修订；失败时保留待写内容供下一次重试。 */
  async flush(): Promise<boolean> {
    try {
      const entries = await Promise.all([...this.#entries.entries()].map(async ([name, promise]) => ({ name, entry: await promise })))
      await Promise.all(entries.map(async ({ name, entry }) => {
        while (entry.flushed < entry.revision) await this.#write(name, entry)
      }))
      return true
    } catch { return false }
  }
}
