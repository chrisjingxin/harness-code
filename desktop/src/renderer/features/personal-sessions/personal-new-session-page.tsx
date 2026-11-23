/**
 * 个人空间新建会话准备页（"今天想推进什么？"）：
 * 支持在未入团、断网续用或任意场景下先选本机工程目录、完成冷启动 Agent 预检后直接开聊，
 * 个人会话不暴露团队归属，需要协作时再按需发布到团队 Project。
 */
import type { ReactElement } from "react"
import type { AcpAgentInfo } from "@workbench/acp-runtime/types"
import { ConversationComposer } from "../../../ui/index.js"
import type { ConversationComposerView, RenderingActions } from "../../../ui/index.js"
import { buildDirectoryContextView, handleDirectoryContextAction } from "../session/session-model.js"
import { NEW_SESSION_DRAFT_ID } from "../session/contracts.js"
import { AgentPreflightCard } from "./agent-preflight-card.js"

export type PersonalNewSessionDraft = {
  readonly directoryPath: string | null
  readonly draftText: string
  readonly providerId: string | null
  readonly revision: number
  readonly selectionStart: number
  readonly selectionEnd: number
}

export type PersonalNewSessionPageProps = {
  readonly accountId: string
  readonly visible: boolean
  readonly draft: PersonalNewSessionDraft
  readonly busy: boolean
  readonly errorMessage?: string | null
  readonly providers: readonly AcpAgentInfo[] | undefined
  readonly checkingProviders: boolean
  readonly defaultProviderId: string | null | undefined
  readonly recentDirectories?: readonly string[]
  readonly rendering?: RenderingActions
  readonly onRefreshProviders: () => void
  readonly onOpenSettings?: () => void
  readonly onChooseDirectory: () => void
  readonly onSelectDirectory: (directoryPath: string) => void
  readonly onSelectProvider: (providerId: string) => void
  readonly onDraftChange: (text: string, selectionStart: number, selectionEnd: number) => void
  readonly onStartSession: () => void
}

export function PersonalNewSessionPage({
  accountId,
  visible,
  draft,
  busy,
  errorMessage,
  providers,
  checkingProviders,
  defaultProviderId,
  recentDirectories,
  rendering,
  onRefreshProviders,
  onOpenSettings,
  onChooseDirectory,
  onSelectDirectory,
  onSelectProvider,
  onDraftChange,
  onStartSession,
}: PersonalNewSessionPageProps): ReactElement {
  const hasPrompt = draft.draftText.trim().length > 0
  const canSubmit = Boolean(draft.directoryPath && hasPrompt && !busy)
  const disabledReason = !draft.directoryPath
    ? "请先选择一个本机工作目录"
    : !hasPrompt
      ? "请输入事项开始本机对话"
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

  const selectedProviderId = draft.providerId ?? defaultProviderId ?? providers?.find(p => p.available)?.id ?? providers?.[0]?.id
  const selectedProvider = providers?.find(item => item.id === selectedProviderId)
  const agentAvailable = selectedProvider ? selectedProvider.available : false
  const agentLabel = selectedProvider
    ? (selectedProvider.available
        ? `${selectedProvider.label} · 本机可用`
        : `${selectedProvider.label} · ${selectedProvider.reason ?? "暂不可用"}`)
    : providers === undefined
      ? "正在检测本机 Agent…"
      : "未检测到本机 Agent"

  const controls: ConversationComposerView["controls"] = providers && providers.length > 0
    ? [{
        id: "provider",
        label: "Agent",
        selectedId: selectedProviderId,
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
    send: { enabled: canSubmit, reason: disabledReason ?? "开始个人会话" },
    cancel: { enabled: false },
    commands: [],
    controls,
    references: [],
    attachments: [],
    projectTarget: null,
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
    <section className="session-new-page" aria-label="新建个人会话">
      <h1>今天想推进什么？</h1>
      <p>个人会话优先在本机独立执行与保存；需要协作时随时可发布到 Project。</p>

      <AgentPreflightCard
        providers={providers}
        checking={checkingProviders}
        onRefresh={onRefreshProviders}
        onOpenSettings={onOpenSettings}
      />

      <div className="session-new-composer">
        <ConversationComposer
          scope={{
            namespace: "desktop-personal",
            accountId,
            workspaceId: "__solo__",
            conversationId: NEW_SESSION_DRAFT_ID,
          }}
          visible={visible}
          model={composer}
          draft={{
            text: draft.draftText,
            selectionStart: draft.selectionStart,
            selectionEnd: draft.selectionEnd,
            revision: draft.revision,
            referenceIds: [],
            attachmentIds: [],
          }}
          actions={{
            onPersonalChange: (_source, change) => {
              if (change.kind === "draft-text") {
                onDraftChange(change.text, change.selectionStart, change.selectionEnd)
              }
            },
            onSend: async () => ({ status: "accepted" }),
            onCapabilitySelect: (_source, controlId, itemId) => {
              if (controlId === "provider") onSelectProvider(itemId)
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
          }}
          sendBlocked={busy}
          cancelBlocked
          submitOnEnter={false}
          onSend={() => { if (canSubmit) onStartSession() }}
          onCancel={() => {}}
        >
          <span
            className="session-tag"
            data-tone={agentAvailable ? "success" : "warning"}
            title={agentLabel}
          >
            {agentAvailable ? "本机可用" : agentLabel}
          </span>
        </ConversationComposer>
      </div>

      {errorMessage && (
        <div className="session-new-send">
          <span className="session-new-status" data-tone="danger" role="alert">
            {errorMessage}
          </span>
        </div>
      )}
      <p className="session-new-note">目录由你选择，支持普通非 Git 文件夹；不加入团队或断网时也可直接使用。</p>
    </section>
  )
}
