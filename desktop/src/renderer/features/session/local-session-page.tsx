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
  IconArrowsMaximize,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconLoader2,
  IconX,
} from "@tabler/icons-react"
import {
  ConversationToolBlocks,
  ConversationView,
  MAX_DRAFT_ANNOTATIONS,
  Markdown,
  SelectionToolbar,
  applyLeadingSlashCommand,
  composeAnnotatedPrompt,
  normalizeAnnotationSelectedText,
  normalizeAnnotationSourceLabel,
} from "../../../ui/index.js"
import { isSteerText } from "../../../shared/index.js"
import type {
  ConversationActions,
  ConversationComposerView,
  ConversationDraftAnnotation,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  ConversationSelectionAnnotation,
  ConversationTimelineEntry,
  RenderingActions,
} from "../../../ui/index.js"
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
import type { LocalDirectoryGitSummary } from "./use-local-directory.js"
import { resolveSessionFileReference } from "./session-file-reference.js"
import { buildDirectoryContextView, handleDirectoryContextAction } from "./session-model.js"
import { CodeCheckpointPanel } from "./code-checkpoint-panel.js"
import { PromptQueuePanel } from "./prompt-queue-panel.js"

export type LocalSessionPageProps = {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly conversation: ProjectConversationSummary
  readonly directoryPath: string | null
  readonly recentDirectories?: readonly string[]
  readonly gitSummary?: LocalDirectoryGitSummary | null
  readonly entries: readonly ConversationTimelineEntry[]
  readonly contentRevision: number
  readonly personal: ConversationPersonalState
  readonly execution: LocalSessionExecutionPort
  readonly rendering: RenderingActions
  readonly hooks?: SessionExternalHooks
  readonly centralFiles?: SessionCentralFilesState
  readonly onChooseDirectory?: () => void
  readonly onSelectDirectory?: (directoryPath: string) => void
  readonly onChooseLocalFiles?: () => void
  readonly onChooseLocalDirectories?: () => void
  readonly onOpenChangesPanel?: () => void
  readonly onRefreshGitStatus?: () => void
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
  recentDirectories,
  gitSummary,
  entries,
  contentRevision,
  personal,
  execution,
  rendering,
  hooks,
  centralFiles,
  onPersonalChange,
  onChooseDirectory,
  onSelectDirectory,
  onChooseLocalFiles,
  onChooseLocalDirectories,
  onOpenChangesPanel,
  onRefreshGitStatus,
  onCapabilitySelect,
  onRequestFileCandidates,
  onOpenFile,
}: LocalSessionPageProps): ReactElement {
  const viewingFile = Boolean(centralFiles && centralFiles.activeCentral !== null)
  const [pvMax, setPvMax] = useState(false)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  const [dismissedRestoreKey, setDismissedRestoreKey] = useState<string | null>(null)
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [confirmingDirectory, setConfirmingDirectory] = useState(false)
  const [expandedPlan, setExpandedPlan] = useState<{
    readonly title: string
    readonly subtitle?: string
    readonly markdown: string
  } | null>(null)
  const planBodyRef = useRef<HTMLDivElement | null>(null)
  const elicitationPlanRef = useRef<HTMLDivElement | null>(null)
  const expandedPlanBodyRef = useRef<HTMLDivElement | null>(null)
  const annotationsRef = useRef<readonly ConversationDraftAnnotation[]>(personal.draft.annotations ?? [])
  annotationsRef.current = personal.draft.annotations ?? []

  const handleAddSelectionToChat = (selection: ConversationSelectionAnnotation) => {
    const normalized = normalizeAnnotationSelectedText(selection.selectedText)
    if (!normalized) return
    const current = annotationsRef.current
    if (current.length >= MAX_DRAFT_ANNOTATIONS) return
    const sourceLabel = normalizeAnnotationSourceLabel(selection.sourceLabel)
    const nextItem: ConversationDraftAnnotation = {
      id: crypto.randomUUID(),
      selectedText: normalized.text,
      ...(sourceLabel ? { sourceLabel } : {}),
    }
    const nextAnnotations = [...current, nextItem]
    annotationsRef.current = nextAnnotations
    onPersonalChange(scope, { kind: "draft-annotations", annotations: nextAnnotations })
  }

  useEffect(() => {
    if (!viewingFile) setPvMax(false)
  }, [viewingFile])

  useEffect(() => {
    setCapabilityError(null)
    setExpandedPlan(null)
  }, [conversation.conversationId])

  useEffect(() => {
    if (!expandedPlan) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      setExpandedPlan(null)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [expandedPlan])

  const availability = execution.getAvailability(conversation.conversationId)
  const directoryStatus = availability.directoryStatus
  const directoryNeedsAction = Boolean(directoryPath && (directoryStatus === "confirmation-required" || directoryStatus === "invalid" || directoryStatus === "unavailable"))
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
  const queue = execution.getPromptQueue?.(conversation.conversationId)
  const queueMode = Boolean(execution.promptQueue && (canCancel || queue?.items.length))
  const canEnqueue = queueMode && (canCancel || availability.available) && !directoryNeedsAction
  const canSteer = Boolean(activeExecution?.activeCanSteer && !directoryNeedsAction)
  const onSend = (steer: boolean): NonNullable<ConversationActions["onSend"]> =>
    (targetScope, draftRevision, text, referenceIds, attachmentIds) => execution.send!({
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
      queue: queueMode,
      steer,
    })
  const isRunning = Boolean(activeExecution?.activeTurnId)
  const capabilities = buildComposerCapabilities({
    providers,
    selectedProviderId,
    sessionState,
    availability,
    directoryPath,
    running: isRunning,
    textOnly: execution.textOnly,
  })
  const composerProjectTarget = directoryPath || hooks?.onRequestCollaborationCandidates
    ? { deviceId: conversation.ownerUserId, projectId: conversation.projectId }
    : null
  const directoryStatusLabel = directoryPath
    ? (directoryStatus === "checking" ? "检查中"
      : directoryStatus === "confirmation-required" ? "待确认"
        : directoryStatus === "invalid" ? "已失效"
          : directoryStatus === "unavailable" ? "待检查" : undefined)
    : undefined
  const directoryStatusTone: "default" | "warning" | "danger" | undefined =
    directoryStatus === "invalid"
      ? "danger"
      : directoryStatus === "confirmation-required" || directoryStatus === "checking" || directoryStatus === "unavailable"
        ? "warning"
        : undefined
  const canConfirmDirectory = Boolean(directoryStatus === "confirmation-required" && execution.confirmDirectory)
  const triggerConfirmDirectory = () => {
    if (!execution.confirmDirectory || confirmingDirectory || isRunning) return
    setConfirmingDirectory(true)
    void execution.confirmDirectory(conversation.conversationId).finally(() => setConfirmingDirectory(false))
  }
  const switchingAvailability = isRunning
    ? { enabled: false, reason: "等待当前回复完成" }
    : { enabled: true }
  const { directory: directoryContext, recentById } = buildDirectoryContextView({
    directoryPath,
    recentDirectories,
    statusLabel: directoryStatusLabel,
    statusTone: directoryStatusTone,
    quickAction: canConfirmDirectory
      ? {
          id: "confirm",
          label: confirmingDirectory ? "正在确认…" : "确认目录",
          availability: { enabled: !confirmingDirectory && !isRunning, reason: isRunning ? "等待当前回复完成" : undefined },
        }
      : undefined,
    confirmItem: canConfirmDirectory
      ? {
          label: confirmingDirectory ? "正在确认…" : "确认并授权此目录",
          availability: { enabled: !confirmingDirectory && !isRunning, reason: isRunning ? "等待当前回复完成" : undefined },
        }
      : undefined,
    switchingAvailability,
    canCopyPath: Boolean(rendering.copyText),
  })
  const upstreamLabel = gitSummary?.upstream
    ? `${gitSummary.upstream.remote}/${gitSummary.upstream.branch} · ↑${gitSummary.upstream.ahead} ↓${gitSummary.upstream.behind}`
    : undefined
  const gitContext = gitSummary?.isGitRepository && gitSummary.branch
    ? {
        branch: gitSummary.branch,
        ...(gitSummary.head ? { head: gitSummary.head } : {}),
        ...(upstreamLabel ? { upstreamLabel } : {}),
        changedCount: gitSummary.changedCount,
        availability: { enabled: true },
        items: [
          {
            id: "open-changes",
            label: "在右侧查看变更",
            description: gitSummary.changedCount > 0 ? `${gitSummary.changedCount} 个未提交变更` : "工作区暂无变更",
            availability: { enabled: Boolean(onOpenChangesPanel) },
          },
          {
            id: "copy-branch",
            label: "复制分支名",
            description: gitSummary.branch,
            availability: { enabled: Boolean(rendering.copyText) },
          },
          {
            id: "refresh-git",
            label: gitSummary.loading ? "正在刷新…" : "刷新 Git 状态",
            availability: { enabled: Boolean(onRefreshGitStatus) && !gitSummary.loading },
          },
        ],
      }
    : undefined
  const directoryReady = Boolean(directoryPath && !directoryNeedsAction && directoryStatus !== "checking")
  const contextMenu: ConversationComposerView["contextMenu"] = {
    title: "添加上下文",
    tooltip: "添加上下文",
    items: [
      {
        id: "files",
        label: "本机文件",
        icon: "file",
        behavior: "custom",
        availability: execution.textOnly
          ? { enabled: false, reason: attachmentUnavailableReason }
          : !directoryPath
            ? { enabled: false, reason: "请先在顶部选择工作目录" }
            : !directoryReady || !onChooseLocalFiles
              ? { enabled: false, reason: availability.reason ?? "当前无法选择本机文件" }
              : { enabled: true },
      },
      {
        id: "folder",
        label: "本机目录",
        icon: "folder",
        behavior: "custom",
        availability: execution.textOnly
          ? { enabled: false, reason: attachmentUnavailableReason }
          : !directoryPath
            ? { enabled: false, reason: "请先在顶部选择工作目录" }
            : !directoryReady || !onChooseLocalDirectories
              ? { enabled: false, reason: availability.reason ?? "当前无法选择本机目录" }
              : { enabled: true },
      },
      {
        id: "mention",
        label: "提及",
        icon: "mention",
        behavior: "mention",
        badge: "工作区与协作",
        availability: composerProjectTarget
          ? { enabled: true }
          : { enabled: false, reason: "请先选择工作目录或连接协作范围" },
      },
      {
        id: "actions",
        label: "命令",
        icon: "action",
        behavior: "command",
        availability: capabilities.commands.length > 0 || availability.available
          ? { enabled: true }
          : { enabled: false, reason: availability.reason ?? "当前 Agent 暂未提供斜杠命令" },
      },
    ],
  }

  const composer: ConversationComposerView = {
    send: hasUnsupportedMaterial
      ? { enabled: false, reason: attachmentUnavailableReason }
      : canEnqueue || availability.available
      ? { enabled: true }
      : { enabled: false, reason: availability.reason ?? "本机 Agent 与执行链路尚未接入" },
    cancel: canCancel
      ? { enabled: true }
      : { enabled: false, reason: availability.reason ?? "当前没有可取消的执行" },
    queue: queueMode,
    primaryActions: canCancel ? (queueMode ? "both" : "cancel") : "send",
    statusText: hasUnsupportedMaterial ? attachmentUnavailableReason
      : canEnqueue || availability.available ? undefined : availability.reason ?? "本机 Agent 与运行链路尚未接入，暂不能发送或取消。",
    commands: capabilities.commands,
    agentModel: capabilities.agentModel,
    controls: capabilities.controls,
    projectTarget: composerProjectTarget,
    references: hooks?.references ?? [],
    attachments: personal.draft.attachmentIds.map(rawPath => {
      const isDir = rawPath.endsWith("/") || rawPath.endsWith("\\")
      const clean = rawPath.replace(/[/\\]+$/, "")
      const base = clean.split(/[/\\]/).at(-1) || clean || rawPath
      return {
        id: rawPath,
        label: isDir ? `${base}/` : base,
        path: clean || rawPath,
        kind: isDir ? "directory" : "file",
        availability: execution.textOnly
          ? { enabled: false, reason: attachmentUnavailableReason }
          : { enabled: true },
      }
    }),
    contextBar: {
      directory: directoryContext,
      ...(gitContext ? { git: gitContext } : {}),
    },
    contextMenu,
  }

  const permission = activeExecution?.permission
  const translatedElicitation = !permission && activeExecution?.elicitation
    ? toConversationInteraction(activeExecution.elicitation, {
        retryRevision: activeExecution.elicitationRetryRevision,
        readOnly: false,
        availability: { enabled: true },
        renderPlanPreview: planForm => (
          <div className="session-plan-elicitation-preview">
            <div className="session-plan-elicitation-toolbar">
              <span className="session-plan-elicitation-path">
                {planForm.displayPath || "执行计划预览"}
              </span>
              <button
                type="button"
                className="session-plan-zoom-btn"
                onClick={() => setExpandedPlan({
                  title: planForm.displayPath ? `执行计划 · ${planForm.displayPath}` : "执行计划详情",
                  markdown: planForm.markdown,
                })}
              >
                <IconArrowsMaximize size={13} stroke={1.8} aria-hidden="true" />
                <span>放大查看</span>
              </button>
            </div>
            <div ref={elicitationPlanRef} className="session-plan-elicitation-markdown">
              <Markdown text={planForm.markdown} actions={messageRendering} />
              <SelectionToolbar
                containerRef={elicitationPlanRef}
                enabled={visible && !(viewingFile && pvMax)}
                onAddToChat={handleAddSelectionToChat}
              />
            </div>
          </div>
        ),
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
            label: option.scope ? option.label + " · " + { once: "仅本次", thread: "本会话", project: "本项目目录" }[option.scope] : option.label,
            ...(option.id === "reject_with_feedback" ? { description: "拒绝并在下一步填写原因或修改建议" } : {}),
            tone: option.allows ? "positive" as const : "negative" as const,
            behavior: option.allows ? "confirm" as const : "immediate" as const,
            feedback: "none" as const,
            availability: { enabled: true },
          })),
        }
      })()
    : translatedElicitation?.interaction ?? null

  const projected = activeExecution
    ? projectLocalExecution({ entries, contentRevision, composer }, activeExecution)
    : { entries, contentRevision, composer }
  // 目录阻止发送时，旧执行/上传提示不能盖住当前目录失败原因。
  const view = directoryNeedsAction
    ? { ...projected, composer: { ...projected.composer, statusText: availability.reason } }
    : projected

  const renderedEntries = hooks?.renderHistoryReferences?.(view.entries) ?? view.entries

  const restoreKey = sessionState?.restoreStatus.kind === "reset"
    ? `${conversation.conversationId}:${sessionState.restoreStatus.sessionId}`
    : null
  const showRestoreBanner = Boolean(capabilities.restoreNotice && restoreKey && dismissedRestoreKey !== restoreKey)
  const activePlans = sessionState?.plans ?? []

  const diagnostic = sessionState?.setupDiagnostics?.join(" ")
  const aboveTimelineSlot = execution.codeCheckpoint || showRestoreBanner || capabilityError || diagnostic || activePlans.length > 0 ? (
    <div className="session-above-timeline">
      {execution.codeCheckpoint && <CodeCheckpointPanel
        key={referenceKey}
        running={Boolean(activeExecution?.activeTurnId)}
        run={action => execution.codeCheckpoint!(conversation.conversationId, action)}
      />}
      {diagnostic && <p className="session-restore-banner" role="status">{diagnostic}</p>}
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
            <div ref={planBodyRef} className="session-plan-body">
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
                      <div className="session-plan-markdown-tools">
                        <button
                          type="button"
                          className="session-plan-zoom-btn"
                          onClick={() => setExpandedPlan({
                            title: "执行计划详情",
                            markdown: plan.content,
                          })}
                        >
                          <IconArrowsMaximize size={12} stroke={1.8} aria-hidden="true" />
                          <span>放大查看</span>
                        </button>
                      </div>
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
              <SelectionToolbar
                containerRef={planBodyRef}
                enabled={visible && !(viewingFile && pvMax)}
                onAddToChat={handleAddSelectionToChat}
              />
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

  const queueSlot = queue?.items.length && execution.promptQueue
    ? <PromptQueuePanel key={scope.conversationId} queue={queue} canResume={availability.available && !canCancel}
        onSteer={canSteer && execution.steerQueued ? requestId => execution.steerQueued!(conversation.conversationId, requestId) : undefined}
        onAction={action => execution.promptQueue!(conversation.conversationId, action)} />
    : undefined
  const slots = aboveTimelineSlot || queueSlot || composerSlot
    ? {
        ...(aboveTimelineSlot ? { aboveTimeline: aboveTimelineSlot } : {}),
        ...(queueSlot ? { aboveComposer: queueSlot } : {}),
        ...(composerSlot ? { composer: composerSlot } : {}),
      }
    : undefined

  return (
    <section className="session-center" aria-label={conversation.title || "本机会话"}>
      <div className={`session-chat-split${viewingFile ? " has-split" : ""}${viewingFile && pvMax ? " is-max" : ""}`}>
        <div className="session-conversation-column">
          <div className="session-conversation-wrap">
            <ConversationView
              {...view}
              entries={renderedEntries}
              scope={scope}
              visible={visible && !(viewingFile && pvMax)}
              interaction={interaction}
              personal={personal}
              actions={{
                onPersonalChange: (targetScope, change) => {
                  if (!execution.commitsAcceptedDraft || change.kind !== "clear-draft") onPersonalChange(targetScope, change)
                },
                ...(execution.send ? { onSend: onSend(false),
                  ...(canSteer
                    && isSteerText(composeAnnotatedPrompt(personal.draft.text, personal.draft.annotations ?? []))
                    && !personal.draft.referenceIds.length
                    && !personal.draft.attachmentIds.length
                    ? { onSteer: onSend(true) } : {}),
                } : {}),
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
                  const next = applyLeadingSlashCommand(personal.draft.text, itemId)
                  onPersonalChange(targetScope, {
                    kind: "draft-text",
                    text: next.text,
                    selectionStart: next.cursor,
                    selectionEnd: next.cursor,
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
                onAddSelectionToChat: (targetScope, selection) => {
                  if (targetScope.conversationId === scope.conversationId) {
                    handleAddSelectionToChat(selection)
                  }
                },
                onDirectoryContextAction: (targetScope, itemId) => {
                  if (targetScope.conversationId !== scope.conversationId) return
                  handleDirectoryContextAction({
                    itemId,
                    directoryPath,
                    recentById,
                    onConfirmDirectory: triggerConfirmDirectory,
                    onChooseDirectory,
                    onSelectDirectory,
                    onCopyPath: path => { void rendering.copyText?.(path).catch(() => {}) },
                  })
                },
                onGitContextAction: (targetScope, itemId) => {
                  if (targetScope.conversationId !== scope.conversationId) return
                  if (itemId === "open-changes") onOpenChangesPanel?.()
                  else if (itemId === "copy-branch" && gitSummary?.branch) void rendering.copyText?.(gitSummary.branch).catch(() => {})
                  else if (itemId === "refresh-git") onRefreshGitStatus?.()
                },
                onContextMenuAction: (targetScope, itemId) => {
                  if (targetScope.conversationId !== scope.conversationId) return
                  if (itemId === "files") onChooseLocalFiles?.()
                  else if (itemId === "folder") onChooseLocalDirectories?.()
                },
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
              onAddSelectionToChat={handleAddSelectionToChat}
            />
          </div>
        ) : null}
      </div>
      {expandedPlan ? (
        <div
          className="session-plan-zoom-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setExpandedPlan(null)
          }}
        >
          <div className="session-plan-zoom-dialog" role="dialog" aria-modal="true" aria-label={expandedPlan.title}>
            <div className="session-plan-zoom-head">
              <div className="session-plan-zoom-title-group">
                <h3>{expandedPlan.title}</h3>
                {expandedPlan.subtitle ? <span>{expandedPlan.subtitle}</span> : null}
              </div>
              <button
                type="button"
                className="session-plan-zoom-close"
                aria-label="关闭放大查看"
                onClick={() => setExpandedPlan(null)}
              >
                <IconX size={16} stroke={1.8} aria-hidden="true" />
              </button>
            </div>
            <div ref={expandedPlanBodyRef} className="session-plan-zoom-body">
              <Markdown text={expandedPlan.markdown} actions={messageRendering} />
              <SelectionToolbar
                containerRef={expandedPlanBodyRef}
                enabled={visible}
                onAddToChat={handleAddSelectionToChat}
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
