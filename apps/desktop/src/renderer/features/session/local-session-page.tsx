/**
 * 本人本机会话页：只服务归属当前账号且在当前设备运行的会话。
 *
 * 【功能定义】
 * 中央复用 @workbench/ui 的 ConversationView 展示消息时间线、工具与输入区；
 * 上方显示本地工作目录切换条与云端共享范围提示；发送与取消严格受控于真实 Agent 执行端口。
 */
import { useEffect, useState } from "react"
import type { ReactElement } from "react"
import { ConversationView } from "@workbench/ui"
import type {
  ConversationActions,
  ConversationComposerView,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  ConversationTimelineEntry,
  RenderingActions,
} from "@workbench/ui"
import type { LocalSessionExecutionPort, ProjectConversationSummary, SessionExternalHooks } from "./contracts.js"
import { ChevronDownIcon, FolderIcon } from "./icons.js"
import { SessionCentralFilePanels } from "./session-center.js"
import type { SessionCentralFilesState } from "./session-center.js"
import { directoryBasename, formatShortTime } from "./session-model.js"
import { projectLocalExecution } from "./local-execution-view.js"
import { attachmentUnavailableReason } from "./use-local-execution.js"

export type LocalSessionPageProps = {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly conversation: ProjectConversationSummary
  readonly ownerName: string
  readonly deviceName: string
  readonly directoryPath: string | null
  readonly entries: readonly ConversationTimelineEntry[]
  readonly contentRevision: number
  readonly personal: ConversationPersonalState
  readonly execution: LocalSessionExecutionPort
  readonly rendering: RenderingActions
  readonly hooks?: SessionExternalHooks
  readonly centralFiles?: SessionCentralFilesState
  readonly onChooseDirectory: () => void
  readonly onPersonalChange: (scope: ConversationScope, change: ConversationPersonalChange) => void
  readonly onCapabilitySelect?: ConversationActions["onCapabilitySelect"]
  readonly onRequestFileCandidates?: ConversationActions["onRequestFileCandidates"]
  readonly onOpenFile?: ConversationActions["onOpenFile"]
}

export function LocalSessionPage({
  scope,
  visible,
  conversation,
  ownerName,
  deviceName,
  directoryPath,
  entries,
  contentRevision,
  personal,
  execution,
  rendering,
  hooks,
  centralFiles,
  onChooseDirectory,
  onPersonalChange,
  onCapabilitySelect,
  onRequestFileCandidates,
  onOpenFile,
}: LocalSessionPageProps): ReactElement {
  const viewingFile = Boolean(centralFiles && centralFiles.activeCentral !== null)
  const [pvMax, setPvMax] = useState(false)
  useEffect(() => {
    if (!viewingFile) setPvMax(false)
  }, [viewingFile])
  const availability = execution.getAvailability(conversation.conversationId)
  const hasUnsupportedMaterial = execution.textOnly && personal.draft.attachmentIds.length > 0
  const folderName = directoryBasename(directoryPath)
  const activeExecution = execution.getView?.(conversation.conversationId)
  const canCancel = Boolean(activeExecution?.activeTurnId && execution.cancel)
  const composer: ConversationComposerView = {
    send: hasUnsupportedMaterial
      ? { enabled: false, reason: attachmentUnavailableReason }
      : availability.available
      ? { enabled: true }
      : { enabled: false, reason: availability.reason ?? "本机 Agent 与执行链路尚未接入" },
    cancel: canCancel
      ? { enabled: true }
      : { enabled: false, reason: availability.reason ?? "当前没有可取消的执行" },
    primaryActions: canCancel ? "cancel" : "send",
    statusText: hasUnsupportedMaterial ? attachmentUnavailableReason
      : availability.available ? undefined : availability.reason ?? "本机 Agent 与运行链路尚未接入，暂不能发送或取消。",
    commands: [],
    controls: [
      {
        id: "agent",
        label: execution.textOnly ? "本机 Agent" : "Harness",
        selectedId: "default",
        availability: availability.available
          ? { enabled: true }
          : { enabled: false, reason: availability.reason },
        items: [{ id: "default", label: execution.textOnly || availability.available ? "本机 Agent" : "未接入", availability: { enabled: availability.available } }],
      },
    ],
    projectTarget: directoryPath || hooks?.onRequestCollaborationCandidates
      ? { deviceId: conversation.deviceId, projectId: conversation.projectId }
      : null,
    references: hooks?.references ?? [],
    attachments: [],
  }
  const permission = activeExecution?.permission
  const view = activeExecution
    ? projectLocalExecution({ entries, contentRevision, composer }, activeExecution)
    : { entries, contentRevision, composer }
  const isRunning = Boolean(activeExecution?.activeTurnId)
  const updatedLabel = formatShortTime(conversation.updatedAt)

  return (
    <section className="session-center" aria-label={conversation.title || "本机会话"}>
      <div className={`session-chat-split${viewingFile ? " has-split" : ""}${viewingFile && pvMax ? " is-max" : ""}`}>
        <div className="session-conversation-column">
          <div className="session-head-wrap">
            <header className="session-heading">
              <div className="session-heading-main">
                <h1>{conversation.title || "未命名会话"}</h1>
                <div
                  className="session-subtitle"
                  title={`会话所有者：${ownerName} · Project 内共享（仅同步已上传的简报与定稿消息）`}
                >
                  <span>本机执行 · {deviceName} · 最近更新 {updatedLabel}</span>
                  <button
                    type="button"
                    className="session-directory-button"
                    onClick={onChooseDirectory}
                    title={directoryPath ? `当前工作目录（仅本机可用）：${directoryPath}` : "选择一个本机文件夹（支持普通非 Git 目录）"}
                  >
                    <FolderIcon size={12} />
                    <span>{folderName ? `工作目录 · ${folderName}` : "选择工作目录"}</span>
                    <ChevronDownIcon size={11} />
                  </button>
                </div>
              </div>
              <div className="session-heading-actions">
                <span
                  className={`status-badge session-status-badge${isRunning ? " running is-running" : ""}`}
                  title="项目成员仅可主动同步已上传的简报与定稿消息；你本机选择的目录不会暴露给他人。"
                >
                  {isRunning ? "本机运行中" : "本机空闲"}
                </span>
              </div>
            </header>
          </div>
          <div className="session-conversation-wrap">
            <ConversationView
              {...view}
              entries={hooks?.renderHistoryReferences?.(view.entries) ?? view.entries}
              scope={scope}
              visible={visible && !(viewingFile && pvMax)}
              interaction={permission ? {
                kind: "approval", id: permission.id, title: permission.title, readOnly: false,
                availability: { enabled: true },
                retryRevision: activeExecution?.permissionRetryRevision,
                options: permission.options.map(option => ({
                  id: option.id, label: option.label, tone: option.allows ? "positive" : "negative",
                  behavior: "immediate", feedback: "none", availability: { enabled: true },
                })),
              } : null}
              personal={personal}
              actions={{
                onPersonalChange: (targetScope, change) => {
                  if (!execution.commitsAcceptedDraft || change.kind !== "clear-draft") onPersonalChange(targetScope, change)
                },
                ...(execution.send
                  ? {
                      onSend: async (targetScope, draftRevision, text, referenceIds, attachmentIds) =>
                        execution.send!({
                          scope: {
                            namespace: targetScope.namespace,
                            accountId: targetScope.accountId,
                            workspaceId: targetScope.workspaceId,
                            projectId: conversation.projectId,
                          },
                          conversationId: conversation.conversationId,
                          directoryPath,
                          draftRevision,
                          text,
                          referenceIds,
                          attachmentIds,
                        }),
                    }
                  : {}),
                ...(execution.cancel
                  ? {
                      onCancel: async targetScope =>
                        execution.cancel!(
                          {
                            namespace: targetScope.namespace,
                            accountId: targetScope.accountId,
                            workspaceId: targetScope.workspaceId,
                            projectId: conversation.projectId,
                          },
                          conversation.conversationId,
                        ),
                    }
                  : {}),
                onInteractionSubmit: execution.answerPermission ? async (targetScope, id, answer) => {
                  if (answer.kind !== "approval" || targetScope.conversationId !== scope.conversationId) throw new Error("审批目标已变更。")
                  await execution.answerPermission!(conversation.conversationId, id, answer.optionId)
                } : undefined,
                onCapabilitySelect,
                onReferenceAction: hooks?.onReferenceAction,
                onRequestCollaborationCandidates: hooks?.onRequestCollaborationCandidates,
                onSelectCollaborationCandidate: hooks?.onSelectCollaborationCandidate,
                onRequestFileCandidates,
                onOpenFile,
                rendering,
              }}
              slots={hooks?.composerExtra ? { composer: hooks.composerExtra } : undefined}
            />
          </div>
        </div>
        {centralFiles && viewingFile ? (
          <div className="session-central-file-pane">
            <SessionCentralFilePanels
              state={centralFiles}
              maximized={pvMax}
              onToggleMaximized={() => setPvMax(value => !value)}
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}
