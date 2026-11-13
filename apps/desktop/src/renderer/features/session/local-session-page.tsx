/**
 * 本人本机会话页：只服务归属当前账号且在当前设备运行的会话。
 *
 * 【功能定义】
 * 中央复用 @workbench/ui 的 ConversationView 展示消息时间线、工具与输入区；
 * 上方显示本地工作目录切换条与云端共享范围提示；发送与取消严格受控于真实 Agent 执行端口。
 */
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
import { ChevronDownIcon, FolderIcon, LaptopIcon, UsersIcon } from "./icons.js"
import { SessionCentralFilePanels, SessionCentralTabBar } from "./session-center.js"
import type { SessionCentralFilesState } from "./session-center.js"
import { directoryBasename } from "./session-model.js"

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
  readonly onReferenceAction?: ConversationActions["onReferenceAction"]
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
  onReferenceAction,
  onRequestFileCandidates,
  onOpenFile,
}: LocalSessionPageProps): ReactElement {
  const viewingFile = Boolean(centralFiles && centralFiles.activeCentral !== null)
  const availability = execution.getAvailability(conversation.conversationId)
  const folderName = directoryBasename(directoryPath)
  const composer: ConversationComposerView = {
    send: availability.available
      ? { enabled: true }
      : { enabled: false, reason: availability.reason ?? "本机 Agent 与执行链路尚未接入" },
    cancel: availability.available && execution.cancel
      ? { enabled: true }
      : { enabled: false, reason: availability.reason ?? "当前没有可取消的执行" },
    primaryActions: "send",
    statusText: availability.available ? undefined : availability.reason ?? "本机 Agent 与运行链路尚未接入，暂不能发送或取消。",
    commands: [],
    controls: [
      {
        id: "agent",
        label: "Harness",
        selectedId: "default",
        availability: availability.available
          ? { enabled: true }
          : { enabled: false, reason: "等待本机 Agent 接入" },
        items: [{ id: "default", label: availability.available ? "本机 Agent" : "未接入", availability: { enabled: availability.available } }],
      },
    ],
    projectTarget: directoryPath ? { deviceId: conversation.deviceId, projectId: conversation.projectId } : null,
    references: hooks?.references ?? [],
    attachments: [],
  }

  return (
    <section className="session-center" aria-label={conversation.title || "本机会话"}>
      <header className="session-heading">
        <div>
          <h1>{conversation.title || "未命名会话"}</h1>
          <div className="session-subtitle">
            <span>{ownerName}</span>
            <span>·</span>
            <span>{deviceName}</span>
            <span className="session-tag" data-tone="success">
              <LaptopIcon size={11} />
              <span>本机会话</span>
            </span>
          </div>
        </div>
        <div className="session-heading-actions">
          <span
            className="session-tag"
            title="项目成员仅可主动同步已上传的简报与定稿消息；你本机选择的目录不会暴露给他人。"
          >
            <UsersIcon size={12} />
            <span>Project 内共享</span>
          </span>
        </div>
      </header>

      {centralFiles ? <SessionCentralTabBar state={centralFiles} /> : null}

      <div className="session-conversation-wrap" hidden={viewingFile}>
        <ConversationView
          scope={scope}
          visible={visible && !viewingFile}
          entries={entries}
          contentRevision={contentRevision}
          interaction={null}
          personal={personal}
          composer={composer}
          actions={{
            onPersonalChange,
            ...(execution.send
              ? {
                  onSend: async (targetScope, _revision, text, referenceIds, attachmentIds) =>
                    execution.send!({
                      scope: {
                        namespace: targetScope.namespace,
                        accountId: targetScope.accountId,
                        workspaceId: targetScope.workspaceId,
                        projectId: conversation.projectId,
                      },
                      conversationId: conversation.conversationId,
                      directoryPath,
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
            onCapabilitySelect,
            onReferenceAction,
            onRequestFileCandidates,
            onOpenFile,
            rendering,
          }}
          slots={{
            aboveTimeline: (
              <div className="session-directory-row">
                <button
                  type="button"
                  className="session-directory-button"
                  onClick={onChooseDirectory}
                  title={directoryPath ?? "选择一个本机文件夹（支持普通非 Git 目录）"}
                >
                  <FolderIcon size={13} />
                  <span>{folderName ? `工作目录 · ${folderName}` : "选择工作目录"}</span>
                  <ChevronDownIcon size={12} />
                </button>
                <span className="session-tag">本机目录 · 仅当前电脑</span>
              </div>
            ),
            ...(hooks?.composerExtra ? { composer: hooks.composerExtra } : {}),
          }}
        />
      </div>
      {centralFiles ? <SessionCentralFilePanels state={centralFiles} /> : null}
    </section>
  )
}
