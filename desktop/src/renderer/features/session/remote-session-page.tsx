/**
 * 跨机器只读会话页（涵盖他人会话与本人其他设备会话）。
 *
 * 【功能定义】
 * 默认仅展示简报卡片与元数据；只有用户点击「同步会话」或「同步更新」后才主动拉取历史正文，
 * 并使用只读模式 ConversationView 展示消息与工具摘要；失败时保留已有简报与历史缓存。
 */
import { useState } from "react"
import type { ReactElement } from "react"
import { ConversationView } from "../../../ui/index.js"
import type {
  ConversationComposerView,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  ConversationTimelineEntry,
  RenderingActions,
} from "../../../ui/index.js"
import type {
  ProjectConversationSummary,
  SessionExternalHooks,
  SessionKind,
  SessionSyncState,
  SessionSyncStatus,
} from "./contracts.js"
import {
  IconAlertTriangle,
  IconChecks,
  IconClock,
  IconGitBranch,
  IconLink,
  IconLock,
  IconMessage,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
} from "@tabler/icons-react"
import { formatShortTime } from "./session-model.js"

const readonlyComposer: ConversationComposerView = {
  send: { enabled: false, reason: "跨机器会话仅供阅读" },
  cancel: { enabled: false, reason: "跨机器会话仅供阅读" },
  primaryActions: "none",
  commands: [],
  controls: [],
  projectTarget: null,
  references: [],
  attachments: [],
}

export type RemoteSessionPageProps = {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly kind: Exclude<SessionKind, "local">
  readonly conversation: ProjectConversationSummary
  readonly ownerName: string
  readonly syncStatus: SessionSyncStatus
  readonly syncState: SessionSyncState
  readonly entries: readonly ConversationTimelineEntry[]
  readonly contentRevision: number
  readonly personal: ConversationPersonalState
  readonly rendering: RenderingActions
  readonly hooks?: SessionExternalHooks
  readonly onSyncConversation: () => void
  readonly onRefreshBrief: () => void
  readonly onPersonalChange: (scope: ConversationScope, change: ConversationPersonalChange) => void
}

export function RemoteSessionPage({
  scope,
  visible,
  kind,
  conversation,
  ownerName,
  syncStatus,
  syncState,
  entries,
  contentRevision,
  personal,
  rendering,
  hooks,
  onSyncConversation,
  onRefreshBrief,
  onPersonalChange,
}: RemoteSessionPageProps): ReactElement {
  const [notice, setNotice] = useState("")
  const isSummaryOnly = conversation.shareMode === "summary_only"
  const isStopped = conversation.shareStatus === "stopped"
  const hasDownloadedMessages = !isSummaryOnly
    && (entries.length > 0 || (syncState.localSyncedSequence > 0 && syncStatus !== "unsynced"))
  const hasRemoteMessages = !isSummaryOnly && conversation.syncedSequence > 0
  const briefUploadedLabel = formatShortTime(conversation.briefUpdatedAtMs || conversation.updatedAt)
  const localSyncedLabel = syncState.lastSyncedAtMs ? formatShortTime(syncState.lastSyncedAtMs) : "—"
  const busy = syncStatus === "syncing"
  const syncActionLabel = busy
    ? "正在同步…"
    : syncStatus === "has_update"
      ? "同步更新"
      : syncStatus === "sync_failed"
        ? "重试同步"
        : "重新同步"
  const canRefreshAction = !isStopped || (hasRemoteMessages && conversation.syncedSequence > syncState.localSyncedSequence)

  return (
    <section
      className="session-center session-remote-readonly"
      aria-label={`${conversation.title || "未命名会话"}（只读）`}
    >
      {hasDownloadedMessages ? (
        <>
          <div className="session-ro-strip-wrap">
            <div
              className="session-remote-synced-note"
              data-tone={syncStatus === "sync_failed" ? "danger" : (syncStatus === "has_update" || isStopped) ? "warning" : undefined}
              role="status"
            >
              {isStopped ? <IconLock size={13} aria-hidden="true" /> : <IconChecks size={13} aria-hidden="true" />}
              {syncStatus === "sync_failed" ? (
                <span>
                  同步失败：{syncState.syncError || "无法拉取最新消息"} · 当前保留已同步至第 {syncState.localSyncedSequence} 条的内容
                </span>
              ) : isStopped ? (
                <span>
                  已停止同步 · 保留已同步内容（只读，共 {syncState.localSyncedSequence} 条）
                </span>
              ) : syncStatus === "has_update" ? (
                <span>
                  发现新消息（云端第 {conversation.syncedSequence} 条，本机第 {syncState.localSyncedSequence} 条）
                </span>
              ) : (
                <span>
                  只读快照 · 已同步至 {localSyncedLabel}（第 {syncState.localSyncedSequence} 条）
                  {syncState.cacheTruncated ? " · 缓存已截断，点击重新同步可拉取全量" : ""}
                </span>
              )}
              {canRefreshAction && (
                <button
                  type="button"
                  className="wb-button wb-button-secondary wb-button-small session-note-action"
                  disabled={busy}
                  onClick={onSyncConversation}
                >
                  <IconRefresh size={12} aria-hidden="true" />
                  <span>{syncActionLabel}</span>
                </button>
              )}
            </div>
          </div>

          <div className="session-conversation-wrap">
            <ConversationView
              scope={scope}
              visible={visible}
              entries={entries}
              contentRevision={contentRevision}
              composer={readonlyComposer}
              interaction={null}
              personal={personal}
              actions={{ onPersonalChange, rendering }}
            />
          </div>
        </>
      ) : (
        <div className="session-remote-body">
          <div className="session-remote-brief">
            <div className="session-brief-top">
              <div className="session-brief-title-group">
                <h2>
                  {isSummaryOnly
                    ? `${kind === "remote_self" ? "本人其他设备" : ownerName} 的状态与成果摘要`
                    : (kind === "remote_self" ? "本人其他设备的会话简报" : `${ownerName} 的会话简报`)}
                </h2>
                <span className="session-brief-meta">
                  最近上传于 {briefUploadedLabel}
                  {isStopped ? " · 已停止同步" : ""}
                </span>
              </div>
              <span className="wb-status-badge">
                {isSummaryOnly
                  ? (isStopped ? "仅共享摘要 · 已停止同步" : "仅共享状态与成果摘要")
                  : isStopped
                    ? "已停止同步 · 只读"
                    : (conversation.briefSource === "agent" ? "Agent 摘要" : "规则摘要")}
              </span>
            </div>

            <p className={`session-brief-text${conversation.briefText ? "" : " is-empty"}`}>
              {conversation.briefText || "原设备暂未生成会话简报。"}
            </p>

            <div className="session-brief-facts">
              <span>
                <IconClock size={13} aria-hidden="true" />
                <span>最近上传于 {briefUploadedLabel}</span>
              </span>
              <span>
                <IconMessage size={13} aria-hidden="true" />
                <span>
                  {isSummaryOnly
                    ? "仅共享状态与成果摘要（不上传正文）"
                    : hasRemoteMessages
                      ? `已上传 ${conversation.syncedSequence} 条消息`
                      : "尚未上传正文消息"}
                </span>
              </span>
              {conversation.repositories.map(repo => (
                <span key={repo.repositoryId}>
                  <IconGitBranch size={13} aria-hidden="true" />
                  <span>{repo.name}</span>
                </span>
              ))}
            </div>

            <div className="session-brief-foot">
              {isSummaryOnly ? (
                <button
                  type="button"
                  className="wb-button wb-button-secondary"
                  disabled={busy}
                  onClick={onRefreshBrief}
                >
                  <IconRefresh size={13} aria-hidden="true" />
                  <span>刷新摘要</span>
                </button>
              ) : hasRemoteMessages ? (
                <button
                  type="button"
                  className="wb-button wb-button-primary"
                  disabled={busy}
                  onClick={onSyncConversation}
                >
                  <IconRefresh size={13} aria-hidden="true" />
                  <span>{busy ? "正在同步…" : "同步会话"}</span>
                </button>
              ) : !isStopped ? (
                <button
                  type="button"
                  className="wb-button wb-button-secondary"
                  disabled={busy}
                  onClick={onRefreshBrief}
                >
                  <IconRefresh size={13} aria-hidden="true" />
                  <span>刷新简报</span>
                </button>
              ) : null}
              <span className="session-brief-hint">
                {isStopped
                  ? "原作者已停止共享；此处保留停共前已同步的内容供只读查阅。"
                  : isSummaryOnly
                    ? "该会话选择「仅共享状态与成果摘要」发布，团队内只可见简报与状态。"
                    : hasRemoteMessages
                      ? "正文尚未同步到这台电脑 · 同步只拉取对话与工具摘要，不会在对方机器执行任何操作。"
                      : "原设备暂未上传消息正文 · 可点击刷新简报确认是否有新消息上传。"}
              </span>
            </div>

            {syncStatus === "sync_failed" && syncState.syncError ? (
              <div className="session-remote-error" role="alert">
                <IconAlertTriangle size={14} aria-hidden="true" />
                <span>同步失败：{syncState.syncError}</span>
              </div>
            ) : null}
          </div>

          <div className="session-remote-note-card">
            <IconShieldCheck size={14} aria-hidden="true" />
            <span>
              {isSummaryOnly
                ? "仅共享状态与成果摘要：没有输入框，也不能拉取历史正文；可引用此简报或据此创建任务。"
                : "同步之后是只读视图：没有输入框，也不能在这里继续对话。查看会话不会操作对方的 Agent 或文件。"}
            </span>
          </div>
        </div>
      )}

      {notice ? <p className="session-inline-notice" role="status">{notice}</p> : null}

      <footer className="session-remote-action-bar">
        <div className="session-peer-foot-inner">
          <span className="session-ro-hint">
            <IconLock size={13} aria-hidden="true" />
            <span>跨机器会话仅供阅读 · 无输入框</span>
          </span>
          <div className="session-remote-actions">
            <button
              type="button"
              className="wb-button wb-button-secondary wb-button-small"
              onClick={() => {
                if (hooks?.onQuoteConversation) {
                  setNotice("")
                  hooks.onQuoteConversation(conversation)
                } else {
                  setNotice("固定引用入口将在引用模块接入后可用。")
                }
              }}
            >
              <IconLink size={13} aria-hidden="true" />
              <span>引用到我的会话</span>
            </button>
            <button
              type="button"
              className="wb-button wb-button-primary wb-button-small"
              onClick={() => {
                if (hooks?.onCreateTaskFromConversation) {
                  setNotice("")
                  hooks.onCreateTaskFromConversation(conversation)
                } else {
                  setNotice("创建任务入口将在项目任务模块接入后可用。")
                }
              }}
            >
              <IconPlus size={13} aria-hidden="true" />
              <span>创建任务</span>
            </button>
          </div>
        </div>
      </footer>
    </section>
  )
}
