/**
 * 新会话准备页（"今天想推进什么？"）。
 *
 * 【功能定义】
 * 让用户在当前 Project 下自选任意本机工作目录（支持普通非 Git 文件夹）、输入待发起的讨论草稿，
 * 并诚实展示当前设备登记与 Agent 可用性；选择目录和输入草稿仅保存在本人本机范围，不自动建会。
 */
import type { ReactElement } from "react"
import type { AcpAgentInfo } from "@workbench/acp-runtime/types"
import { BrandMark, ConversationComposer } from "../../../ui/index.js"
import type { ConversationComposerView, RenderingActions } from "../../../ui/index.js"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"
import { buildDirectoryContextView, handleDirectoryContextAction } from "./session-model.js"
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
  readonly providers?: readonly AcpAgentInfo[]
  readonly selectedProviderId?: string
  readonly recentDirectories?: readonly string[]
  readonly rendering?: RenderingActions
  readonly errorMessage?: string | null
  readonly onChooseDirectory: () => void
  readonly onSelectDirectory?: (directoryPath: string) => void
  readonly onSelectProvider?: (providerId: string) => void
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
  providers,
  selectedProviderId,
  recentDirectories,
  rendering,
  errorMessage,
  onChooseDirectory,
  onSelectDirectory,
  onSelectProvider,
  onDraftChange,
  onStartSession,
}: NewSessionPageProps): ReactElement {
  const hasPrompt = draft.draftText.trim().length > 0 || draft.referenceIds.length > 0
  const canSubmit = Boolean(draft.directoryPath && hasPrompt && canCreateConversation && !busy)
  const disabledReason = !draft.directoryPath
    ? "请先选择一个本机工作目录"
    : !hasPrompt
      ? "请输入事项或加入引用材料"
      : !canCreateConversation
        ? createBlockedReason ?? "当前尚不能发起新会话"
        : busy
          ? "创建中…"
          : undefined

  const switchingAvailability = busy
    ? { enabled: false, reason: "正在创建会话…" }
    : { enabled: true }
  const { directory: directoryContext, recentById } = buildDirectoryContextView({
    directoryPath: draft.directoryPath,
    recentDirectories,
    switchingAvailability,
    canCopyPath: Boolean(rendering?.copyText),
  })

  const controls: ConversationComposerView["controls"] = providers && providers.length > 0 && onSelectProvider
    ? [{
        id: "provider",
        label: "Agent",
        selectedId: selectedProviderId ?? providers[0]?.id,
        availability: switchingAvailability,
        items: providers.map(provider => ({
          id: provider.id,
          label: provider.label,
          ...(provider.available ? {} : { description: provider.reason ?? "暂不可用" }),
          availability: provider.available
            ? { enabled: true }
            : { enabled: false, reason: provider.reason ?? "暂不可用" },
        })),
      }]
    : []

  const composer: ConversationComposerView = {
    primaryActions: "send",
    send: { enabled: canSubmit, reason: disabledReason ?? "开始会话" },
    cancel: { enabled: false },
    commands: [],
    controls,
    references: hooks?.references ?? [],
    attachments: [],
    projectTarget: { projectId: scope.projectId, deviceId: scope.accountId },
    contextBar: {
      directory: directoryContext,
    },
    contextMenu: {
      title: "添加上下文",
      tooltip: "添加上下文",
      items: [
        {
          id: "files",
          label: "本机文件",
          icon: "file",
          behavior: "custom",
          availability: { enabled: false, reason: "开始会话后可添加本机文件" },
        },
        {
          id: "folder",
          label: "本机目录",
          icon: "folder",
          behavior: "custom",
          availability: { enabled: false, reason: "开始会话后可添加本机目录" },
        },
        {
          id: "mention",
          label: "提及",
          icon: "mention",
          behavior: "mention",
          badge: "项目协作",
          availability: hooks?.onRequestCollaborationCandidates
            ? switchingAvailability
            : { enabled: false, reason: "协作引用暂不可用" },
        },
        {
          id: "actions",
          label: "命令",
          icon: "action",
          behavior: "command",
          availability: { enabled: false, reason: "开始会话后可使用斜杠命令" },
        },
      ],
    },
  }

  return (
    <section className="session-new-page" aria-label="新会话准备">
      <div className="home-welcome">
        <div className="home-brand-row">
          <span className="home-logo" aria-hidden="true">
            <BrandMark />
          </span>
          <div className="home-heading">
            <h1>今天想推进什么？</h1>
            <span className="hui-badge" data-tone="muted">{projectName}</span>
          </div>
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
              onSend: async () => ({ status: "accepted" }),
              onCapabilitySelect: (_source, controlId, itemId) => {
                if (controlId === "provider") onSelectProvider?.(itemId)
              },
              onDirectoryContextAction: (_source, itemId) => {
                handleDirectoryContextAction({
                  itemId,
                  directoryPath: draft.directoryPath,
                  recentById,
                  onChooseDirectory,
                  onSelectDirectory,
                  onCopyPath: path => { void rendering?.copyText?.(path).catch(() => {}) },
                })
              },
              onRequestCollaborationCandidates: hooks?.onRequestCollaborationCandidates,
              onSelectCollaborationCandidate: hooks?.onSelectCollaborationCandidate,
              onReferenceAction: hooks?.onReferenceAction,
            }}
            sendBlocked={busy}
            cancelBlocked
            submitOnEnter={false}
            placeholder="输入你想推进的事项，输入 @ 引用项目会话或团队知识…"
            onSend={() => { if (canSubmit) onStartSession() }}
            onCancel={() => {}}
          >
            {!agentAvailable && (
              <span
                className="hui-badge"
                data-tone="warn"
                data-size="xs"
                title={agentLabel}
              >
                <span className="hui-lamp" aria-hidden="true" />
                <span>{agentLabel}</span>
              </span>
            )}
            {hooks?.composerExtra}
          </ConversationComposer>
        </div>
        {(errorMessage || (!canCreateConversation && createBlockedReason)) ? (
          <div className="session-new-send">
            <span
              className="session-new-status"
              data-tone={errorMessage ? "danger" : undefined}
              role={errorMessage ? "alert" : "status"}
            >
              {errorMessage || createBlockedReason}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
