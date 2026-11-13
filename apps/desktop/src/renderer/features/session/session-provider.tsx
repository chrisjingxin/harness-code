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
import type {
  CollaborationContextView,
  ConversationActions,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  RenderingActions,
  WorkbenchRightSlot,
} from "@workbench/ui"
import type { ProjectPage, ProjectPageProvider, ProjectNavigationScope } from "../project-navigation/contracts.js"
import type {
  LocalSessionExecutionPort,
  NewSessionDraft,
  ProjectConversationSummary,
  SessionExternalHooks,
  SessionKind,
  SessionSyncState,
} from "./contracts.js"
import { LocalSessionPage } from "./local-session-page.js"
import { NewSessionPage } from "./new-session-page.js"
import { RemoteSessionPage } from "./remote-session-page.js"
import "./session.css"
import {
  classifyConversation,
  decodeHistoryToTimelineEntries,
  deriveSyncStatus,
  emptySyncState,
  shortDeviceLabel,
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
  readonly localDeviceId: string | null
  readonly localDeviceName?: string
  readonly conversations: readonly ProjectConversationSummary[]
  readonly syncStates: Readonly<Record<string, SessionSyncState>>
  readonly personalStates: Readonly<Record<string, ConversationPersonalState>>
  readonly directories: Readonly<Record<string, string | null>>
  readonly newDraft: NewSessionDraft
  readonly newSessionBusy: boolean
  readonly canCreateConversation: boolean
  readonly createBlockedReason?: string
  readonly newSessionError?: string | null
  readonly execution: LocalSessionExecutionPort
  readonly rendering: RenderingActions
  readonly hooks?: SessionExternalHooks
  resolveOwnerName(userId: string): string
  resolveDeviceName?(deviceId: string): string | undefined
  onChooseNewDirectory(): void
  onNewDraftChange(text: string): void
  onStartNewSession(): void
  onChooseSessionDirectory(conversationId: string): void
  onSyncConversation(conversationId: string): void
  onRefreshBrief(conversationId: string): void
  onPersonalChange(scope: ConversationScope, change: ConversationPersonalChange): void
  onCapabilitySelect?: ConversationActions["onCapabilitySelect"]
  onReferenceAction?: ConversationActions["onReferenceAction"]
  onRequestFileCandidates?: ConversationActions["onRequestFileCandidates"]
  onOpenFile?: ConversationActions["onOpenFile"]
  renderLocalRight?(context: { scope: ProjectNavigationScope; conversation: ProjectConversationSummary; slot: WorkbenchRightSlot }): ReactNode | null
  renderLocalCentral?(context: { scope: ProjectNavigationScope; conversation: ProjectConversationSummary }): ReactNode | null
}

/** 根据实时控制器构造符合 HC-217 协议的会话页面提供者。 */
export function createSessionPageProvider(controller: SessionPageController): ProjectPageProvider {
  const findConversation = (conversationId: string): ProjectConversationSummary | undefined =>
    controller.conversations.find(item => item.conversationId === conversationId)

  const classify = (conversation: ProjectConversationSummary): SessionKind =>
    classifyConversation(conversation, controller.currentUserId, controller.localDeviceId)

  return {
    render({ scope, page, navigator, visible }): ReactElement | null {
      if (page.kind === "new") {
        const avail = controller.execution.getAvailability("__new__")
        return (
          <NewSessionPage
            projectName={controller.projectName}
            draft={controller.newDraft}
            busy={controller.newSessionBusy}
            canCreateConversation={controller.canCreateConversation}
            createBlockedReason={controller.createBlockedReason}
            agentLabel={avail.available ? "Harness · 本机可用" : "Agent 暂不可用 · 仅支持草稿"}
            agentAvailable={avail.available}
            errorMessage={controller.newSessionError}
            onChooseDirectory={controller.onChooseNewDirectory}
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
      const deviceName = shortDeviceLabel(
        conversation.deviceId,
        isLocal ? controller.localDeviceName : controller.resolveDeviceName?.(conversation.deviceId),
        isLocal,
      )
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
            ownerName={ownerName}
            deviceName={deviceName}
            directoryPath={controller.directories[conversation.conversationId] ?? null}
            entries={entries}
            contentRevision={syncState.localSyncedSequence}
            personal={personal}
            execution={controller.execution}
            rendering={controller.rendering}
            hooks={controller.hooks}
            centralOverride={controller.renderLocalCentral?.({ scope, conversation })}
            onChooseDirectory={() => controller.onChooseSessionDirectory(conversation.conversationId)}
            onPersonalChange={controller.onPersonalChange}
            onCapabilitySelect={controller.onCapabilitySelect}
            onReferenceAction={controller.onReferenceAction}
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
          deviceName={deviceName}
          syncStatus={syncStatus}
          syncState={syncState}
          entries={entries}
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
        deviceName: shortDeviceLabel(
          conversation.deviceId,
          isLocal ? controller.localDeviceName : controller.resolveDeviceName?.(conversation.deviceId),
          isLocal,
        ),
        projectName: controller.projectName,
        connection: isLocal ? "本机会话" : "只读简报与主动同步",
      }
    },
  }
}
