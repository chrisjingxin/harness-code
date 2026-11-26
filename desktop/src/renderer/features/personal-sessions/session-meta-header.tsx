/**
 * 会话顶部元信息芯片栏（对齐方案 B 原型 `.c4-chat-head` / `.hui-badge`）：
 * 左侧展示当前共享状态（仅本机 / 已停止同步 / Project 可见与档位）；
 * 右侧提供「发布到项目…」与「停止共享」动作入口（个人会话不展示团队切换器）。
 */
import { IconLockFilled } from "@tabler/icons-react"
import type { ReactElement } from "react"
import type { ConversationShareMode } from "@workbench/collaboration-client/types"
import type { LocalConversationShareStatus } from "../../../shared/index.js"

export type SessionMetaHeaderProps = {
  readonly projectName: string | null
  readonly shareStatus: LocalConversationShareStatus
  readonly shareMode: ConversationShareMode | null
  readonly offline: boolean
  readonly hasPublishableTeams: boolean
  /** 会话已归档时额外展示「已归档」徽章。 */
  readonly archived?: boolean
  /** 已归档会话提供「取消归档」入口。 */
  readonly onRestore?: () => void
  readonly onOpenPublish?: () => void
  readonly onOpenStopSharing?: () => void
}

export function SessionMetaHeader({
  projectName,
  shareStatus,
  shareMode,
  offline,
  hasPublishableTeams,
  archived,
  onRestore,
  onOpenPublish,
  onOpenStopSharing,
}: SessionMetaHeaderProps): ReactElement {
  const visibilityLabel = shareStatus === "active"
    ? `项目可见${projectName ? ` · ${projectName}` : ""}（${shareMode === "summary_only" ? "仅共享摘要" : "完整正文"}）`
    : shareStatus === "stopped"
      ? "已停止同步 · 仅本机保留"
      : "仅本机"

  const badgeTone = shareStatus === "active" ? "accent" : shareStatus === "stopped" ? "warn" : "muted"
  const publishDisabled = offline || !hasPublishableTeams
  const publishDisabledTitle = offline
    ? "离线状态暂不可发布到团队项目"
    : !hasPublishableTeams
      ? "当前账号尚未加入可发布的团队或项目"
      : "将当前个人会话发布到团队项目"

  return (
    <div className="psess-chat-head" role="region" aria-label="会话上下文与共享状态">
      <div className="psess-meta-chips">
        <span
          className="hui-badge"
          data-tone={badgeTone}
          data-size="xs"
          title={visibilityLabel}
        >
          {shareStatus === "active"
            ? <span className="hui-lamp" aria-hidden="true" />
            : <IconLockFilled size={12} aria-hidden="true" />}
          <span>{visibilityLabel}</span>
        </span>
        {archived && (
          <span className="hui-badge" data-tone="muted" data-size="xs" title="已归档">
            <span>已归档</span>
          </span>
        )}
      </div>

      <div className="psess-head-actions">
        {archived && onRestore && (
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-xs"
            title="将该会话移出已归档区"
            onClick={onRestore}
          >
            取消归档
          </button>
        )}
        {shareStatus === "active" && onOpenStopSharing && (
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-xs"
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
            className="wb-button wb-button-soft wb-button-xs"
            disabled={publishDisabled}
            title={publishDisabledTitle}
            onClick={onOpenPublish}
          >
            发布到项目…
          </button>
        )}
      </div>
    </div>
  )
}
