/** 团队知识只读门面：标题页按身份代次缓存，正文始终通过原有权限接口读取固定版本。 */
import type { CollaborationState } from "@workbench/collaboration-client"
import type { KnowledgeListResponse, KnowledgeVersion } from "@workbench/collaboration-client/types"
import type { MemoryScope } from "./types.js"

export type KnowledgeScope = MemoryScope & { generation: number }
export type KnowledgeTitle = { title: string; referenceId: string; version: number; alreadyReferenced?: boolean }
const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const reference = new RegExp(`^knowledge:(${id}):(${id})$`, "i")
const keyOf = (scope: KnowledgeScope) => JSON.stringify([new URL(scope.origin).origin, scope.accountId, scope.generation, scope.workspaceId])

export class TeamKnowledge {
  #pages = new Map<string, { expires: number; value: KnowledgeListResponse }>()
  #pending = new Map<string, Promise<KnowledgeListResponse>>()
  #versions = new Map<string, number>()
  constructor(private readonly identity: Pick<CollaborationState, "applicationWorkspace">, private readonly now = Date.now) {}
  /** 本机保存和现有轻量通知都调用此入口；失效期间的旧请求不能回填缓存。 */
  invalidate(workspaceId?: string): void {
    const keys = new Set([...this.#pages.keys(), ...this.#pending.keys()])
    for (const key of keys) if (!workspaceId || JSON.parse(key)[3] === workspaceId) {
      this.#pages.delete(key)
      this.#pending.delete(key)
      this.#versions.set(key, (this.#versions.get(key) ?? 0) + 1)
    }
  }
  async page(scope: KnowledgeScope, query = "", afterId: string | null = null): Promise<KnowledgeListResponse> {
    const key = keyOf(scope)
    const cached = this.#pages.get(key)
    if (!query && !afterId && cached && cached.expires > this.now()) return structuredClone(cached.value)
    const load = async () => {
      const result = await this.identity.applicationWorkspace(scope.workspaceId, c => c.listKnowledge(scope.workspaceId, query, afterId))
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    if (query || afterId) return load()
    let pending = this.#pending.get(key)
    if (!pending) {
      const version = this.#versions.get(key) ?? 0
      pending = load().then(value => {
        if ((this.#versions.get(key) ?? 0) === version) this.#pages.set(key, { expires: this.now() + 60_000, value })
        return value
      }).finally(() => { if (this.#pending.get(key) === pending) this.#pending.delete(key) })
      this.#pending.set(key, pending)
    }
    return structuredClone(await pending)
  }
  async list(scope: KnowledgeScope, query = "", afterId: string | null = null) {
    const page = await this.page(scope, query, afterId)
    return { items: page.items.filter(item => !item.archived).map(item => ({ title: item.title, referenceId: `knowledge:${item.knowledgeId}:${item.currentVersionId}`, version: item.version })), nextAfterId: page.nextAfterId }
  }
  async directory(scope: KnowledgeScope, referenced: readonly string[] = []) {
    const page = await this.list(scope)
    const items: KnowledgeTitle[] = []
    let hasMore = page.nextAfterId !== null
    for (const item of page.items.sort((a, b) => a.referenceId.localeCompare(b.referenceId))) {
      const next = { ...item, ...(referenced.includes(item.referenceId) ? { alreadyReferenced: true } : {}) }
      if (Buffer.byteLength(JSON.stringify({ items: [...items, next], hasMore: true }), "utf8") > 8 * 1024) { hasMore = true; continue }
      items.push(next)
    }
    return { items, hasMore }
  }
  async read(scope: KnowledgeScope, referenceId: string): Promise<{ title: string; referenceId: string; version: number; text: string }> {
    const match = reference.exec(referenceId)
    if (!match) throw new Error("知识引用格式应为 knowledge:<知识ID>:<版本ID>。")
    const result = await this.identity.applicationWorkspace<KnowledgeVersion>(scope.workspaceId, c => c.readKnowledgeVersion(scope.workspaceId, match[1], match[2]))
    if (!result.ok) throw new Error(result.error.message)
    return { title: result.value.version.title, referenceId, version: result.value.version.version, text: result.value.text }
  }
}
