/**
 * 新会话准备页（"今天想推进什么？"）。
 *
 * 【功能定义】
 * 让用户在当前 Project 下自选任意本机工作目录（支持普通非 Git 文件夹）、输入待发起的讨论草稿，
 * 并诚实展示当前设备登记与 Agent 可用性；选择目录和输入草稿仅保存在本人本机范围，不自动建会。
 */
import type { ReactElement } from "react"
import { ConversationComposer } from "@workbench/ui"
import type { ConversationComposerView } from "@workbench/ui"
import type { ProjectNavigationScope } from "../project-navigation/index.js"
import { ArrowRightIcon, ChevronDownIcon, FolderIcon } from "./icons.js"
import { directoryBasename } from "./session-model.js"
import { NEW_SESSION_DRAFT_ID } from "./contracts.js"
import type { NewSessionDraft, SessionExternalHooks } from "./contracts.js"
import { newSessionConversationDraft } from "./new-session-draft.js"

export type NewSessionPageProps = {
  readonly scope: ProjectNavigationScope
  readonly visible: boolean
  readonly hooks?: SessionExternalHooks
  readonly projectName: string
  readonly draft: NewSessionDraft
  readonly busy: boolean
  readonly canCreateConversation: boolean
  readonly createBlockedReason?: string
  readonly agentLabel: string
  readonly agentAvailable: boolean
  readonly errorMessage?: string | null
  readonly onChooseDirectory: () => void
  readonly onDraftChange: (text: string, selectionStart?: number, selectionEnd?: number) => void
  readonly onStartSession: () => void
}

export function NewSessionPage({
  scope,
  visible,
  hooks,
  projectName,
  draft,
  busy,
  canCreateConversation,
  createBlockedReason,
  agentLabel,
  agentAvailable,
  errorMessage,
  onChooseDirectory,
  onDraftChange,
  onStartSession,
}: NewSessionPageProps): ReactElement {
  const folderName = directoryBasename(draft.directoryPath)
  const hasPrompt = draft.draftText.trim().length > 0 || draft.referenceIds.length > 0
  const canSubmit = Boolean(draft.directoryPath && hasPrompt && canCreateConversation && !busy)
  const disabledReason = !draft.directoryPath
    ? "请先选择一个本机工作目录"
    : !hasPrompt
      ? "请输入事项或加入引用材料"
      : !canCreateConversation
        ? createBlockedReason ?? "当前尚不能发起新会话"
        : undefined
  const composer: ConversationComposerView = {
    primaryActions: "none", send: { enabled: false }, cancel: { enabled: false },
    commands: [], controls: [], references: hooks?.references ?? [], attachments: [],
    projectTarget: { projectId: scope.projectId, deviceId: scope.accountId },
  }

  return (
    <section className="session-new-page" aria-label="新会话准备">
      <h1>今天想推进什么？</h1>
      <p>在“{projectName}”中创建自己的会话。</p>
      <div className="session-new-controls">
        <button
          type="button"
          className="wb-button wb-button-secondary wb-button-small"
          onClick={onChooseDirectory}
          title={draft.directoryPath ?? "选择一个本机文件夹（支持普通非 Git 目录）"}
        >
          <FolderIcon size={14} />
          <span>{folderName || "选择文件夹"}</span>
          <ChevronDownIcon size={12} />
        </button>
        <span
          className="session-tag"
          data-tone={agentAvailable ? "success" : "warning"}
          title={agentLabel}
        >
          {agentLabel}
        </span>
      </div>
      <div className="session-new-composer">
        <ConversationComposer
          scope={{ ...scope, conversationId: NEW_SESSION_DRAFT_ID }}
          visible={visible}
          model={composer}
          draft={newSessionConversationDraft(draft)}
          actions={{
            onPersonalChange: (_source, change) => {
              if (change.kind === "draft-text") onDraftChange(change.text, change.selectionStart, change.selectionEnd)
            },
            onRequestCollaborationCandidates: hooks?.onRequestCollaborationCandidates,
            onSelectCollaborationCandidate: hooks?.onSelectCollaborationCandidate,
            onReferenceAction: hooks?.onReferenceAction,
          }}
          sendBlocked
          cancelBlocked
          submitOnEnter={false}
          onSend={() => {}}
          onCancel={() => {}}
        >{hooks?.composerExtra}</ConversationComposer>
      </div>
      <div className="session-new-send">
        <span
          className="session-new-status"
          data-tone={errorMessage ? "danger" : undefined}
          role={errorMessage ? "alert" : "status"}
        >
          {errorMessage || (!canCreateConversation ? createBlockedReason : "")}
        </span>
        <button
          type="button"
          className="wb-button wb-button-primary"
          disabled={!canSubmit}
          title={disabledReason}
          onClick={onStartSession}
        >
          <ArrowRightIcon size={14} />
          <span>{busy ? "正在创建…" : "开始会话"}</span>
        </button>
      </div>
      <p className="session-new-note">目录由你选择，可以是普通文件夹。</p>
    </section>
  )
}
