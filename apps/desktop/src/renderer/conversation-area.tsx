/** 正式窗口的历史、实时连接状态和已迁出的对话视图。 */
import type { ConversationConnection, DesktopHost, ExecutionReasonCode, ExecutionState, ExecutionView } from "@workbench/contracts"
import { ConversationView } from "@workbench/ui"
import type { ConversationActions, ConversationPersonalChange, ConversationPersonalState, ConversationScope } from "@workbench/ui"
import { historyEntries, latestExecution } from "./conversation-history.js"
import type { HistoryView } from "./workspace-conversations.js"
import "@workbench/ui/conversation.css"

const executionLabels: Record<ExecutionState, string> = {
  queued: "已排队", dispatching: "正在派发", accepted: "设备已受理", running: "运行中",
  unknown: "结果待确认", succeeded: "已完成", failed: "失败", cancelled: "已取消", rejected: "未执行",
}
const connectionLabels: Record<ConversationConnection, string> = {
  connecting: "正在连接实时更新", connected: "实时更新已连接",
  reconnecting: "连接中断，正在重连", recovering: "正在补读更新",
}
const reasonLabels: Record<ExecutionReasonCode, string> = {
  WAITING_DEVICE: "等待设备", WAITING_PREVIOUS: "等待前序执行", WAITING_PROJECT: "等待项目",
  WAITING_EXECUTOR: "等待执行器", AUTHOR_UNAVAILABLE: "发起人不可用", PROJECT_NOT_SHARED: "项目未共享",
  SHARE_VERSION_CHANGED: "项目共享状态已变化", DEVICE_REVOKED: "设备已撤销", TARGET_INVALID: "目标不可用",
  PROJECT_ROOT_CHANGED: "项目目录已变化", CAPABILITY_UNAVAILABLE: "执行能力不可用",
  CANCEL_REQUESTED: "已请求取消", DELIVERY_UNCONFIRMED: "送达未确认", DEVICE_DISCONNECTED: "设备已断开",
  RUNNER_STATE_UNKNOWN: "执行器状态未知", NATIVE_SESSION_UNAVAILABLE: "原会话不可用",
  EXECUTION_FAILED: "执行失败", CANCELLED_BEFORE_DISPATCH: "派发前已取消", CANCELLED_BY_RUNNER: "执行器已取消",
}

function executionLabel(execution: ExecutionView): string {
  const parts = [executionLabels[execution.state]]
  if (execution.reasonCode) parts.push(reasonLabels[execution.reasonCode])
  if (execution.state === "unknown") parts.push(`上次确认：${executionLabels[execution.lastConfirmedState]}`)
  if (execution.cancelState === "requested") parts.push("已请求取消")
  if (execution.cancelState === "delivered") parts.push("取消请求已送达")
  return parts.join(" · ")
}

export function ConversationArea({ scope, view, personal, onPersonalChange, refresh, host, visible, projectActions }: {
  scope: ConversationScope | null
  view: HistoryView
  personal: ConversationPersonalState
  onPersonalChange(scope: ConversationScope, change: ConversationPersonalChange): void
  refresh(): void
  host: DesktopHost
  visible: boolean
  projectActions?: Pick<ConversationActions, "onRequestFileCandidates" | "onOpenFile">
}) {
  if (!scope) return <section className="desktop-empty desktop-conversation" aria-label="对话"><h1>对话</h1><p>从左侧选择共享会话。</p></section>
  if (view.phase === "loading") return <section className="desktop-empty desktop-conversation" aria-label="对话">
    <p role="status">{view.pages ? `正在读取历史，已读取 ${view.pages} 页…` : "正在读取会话历史…"}</p>
  </section>
  if (view.phase === "error") return <section className="desktop-empty desktop-conversation" aria-label="对话">
    <p className="error" role="alert">{view.message}</p>
    <button className="wb-button wb-button-secondary" onClick={refresh}>重试历史</button>
  </section>
  if (view.phase !== "ready") return null
  const execution = latestExecution(view.projection)
  const disabled = { enabled: false, reason: "发送和取消尚未接入。" }
  return <div className="desktop-history">
    <div className="desktop-history-toolbar">
      <span role="status">{execution ? `最近执行：${executionLabel(execution)}` : "暂无执行记录"}</span>
      <span role="status">{connectionLabels[view.connection]}</span>
      <button className="wb-button wb-button-secondary wb-button-small" onClick={refresh}>刷新历史</button>
    </div>
    <ConversationView
      scope={scope}
      visible={visible}
      entries={historyEntries(view.projection)}
      contentRevision={view.projection.contentRevision}
      composer={{
        send: disabled,
        cancel: disabled,
        primaryActions: "send",
        statusText: "发送和取消尚未接入。",
        commands: [],
        controls: [],
        projectTarget: { deviceId: view.conversation.deviceId, projectId: view.conversation.projectId },
        references: [],
        attachments: [],
      }}
      interaction={null}
      personal={personal}
      actions={{ onPersonalChange, ...projectActions, rendering: { copyText: host.copyText, openExternal: host.openExternal } }}
    />
  </div>
}
