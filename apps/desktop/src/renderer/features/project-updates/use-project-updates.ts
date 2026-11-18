/** 在团队外壳接收轻量事件。工作区内切页或切项目只替换当前刷新接点。 */
import { useLayoutEffect, useRef, useState } from "react"
import type { NotificationEvent, ProjectUpdatesHost, ProjectUpdatesStatus } from "@workbench/contracts"

export interface ProjectUpdateTargets {
  readonly projectId: string | null
  readonly isBoardActive?: boolean
  readonly refreshProjectList: () => void
  readonly refreshProjectDetail: () => void
  readonly refreshConversations: () => void
  readonly refreshBoard: () => void
  readonly refreshTasks: (taskIds: readonly string[]) => void
  readonly refreshKnowledge: (knowledgeIds: readonly string[]) => void
}

export function useProjectUpdates(
  host: ProjectUpdatesHost | undefined,
  accountId: string,
  workspaceId: string,
  targets: ProjectUpdateTargets,
): ProjectUpdatesStatus {
  const [status, setStatus] = useState<ProjectUpdatesStatus>("connecting")
  const currentTargets = useRef(targets)
  useLayoutEffect(() => { currentTargets.current = targets }, [targets])

  useLayoutEffect(() => {
    if (!host) { setStatus("unavailable"); return }
    const subscriptionId = crypto.randomUUID()
    let current = true
    let batch: NotificationEvent[] = []
    let timer: ReturnType<typeof setTimeout> | undefined

    function flush() {
      timer = undefined
      const events = batch
      batch = []
      dispatchProjectUpdates(events, currentTargets.current)
    }

    const stop = host.onNotice(notice => {
      if (!current || notice.subscriptionId !== subscriptionId) return
      if (notice.kind === "status") { setStatus(notice.status); return }
      // 按固定窗口合并补发和突发通知。新页面首次加载时也会读取当前元数据。
      batch.push(notice.event)
      timer ??= setTimeout(flush, 120)
      void host.acknowledge(subscriptionId, notice.event.id).catch(() => {})
    })
    setStatus("connecting")
    void host.subscribe(workspaceId, subscriptionId).then(result => {
      if (current && !result.ok) setStatus("unavailable")
    }).catch(() => { if (current) setStatus("unavailable") })
    return () => {
      current = false
      clearTimeout(timer)
      stop()
      void host.unsubscribe(subscriptionId).catch(() => {})
    }
  }, [host, accountId, workspaceId])

  return status
}

/** 只分派读取意图。任务/知识对象 ID 用于刷新相关缓存，固定材料仍由原引用持有。 */
export function dispatchProjectUpdates(events: readonly NotificationEvent[], targets: ProjectUpdateTargets): void {
  let projectList = false
  let projectDetail = false
  let conversations = false
  const tasks = new Set<string>()
  const knowledge = new Set<string>()
  for (const event of events) {
    if (event.type === "knowledge.updated") { knowledge.add(event.objectId); continue }
    if (event.type === "project.member_changed") projectList = true
    if (event.projectId === null || event.projectId !== targets.projectId) continue
    switch (event.type) {
      case "project.member_changed": projectDetail = true; break
      case "conversation.brief_updated": conversations = true; break
      case "task.assigned":
      case "task.changed": tasks.add(event.objectId); break
    }
  }
  if (projectList) targets.refreshProjectList()
  if (projectDetail) targets.refreshProjectDetail()
  if (projectDetail || conversations) targets.refreshConversations()
  if (projectDetail || tasks.size) targets.refreshTasks([...tasks])
  if (targets.isBoardActive !== false && (projectDetail || conversations || tasks.size)) targets.refreshBoard()
  if (knowledge.size) targets.refreshKnowledge([...knowledge])
}
