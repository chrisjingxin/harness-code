/**
 * 跨机器只读会话页（涵盖他人会话与本人其他设备会话）。
 *
 * 【功能定义】
 * 默认仅展示简报与元数据；只有用户点击「同步会话」或「同步更新」后才主动拉取历史正文，
 * 并使用只读模式 ConversationView 展示消息与工具摘要；失败时保留已有简报与历史缓存。
 */
import { useState } from "react"
import type { ReactElement } from "react"
import { ConversationView } from "@workbench/ui"
import type {
  ConversationComposerView,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  ConversationTimelineEntry,
  RenderingActions,
} from "@workbench/ui"
import type {
  ProjectConversationSummary,
  SessionExternalHooks,
  SessionKind,
  SessionSyncState,
  SessionSyncStatus,
} from "./contracts.js"
import {
  AlertIcon,
  CheckDoubleIcon,
  ClockIcon,
  GitBranchIcon,
  LinkIcon,
  LockIcon,
  MessageIcon,
  PlusIcon,
  RefreshIcon,
  ShieldCheckIcon,
} from "./icons.js"
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
  readonly deviceName: string
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
  deviceName,
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
  const hasDownloadedMessages = entries.length > 0 || (syncState.localSyncedSequence > 0 && syncStatus !== "unsynced")
  const hasRemoteMessages = conversation.syncedSequence > 0
  const briefUploadedLabel = formatShortTime(conversation.briefUpdatedAtMs || conversation.updatedAt)
  const localSyncedLabel = syncState.lastSyncedAtMs ? formatShortTime(syncState.lastSyncedAtMs) : "—"
  const busy = syncStatus === "syncing"

  return (
    <section
      className="session-center session-remote-readonly"
      aria-label={`${conversation.title || "未命名会话"}（只读）`}
    >
      <header className="session-heading">
        <div>
          <h1>{conversation.title || "未命名会话"}</h1>
          <div className="session-subtitle">
            <span>{ownerName}</span>
            <span>·</span>
            <span>{deviceName}</span>
            <span className="session-tag">
              <LockIcon size={11} />
              <span>{kind === "remote_self" ? "其他设备 · 只读" : "只读"}</span>
            </span>
          </div>
        </div>
        <div className="session-heading-actions">
          {hasDownloadedMessages ? (
            <button
              type="button"
              className="wb-button wb-button-secondary wb-button-small"
              disabled={busy}
              onClick={onSyncConversation}
            >
              <RefreshIcon size={13} />
              <span>{busy ? "正在同步…" : syncStatus === "has_update" ? "同步更新" : "重新同步"}</span>
            </button>
          ) : (
            <button
              type="button"
              className="wb-button wb-button-quiet wb-button-small"
              disabled={busy}
              onClick={onRefreshBrief}
            >
              <RefreshIcon size={13} />
              <span>刷新简报</span>
            </button>
          )}
        </div>
      </header>

      {hasDownloadedMessages ? (
        <>
          <div
            className="session-remote-synced-note"
            data-tone={syncStatus === "sync_failed" ? "danger" : syncStatus === "has_update" ? "warning" : undefined}
            role="status"
          >
            <CheckDoubleIcon size={13} />
            {syncStatus === "sync_failed" ? (
              <span>
                同步失败：{syncState.syncError || "无法拉取最新消息"} · 当前保留已同步至第 {syncState.localSyncedSequence} 条的内容
              </span>
            ) : syncStatus === "has_update" ? (
              <span>
                发现新消息（云端已上传至第 {conversation.syncedSequence} 条，本机已同步至第 {syncState.localSyncedSequence} 条）
              </span>
            ) : (
              <span>
                已同步至 {localSyncedLabel}（第 {syncState.localSyncedSequence} 条）· 当前显示已下载的定稿消息
                {syncState.cacheTruncated ? " · 本机缓存已保留最近片段，点击重新同步可查看最新全量" : ""}
              </span>
            )}
            {syncStatus === "sync_failed" || syncStatus === "has_update" ? (
              <button
                type="button"
                className="wb-button wb-button-secondary wb-button-small session-note-action"
                disabled={busy}
                onClick={onSyncConversation}
              >
                {busy ? "正在同步…" : "立即同步"}
              </button>
            ) : null}
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
            <div className="session-eyebrow">
              <span>会话简报</span>
              <span className="session-tag">
                {conversation.briefSource === "agent" ? "Agent 摘要" : "规则摘要"}
              </span>
            </div>

            <p className={`session-brief-text${conversation.briefText ? "" : " is-empty"}`}>
              {conversation.briefText || "原设备暂未生成会话简报。"}
            </p>

            <div className="session-brief-facts">
              <span>
                <ClockIcon size={13} />
                <span>最近上传于 {briefUploadedLabel}</span>
              </span>
              <span>
                <MessageIcon size={13} />
                <span>
                  {hasRemoteMessages ? `已上传 ${conversation.syncedSequence} 条消息` : "尚未上传正文消息"}
                </span>
              </span>
              {conversation.repositories.map(repo => (
                <span key={repo.repositoryId}>
                  <GitBranchIcon size={13} />
                  <span>{repo.name}</span>
                </span>
              ))}
            </div>

            <div className="session-remote-download">
              <span className="session-download-icon">
                <MessageIcon size={18} />
              </span>
              <div>
                <h2>{hasRemoteMessages ? "正文尚未同步到这台电脑" : "原设备暂未上传消息正文"}</h2>
                <p>
                  {hasRemoteMessages
                    ? "主动同步后，查看已上传的对话和工具摘要。"
                    : "当前只有会话摘要；你可以点击刷新简报确认是否有新消息上传。"}
                </p>
              </div>
              {hasRemoteMessages ? (
                <button
                  type="button"
                  className="wb-button wb-button-primary"
                  disabled={busy}
                  onClick={onSyncConversation}
                >
                  <RefreshIcon size={13} />
                  <span>{busy ? "正在同步…" : "同步会话"}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="wb-button wb-button-secondary"
                  disabled={busy}
                  onClick={onRefreshBrief}
                >
                  <RefreshIcon size={13} />
                  <span>刷新简报</span>
                </button>
              )}
            </div>

            {syncStatus === "sync_failed" && syncState.syncError ? (
              <div className="session-remote-error" role="alert">
                <AlertIcon size={14} />
                <span>同步失败：{syncState.syncError}</span>
              </div>
            ) : null}

            <div className="session-remote-footnote">
              <ShieldCheckIcon size={13} />
              <span>查看会话不会操作对方的 Agent 或文件。</span>
            </div>
          </div>
        </div>
      )}

      {notice ? <p className="session-inline-notice" role="status">{notice}</p> : null}

      <footer className="session-remote-action-bar">
        <span>
          <LockIcon size={13} />
          <span>跨机器会话仅供阅读</span>
        </span>
        <div className="session-remote-actions">
          <button
            type="button"
            className="wb-button wb-button-quiet wb-button-small"
            onClick={() => {
              if (hooks?.onCreateTaskFromConversation) {
                setNotice("")
                hooks.onCreateTaskFromConversation(conversation)
              } else {
                setNotice("创建任务入口将在项目任务模块接入后可用。")
              }
            }}
          >
            <PlusIcon size={13} />
            <span>创建任务</span>
          </button>
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
            <LinkIcon size={13} />
            <span>引用到我的会话</span>
          </button>
        </div>
      </footer>
    </section>
  )
}
