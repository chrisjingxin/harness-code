/**
 * 【功能定义】全局跨团队 Inbox 状态与实时增量校准 Hook：
 * 首次加载 + 筛选拉取 → 订阅 `/api/v1/me/notifications/stream` → 断线重连全量校准 → 不抢焦点静默刷新角标与列表。
 * 【协作边界】仅经 `InboxHost` IPC 访问服务端，离线或未登态下安全降级并保持旧状态可读取。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { InboxBucket, InboxResponse } from "@workbench/collaboration-client/types"
import type { InboxHost, ProjectUpdatesStatus } from "../../../shared/index.js"

export type InboxStreamState = ProjectUpdatesStatus | "offline"

export function useInbox(options: {
  readonly host?: InboxHost
  readonly accountId: string | null
  readonly online: boolean
}) {
  const { host, accountId, online } = options
  const [bucket, setBucket] = useState<InboxBucket>("action_required")
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("")
  const [categoryFilter, setCategoryFilter] = useState<string>("")
  const [data, setData] = useState<InboxResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")
  const [streamStatus, setStreamStatus] = useState<InboxStreamState>(online ? "connecting" : "offline")
  const [streamSeed, setStreamSeed] = useState<{ readonly accountId: string; readonly cursor?: number } | null>(null)

  const reqSeqRef = useRef(0)
  const activeQueryRef = useRef({ bucket, workspaceFilter, categoryFilter, accountId })
  activeQueryRef.current = { bucket, workspaceFilter, categoryFilter, accountId }
  const dataRef = useRef<InboxResponse | null>(data)
  dataRef.current = data
  const onlineRef = useRef(online)
  onlineRef.current = online

  const fetchSnapshot = useCallback(async (mode: "initial" | "silent" = "initial") => {
    if (!host || !accountId || !onlineRef.current) return
    const targetAccountId = accountId
    const snapshot = activeQueryRef.current
    const seedStream = (cursor?: number) => {
      if (activeQueryRef.current.accountId !== targetAccountId || !onlineRef.current) return
      setStreamSeed(prev => prev?.accountId === targetAccountId ? prev : {
        accountId: targetAccountId,
        ...(cursor !== undefined ? { cursor } : {}),
      })
    }
    const seq = ++reqSeqRef.current
    if (mode === "initial" && (!dataRef.current || dataRef.current.bucket !== snapshot.bucket)) {
      setLoading(true)
    } else {
      setRefreshing(true)
    }
    try {
      const result = await host.getInbox({
        bucket: snapshot.bucket,
        ...(snapshot.workspaceFilter ? { workspaceId: snapshot.workspaceFilter } : {}),
        ...(snapshot.categoryFilter ? { category: snapshot.categoryFilter } : {}),
      })
      if (reqSeqRef.current !== seq) {
        if (result.ok) seedStream(result.value.notificationCursor)
        return
      }
      if (!result.ok) {
        setError(result.error.message)
        seedStream()
        return
      }
      setData(result.value)
      setError("")
      seedStream(result.value.notificationCursor)
    } catch {
      if (reqSeqRef.current === seq) {
        setError("暂时无法读取跨团队待办，请稍后重试。")
        seedStream()
      }
    } finally {
      if (reqSeqRef.current === seq) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [host, accountId])

  const refresh = useCallback(() => fetchSnapshot("silent"), [fetchSnapshot])

  useEffect(() => {
    if (!accountId) {
      setData(null)
      setError("")
      setStreamStatus("offline")
      setStreamSeed(null)
      return
    }
    if (!online) {
      setStreamStatus("offline")
      setStreamSeed(null)
      return
    }
    void fetchSnapshot("initial")
  }, [accountId, online, bucket, workspaceFilter, categoryFilter, fetchSnapshot])

  useEffect(() => {
    if (!host || !accountId || !online) {
      setStreamStatus("offline")
      return
    }
    // 等待首轮 getInbox 返回最新 notificationCursor 再建流，避免首次订阅传 undefined 导致从游标 0 重放全量历史。
    if (!streamSeed || streamSeed.accountId !== accountId) {
      setStreamStatus("connecting")
      return
    }
    const subscriptionId = crypto.randomUUID()
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleRefresh = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        if (active) void fetchSnapshot("silent")
      }, 150)
    }

    const stop = host.onNotice(notice => {
      if (!active || notice.subscriptionId !== subscriptionId) return
      if (notice.kind === "status") {
        setStreamStatus(notice.status)
        if (notice.status === "connected") void fetchSnapshot("silent")
        return
      }
      void host.acknowledge(subscriptionId, notice.event.id).catch(() => {})
      if (
        notice.event.type.startsWith("task.")
        || notice.event.type.startsWith("project.")
        || notice.event.type.startsWith("workspace.")
      ) {
        scheduleRefresh()
      }
    })

    setStreamStatus("connecting")
    void host.subscribe(subscriptionId, streamSeed.cursor).then(result => {
      if (active && !result.ok) setStreamStatus("unavailable")
    }).catch(() => {
      if (active) setStreamStatus("unavailable")
    })

    return () => {
      active = false
      if (timer) clearTimeout(timer)
      stop()
      void host.unsubscribe(subscriptionId).catch(() => {})
    }
  }, [host, accountId, online, streamSeed, fetchSnapshot])

  // 若筛选的团队已不再存在于最新团队列表（如刚被移除），自动回退到全部团队。
  useEffect(() => {
    if (!workspaceFilter || !data) return
    if (!data.workspaces.some(w => w.workspaceId === workspaceFilter)) {
      setWorkspaceFilter("")
    }
  }, [workspaceFilter, data])

  return {
    bucket,
    setBucket,
    workspaceFilter,
    setWorkspaceFilter,
    categoryFilter,
    setCategoryFilter,
    data,
    loading,
    refreshing,
    error,
    streamStatus,
    refresh,
  }
}
