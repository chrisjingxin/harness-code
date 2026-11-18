/**
 * 本人本机会话页：只服务归属当前账号且在当前设备运行的会话。
 *
 * 1. 功能定义：中央复用 `@workbench/ui` 的 `ConversationView` 展示时间线、工具、交互表单与输入区；
 *    实时消费多代理列表、ACP 会话能力（模式/配置/斜杠命令/执行计划/上下文用量/回退提示）与文件分栏。
 * 2. 协作边界：调用 `contracts.ts` 的 `LocalSessionExecutionPort`、`local-execution-view.ts` 的投影与能力构造函数，
 *    以及 `elicitation-form.ts` 的通用表单映射器；不得直接调用 Node/Electron 或改动公共 `@workbench/ui`。
 */
import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"
import { ConversationToolBlocks, ConversationView, Markdown } from "@workbench/ui"
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
import { toConversationInteraction, toElicitationAnswer } from "./elicitation-form.js"
import { SessionCentralFilePanels } from "./session-center.js"
import type { SessionCentralFilesState } from "./session-center.js"
import {
  buildComposerCapabilities,
  describePermissionRequest,
  projectLocalExecution,
} from "./local-execution-view.js"
import { attachmentUnavailableReason } from "./use-local-execution.js"
import { resolveSessionFileReference } from "./session-file-reference.js"

export type LocalSessionPageProps = {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly conversation: ProjectConversationSummary
  readonly directoryPath: string | null
  readonly entries: readonly ConversationTimelineEntry[]
  readonly contentRevision: number
  readonly personal: ConversationPersonalState
  readonly execution: LocalSessionExecutionPort
  readonly rendering: RenderingActions
  readonly hooks?: SessionExternalHooks
  readonly centralFiles?: SessionCentralFilesState
  readonly onPersonalChange: (scope: ConversationScope, change: ConversationPersonalChange) => void
  readonly onCapabilitySelect?: ConversationActions["onCapabilitySelect"]
  readonly onRequestFileCandidates?: ConversationActions["onRequestFileCandidates"]
  readonly onOpenFile?: ConversationActions["onOpenFile"]
}

const PLAN_PRIORITY_LABEL = {
  high: "高",
  medium: "中",
  low: "低",
} as const

export function LocalSessionPage({
  scope,
  visible,
  conversation,
  directoryPath,
  entries,
  contentRevision,
  personal,
  execution,
  rendering,
  hooks,
  centralFiles,
  onPersonalChange,
  onCapabilitySelect,
  onRequestFileCandidates,
  onOpenFile,
}: LocalSessionPageProps): ReactElement {
  const viewingFile = Boolean(centralFiles && centralFiles.activeCentral !== null)
  const [pvMax, setPvMax] = useState(false)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  const [dismissedRestoreKey, setDismissedRestoreKey] = useState<string | null>(null)
  const [capabilityError, setCapabilityError] = useState<string | null>(null)

  useEffect(() => {
    if (!viewingFile) setPvMax(false)
  }, [viewingFile])

  useEffect(() => {
    setCapabilityError(null)
  }, [conversation.conversationId])

  const availability = execution.getAvailability(conversation.conversationId)
  const hasUnsupportedMaterial = Boolean(execution.textOnly && personal.draft.attachmentIds.length > 0)
  const referenceKey = JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId, conversation.projectId, directoryPath])
  const activeReference = useRef({ key: referenceKey, visible })
  const referenceRequest = useRef(0)
  activeReference.current = { key: referenceKey, visible }
  useEffect(() => {
    activeReference.current.visible = visible
    return () => { activeReference.current.visible = false; referenceRequest.current += 1 }
  }, [referenceKey, visible])

  const messageRendering: RenderingActions = {
    ...rendering,
    ...(directoryPath && onOpenFile ? { openFile: async (reference: string, resolved = false) => {
      const request = ++referenceRequest.current
      // 查找较慢时，旧点击不能覆盖用户后来选择的文件或会话。
      const isCurrent = () => activeReference.current.visible && activeReference.current.key === referenceKey && referenceRequest.current === request
      const file = resolveSessionFileReference(reference, directoryPath)
      if (!file) throw new Error("只能打开当前工作目录内的文件。")
      const target = { deviceId: conversation.ownerUserId, projectId: conversation.projectId }
      let path = file.path
      if (!resolved && !file.exact) {
        if (!onRequestFileCandidates) throw new Error("无法查找文件，请从文件树打开。")
        const result = await onRequestFileCandidates(scope, target, {
          requestId: 0, draftRevision: 0, tokenStart: 0, tokenEnd: 0, directory: "", query: path,
        })
        if (!isCurrent()) return
        if (result.status !== "ready") throw new Error(result.message || "文件查找失败。")
        const matches = result.items.filter(item => item.kind !== "directory" && item.name === path).map(item => item.relativePath)
        if (matches.length === 0) throw new Error(result.truncated ? "文件搜索结果不完整，请从文件树打开。" : "未找到文件，请检查工作目录。")
        if (matches.length > 1 || result.truncated) return matches
        path = matches[0]!
      }
      if (!isCurrent()) return
      onOpenFile(scope, target, path, "central", file.line !== undefined ? { line: file.line, endLine: file.endLine } : undefined)
    } } : {}),
  }

  const activeExecution = execution.getView?.(conversation.conversationId)
  const sessionState = activeExecution?.sessionState
  const providers = execution.getProviders?.()
  const selectedProviderId = execution.getSelectedProviderId?.(conversation.conversationId)
  const canCancel = Boolean(activeExecution?.activeTurnId && execution.cancel)
  const capabilities = buildComposerCapabilities({
    providers,
    selectedProviderId,
    sessionState,
    availability,
    directoryPath,
    running: Boolean(activeExecution?.activeTurnId),
    textOnly: execution.textOnly,
  })

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
    commands: capabilities.commands,
    controls: capabilities.controls,
    ...(capabilities.tabCycle ? { tabCycle: capabilities.tabCycle } : {}),
    projectTarget: directoryPath || hooks?.onRequestCollaborationCandidates
      ? { deviceId: conversation.ownerUserId, projectId: conversation.projectId }
      : null,
    references: hooks?.references ?? [],
    attachments: [],
  }

  const permission = activeExecution?.permission
  const translatedElicitation = !permission && activeExecution?.elicitation
    ? toConversationInteraction(activeExecution.elicitation, {
        retryRevision: activeExecution.elicitationRetryRevision,
        readOnly: false,
        availability: { enabled: true },
      })
    : null

  const interaction = permission
    ? (() => {
        const described = describePermissionRequest(permission)
        return {
          kind: "approval" as const,
          id: permission.id,
          title: permission.title,
          ...(described.description ? { description: described.description } : {}),
          ...(described.blocks.length ? { preview: <ConversationToolBlocks blocks={described.blocks} /> } : {}),
          readOnly: false,
          availability: { enabled: true },
          retryRevision: activeExecution?.permissionRetryRevision,
          options: permission.options.map(option => ({
            id: option.id,
            label: option.label,
            ...(option.id === "reject_with_feedback" ? { description: "拒绝并在下一步填写原因或修改建议" } : {}),
            tone: option.allows ? "positive" as const : "negative" as const,
            behavior: "immediate" as const,
            feedback: "none" as const,
            availability: { enabled: true },
          })),
        }
      })()
    : translatedElicitation?.interaction ?? null

  const view = activeExecution
    ? projectLocalExecution({ entries, contentRevision, composer }, activeExecution)
    : { entries, contentRevision, composer }

  const restoreKey = sessionState?.restoreStatus.kind === "reset"
    ? `${conversation.conversationId}:${sessionState.restoreStatus.sessionId}`
    : null
  const showRestoreBanner = Boolean(capabilities.restoreNotice && restoreKey && dismissedRestoreKey !== restoreKey)
  const activePlans = sessionState?.plans ?? []

  const aboveTimelineSlot = showRestoreBanner || capabilityError || activePlans.length > 0 ? (
    <div className="session-above-timeline">
      {showRestoreBanner ? (
        <div className="session-restore-banner" role="status">
          <IconAlertTriangle size={14} stroke={1.8} />
          <span className="session-restore-banner-text">{capabilities.restoreNotice}</span>
          <button
            type="button"
            className="session-banner-dismiss"
            aria-label="关闭恢复提示"
            onClick={() => setDismissedRestoreKey(restoreKey)}
          >
            <IconX size={13} stroke={1.8} />
          </button>
        </div>
      ) : null}

      {capabilityError ? (
        <div className="session-restore-banner session-restore-banner-error" role="alert">
          <IconAlertTriangle size={14} stroke={1.8} />
          <span className="session-restore-banner-text">{capabilityError}</span>
          <button
            type="button"
            className="session-banner-dismiss"
            aria-label="关闭错误提示"
            onClick={() => setCapabilityError(null)}
          >
            <IconX size={13} stroke={1.8} />
          </button>
        </div>
      ) : null}

      {activePlans.length > 0 ? (
        <div className="session-plan-card" aria-label="Agent 执行计划">
          <button
            type="button"
            className="session-plan-header"
            aria-expanded={!planCollapsed}
            onClick={() => setPlanCollapsed(prev => !prev)}
          >
            <span className="session-plan-header-left">
              {planCollapsed ? <IconChevronRight size={14} stroke={1.8} /> : <IconChevronDown size={14} stroke={1.8} />}
              <span>执行计划</span>
            </span>
            <span className="session-plan-summary">
              {(() => {
                const entryPlans = activePlans.filter(p => p.kind === "entries")
                const total = entryPlans.reduce((sum, p) => sum + p.entries.length, 0)
                if (total === 0) return `${activePlans.length} 项`
                const done = entryPlans.reduce((sum, p) => sum + p.entries.filter(e => e.status === "completed").length, 0)
                return `${done}/${total} 完成`
              })()}
            </span>
          </button>
          {!planCollapsed ? (
            <div className="session-plan-body">
              {activePlans.map((plan, planIdx) => {
                if (plan.kind === "entries") {
                  return (
                    <ul key={plan.id ?? `entries-${planIdx}`} className="session-plan-entries">
                      {plan.entries.map((entry, entryIdx) => (
                        <li key={`${planIdx}-${entryIdx}`} className={`session-plan-entry is-${entry.status}`}>
                          <span className="session-plan-entry-icon" aria-hidden="true">
                            {entry.status === "completed" ? (
                              <IconCheck size={13} stroke={2} />
                            ) : entry.status === "in_progress" ? (
                              <IconLoader2 size={13} stroke={2} className="session-plan-spin" />
                            ) : (
                              <span className="session-plan-dot" />
                            )}
                          </span>
                          <span className="session-plan-entry-content">{entry.content}</span>
                          <span className={`session-plan-priority is-${entry.priority}`}>
                            {PLAN_PRIORITY_LABEL[entry.priority]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                }
                if (plan.kind === "markdown") {
                  return (
                    <div key={plan.id} className="session-plan-markdown">
                      <Markdown text={plan.content} actions={messageRendering} />
                    </div>
                  )
                }
                return (
                  <div key={plan.id} className="session-plan-file">
                    <IconFileText size={14} stroke={1.8} />
                    {messageRendering.openFile ? (
                      <button
                        type="button"
                        className="session-plan-file-link"
                        onClick={() => {
                          void messageRendering.openFile?.(plan.uri).catch(err => {
                            setCapabilityError(err instanceof Error ? err.message : "无法打开计划文件。")
                          })
                        }}
                      >
                        {plan.uri}
                      </button>
                    ) : (
                      <span className="session-plan-file-text">{plan.uri}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : undefined

  const composerSlot = capabilities.usageBadge || hooks?.composerExtra ? (
    <div className="session-composer-extra">
      {capabilities.usageBadge ? (
        <span className="session-usage-badge" title="当前上下文窗口 Token 占用">
          上下文 {capabilities.usageBadge}
        </span>
      ) : null}
      {hooks?.composerExtra}
    </div>
  ) : undefined

  const slots = aboveTimelineSlot || composerSlot
    ? {
        ...(aboveTimelineSlot ? { aboveTimeline: aboveTimelineSlot } : {}),
        ...(composerSlot ? { composer: composerSlot } : {}),
      }
    : undefined

  return (
    <section className="session-center" aria-label={conversation.title || sessionState?.sessionTitle || "本机会话"}>
      <div className={`session-chat-split${viewingFile ? " has-split" : ""}${viewingFile && pvMax ? " is-max" : ""}`}>
        <div className="session-conversation-column">
          <div className="session-conversation-wrap">
            <ConversationView
              {...view}
              entries={hooks?.renderHistoryReferences?.(view.entries) ?? view.entries}
              scope={scope}
              visible={visible && !(viewingFile && pvMax)}
              interaction={interaction}
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
                onInteractionSubmit: execution.answerPermission || execution.answerElicitation
                  ? async (targetScope, id, answer) => {
                      if (targetScope.conversationId !== scope.conversationId) {
                        throw new Error("交互目标已变更。")
                      }
                      if (permission && permission.id === id) {
                        if (!execution.answerPermission) throw new Error("当前运行宿主不支持权限审批。")
                        if (answer.kind !== "approval") throw new Error("审批回答格式无效。")
                        await execution.answerPermission(conversation.conversationId, id, answer.optionId)
                        return
                      }
                      if (translatedElicitation && translatedElicitation.interaction.id === id) {
                        if (!execution.answerElicitation) throw new Error("当前运行宿主不支持交互表单。")
                        const mapped = toElicitationAnswer(translatedElicitation.form, answer)
                        await execution.answerElicitation(conversation.conversationId, id, mapped)
                        return
                      }
                      throw new Error("当前交互请求已结束或变更。")
                    }
                  : undefined,
                onCommand: (targetScope, itemId) => {
                  if (targetScope.conversationId !== scope.conversationId) return
                  const currentText = personal.draft.text
                  const trimmedLeft = currentText.trimStart()
                  const commandPrefix = `/${itemId} `
                  const nextText = trimmedLeft.startsWith("/") && !/\s/.test(trimmedLeft)
                    ? commandPrefix
                    : currentText.trim().length > 0
                      ? `${commandPrefix}${currentText}`
                      : commandPrefix
                  const cursor = commandPrefix.length
                  onPersonalChange(targetScope, {
                    kind: "draft-text",
                    text: nextText,
                    selectionStart: cursor,
                    selectionEnd: cursor,
                  })
                },
                onCapabilitySelect: (targetScope, controlId, itemId) => {
                  onCapabilitySelect?.(targetScope, controlId, itemId)
                  if (targetScope.conversationId !== scope.conversationId) return
                  setCapabilityError(null)
                  if (controlId === "agent") {
                    void execution.selectProvider?.(conversation.conversationId, itemId).catch(error => {
                      setCapabilityError(error instanceof Error ? error.message : "切换 Agent 失败。")
                    })
                    return
                  }
                  if (controlId === "mode") {
                    void execution.setMode?.(conversation.conversationId, itemId).catch(error => {
                      setCapabilityError(error instanceof Error ? error.message : "切换会话模式失败。")
                    })
                    return
                  }
                  if (controlId.startsWith("config:")) {
                    const configId = controlId.slice("config:".length)
                    const option = sessionState?.configOptions.find(item => item.id === configId)
                    const value = option?.type === "boolean" ? itemId === "true" : itemId
                    void execution.setConfigOption?.(conversation.conversationId, configId, value).catch(error => {
                      setCapabilityError(error instanceof Error ? error.message : "更新会话配置失败。")
                    })
                  }
                },
                onReferenceAction: hooks?.onReferenceAction,
                onRequestCollaborationCandidates: hooks?.onRequestCollaborationCandidates,
                onSelectCollaborationCandidate: hooks?.onSelectCollaborationCandidate,
                onRequestFileCandidates,
                onOpenFile,
                rendering: messageRendering,
              }}
              slots={slots}
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
