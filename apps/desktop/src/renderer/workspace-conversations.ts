/** 读取当前工作区会话，以及按固定上界逐页重放已保存历史。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  CollaborationError, ConversationPageCursor, ConversationReadHost, ConversationSummary,
} from "@workbench/contracts"
import type { ConversationScope } from "@workbench/ui"
import type { ListAvailability } from "./list-availability.js"
import type { HistoryProjection } from "./conversation-history.js"
import { ConversationFeed, conversationScopeKey } from "./conversation-feed.js"
import type { HistoryView } from "./conversation-feed.js"
export { conversationScopeKey } from "./conversation-feed.js"
export type { HistoryView } from "./conversation-feed.js"

type ListState = {
  rows: readonly ConversationSummary[]
  nextPage: ConversationPageCursor | null
  availability: ListAvailability
}

function listFailure(error: CollaborationError): ListAvailability {
  if (error.code === "AUTHENTICATION_REQUIRED" || error.code === "RESOURCE_NOT_FOUND" || error.code === "REQUEST_SOURCE_REJECTED") {
    return { state: "denied", message: "当前账号无法读取共享会话。" }
  }
  return { state: "offline", message: error.message }
}

/** 列表的两个导航入口共用同一数据和续页位置。 */
export function useWorkspaceConversations(host: ConversationReadHost, workspaceId: string | null) {
  const [state, setState] = useState<ListState>({ rows: [], nextPage: null, availability: { state: "loading" } })
  const request = useRef(0)

  const load = useCallback(async (cursor: ConversationPageCursor | null) => {
    if (!workspaceId) return
    const version = ++request.current
    setState(previous => ({ ...previous, availability: { state: "loading" } }))
    try {
      const result = await host.listConversations(workspaceId, cursor)
      if (version !== request.current) return
      if (!result.ok) {
        const availability = listFailure(result.error)
        setState(previous => ({
          ...previous,
          rows: availability.state === "denied" ? [] : previous.rows,
          nextPage: availability.state === "denied" ? null : previous.nextPage,
          availability,
        }))
        return
      }
      if (result.value.conversations.some(item => item.workspaceId !== workspaceId)) throw new Error("会话列表范围不一致")
      setState(previous => {
        const rows = cursor ? [...previous.rows] : []
        const known = new Map(rows.map(item => [item.conversationId, item]))
        for (const conversation of result.value.conversations) {
          if (!known.has(conversation.conversationId)) {
            known.set(conversation.conversationId, conversation)
            rows.push(conversation)
          }
        }
        return {
          rows,
          nextPage: result.value.nextPage,
          availability: { state: "ready", hasMore: result.value.nextPage !== null },
        }
      })
    } catch {
      if (version === request.current) setState(previous => ({ ...previous, availability: { state: "offline", message: "无法读取共享会话，请重试。" } }))
    }
  }, [host, workspaceId])

  useEffect(() => {
    void load(null)
    return () => { request.current++ }
  }, [load])

  return {
    ...state,
    refresh: () => { void load(null) },
    loadMore: () => { if (state.nextPage && state.availability.state === "ready") void load(state.nextPage) },
  }
}

/** 已加载投影仅留在窗口内存，选中后确认权限、补历史并接实时更新。 */
export function useConversationHistory(
  host: ConversationReadHost,
  scope: ConversationScope | null,
  cache: Map<string, HistoryProjection>,
  resetSeenRevision: (scope: ConversationScope) => void,
) {
  const [state, setState] = useState<{ key: string | null; view: HistoryView }>({ key: null, view: { phase: "empty" } })
  const [attempt, setAttempt] = useState(0)
  const resetRef = useRef(resetSeenRevision)
  resetRef.current = resetSeenRevision
  const namespace = scope?.namespace
  const accountId = scope?.accountId
  const workspaceId = scope?.workspaceId
  const conversationId = scope?.conversationId
  const visibleKey = scope ? conversationScopeKey(scope) : null

  useEffect(() => {
    if (!namespace || !accountId || !workspaceId || !conversationId) {
      setState({ key: null, view: { phase: "empty" } })
      return
    }
    const current: ConversationScope = { namespace, accountId, workspaceId, conversationId }
    const key = conversationScopeKey(current)
    const feed = new ConversationFeed(host, current, cache, view => setState({ key, view }), value => resetRef.current(value))
    feed.start()
    return () => feed.stop()
  }, [host, namespace, accountId, workspaceId, conversationId, attempt, cache])

  // 会话刚切换而 effect 尚未运行时，不让上一会话的内容出现在新范围。
  const view: HistoryView = state.key === visibleKey ? state.view : visibleKey ? { phase: "loading", pages: 0 } : { phase: "empty" }
  return { view, refresh: () => setAttempt(value => value + 1) }
}
