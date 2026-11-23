/**
 * 会话顶部元信息芯片栏（对齐方案 B 原型 `.c4-chat-head` / `sessionMeta`）：
 * 左侧展示当前共享状态（仅本机 / 已停止同步 / Project 可见与档位）；
 * 右侧提供「发布到 Project…」与「停止共享」动作入口（个人会话不展示团队切换器）。
 */
import type { ReactElement } from "react"
import type { ConversationShareMode } from "@workbench/collaboration-client/types"
import type { LocalConversationShareStatus } from "../../../shared/index.js"

export type SessionMetaHeaderProps = {
  readonly projectName: string | null
  readonly shareStatus: LocalConversationShareStatus
  readonly shareMode: ConversationShareMode | null
  readonly offline: boolean
  readonly hasPublishableTeams: boolean
  readonly onOpenPublish?: () => void
  readonly onOpenStopSharing?: () => void
}

export function SessionMetaHeader({
  projectName,
  shareStatus,
  shareMode,
  offline,
  hasPublishableTeams,
  onOpenPublish,
  onOpenStopSharing,
}: SessionMetaHeaderProps): ReactElement {
  const visibilityLabel = shareStatus === "active"
    ? `Project 可见${projectName ? ` · ${projectName}` : ""}（${shareMode === "summary_only" ? "仅共享摘要" : "完整正文"}）`
    : shareStatus === "stopped"
      ? "已停止同步 · 仅本机保留"
      : "仅本机"

  const publishDisabled = offline || !hasPublishableTeams
  const publishDisabledTitle = offline
    ? "离线状态暂不可发布到团队 Project"
    : !hasPublishableTeams
      ? "当前账号尚未加入可发布的团队或项目"
      : "将当前个人会话发布到团队 Project"

  return (
    <div className="psess-chat-head" role="region" aria-label="会话上下文与共享状态">
      <div className="psess-meta-chips">
        <span
          className={`psess-chip${shareStatus === "active" ? " is-shared" : shareStatus === "stopped" ? " is-stopped" : ""}`}
          title={visibilityLabel}
        >
          {visibilityLabel}
        </span>
      </div>

      <div className="psess-head-actions">
        {shareStatus === "active" && onOpenStopSharing && (
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small"
            disabled={offline}
            title={offline ? "离线状态暂不可操作云端停止共享" : "停止同步此会话的新内容"}
            onClick={onOpenStopSharing}
          >
            停止共享
          </button>
        )}
        {shareStatus === "local_only" && onOpenPublish && (
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small"
            disabled={publishDisabled}
            title={publishDisabledTitle}
            onClick={onOpenPublish}
          >
            发布到 Project…
          </button>
        )}
      </div>
    </div>
  )
}
