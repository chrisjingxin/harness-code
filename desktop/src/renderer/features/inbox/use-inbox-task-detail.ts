/**
 * 【功能定义】收件箱右侧主从审阅面板的任务详情按需加载与就地流转 Hook：
 * 选中条目变化 → 请求序隔离拉取 `TaskDetail` → 同签名幂等 `transitionTask` → 冲突自动刷新。
 * 【协作边界】仅经 `CollaborationAppsHost`（现有 IPC 窄端口）读写指定 Workspace/Project 任务，不新增后端或 IPC 接口。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { InboxItem, TaskDetail, TaskStatus } from "@workbench/collaboration-client/types"
import type { CollaborationAppsHost } from "../../../shared/index.js"

function transitionToast(status: TaskStatus): string {
  switch (status) {
    case "doing":
      return "已接收任务，任务进入「进行中」。"
    case "done":
      return "已通过验收，任务已闭环。"
    case "todo":
      return "已退回任务至待接收队列。"
    case "cancelled":
      return "已取消该任务。"
    default:
      return "任务状态已更新。"
  }
}

export function useInboxTaskDetail(options: {
  readonly collaborationApps?: CollaborationAppsHost
  readonly item: InboxItem | null
  readonly online: boolean
  readonly onMutated?: (toastMessage?: string) => void
}) {
  const { collaborationApps, item, online, onMutated } = options
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState("")
  const [note, setNote] = useState("")
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  const seqRef = useRef(0)
  const detailRef = useRef<TaskDetail | null>(null)
  detailRef.current = detail
  const replayRef = useRef<{ signature: string; requestId: string } | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 仅当切换选中的 Inbox 条目时清空用户输入备注与确认态；后台同一条目更新不打断输入。
  useEffect(() => {
    setNote("")
    setActionError("")
    setConfirmingCancel(false)
    replayRef.current = null
  }, [item?.itemKey])

  const workspaceId = item?.workspaceId ?? null
  const projectId = item?.projectId ?? null
  const taskId = item?.sourceType === "task" ? item.objectId : null
  const updatedAtMs = item?.updatedAtMs ?? 0

  useEffect(() => {
    if (!online || !collaborationApps || !workspaceId || !projectId || !taskId) {
      seqRef.current++
      setDetail(null)
      setLoading(false)
      setLoadError("")
      return
    }
    const seq = ++seqRef.current
    const sameTask = detailRef.current?.task.taskId === taskId && detailRef.current?.task.projectId === projectId
    if (!sameTask) setDetail(null)
    setLoading(true)
    setLoadError("")

    void collaborationApps.readTask(workspaceId, projectId, taskId).then(res => {
      if (!mountedRef.current || seqRef.current !== seq) return
      if (!res.ok) {
        if (!sameTask || res.error.code === "RESOURCE_NOT_FOUND") setDetail(null)
        setLoadError(res.error.message)
        return
      }
      if (res.value.task.taskId !== taskId || res.value.task.projectId !== projectId) {
        setLoadError("返回的任务详情与选中条目不匹配。")
        return
      }
      setDetail(res.value)
      setLoadError("")
    }).catch(() => {
      if (mountedRef.current && seqRef.current === seq) {
        setLoadError("无法读取任务详情，请重试。")
      }
    }).finally(() => {
      if (mountedRef.current && seqRef.current === seq) setLoading(false)
    })
  }, [online, collaborationApps, workspaceId, projectId, taskId, updatedAtMs, reloadToken])

  const reload = useCallback(() => {
    setReloadToken(v => v + 1)
  }, [])

  const transition = useCallback(async (targetStatus: TaskStatus, rawNote?: string) => {
    const activeDetail = detailRef.current
    if (!collaborationApps || !workspaceId || !projectId || !taskId || !activeDetail || busy) return
    const trimmedNote = (rawNote ?? note).trim()
    const signature = JSON.stringify([activeDetail.task.taskId, activeDetail.task.version, targetStatus, trimmedNote])
    if (replayRef.current?.signature !== signature) {
      replayRef.current = { signature, requestId: crypto.randomUUID() }
    }
    setBusy(true)
    setActionError("")
    try {
      const res = await collaborationApps.transitionTask(workspaceId, projectId, taskId, {
        targetStatus,
        expectedVersion: activeDetail.task.version,
        requestId: replayRef.current.requestId,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      })
      if (!mountedRef.current) return
      if (!res.ok) {
        if (res.error.code === "VERSION_CONFLICT" || res.error.code === "TASK_STATE_CONFLICT") {
          setActionError("任务状态已被其他人更新，已为你刷新最新详情。")
          setConfirmingCancel(false)
          replayRef.current = null
          setReloadToken(v => v + 1)
          onMutated?.()
        } else {
          setActionError(res.error.message)
        }
        return
      }
      if (res.value.task.taskId !== taskId || res.value.task.projectId !== projectId) {
        setActionError("状态变更结果与当前任务不一致，请刷新重试。")
        return
      }
      setDetail(res.value)
      setNote("")
      setActionError("")
      setConfirmingCancel(false)
      replayRef.current = null
      onMutated?.(transitionToast(targetStatus))
    } catch {
      if (mountedRef.current) setActionError("操作结果待确认，可重试同一操作。")
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [collaborationApps, workspaceId, projectId, taskId, busy, note, onMutated])

  return {
    detail,
    loading,
    loadError,
    busy,
    actionError,
    note,
    setNote,
    confirmingCancel,
    setConfirmingCancel,
    reload,
    transition,
  }
}
