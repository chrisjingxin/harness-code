/**
 * 两份普通 Markdown 的唯一内容存储，上游为桌面 MCP 和轻量用户编辑端口。
 * 身份预检 → 范围短锁 → 读取/惰性迁移 → 内容 hash 比对 → 同步并原子保存。
 * 不解释业务条目或目录事实，不调用模型；网络授权由上游在进入本地锁前完成。
 */
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { ProjectMemoryDocument, ProjectMemoryInput, ProjectMemoryResult, ProjectMemorySize } from "../../shared/workbench-context-host.js"
import { CONTEXT_REQUEST_BYTES, MEMORY_TARGET_BYTES, type MemoryScope } from "./types.js"
import { migrateLegacyMemory } from "./legacy-memory.js"
import { MemoryFileError, backupMemoryBytes, ensureMemoryDirectory, readMemoryBytes, replaceMemoryBytes } from "./memory-files.js"

const locks = new Map<string, Promise<unknown>>()
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const safeId = (value: string) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const file = (document: ProjectMemoryDocument) => `${document}.md`
const current = (isCurrent: () => boolean) => {
  if (!isCurrent()) throw new MemoryFileError("scope_revoked", "身份、会话绑定或轮次已失效，未保存。")
}
const conflict = (document: ProjectMemoryDocument, bytes: Buffer | null): ProjectMemoryResult => ({
  status: "conflict", document, currentRevision: bytes ? hash(bytes) : null, retry: "read_then_merge", message: "文档已变化，请重新读取最新内容并合并后保存。",
})
/** 不改换行、不替换非法字符，内容版本始终对应文件实际字节。 */
function text(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new MemoryFileError("invalid_utf8", "记忆文件不是有效 UTF-8，原件已保留。") }
}
function failure(document: ProjectMemoryDocument, error: unknown): ProjectMemoryResult {
  return error instanceof MemoryFileError
    ? { status: "unavailable", document, reason: error.reason, message: error.message }
    : { status: "error", document, reason: "io_error", message: "记忆文件读写失败，原件未被主动回滚；请重读核对后重试。" }
}
/** UI 和 MCP 共用字段校验；允许任意 Markdown，不检查路径存在、Git 或来源证明。 */
export function validMemoryDocument(value: unknown): value is ProjectMemoryDocument { return value === "team" || value === "personal" }
export function validMemoryInput(value: unknown): value is ProjectMemoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return Object.keys(raw).length === 3 && validMemoryDocument(raw.document) && typeof raw.content === "string"
    && typeof raw.expectedRevision === "string" && /^[a-f0-9]{64}$/.test(raw.expectedRevision)
    && Buffer.from(raw.content, "utf8").toString("utf8") === raw.content
}

/** root 可注入 tmp 样本根；产品仅在当前身份正常访问时惰性迁移指定文档，不扫描用户目录。 */
export class ProjectMemoryStore {
  readonly root: string
  constructor(root = join(homedir(), ".harness", "workbench", "project-memory")) { this.root = resolve(root) }
  directory(scope: MemoryScope): string {
    if (!safeId(scope.accountId) || !safeId(scope.workspaceId)) throw new MemoryFileError("unsafe_path", "记忆范围标识无效。")
    return join(this.root, hash(Buffer.from(new URL(scope.origin).origin)), scope.accountId, scope.workspaceId)
  }
  async #locked<T>(scope: MemoryScope, action: () => Promise<T>): Promise<T> {
    const key = this.directory(scope), previous = locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    locks.set(key, next)
    try { return await next } finally { if (locks.get(key) === next) locks.delete(key) }
  }
  async #prepare(scope: MemoryScope, document: ProjectMemoryDocument, isCurrent: () => boolean, initialize: boolean): Promise<Buffer | null> {
    current(isCurrent)
    if (!validMemoryDocument(document)) throw new MemoryFileError("invalid_arguments", "文档只能是 team 或 personal。")
    const directory = this.directory(scope), path = join(directory, file(document))
    await ensureMemoryDirectory(this.root, directory)
    let bytes = await readMemoryBytes(path)
    if (bytes === null) {
      if (!initialize) return null
      const template = Buffer.from(document === "team" ? "# 团队工程记忆\n" : "# 个人工程记忆\n")
      await replaceMemoryBytes(path, template, async () => {
        await ensureMemoryDirectory(this.root, directory)
        if (await readMemoryBytes(path) !== null) throw new MemoryFileError("changed", "文档已由其它操作创建，请重读。")
        current(isCurrent)
      })
      bytes = template
    }
    let migrated: string | undefined
    try { migrated = migrateLegacyMemory(text(bytes), document) }
    catch (error) {
      if (error instanceof MemoryFileError) throw error
      throw new MemoryFileError("corrupt_legacy", "旧记忆格式损坏或正文不一致，原件只读保留，请人工检查。")
    }
    if (migrated !== undefined) {
      current(isCurrent)
      const original = bytes
      await backupMemoryBytes(`${path}.hc233-v1.${hash(original)}.bak`, original)
      const replacement = Buffer.from(migrated, "utf8")
      await replaceMemoryBytes(path, replacement, async () => {
        await ensureMemoryDirectory(this.root, directory)
        if (!(await readMemoryBytes(path))?.equals(original)) throw new MemoryFileError("changed", "迁移期间文档已变化，原件保留，请重读。")
        current(isCurrent)
      })
      bytes = replacement
    }
    current(isCurrent)
    return bytes
  }
  async #size(scope: MemoryScope, document: ProjectMemoryDocument, bytes: Buffer): Promise<ProjectMemorySize> {
    let pairBytes: number | null = null
    try {
      const other = await readMemoryBytes(join(this.directory(scope), file(document === "team" ? "personal" : "team")))
      if (other !== null) {
        const content = text(other)
        // 不在篇幅统计中迁移另一份；损坏/未迁移文档不影响本份独立保存。
        if (migrateLegacyMemory(content, document === "team" ? "personal" : "team") === undefined) pairBytes = bytes.length + other.length
      }
    } catch { /* 总篇幅未知时明确返回 null，不把另一份故障当当前文件写入失败。 */ }
    return { documentBytes: bytes.length, pairBytes, targetBytes: MEMORY_TARGET_BYTES, overTarget: pairBytes === null ? null : pairBytes > MEMORY_TARGET_BYTES }
  }
  /** 返回完整正文和实际内容版本，空文件不会自动补文。 */
  async read(scope: MemoryScope, document: ProjectMemoryDocument, isCurrent: () => boolean): Promise<ProjectMemoryResult> {
    try {
      return await this.#locked(scope, async () => {
        const bytes = (await this.#prepare(scope, document, isCurrent, true))!
        const size = await this.#size(scope, document, bytes)
        current(isCurrent)
        return { status: "ready", document, content: text(bytes), revision: hash(bytes), size }
      })
    } catch (error) { return failure(document, error) }
  }
  /** 比对内容版本后立即保存；saved 的文件不会因后续取消或失败撤销。 */
  async update(scope: MemoryScope, input: ProjectMemoryInput, isCurrent: () => boolean): Promise<ProjectMemoryResult> {
    const { document } = input
    if (!validMemoryInput(input)) return { status: "error", document, reason: "invalid_arguments", message: "需要有效 document、完整 content 和读取获得的 expectedRevision。" }
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > CONTEXT_REQUEST_BYTES) return { status: "error", document, reason: "request_too_large", message: "序列化参数超过 64 KiB 技术限制，请整理后重试，原件未变。" }
    try {
      return await this.#locked(scope, async () => {
        const bytes = await this.#prepare(scope, document, isCurrent, false)
        if (bytes === null || hash(bytes) !== input.expectedRevision) return conflict(document, bytes)
        const next = Buffer.from(input.content, "utf8")
        if (next.equals(bytes)) return { status: "no_change", document, revision: hash(bytes), size: await this.#size(scope, document, bytes), message: "内容未变化。" }
        const directory = this.directory(scope), path = join(directory, file(document))
        let changed: Buffer | null | undefined
        try {
          await replaceMemoryBytes(path, next, async () => {
            await ensureMemoryDirectory(this.root, directory)
            const latest = await readMemoryBytes(path)
            if (!latest?.equals(bytes)) { changed = latest; throw new MemoryFileError("changed", "文档已变化。") }
            current(isCurrent)
          })
        } catch (error) { if (changed !== undefined) return conflict(document, changed); throw error }
        // rename 已完成即保存事实；篇幅统计或展示失败不得再报告成“没有保存”。
        const size = await this.#size(scope, document, next)
        return { status: "saved", document, revision: hash(next), size, message: `已保存 ${file(document)}。${size.overTarget ? "两份记忆合计超过 8 KiB，建议整理重复内容。" : ""}` }
      })
    } catch (error) { return failure(document, error) }
  }
}
