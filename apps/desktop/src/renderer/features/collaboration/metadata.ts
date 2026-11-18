/** 任务和知识的分页与轻量刷新。通知只更新对应范围的元数据读取代次。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CollaborationResult, KnowledgeSummary } from "@workbench/contracts"
import type { CollaborationAppsHost } from "../../../collaboration-apps-host.js"
import type { ProjectNavigationScope } from "../project-navigation/index.js"

export async function readPages<Page extends { nextAfterId: string | null }, Item>(
  load: (afterId: string | null) => Promise<CollaborationResult<Page>>,
  itemsOf: (page: Page) => readonly Item[],
  isCurrent: () => boolean = () => true,
): Promise<Item[]> {
  const items: Item[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const result = await load(cursor)
    if (!isCurrent()) return []
    if (!result.ok) throw new Error(result.error.message)
    items.push(...itemsOf(result.value))
    cursor = result.value.nextAfterId
    if (cursor && seen.has(cursor)) throw new Error("分页位置重复，请刷新后重试。")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return items
}

export type KnowledgeMetadataScope = Pick<ProjectNavigationScope, "namespace" | "accountId" | "workspaceId">

/** 外壳搜索与数量只读知识摘要，不为后台导航加载正文。 */
export function useTeamKnowledgeMetadata(host: CollaborationAppsHost | undefined, scope: ProjectNavigationScope | null, revision: number) {
  type Rows = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; items: readonly KnowledgeSummary[] }
  const [state, setState] = useState<{ scope: ProjectNavigationScope; rows: Rows }>()
  useEffect(() => {
    if (!host || !scope) return
    let current = true
    void readPages(afterId => host.listKnowledge(scope.workspaceId, "", afterId), page => page.items, () => current)
      .then(items => {
        if (current) setState({ scope, rows: { status: "ready", items: items.filter(item => !item.archived) } })
      }).catch(error => {
        if (current) setState({ scope, rows: { status: "error", message: error instanceof Error ? error.message : "无法读取知识列表。" } })
      })
    return () => { current = false }
  }, [host, scope, revision])
  return scope && state?.scope === scope ? state.rows : { status: "loading" as const }
}

/** HC-220 可按通知目标请求刷新列表元数据，页面正文和固定引用仍按各自的读取入口加载。 */
export function useCollaborationMetadata(scope: ProjectNavigationScope | null) {
  const [taskRevision, bumpTask] = useState(0)
  const [knowledgeRevision, bumpKnowledge] = useState(0)
  const active = useRef(scope)
  useLayoutEffect(() => {
    active.current = scope
    return () => { active.current = null }
  }, [scope])

  const matchesTeam = (target: KnowledgeMetadataScope) => {
    const current = active.current
    return current && current.namespace === target.namespace && current.accountId === target.accountId && current.workspaceId === target.workspaceId
  }
  const refreshTaskMetadata = useCallback((target: ProjectNavigationScope) => {
    if (matchesTeam(target) && active.current?.projectId === target.projectId) bumpTask(revision => revision + 1)
  }, [])
  const refreshKnowledgeMetadata = useCallback((target: KnowledgeMetadataScope) => {
    if (matchesTeam(target)) bumpKnowledge(revision => revision + 1)
  }, [])
  return { taskRevision, knowledgeRevision, refreshTaskMetadata, refreshKnowledgeMetadata }
}
