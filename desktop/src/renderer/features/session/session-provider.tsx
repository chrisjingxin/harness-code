/**
 * 会话页面提供者与个人状态隔离容器。
 *
 * 【功能定义】
 * 实现 HC-217 的 ProjectPageProvider 接口，统一负责：
 * - 新会话准备页 (page.kind === "new")
 * - 本人本机会话页与跨机器只读页 (page.kind === "conversation")
 * 并在不破坏作用域隔离的前提下提供只读态右键栏隐藏、顶栏上下文输出与缺失会话降级展示。
 */
import type { ReactElement, ReactNode } from "react"
import type { UserSummary } from "@workbench/collaboration-client/types"
import type {
  CollaborationContextView,
  ConversationActions,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  RenderingActions,
  WorkbenchRightSlot,
} from "../../../ui/index.js"
import { UserAvatar } from "../collaboration-views/index.js"
import type { ProjectPage, ProjectPageProvider, ProjectNavigationScope } from "../project-navigation/contracts.js"
import type { LocalSessionExecutionPort, NewSessionDraft, ProjectConversationSummary, SessionExternalHooks, SessionKind, SessionSyncState } from "./contracts.js"
import { IconChevronDown, IconFolder } from "@tabler/icons-react"
import { LocalSessionPage } from "./local-session-page.js"
import type { SessionCentralFilesState } from "./session-center.js"
import { NewSessionPage } from "./new-session-page.js"
import { RemoteSessionPage } from "./remote-session-page.js"
import "./session.css"
import {
  classifyConversation,
  decodeHistoryToTimelineEntries,
  deriveSyncStatus,
  directoryBasename,
  emptySyncState,
  resolveConversationTitle,
} from "./session-model.js"

export const EMPTY_PERSONAL_STATE: ConversationPersonalState = {
  scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
  expandedTools: [],
  expandedOutputs: [],
  draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
  interactions: {},
}

export function applyConversationPersonalChange(
  previous: ConversationPersonalState,
  change: ConversationPersonalChange,
): ConversationPersonalState {
  switch (change.kind) {
    case "scroll":
      return { ...previous, scroll: change.value }
    case "tool":
      return {
        ...previous,
        expandedTools: change.expanded
          ? (previous.expandedTools.includes(change.entryId) ? previous.expandedTools : [...previous.expandedTools, change.entryId])
          : previous.expandedTools.filter(id => id !== change.entryId),
      }
    case "output":
      return {
        ...previous,
        expandedOutputs: change.expanded
          ? (previous.expandedOutputs.includes(change.entryId) ? previous.expandedOutputs : [...previous.expandedOutputs, change.entryId])
          : previous.expandedOutputs.filter(id => id !== change.entryId),
      }
    case "draft-text":
      return {
        ...previous,
        draft: {
          ...previous.draft,
          text: change.text,
          selectionStart: change.selectionStart,
          selectionEnd: change.selectionEnd,
          revision: previous.draft.revision + 1,
        },
      }
    case "draft-references":
      return {
        ...previous,
        draft: { ...previous.draft, referenceIds: [...change.referenceIds], revision: previous.draft.revision + 1 },
      }
    case "draft-attachments":
      return {
        ...previous,
        draft: { ...previous.draft, attachmentIds: [...change.attachmentIds], revision: previous.draft.revision + 1 },
      }
    case "clear-draft":
      if (previous.draft.revision !== change.expectedRevision) return previous
      return {
        ...previous,
        draft: { ...EMPTY_PERSONAL_STATE.draft, revision: previous.draft.revision + 1 },
      }
    case "interaction": {
      const nextInteractions = { ...previous.interactions }
      if (change.answer === null) delete nextInteractions[change.interactionId]
      else nextInteractions[change.interactionId] = change.answer
      return { ...previous, interactions: nextInteractions }
    }
  }
}

export type SessionPageController = {
  readonly projectName: string
  readonly currentUserId: string
  readonly conversations: readonly ProjectConversationSummary[]
  readonly syncStates: Readonly<Record<string, SessionSyncState>>
  readonly personalStates: Readonly<Record<string, ConversationPersonalState>>
  readonly directories: Readonly<Record<string, string | null>>
  readonly newDraft: NewSessionDraft
  readonly newSessionBusy: boolean
  readonly canCreateConversation: boolean
  readonly createBlockedReason?: string
  readonly newSessionError?: string | null
  readonly newProviderId?: string | null
  readonly execution: LocalSessionExecutionPort
  readonly rendering: RenderingActions
  readonly hooks?: SessionExternalHooks
  /** 可选：根据成员 ID 返回头像与工号等资料，供跨机只读会话顶栏展示队友头像。 */
  resolveOwner?(userId: string): Pick<UserSummary, "userNo" | "userName" | "photo"> | undefined
  resolveOwnerName(userId: string): string
  onChooseNewDirectory(): void
  onSelectNewProvider?(providerId: string): void
  onNewDraftChange(text: string, selectionStart?: number, selectionEnd?: number): void
  onStartNewSession(): void
  onChooseSessionDirectory(conversationId: string): void
  onSyncConversation(conversationId: string): void
  onRefreshBrief(conversationId: string): void
  onPersonalChange(scope: ConversationScope, change: ConversationPersonalChange): void
  onCapabilitySelect?: ConversationActions["onCapabilitySelect"]
  onRequestFileCandidates?: ConversationActions["onRequestFileCandidates"]
  onOpenFile?: ConversationActions["onOpenFile"]
  renderLocalRight?(context: { scope: ProjectNavigationScope; conversation: ProjectConversationSummary; slot: WorkbenchRightSlot }): ReactNode | null
  getCentralFiles?(context: { scope: ProjectNavigationScope; conversation: ProjectConversationSummary }): SessionCentralFilesState | undefined
}

/** 根据实时控制器构造符合 HC-217 协议的会话页面提供者。 */
export function createSessionPageProvider(controller: SessionPageController): ProjectPageProvider {
  const findConversation = (conversationId: string): ProjectConversationSummary | undefined =>
    controller.conversations.find(item => item.conversationId === conversationId)

  const classify = (conversation: ProjectConversationSummary): SessionKind =>
    classifyConversation(conversation, controller.currentUserId)

  return {
    render({ scope, page, navigator, visible }): ReactElement | null {
      if (page.kind === "new") {
        const avail = controller.execution.getAvailability("__new__")
        const providerList = controller.execution.getProviders?.()
        const selectedProviderId = controller.newProviderId ?? providerList?.defaultProviderId ?? undefined
        const selectedProvider = providerList?.providers.find(item => item.id === selectedProviderId)
        const agentAvailable = selectedProvider ? selectedProvider.available : avail.available
        const agentLabel = selectedProvider
          ? (selectedProvider.available
              ? `${selectedProvider.label} · 本机可用`
              : `${selectedProvider.label} · ${selectedProvider.reason ?? "暂不可用"}`)
          : avail.available
            ? "Harness · 本机可用"
            : controller.execution.textOnly
              ? avail.reason ?? "创建后确认本机 Agent"
              : "Agent 暂不可用 · 仅支持草稿"
        return (
          <NewSessionPage
            scope={scope}
            visible={visible}
            hooks={controller.hooks}
            projectName={controller.projectName}
            draft={controller.newDraft}
            busy={controller.newSessionBusy}
            canCreateConversation={controller.canCreateConversation}
            createBlockedReason={controller.createBlockedReason}
            agentLabel={agentLabel}
            agentAvailable={agentAvailable}
            providers={providerList?.providers}
            selectedProviderId={selectedProviderId}
            errorMessage={controller.newSessionError}
            onChooseDirectory={controller.onChooseNewDirectory}
            onSelectProvider={controller.onSelectNewProvider}
            onDraftChange={controller.onNewDraftChange}
            onStartSession={controller.onStartNewSession}
          />
        )
      }

      if (page.kind !== "conversation") return null

      const conversation = findConversation(page.conversationId)
      if (!conversation) {
        return (
          <section className="session-center" aria-label="会话不可用">
            <div className="session-new-page">
              <h1>会话暂不可用</h1>
              <p>该会话可能已不在当前项目中，或当前列表尚未加载完成。</p>
              <button
                type="button"
                className="wb-button wb-button-secondary"
                onClick={() => navigator.openPage({ kind: "new" })}
              >
                返回新会话准备页
              </button>
            </div>
          </section>
        )
      }

      const kind = classify(conversation)
      const ownerName = controller.resolveOwnerName(conversation.ownerUserId)
      const isLocal = kind === "local"
      const syncState = controller.syncStates[conversation.conversationId] ?? emptySyncState()
      const syncStatus = deriveSyncStatus({
        kind,
        remoteSyncedSequence: conversation.syncedSequence,
        localSyncedSequence: syncState.localSyncedSequence,
        syncing: syncState.syncing,
        syncError: syncState.syncError,
      })
      const entries = decodeHistoryToTimelineEntries(syncState.messages, {
        userId: conversation.ownerUserId,
        displayName: ownerName,
      })
      const convScope: ConversationScope = {
        namespace: scope.namespace,
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        conversationId: conversation.conversationId,
      }
      const personal = controller.personalStates[conversation.conversationId] ?? EMPTY_PERSONAL_STATE

      if (isLocal) {
        return (
          <LocalSessionPage
            scope={convScope}
            visible={visible}
            conversation={conversation}
            directoryPath={controller.directories[conversation.conversationId] ?? null}
            entries={entries}
            contentRevision={syncState.localSyncedSequence}
            personal={personal}
            execution={controller.execution}
            rendering={controller.rendering}
            hooks={controller.hooks}
            centralFiles={controller.getCentralFiles?.({ scope, conversation })}
            onChooseDirectory={() => controller.onChooseSessionDirectory(conversation.conversationId)}
            onPersonalChange={controller.onPersonalChange}
            onCapabilitySelect={controller.onCapabilitySelect}
            onRequestFileCandidates={controller.onRequestFileCandidates}
            onOpenFile={controller.onOpenFile}
          />
        )
      }

      return (
        <RemoteSessionPage
          scope={convScope}
          visible={visible}
          kind={kind}
          conversation={conversation}
          ownerName={ownerName}
          syncStatus={syncStatus}
          syncState={syncState}
          entries={controller.hooks?.renderHistoryReferences?.(entries) ?? entries}
          contentRevision={syncState.localSyncedSequence}
          personal={personal}
          rendering={controller.rendering}
          hooks={controller.hooks}
          onSyncConversation={() => controller.onSyncConversation(conversation.conversationId)}
          onRefreshBrief={() => controller.onRefreshBrief(conversation.conversationId)}
          onPersonalChange={controller.onPersonalChange}
        />
      )
    },

    right({ scope, page, slot }) {
      if (page.kind !== "conversation") return null
      const conversation = findConversation(page.conversationId)
      if (!conversation) return null
      // 跨机器会话（含本人其他设备）一律禁止挂载实时文件面板。
      if (classify(conversation) !== "local") return null
      return controller.renderLocalRight?.({ scope, conversation, slot }) ?? null
    },

    headerTitle({ page, leftCollapsed }): ReactElement | null {
      const crumb = leftCollapsed && controller.projectName ? (
        <span className="tb-crumb">
          <span className="tb-crumb-name">{controller.projectName}</span>
          <span className="tb-crumb-sep" aria-hidden="true">/</span>
        </span>
      ) : null

      if (page.kind === "new") {
        return (
          <>
            {crumb}
            <span className="tb-name">新建会话</span>
            <span className="tb-count">本机执行</span>
          </>
        )
      }

      if (page.kind !== "conversation") return null

      const conversation = findConversation(page.conversationId)
      if (!conversation) {
        return (
          <>
            {crumb}
            <span className="tb-name">{controller.projectName || "会话不可用"}</span>
          </>
        )
      }

      const kind = classify(conversation)
      const isLocal = kind === "local"
      const activeExecution = isLocal ? controller.execution.getView?.(conversation.conversationId) : undefined
      const title = resolveConversationTitle(conversation.title, activeExecution?.sessionState?.sessionTitle)

      if (isLocal) {
        const directoryPath = controller.directories[conversation.conversationId] ?? null
        const folderName = directoryBasename(directoryPath)
        const availability = controller.execution.getAvailability(conversation.conversationId)
        const directoryStatus = availability.directoryStatus
        const directoryStatusLabel = directoryPath
          ? (directoryStatus === "checking" ? "检查中"
            : directoryStatus === "confirmation-required" ? "待确认"
              : directoryStatus === "invalid" ? "已失效"
                : directoryStatus === "unavailable" ? "待检查" : "")
          : ""
        const isRunning = Boolean(activeExecution?.activeTurnId)
        return (
          <>
            {crumb}
            <span className="tb-name" title={title}>{title}</span>
            <button
              type="button"
              className="tb-dir session-directory-button"
              title={directoryPath ? [directoryPath, directoryStatusLabel ? availability.reason : undefined].filter(Boolean).join("\n") : "选择一个本机文件夹（支持普通非 Git 目录）"}
              onClick={() => controller.onChooseSessionDirectory(conversation.conversationId)}
            >
              <IconFolder size={12} aria-hidden="true" />
              <span className="d">{folderName ? `${folderName}${directoryStatusLabel ? ` · ${directoryStatusLabel}` : ""}` : "选择工作目录"}</span>
              <span className="chev" aria-hidden="true"><IconChevronDown size={11} aria-hidden="true" /></span>
            </button>
            {isRunning ? (
              <span className="tb-state running">
                <span className="d" aria-hidden="true" />
                运行中
              </span>
            ) : null}
          </>
        )
      }

      const owner = controller.resolveOwner?.(conversation.ownerUserId)
      const ownerName = controller.resolveOwnerName(conversation.ownerUserId)
      const syncState = controller.syncStates[conversation.conversationId] ?? emptySyncState()
      const syncStatus = deriveSyncStatus({
        kind,
        remoteSyncedSequence: conversation.syncedSequence,
        localSyncedSequence: syncState.localSyncedSequence,
        syncing: syncState.syncing,
        syncError: syncState.syncError,
      })
      const hasDownloadedMessages = syncState.messages.length > 0 || (syncState.localSyncedSequence > 0 && syncStatus !== "unsynced")
      const stateBadge = syncStatus === "syncing"
        ? <span className="tb-state sync"><span className="d" aria-hidden="true" />同步中… · 只读</span>
        : syncStatus === "has_update"
          ? <span className="tb-state sync"><span className="d" aria-hidden="true" />有更新 · 只读</span>
          : syncStatus === "sync_failed"
            ? <span className="tb-state failed"><span className="d" aria-hidden="true" />同步失败 · 只读</span>
            : hasDownloadedMessages
              ? <span className="tb-state ro">已同步 · 只读</span>
              : <span className="tb-state sync"><span className="d" aria-hidden="true" />未同步 · 只读</span>

      return (
        <>
          {kind === "remote_other" ? (
            <span className="tb-peer">
              <UserAvatar user={owner ? { ...owner, userName: owner.userName || ownerName } : { userName: ownerName }} name={ownerName} size={20} />
              <span className="tb-peer-name">{ownerName}</span>
            </span>
          ) : (
            <>
              {crumb}
              <span className="tb-peer-name">本人其他设备</span>
            </>
          )}
          <span className="tb-dot-sep" aria-hidden="true">·</span>
          <span className="tb-name" title={title}>{title}</span>
          {stateBadge}
        </>
      )
    },

    context({ page }): CollaborationContextView | null {
      if (page.kind === "new") {
        return {
          title: "新会话",
          projectName: controller.projectName,
          connection: "选择目录并准备讨论",
        }
      }
      if (page.kind !== "conversation") return null
      const conversation = findConversation(page.conversationId)
      if (!conversation) return null
      const kind = classify(conversation)
      const isLocal = kind === "local"
      return {
        title: conversation.title || "未命名会话",
        deviceName: isLocal ? "本机" : "只读共享",
        projectName: controller.projectName,
        connection: isLocal ? "本机会话" : "只读简报与主动同步",
      }
    },
  }
}
