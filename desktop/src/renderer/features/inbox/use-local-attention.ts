/**
 * 【功能定义】方案 A 本机等待确认监听 Hook：
 * 订阅本机 ACP 执行通知流，维护纯内存态等待信号，并排除当前正在查看的会话。
 * 【协作边界】严禁向任何云端协作接口上报本机审批/出错状态。
 */
import { useEffect, useMemo, useState } from "react"
import type { DesktopLocalExecutionHost, LocalConversationRecord } from "../../../shared/index.js"
import {
  applyLocalExecutionNoticeToSignals,
  collectLocalAttentionItems,
  type LocalAttentionItem,
  type LocalAttentionSignal,
} from "./inbox-model.js"

export function useLocalAttention(options: {
  readonly localExecution?: DesktopLocalExecutionHost
  readonly accountId: string | null
  readonly personalRecords: readonly LocalConversationRecord[]
  readonly activeViewedConversationId: string | null
  readonly projectNamesById?: Readonly<Record<string, string>>
}): readonly LocalAttentionItem[] {
  const { localExecution, accountId, personalRecords, activeViewedConversationId, projectNamesById } = options
  const [signals, setSignals] = useState<Readonly<Record<string, LocalAttentionSignal>>>({})

  useEffect(() => {
    setSignals({})
    if (!localExecution || !accountId) return
    return localExecution.onNotice(notice => {
      if (notice.scope.accountId !== accountId) return
      setSignals(prev => applyLocalExecutionNoticeToSignals(prev, notice, Date.now()))
    })
  }, [localExecution, accountId])

  return useMemo(
    () => collectLocalAttentionItems({
      signals,
      personalRecords,
      activeViewedConversationId,
      projectNamesById,
    }),
    [signals, personalRecords, activeViewedConversationId, projectNamesById],
  )
}
