/** 进入看板或收到刷新意图时加载聚合。同范围保留旧内容，迟到的其他项目响应直接丢弃。 */
import { useCallback, useEffect, useState } from "react"
import type { BoardResponse, ProjectUpdatesHost } from "@workbench/contracts"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"

type BoardState = {
  scopeKey: string
  data: BoardResponse | null
  updatedAt: number | null
  busy: boolean
  error: string
}
const blank: BoardState = { scopeKey: "", data: null, updatedAt: null, busy: true, error: "" }

export function useProjectBoard(
  host: ProjectUpdatesHost | undefined,
  scope: ProjectNavigationScope | null,
  visible: boolean,
) {
  const scopeKey = scope ? JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.projectId]) : ""
  const workspaceId = scope?.workspaceId
  const projectId = scope?.projectId
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(previous => previous + 1), [])
  const [state, setState] = useState(blank)

  useEffect(() => {
    if (!host || !workspaceId || !projectId || !visible) return
    let current = true
    setState(previous => ({ ...(previous.scopeKey === scopeKey ? previous : blank), scopeKey, busy: true, error: "" }))
    void host.readBoard(workspaceId, projectId).then(result => {
      if (!current) return
      if (result.ok && result.value.projectId === projectId) {
        setState({ scopeKey, data: result.value, updatedAt: Date.now(), busy: false, error: "" })
        return
      }
      if (!result.ok && ["AUTHENTICATION_REQUIRED", "RESOURCE_NOT_FOUND", "WORKSPACE_MEMBER_REQUIRED"].includes(result.error.code)) {
        setState({ ...blank, scopeKey, busy: false, error: "当前项目看板不可访问。" })
        return
      }
      setState(previous => ({ ...previous, busy: false, error: "无法刷新项目看板，请重试。" }))
    }).catch(() => {
      if (current) setState(previous => ({ ...previous, busy: false, error: "无法刷新项目看板，请重试。" }))
    })
    return () => { current = false }
  }, [host, scopeKey, workspaceId, projectId, visible, version])

  const { data, updatedAt, busy, error } = state.scopeKey === scopeKey ? state : blank
  return { data, updatedAt, busy, error, refresh }
}
