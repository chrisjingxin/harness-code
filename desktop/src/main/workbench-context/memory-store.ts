/**
 * 两份 Markdown 的唯一持久化入口，上游为桌面上下文服务和用户确认动作。
 * 读取最新文件 → 条目版本核对 → 渲染并检查篇幅 → 临时文件同步 → 原子替换。
 * 同一范围共用短写锁；网络权限核对由上游在入锁前完成，锁内只做本地文件操作。
 */
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { MEMORY_BODY_LIMIT, MEMORY_ENTRY_LIMIT, memoryFile, type MemoryDocument, type MemoryEntry, type MemoryFields, type MemoryFile, type MemoryPair, type MemoryProposal, type MemoryScope, type MemorySource, type MemoryUpdateResult } from "./types.js"

const files: MemoryFile[] = ["team.md", "personal.md"]
const locks = new Map<string, Promise<unknown>>()
const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"
const empty = (): MemoryDocument => ({ formatVersion: 1, documentRevision: 0, updatedAt: "", entries: [] })
const fieldNames = ["name", "summary", "aliases", "projectIds", "repositoryId", "repositoryIds", "relatedProjectIds", "remoteUrl", "upstreamUrl", "rootPath", "relativePath"] as const
const arrays = new Set(["aliases", "projectIds", "repositoryIds", "relatedProjectIds"])
const clean = (text: string) => text.replace(/[\r\n\p{Cc}]/gu, " ").trim()
const scopeKey = (scope: MemoryScope) => JSON.stringify([new URL(scope.origin).origin, scope.accountId, scope.workspaceId])
const safeId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(value)

/** 普通 Markdown 正文只由已校验业务字段生成，不携带文件头技术字段。 */
export function renderMemory(file: MemoryFile, entries: readonly MemoryEntry[]): string {
  if (!entries.length) return ""
  return [`# ${file === "team.md" ? "团队工程概览" : "个人工程目录"}`, ...entries.map(entry => [
    `## ${entry.name}${entry.aliases?.length ? `（${entry.aliases.join("、")}）` : ""}`,
    entry.summary,
    ...(entry.projectIds?.length ? [`关联 Project：${entry.projectIds.join("、")}`] : []),
    ...(entry.repositoryId ? [`团队仓库 ID：${entry.repositoryId}`] : []),
    ...(entry.repositoryIds?.length ? [`涉及仓库：${entry.repositoryIds.join("、")}`] : []),
    ...(entry.relatedProjectIds?.length ? [`相关 Project：${entry.relatedProjectIds.join("、")}`] : []),
    ...(entry.rootPath ? [`本机根目录：${entry.rootPath}；相对目录：${entry.relativePath ?? "."}`] : []),
    ...(entry.remoteUrl ? [`${file === "team.md" ? "团队" : "本人"}仓库：${entry.remoteUrl}`] : []),
    ...(entry.upstreamUrl ? [`团队上游：${entry.upstreamUrl}`] : []),
  ].filter(Boolean).join("\n"))].join("\n\n") + "\n"
}

/** YAML 1.2 文件头采用 JSON 流式值；无需额外持久化 JSON，也不执行任意 YAML 标签。 */
function encode(document: MemoryDocument, file: MemoryFile): string {
  return `---\nformatVersion: 1\ndocumentRevision: ${document.documentRevision}\nupdatedAt: ${JSON.stringify(document.updatedAt)}\nentries: ${JSON.stringify(document.entries)}\n---\n${renderMemory(file, document.entries)}`
}
function validateFields(value: Partial<MemoryFields>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("变更字段必须是对象。")
  for (const [key, item] of Object.entries(value)) {
    if (!fieldNames.includes(key as typeof fieldNames[number])) throw new Error(`不支持的维护字段：${key}`)
    if (arrays.has(key)) {
      if (!Array.isArray(item) || item.length > 64 || item.some(v => typeof v !== "string" || !v || clean(v) !== v)) throw new Error(`字段 ${key} 无效。`)
    } else if (typeof item !== "string" || clean(item) !== item || item.includes("\0")) throw new Error(`字段 ${key} 无效。`)
  }
}
function decode(text: string, file: MemoryFile): MemoryDocument {
  const match = /^---\nformatVersion: 1\ndocumentRevision: (\d+)\nupdatedAt: (.+)\nentries: (.+)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${file} 文件头无法解析，原文件已保留。`)
  const entries: MemoryEntry[] = JSON.parse(match[3])
  const document: MemoryDocument = { formatVersion: 1, documentRevision: Number(match[1]), updatedAt: JSON.parse(match[2]), entries }
  if (!Number.isSafeInteger(document.documentRevision) || typeof document.updatedAt !== "string" || !Array.isArray(entries)) throw new Error(`${file} 维护字段无效。`)
  const ids = new Set<string>()
  for (const entry of entries) {
    const { entryId, entryRevision, kind, sources, confirmedAt, ...fields } = entry
    validateFields(fields)
    if (!safeId(entryId) || ids.has(entryId) || !Number.isSafeInteger(entryRevision) || entryRevision < 1
      || !["team_project", "team_repository", "personal_directory"].includes(kind) || memoryFile(kind) !== file
      || !fields.name || typeof fields.summary !== "string" || !Array.isArray(sources) || !sources.length
      || sources.some(s => !s || typeof s.sourceId !== "string" || !["project", "repository", "conversation", "snapshot", "knowledge", "user_confirmation"].includes(s.kind)
        || s.projectId !== undefined && typeof s.projectId !== "string"
        || s.confirmedDirectory !== undefined && typeof s.confirmedDirectory !== "string"
        || [s.repositoryId, s.remoteUrl, s.upstreamUrl].some(value => value !== undefined && typeof value !== "string"))
      || typeof confirmedAt !== "string" || bytes(entry) > MEMORY_ENTRY_LIMIT) throw new Error(`${file} 条目无效，原文件已保留。`)
    ids.add(entryId)
  }
  if (renderMemory(file, entries) !== match[4]) throw new Error(`${file} 正文与维护字段不一致，原文件已保留，请通过工具修改。`)
  return document
}
function sameFacts(a: MemoryEntry, b: MemoryEntry) {
  return fieldNames.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}
function identity(entry: MemoryFields & { kind: string }) {
  if (entry.kind === "team_project") return entry.projectIds?.[0] ? `project:${entry.projectIds[0]}` : null
  if (entry.kind === "team_repository") return entry.repositoryId ? `repository:${entry.repositoryId}` : null
  return entry.rootPath ? `directory:${entry.repositoryId ?? ""}:${resolve(entry.rootPath === "~" ? homedir() : entry.rootPath, entry.relativePath ?? ".")}` : null
}

/** 每个服务来源、账号和 Team 单独读写；root 可由隔离冒烟指定，产品默认取系统主目录。 */
export class ProjectMemoryStore {
  constructor(readonly root = join(homedir(), ".harness", "workbench", "project-memory")) {}
  directory(scope: MemoryScope): string {
    if (!safeId(scope.accountId) || !safeId(scope.workspaceId)) throw new Error("记忆范围标识无效。")
    return join(this.root, createHash("sha256").update(new URL(scope.origin).origin).digest("hex"), scope.accountId, scope.workspaceId)
  }
  async #ensure(scope: MemoryScope) {
    const target = this.directory(scope)
    // 不跟随范围目录中的符号链接，避免其他位置被当作当前账号记忆覆盖。
    const parts = [this.root, join(target, "..", ".."), join(target, ".."), target]
    for (const path of parts) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      if ((await lstat(path)).isSymbolicLink()) throw new Error("记忆目录不能使用符号链接。")
    }
  }
  async read(scope: MemoryScope): Promise<MemoryPair> {
    const target = this.directory(scope)
    for (const path of [this.root, join(target, "..", ".."), join(target, ".."), target]) {
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error("记忆目录不能使用符号链接。") }
      catch (error) { if (!missing(error)) throw error }
    }
    const result = {} as MemoryPair
    for (const file of files) {
      try {
        const path = join(target, file)
        if ((await lstat(path)).isSymbolicLink()) throw new Error(`${file} 不能使用符号链接。`)
        result[file] = decode(await readFile(path, "utf8"), file)
      } catch (error) { if (!missing(error)) throw error; result[file] = empty() }
    }
    return result
  }
  async #write(scope: MemoryScope, file: MemoryFile, document: MemoryDocument, isCurrent: () => boolean): Promise<void> {
    await this.#ensure(scope)
    const target = join(this.directory(scope), file)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, "wx", 0o600)
      try { await handle.writeFile(encode(document, file), "utf8"); await handle.sync() } finally { await handle.close() }
      if (!isCurrent()) throw new Error("身份或来源已失效，未保存。")
      await rename(temp, target)
    } finally { await rm(temp, { force: true }).catch(() => {}) }
  }
  /** 首次使用即创建两份空概览，损坏文件保持原件；初始化不虚增业务修订号。 */
  async initialize(scope: MemoryScope, isCurrent: () => boolean): Promise<void> {
    await this.#locked(scope, async () => {
      await this.read(scope)
      for (const file of files) {
        try { await lstat(join(this.directory(scope), file)) }
        catch (error) {
          if (!missing(error)) throw error
          if (!isCurrent()) throw new Error("身份已失效。")
          await this.#write(scope, file, empty(), isCurrent)
        }
      }
    })
  }
  async #locked<T>(scope: MemoryScope, action: () => Promise<T>): Promise<T> {
    const key = `${this.root}:${scopeKey(scope)}`
    const previous = locks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    locks.set(key, current)
    try { return await current } finally { if (locks.get(key) === current) locks.delete(key) }
  }
  #merge(pair: MemoryPair, proposal: MemoryProposal, sources: MemorySource[], assignedEntryId?: string): { result: MemoryUpdateResult; pair: MemoryPair } {
    const file = memoryFile(proposal.kind)
    const document = pair[file]
    const entries = document.entries
    const supplied = proposal.fields ?? {}
    validateFields(supplied)
    let existing = entries.find(e => e.entryId === proposal.entryId)
    if (!existing && proposal.entryId) return { pair, result: { status: "conflict", message: "原条目不存在，请重新查询。", file } }
    const logicalIdentity = identity({ ...supplied, kind: proposal.kind } as MemoryEntry)
    if (!existing && logicalIdentity) existing = entries.find(e => identity(e) === logicalIdentity)
    if (existing && existing.kind !== proposal.kind) throw new Error("条目类型不能变更。")
    if (!existing && !logicalIdentity && proposal.operation === "upsert") {
      const sameName = entries.filter(e => e.kind === proposal.kind && e.name === supplied.name)
      if (sameName.length === 1) existing = sameName[0]
    }
    const fields = { ...existing, ...supplied }
    if (proposal.operation === "upsert" && (!fields.name || typeof fields.summary !== "string")) throw new Error("名称与简短用途说明必填。")
    const candidate: MemoryEntry = { ...fields, kind: proposal.kind, entryId: existing?.entryId ?? assignedEntryId ?? randomUUID(), entryRevision: (existing?.entryRevision ?? 0) + 1, sources: [...new Map([...(existing?.sources ?? []), ...sources].map(source => [source.sourceId, source])).values()], confirmedAt: new Date().toISOString() } as MemoryEntry
    if (existing && proposal.operation === "upsert" && sameFacts(existing, candidate)) return { pair, result: { status: "no_change", message: "事实未变化。", entryId: existing.entryId, file, entry: existing } }
    if ((existing?.entryRevision ?? 0) !== proposal.baseEntryRevision) return { pair, result: { status: "conflict", message: "条目已被更新，请查询最新修订。", entryId: existing?.entryId, file, entry: existing } }
    if (proposal.operation === "remove" && !existing) return { pair, result: { status: "no_change", message: "条目已经不存在。", file } }
    if (proposal.kind === "personal_directory" && proposal.operation === "upsert") {
      if (!candidate.rootPath || !isAbsolute(candidate.rootPath === "~" ? homedir() : candidate.rootPath)) throw new Error("本机根目录必须是绝对路径或 ~。")
      const path = resolve(candidate.rootPath === "~" ? homedir() : candidate.rootPath, candidate.relativePath ?? ".")
      if (!sources.some(s => s.confirmedDirectory === path
        && (!candidate.repositoryId || s.repositoryId === candidate.repositoryId)
        && (!candidate.remoteUrl || s.remoteUrl === candidate.remoteUrl)
        && (!candidate.upstreamUrl || s.upstreamUrl === candidate.upstreamUrl))) return { pair, result: { status: "needs_confirmation", message: "请本人选择目录或先实际核对本机目录及 Git 对应关系。", file } }
    }
    if (existing?.sources.some(s => s.kind === "user_confirmation") && !sources.some(s => s.kind === "user_confirmation")) return { pair, result: { status: "conflict", message: "与本人已确认记录冲突，请先向用户核实。", file, entry: existing } }
    if (proposal.operation === "upsert" && bytes(candidate) > MEMORY_ENTRY_LIMIT) throw new Error("单条维护记录超过 4 KiB，请精简后重新提案。")
    const next = entries.filter(e => e.entryId !== existing?.entryId)
    if (proposal.operation !== "remove") {
      const index = existing ? entries.indexOf(existing) : next.length
      next.splice(index, 0, candidate)
    }
    const merged = { ...pair, [file]: { ...document, entries: next, documentRevision: document.documentRevision + 1, updatedAt: new Date().toISOString() } }
    if (files.reduce((sum, f) => sum + bytes(renderMemory(f, merged[f].entries)), 0) > MEMORY_BODY_LIMIT) throw new Error("两份业务正文合计超过 8 KiB，请精简后重新提案；原文件未变。")
    return { pair: merged, result: { status: "pending", message: "准备更新项目记忆，等待本轮正常完成，尚未保存。", entryId: candidate.entryId, file, ...(proposal.operation === "upsert" ? { entry: candidate } : {}) } }
  }
  /** 预检与落盘使用同一合并逻辑；预检不改变文件，提交时重新读取最新条目。 */
  async update(scope: MemoryScope, proposal: MemoryProposal, sources: MemorySource[], commit: boolean, isCurrent: () => boolean, assignedEntryId?: string): Promise<MemoryUpdateResult> {
    try {
      return await this.#locked(scope, async () => {
        if (!isCurrent()) throw new Error("身份或来源已失效，未保存。")
        const current = await this.read(scope)
        if (!isCurrent()) throw new Error("身份或来源已失效，未保存。")
        const merged = this.#merge(current, proposal, sources, assignedEntryId)
        if (!commit || merged.result.status !== "pending") return merged.result
        const file = merged.result.file!
        await this.#write(scope, file, merged.pair[file], isCurrent)
        return { ...merged.result, status: "saved", message: `已${proposal.operation === "remove" ? "移除" : "记住"}${merged.result.entry?.name ?? "工程记录"}。` }
      })
    } catch (error) { return { status: "error", message: error instanceof Error ? error.message : "项目记忆保存失败。", file: memoryFile(proposal.kind) } }
  }
}
