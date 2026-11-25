/** 团队知识只读门面：当前身份和实际目录决定自动适用范围，固定正文和真实工具读统计分开。 */
import type { CollaborationState } from "@workbench/collaboration-client";
import type { KnowledgeLevel, KnowledgeListResponse, KnowledgeVersion, KnowledgeQuery } from "@workbench/collaboration-client/types";
import type { MemoryScope } from "./types.js";
import { directoryGitFacts } from "./directory-facts.js";
import type { FixedKnowledgeMaterial } from "../../shared/workbench-context-host.js";
export type KnowledgeScope = MemoryScope & {
  generation: number;
  repositoryIds?: readonly string[];
};
/** 已向当前存活 ACP 会话送达的规约版本快照，用于跨轮增量比对与失效通知。 */
export type DeliveredRuleRecord = {
  readonly knowledgeId: string;
  readonly versionId: string;
  readonly referenceId: string;
  readonly title: string;
  readonly version: number;
};
const id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", reference = new RegExp(`^knowledge:(${id}):(${id})$`, "i");
const keyOf = (s: KnowledgeScope, q: KnowledgeQuery) => JSON.stringify([new URL(s.origin).origin, s.accountId, s.generation, s.workspaceId, q]);
const normalize = (s: string) => s.trim().replace(/\/+$/, "").replace(/\.git$/, "");
export class TeamKnowledge {
  #pages = new Map<string, {
    expires: number;
    value: KnowledgeListResponse;
  }>();
  #pending = new Map<string, Promise<KnowledgeListResponse>>();
  #versions = new Map<string, number>();
  constructor(private readonly identity: Pick<CollaborationState, "applicationWorkspace">, private readonly now = Date.now) { }
  invalidate(workspaceId?: string) { for (const key of new Set([...this.#pages.keys(), ...this.#pending.keys()]))
    if (!workspaceId || JSON.parse(key)[3] === workspaceId) {
      this.#pages.delete(key);
      this.#pending.delete(key);
      this.#versions.set(key, (this.#versions.get(key) ?? 0) + 1);
    } }
  /** 只确认当前已授权目录的实际 Git 身份；其他 MD 工程记录不能扩大本轮范围。 */
  async repositories(scope: KnowledgeScope, path: string): Promise<string[]> { const facts = await directoryGitFacts(path), r = await this.identity.applicationWorkspace(scope.workspaceId, c => c.listRepositories(scope.workspaceId)); if (!r.ok)
    throw new Error(r.error.message); const addresses = [facts.remoteUrl, facts.upstreamUrl].filter((s): s is string => Boolean(s)).map(normalize); const matches = r.value.repositories.filter(x => x.status === "active" && addresses.includes(normalize(x.remoteUrl))); return matches.length === 1 ? [matches[0].repositoryId] : []; }
  async page(scope: KnowledgeScope, query = "", afterId: string | null = null, options: KnowledgeQuery = { scopeMode: "applicable", repositoryIds: [...scope.repositoryIds ?? []] }): Promise<KnowledgeListResponse> {
    const key = keyOf(scope, options), cacheable = !query && !afterId && options.level !== "rule", cached = this.#pages.get(key);
    if (cacheable && cached && cached.expires > this.now())
      return structuredClone(cached.value);
    const load = async () => { const r = await this.identity.applicationWorkspace(scope.workspaceId, c => c.listKnowledge(scope.workspaceId, query, afterId, options)); if (!r.ok)
      throw new Error(r.error.message); return r.value; };
    if (!cacheable)
      return load();
    let pending = this.#pending.get(key);
    if (!pending) {
      const version = this.#versions.get(key) ?? 0;
      pending = load().then(value => { if ((this.#versions.get(key) ?? 0) === version)
        this.#pages.set(key, { expires: this.now() + 60000, value }); return value; }).finally(() => { if (this.#pending.get(key) === pending)
        this.#pending.delete(key); });
      this.#pending.set(key, pending);
    }
    return structuredClone(await pending);
  }
  async list(scope: KnowledgeScope, query = "", afterId: string | null = null, mode: "all" | "applicable" = "applicable", level?: KnowledgeLevel) {
    const page = await this.page(scope, query, afterId, { scopeMode: mode, repositoryIds: [...scope.repositoryIds ?? []], ...(level ? { level } : {}) });
    return { items: page.items.filter(x => !x.archived).map(x => ({ title: x.title, referenceId: `knowledge:${x.knowledgeId}:${x.currentVersionId}`, version: x.version, level: x.level, applicable: x.scope.kind === "workspace" || x.scope.repositoryIds.some(id => scope.repositoryIds?.includes(id)) })), nextAfterId: page.nextAfterId };
  }
  /** 规约整组准备完成后才交给调用者；传入 deliveredRules 时仅拉取新增或改版条目，并输出失效通知。 */
  async rules(scope: KnowledgeScope, provided: ReadonlyMap<string, unknown> = new Map(), deliveredRules?: ReadonlyMap<string, DeliveredRuleRecord>) {
    const materials: FixedKnowledgeMaterial[] = [];
    const activeRules = new Map<string, DeliveredRuleRecord>();
    const seen = new Set<string>();
    let after: string | null = null;
    try {
      do {
        if (after && seen.has(after))
          throw new Error("规约分页游标重复。");
        if (after)
          seen.add(after);
        const page = await this.page(scope, "", after, { level: "rule", scopeMode: "applicable", repositoryIds: [...scope.repositoryIds ?? []], limit: 100 });
        for (const item of page.items) {
          if (item.archived)
            continue;
          const ref = `knowledge:${item.knowledgeId}:${item.currentVersionId}`;
          activeRules.set(item.knowledgeId, {
            knowledgeId: item.knowledgeId,
            versionId: item.currentVersionId,
            referenceId: ref,
            title: item.title,
            version: item.version,
          });
          // 仅对未送达或版本已变更的规约拉取正文；若本轮已被用户手动固定引用，则复用之不重复附带。
          const isUnchanged = deliveredRules?.get(item.knowledgeId)?.versionId === item.currentVersionId;
          if (!isUnchanged && !provided.has(ref))
            materials.push(await this.read(scope, ref));
        }
        after = page.nextAfterId;
      } while (after);
      const isDelta = deliveredRules !== undefined;
      const removed: DeliveredRuleRecord[] = [];
      if (deliveredRules) {
        for (const [knowledgeId, record] of deliveredRules) {
          if (!activeRules.has(knowledgeId))
            removed.push(record);
        }
      }
      const sections: string[] = [];
      if (materials.length > 0) {
        sections.push(isDelta
          ? `<团队规约更新（固定版本，替代先前同名旧版）>\n${JSON.stringify(materials)}\n</团队规约更新>`
          : `<团队规约（固定版本）>\n${JSON.stringify(materials)}\n</团队规约>`);
      }
      if (removed.length > 0) {
        sections.push(`<团队规约失效通知>\n以下先前提供的团队规约已归档或不再适用于当前目录，请停止遵循：${JSON.stringify(removed.map(r => ({ title: r.title, referenceId: r.referenceId })))}\n</团队规约失效通知>`);
      }
      const text = sections.join("\n");
      if (Buffer.byteLength(text, "utf8") > 8192)
        return { materials: [], removed: [], activeRules: new Map<string, DeliveredRuleRecord>(), text: "", status: { code: "RULE_CONTEXT_TOO_LARGE" as const, message: "团队规约未附带：整组超过8 KiB，可精简后重试。" } };
      const message = isDelta
        ? (materials.length || removed.length ? `已准备规约变更：更新${materials.length}条，失效${removed.length}条。` : "适用规约无变化。")
        : (materials.length ? `已完整准备${materials.length}条适用规约。` : "没有需额外附带的适用规约。");
      return { materials, removed, activeRules, text, status: { code: "ready" as const, message } };
    }
    catch (e) {
      return { materials: [], removed: [], activeRules: new Map<string, DeliveredRuleRecord>(), text: "", status: { code: "unavailable" as const, message: `团队规约未附带，可重试：${e instanceof Error ? e.message : "读取失败"}` } };
    }
  }
  async read(scope: KnowledgeScope, referenceId: string) { const m = reference.exec(referenceId); if (!m)
    throw new Error("知识引用格式应为 knowledge:<知识ID>:<版本ID>。"); const r = await this.identity.applicationWorkspace<KnowledgeVersion>(scope.workspaceId, c => c.readKnowledgeVersion(scope.workspaceId, m[1], m[2])); if (!r.ok)
    throw new Error(r.error.message); return { title: r.value.version.title, referenceId, version: r.value.version.version, text: r.value.text }; }
  async reportRead(scope: KnowledgeScope, referenceId: string, readId: string) { const m = reference.exec(referenceId); if (!m)
    throw new Error("固定知识版本无效。"); const r = await this.identity.applicationWorkspace(scope.workspaceId, c => c.reportKnowledgeRead(scope.workspaceId, m[1], m[2], { readId })); if (!r.ok)
    throw new Error(r.error.message); return r.value; }
}
