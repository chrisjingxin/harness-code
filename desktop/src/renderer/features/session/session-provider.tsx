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
import type { PersonalDraftImage } from "../../../shared/index.js"
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
import { LocalSessionPage } from "./local-session-page.js"
import type { SessionCentralFilesState } from "./session-center.js"
import type { LocalDirectoryGitSummary } from "./use-local-directory.js"
import { NewSessionPage } from "./new-session-page.js"
import { RemoteSessionPage } from "./remote-session-page.js"
import "./session.css"
import {
  EMPTY_PERSONAL_STATE,
  applyConversationPersonalChange,
  classifyConversation,
  decodeHistoryToTimelineEntries,
  deriveSyncStatus,
  emptySyncState,
} from "./session-model.js"

export { EMPTY_PERSONAL_STATE, applyConversationPersonalChange }

export type SessionPageController = {
  readonly projectName: string
  readonly currentUserId: string
  readonly conversations: readonly ProjectConversationSummary[]
  readonly syncStates: Readonly<Record<string, SessionSyncState>>
  readonly personalStates: Readonly<Record<string, ConversationPersonalState>>
  readonly sentImagesByConversation?: Readonly<Record<string, Readonly<Record<string, readonly PersonalDraftImage[]>>>>
  readonly directories: Readonly<Record<string, string | null>>
  readonly recentDirectories?: readonly string[]
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
  onSelectNewDirectory?(directoryPath: string): void
  onSelectNewProvider?(providerId: string): void
  onNewDraftChange(text: string, selectionStart?: number, selectionEnd?: number): void
  onStartNewSession(): void
  onChooseSessionDirectory(conversationId: string): void
  onSelectSessionDirectory?(conversationId: string, directoryPath: string): void
  onChooseLocalFiles?(conversationId: string): void
  onChooseLocalDirectories?(conversationId: string): void
  getGitSummary?(conversationId: string): LocalDirectoryGitSummary | null
  onOpenChangesPanel?(conversationId: string): void
  onRefreshGitStatus?(conversationId: string): void
  onSyncConversation(conversationId: string): void
  onRefreshBrief(conversationId: string): void
  onPersonalChange(scope: ConversationScope, change: ConversationPersonalChange): void
  onCapabilitySelect?: ConversationActions["onCapabilitySelect"]
  onRequestFileCandidates?: ConversationActions["onRequestFileCandidates"]
  onOpenFile?: ConversationActions["onOpenFile"]
  renderLocalRight?(context: { scope: ProjectNavigationScope; conversation: ProjectConversationSummary; slot: WorkbenchRightSlot }): ReactNode | null
  getCentralFiles?(context: { scope: ProjectNavigationScope; conversation: ProjectConversationSummary }): SessionCentralFilesState | undefined
  renderSessionHeader?(conversation: ProjectConversationSummary): ReactNode
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
            recentDirectories={controller.recentDirectories}
            rendering={controller.rendering}
            errorMessage={controller.newSessionError}
            onChooseDirectory={controller.onChooseNewDirectory}
            onSelectDirectory={controller.onSelectNewDirectory}
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
      const entries = decodeHistoryToTimelineEntries(
        syncState.messages,
        {
          userId: conversation.ownerUserId,
          displayName: ownerName,
        },
        controller.sentImagesByConversation?.[conversation.conversationId],
      )
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
            headerBar={controller.renderSessionHeader?.(conversation)}
            visible={visible}
            conversation={conversation}
            directoryPath={controller.directories[conversation.conversationId] ?? null}
            recentDirectories={controller.recentDirectories}
            gitSummary={controller.getGitSummary?.(conversation.conversationId) ?? null}
            entries={entries}
            contentRevision={syncState.localSyncedSequence}
            personal={personal}
            execution={controller.execution}
            rendering={controller.rendering}
            hooks={controller.hooks}
            centralFiles={controller.getCentralFiles?.({ scope, conversation })}
            onChooseDirectory={() => controller.onChooseSessionDirectory(conversation.conversationId)}
            onSelectDirectory={controller.onSelectSessionDirectory
              ? path => controller.onSelectSessionDirectory!(conversation.conversationId, path)
              : undefined}
            onChooseLocalFiles={controller.onChooseLocalFiles
              ? () => controller.onChooseLocalFiles!(conversation.conversationId)
              : undefined}
            onChooseLocalDirectories={controller.onChooseLocalDirectories
              ? () => controller.onChooseLocalDirectories!(conversation.conversationId)
              : undefined}
            onOpenChangesPanel={controller.onOpenChangesPanel
              ? () => controller.onOpenChangesPanel!(conversation.conversationId)
              : undefined}
            onRefreshGitStatus={controller.onRefreshGitStatus
              ? () => controller.onRefreshGitStatus!(conversation.conversationId)
              : undefined}
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
      const title = conversation.title

      if (isLocal) {
        const isRunning = Boolean(activeExecution?.activeTurnId)
        return (
          <>
            {crumb}
            <span className="tb-name" title={title}>{title}</span>
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
      const isSummaryOnly = conversation.shareMode === "summary_only"
      const isStopped = conversation.shareStatus === "stopped"
      const stateBadge = isSummaryOnly
        ? <span className="tb-state ro">{isStopped ? "仅共享摘要 · 已停止同步 · 只读" : "仅共享摘要 · 只读"}</span>
        : syncStatus === "syncing"
          ? <span className="tb-state sync"><span className="d" aria-hidden="true" />同步中… · 只读</span>
          : syncStatus === "has_update"
            ? <span className="tb-state sync"><span className="d" aria-hidden="true" />有更新 · 只读</span>
            : syncStatus === "sync_failed"
              ? <span className="tb-state failed"><span className="d" aria-hidden="true" />同步失败 · 只读</span>
              : isStopped
                ? <span className="tb-state ro">已停止同步 · 只读</span>
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
