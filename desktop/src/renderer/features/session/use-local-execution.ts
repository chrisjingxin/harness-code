/**
 * 本机会话执行的页面适配 Hook。
 *
 * 1. 功能定义：把主进程 `DesktopLocalExecutionHost` 的多代理注册表、实时 ACP 会话能力、
 *    流式推理/工具/权限/表单事件流，适配为会话工作台消费的 `LocalSessionExecutionPort`。
 * 2. 协作边界：下游依赖 `contracts.ts`、`local-execution-view.ts` 与 `elicitation-form.ts`；
 *    上游服务于 `use-project-sessions.ts`、`local-session-page.tsx` 与 `session-provider.tsx`。
 * 3. 核心防护：通过 `bindingId` 缓冲解决 `prepare()` 期间 `session-state`/`elicitation` 通知
 *    早于 IPC `invoke` 回包到达的竞态，确保模式、斜杠命令与交互表单不会丢失。
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react"
import type {
  AcpAgentList,
  LocalAcpElicitationAnswer,
  LocalAcpElicitationRequest,
} from "@workbench/acp-runtime/types"
import {
  isSteerText,
  localExecutionKey,
  type DesktopLocalExecutionHost,
  type LocalDirectoryStatus,
  type LocalExecutionAttachment,
  type LocalExecutionAvailability,
  type LocalExecutionBinding,
  type LocalExecutionNotice,
  type LocalExecutionScope,
  type LocalExecutionSessionState,
  type KnowledgeContextStatus,
  type PersonalDraftImage,
  type PromptQueueView,
} from "../../../shared/index.js"
import { MAX_QUEUED_PROMPT_CHARS } from "../../../ui/conversation/annotations-codec.js"
import { isToolCallMarkupTitle } from "./session-model.js"
import type { LocalSessionExecutionPort, SessionExecutionScope } from "./contracts.js"
import { toConversationInteraction } from "./elicitation-form.js"
import {
  applyLocalExecutionUpdate,
  describePermissionRequest,
  emptyLocalExecutionView,
  extractFileAttachments,
} from "./local-execution-view.js"
import type { LocalExecutionView } from "./local-execution-view.js"

const WORKSPACE_MUTATING_TOOL_KINDS = new Set(["edit", "delete", "move", "execute"])
const MAX_PENDING_BINDING_NOTICES = 4

export const attachmentUnavailableReason = "本机 Agent 暂不支持附件。移除附件后可发送，当前草稿已保留。"
const unknownReason = "发送结果待确认。请保留当前草稿，等待本机执行状态更新。"
const preparing: LocalExecutionAvailability = { available: false, reason: "正在确认本机会话执行能力…" }
const readyOnOpen: LocalExecutionAvailability = { available: false, reason: "创建后确认本机 Agent" }

type Target = {
  readonly scope: LocalExecutionScope
  readonly namespace: string
  readonly key: string
  readonly directory: string | null
  readonly selectionRevision: number
}

type Flight = {
  readonly scope: SessionExecutionScope
  readonly bindingId: string
  readonly draftRevision?: number
  readonly referenceIds: readonly string[]
  readonly images?: readonly PersonalDraftImage[]
  readonly requestId: string
  turnId?: string
  lastSequence: number
  unknown: boolean
}

type BufferedBindingNotices = {
  sessionState?: LocalExecutionSessionState
  elicitation?: LocalAcpElicitationRequest | null
}

type Screen = {
  knowledgeStatus?: KnowledgeContextStatus
  contextTurns?: Map<string, string>
  timeline: LocalExecutionView
  queue?: PromptQueueView
  preparedFor?: Target
  preparedForProvider?: string
  prepareToken?: number
  retiredBindingId?: string
  binding?: LocalExecutionBinding
  availability?: LocalExecutionAvailability
  directoryStatus?: LocalDirectoryStatus
  terminal?: { readonly bindingId: string; readonly availability: LocalExecutionAvailability }
  flight?: Flight
  pendingBindingNotices?: Map<string, BufferedBindingNotices>
}

function summarizeElicitationAnswer(answer: LocalAcpElicitationAnswer): string {
  if (answer.action === "decline") return "已跳过（拒绝填写）"
  if (answer.action === "cancel") return "已取消"
  const decision = typeof answer.content?.decision === "string" ? answer.content.decision : undefined
  if (decision === "approved") return "已批准并开始执行"
  if (decision === "revise") return "已提交修改意见"
  if (decision === "abandoned") return "已放弃"
  if (decision === "accepted") return "已批准并提交"
  if (decision === "edited") return "已附修改意见提交"
  if (decision === "rejected") return "已拒绝"
  return "已提交填写内容"
}

function pushBufferedNotice(
  screen: Screen,
  bindingId: string,
  patch: Partial<BufferedBindingNotices>,
): void {
  if (!screen.pendingBindingNotices) screen.pendingBindingNotices = new Map()
  const existing = screen.pendingBindingNotices.get(bindingId) ?? {}
  if ("sessionState" in patch) existing.sessionState = patch.sessionState
  if ("elicitation" in patch) existing.elicitation = patch.elicitation
  screen.pendingBindingNotices.delete(bindingId)
  screen.pendingBindingNotices.set(bindingId, existing)
  while (screen.pendingBindingNotices.size > MAX_PENDING_BINDING_NOTICES) {
    const oldest = screen.pendingBindingNotices.keys().next().value
    if (oldest !== undefined) screen.pendingBindingNotices.delete(oldest)
  }
}

/** 只为当前选中的本人会话准备执行，其他本人会话仍可完成已受理的一轮。 */
export function useLocalExecution(
  host: DesktopLocalExecutionHost | undefined,
  project: SessionExecutionScope | null,
  conversationId: string | null,
  directory: string | null,
  selectionRevision: number,
  ownerName: string,
  onAccepted: (scope: SessionExecutionScope, conversationId: string, revision: number) => void,
  onWorkspaceRefresh?: (scope: SessionExecutionScope, conversationId: string) => void,
  preferredProviders?: Readonly<Record<string, string>>,
  onSessionTitleChange?: (scope: LocalExecutionScope, title: string | undefined) => void,
  onProviderChange?: (scope: LocalExecutionScope, providerId: string) => void,
  onTurnUploaded?: (scope: LocalExecutionScope, userSequence: number, images: readonly PersonalDraftImage[]) => void,
  onTurnFinished?: (scope: LocalExecutionScope) => void,
  onSharingStopped?: (scope: LocalExecutionScope) => void,
): LocalSessionExecutionPort | undefined {
  const accountId = project?.accountId
  const workspaceId = project?.workspaceId ?? null
  const projectId = project?.projectId ?? null
  const namespace = project?.namespace
  const [confirmationRevision, retryPreparation] = useReducer(revision => revision + 1, 0)
  const confirming = useRef(false)
  const target = useMemo<Target | null>(() => {
    if (!accountId || !conversationId || namespace === undefined) return null
    const scope = { accountId, workspaceId, projectId, conversationId }
    return { scope, namespace, key: localExecutionKey(scope), directory, selectionRevision: selectionRevision + confirmationRevision }
  }, [accountId, workspaceId, projectId, conversationId, directory, selectionRevision, confirmationRevision, namespace])

  const screens = useRef(new Map<string, Screen>())
  const providersRef = useRef<AcpAgentList | undefined>(undefined)
  const providerOverrides = useRef(new Map<string, string>())
  const current = useRef({
    target, onAccepted, onWorkspaceRefresh, ownerName, preferredProviders, onSessionTitleChange, onProviderChange, onTurnUploaded,
    onTurnFinished, onSharingStopped,
  })
  const mounted = useRef(false)
  const [, refresh] = useReducer(revision => revision + 1, 0)

  useLayoutEffect(() => {
    current.current = {
      target, onAccepted, onWorkspaceRefresh, ownerName, preferredProviders, onSessionTitleChange, onProviderChange, onTurnUploaded,
      onTurnFinished, onSharingStopped,
    }
  }, [target, onAccepted, onWorkspaceRefresh, ownerName, preferredProviders, onSessionTitleChange, onProviderChange, onTurnUploaded, onTurnFinished, onSharingStopped])

  function applySessionStateNotice(
    scope: LocalExecutionScope,
    screen: Screen,
    state: LocalExecutionSessionState,
  ): void {
    screen.timeline = applyLocalExecutionUpdate(screen.timeline, { kind: "session-state", state })
    const title = state.connected ? state.sessionTitle?.trim() : undefined
    const usableTitle = title && isToolCallMarkupTitle(title) ? undefined : title || undefined
    current.current.onSessionTitleChange?.(scope, usableTitle)
  }

  function applyElicitationNotice(
    scope: LocalExecutionScope,
    bindingId: string,
    screen: Screen,
    request: LocalAcpElicitationRequest | null,
  ): void {
    // 若远端发来了当前桌面表单无法渲染的空/不支持 Schema，主动回复 decline 防止宿主无限挂起。
    if (request && !toConversationInteraction(request)) {
      void host?.answerElicitation?.(scope, bindingId, request.id, { action: "decline" }).catch(() => {})
      if (screen.timeline.elicitation) {
        screen.timeline = applyLocalExecutionUpdate(screen.timeline, { kind: "elicitation", request: null })
      }
      return
    }
    screen.timeline = applyLocalExecutionUpdate(screen.timeline, { kind: "elicitation", request })
  }

  function flushBufferedNotices(scope: LocalExecutionScope, bindingId: string, screen: Screen): void {
    const buffered = screen.pendingBindingNotices?.get(bindingId)
    screen.pendingBindingNotices?.delete(bindingId)
    if (!buffered) return
    if (buffered.sessionState) {
      applySessionStateNotice(scope, screen, buffered.sessionState)
    }
    if (buffered.elicitation !== undefined) {
      applyElicitationNotice(scope, bindingId, screen, buffered.elicitation)
    }
  }

  function accept(
    screen: Screen,
    flight: Flight,
    conversationId: string,
    turnId: string,
    text: string,
    canSteer?: boolean,
    images?: readonly PersonalDraftImage[],
    attachments?: readonly LocalExecutionAttachment[],
    knowledgeStatus?: KnowledgeContextStatus,
  ): void {
    if (flight.turnId !== undefined) return
    flight.turnId = turnId
    // 只接受当前 scope/binding/request 的受理结果；成功的下一轮清除旧降级提示。
    screen.knowledgeStatus = knowledgeStatus?.code !== "ready" ? knowledgeStatus : undefined
    screen.contextTurns ??= new Map()
    screen.contextTurns.set(flight.requestId, turnId)
    if (screen.contextTurns.size > 200) screen.contextTurns.delete(screen.contextTurns.keys().next().value!)
    const finalImages = images && images.length > 0 ? images : flight.images
    screen.timeline = applyLocalExecutionUpdate(screen.timeline, {
      kind: "accepted",
      turnId,
      text,
      canSteer,
      referenceIds: flight.referenceIds,
      ...(finalImages?.length ? { images: finalImages } : {}),
      ...(attachments?.length ? { attachments } : {}),
      author: { id: flight.scope.accountId, displayName: current.current.ownerName },
    })
    if (flight.draftRevision !== undefined) current.current.onAccepted(flight.scope, conversationId, flight.draftRevision)
    refresh()
  }

  function applyQueue(screen: Screen, queue: PromptQueueView): void {
    if (!mounted.current || (screen.queue && screen.queue.revision >= queue.revision)) return
    screen.queue = queue
    refresh()
  }

  useEffect(() => {
    mounted.current = true
    providersRef.current = undefined
    void host?.listProviders?.().then(result => {
      if (!mounted.current || !result.ok) return
      providersRef.current = result.value
      refresh()
    }).catch(() => {})

    const stop = host?.onNotice((notice: LocalExecutionNotice) => {
      const key = localExecutionKey(notice.scope)
      const screen = screens.current.get(key)
      if (notice.kind === "upload") {
        if (notice.sharingStopped) {
          current.current.onSharingStopped?.(notice.scope)
        }
        if (!screen && !notice.failure) return
        const nextScreen = screen ?? { timeline: emptyLocalExecutionView }
        nextScreen.timeline = applyLocalExecutionUpdate(nextScreen.timeline, notice)
        screens.current.set(key, nextScreen)
        if (!notice.failure && notice.firstSequence !== undefined) {
          const userEntry = nextScreen.timeline.entries.find(
            entry => entry.kind === "message" && entry.role === "user" && entry.id === `local-execution:${notice.turnId}:user`,
          )
          if (userEntry?.kind === "message" && userEntry.images?.length) {
            const persisted = userEntry.images.map(({ id, name, mimeType, sizeBytes, width, height }) => ({
              id,
              name,
              mimeType,
              sizeBytes,
              ...(width !== undefined ? { width } : {}),
              ...(height !== undefined ? { height } : {}),
            }))
            current.current.onTurnUploaded?.(notice.scope, notice.firstSequence, persisted)
          }
        }
        refresh()
        return
      }
      if (!screen) return
      if (notice.kind === "context-tool") {
        const turnId = screen.contextTurns?.get(notice.requestId)
        if (turnId && screen.binding?.bindingId === notice.bindingId) {
          screen.timeline = applyLocalExecutionUpdate(screen.timeline, { kind: "context-tool", turnId, tool: notice.tool })
          refresh()
        }
        return
      }
      if (notice.kind === "prompt-queue") {
        applyQueue(screen, notice.queue)
        return
      }
      if (notice.kind === "steered") {
        if (screen.binding?.bindingId === notice.bindingId) {
          screen.timeline = applyLocalExecutionUpdate(screen.timeline, { ...notice,
            author: { id: notice.scope.accountId, displayName: current.current.ownerName } })
          refresh()
        }
        return
      }

      if (notice.kind === "session-state") {
        if (screen.binding?.bindingId === notice.bindingId) {
          applySessionStateNotice(notice.scope, screen, notice.state)
          refresh()
        } else if (!screen.binding) {
          // 主进程有时复用原绑定；准备回包到达后只消费所返回 bindingId 的状态。
          pushBufferedNotice(screen, notice.bindingId, { sessionState: notice.state })
        }
        return
      }

      if (notice.kind === "elicitation") {
        if (screen.binding?.bindingId === notice.bindingId) {
          applyElicitationNotice(notice.scope, notice.bindingId, screen, notice.request)
          refresh()
        } else if (!screen.binding && notice.bindingId !== screen.retiredBindingId) {
          if (notice.request && !toConversationInteraction(notice.request)) {
            void host?.answerElicitation?.(notice.scope, notice.bindingId, notice.request.id, { action: "decline" }).catch(() => {})
          } else {
            pushBufferedNotice(screen, notice.bindingId, { elicitation: notice.request })
          }
        }
        return
      }

      if (notice.kind === "accepted" && notice.queued && screen.binding?.bindingId === notice.bindingId
        && screen.preparedFor && !screen.flight) {
        const flight: Flight = {
          scope: {
            ...notice.scope,
            namespace: screen.preparedFor.namespace,
          },
          bindingId: notice.bindingId, requestId: notice.requestId, referenceIds: notice.referenceIds ?? [],
          ...(notice.images?.length ? { images: notice.images } : {}),
          lastSequence: 0, unknown: false,
        }
        screen.flight = flight
        accept(screen, flight, notice.scope.conversationId, notice.turnId, notice.text, notice.canSteer, notice.images, notice.attachments, notice.knowledgeStatus)
        return
      }
      const flight = screen.flight
      if (!flight) {
        // 窗口页面重载时可能只恢复了当前绑定。旧轮正文不回放，但终态仍可解除忙状态。
        if (notice.kind === "finished" && screen.preparedFor) {
          screen.terminal = notice
          if (screen.binding?.bindingId === notice.bindingId) {
            screen.availability = notice.availability
            screen.directoryStatus = notice.availability.directoryStatus ?? screen.directoryStatus
            current.current.onTurnFinished?.(notice.scope)
            refresh()
          }
        }
        return
      }
      if (flight.bindingId !== notice.bindingId) return
      if (notice.kind === "accepted") {
        if (flight.requestId === notice.requestId) accept(screen, flight, notice.scope.conversationId, notice.turnId, notice.text, notice.canSteer, notice.images, notice.attachments, notice.knowledgeStatus)
        return
      }
      if (flight.turnId !== notice.turnId || notice.sequence !== flight.lastSequence + 1) return
      flight.lastSequence = notice.sequence
      if (notice.kind === "permission") {
        screen.timeline = applyLocalExecutionUpdate(screen.timeline, {
          kind: "permission", turnId: notice.turnId, request: notice.request,
        })
        refresh()
        return
      }
      screen.timeline = applyLocalExecutionUpdate(screen.timeline, notice.kind === "text"
        ? { kind: "assistant-text", turnId: notice.turnId, text: notice.text, messageId: notice.messageId }
        : notice.kind === "tool" ? notice
          : notice.kind === "thought" ? { kind: "thought", turnId: notice.turnId, text: notice.text }
            : { kind: "finished", turnId: notice.turnId, failure: notice.failure, ephemeral: notice.ephemeral, runSummary: notice.runSummary })
      if (notice.kind === "tool"
        && (notice.tool.status === "completed" || notice.tool.status === "failed")
        && (WORKSPACE_MUTATING_TOOL_KINDS.has(notice.tool.kind ?? "") || Boolean(notice.tool.diffs?.length))) {
        current.current.onWorkspaceRefresh?.(flight.scope, notice.scope.conversationId)
      }
      if (notice.kind === "finished") {
        screen.flight = undefined
        screen.terminal = notice
        if (screen.binding?.bindingId === notice.bindingId) screen.availability = notice.availability
        screen.directoryStatus = notice.availability.directoryStatus ?? screen.directoryStatus
        current.current.onWorkspaceRefresh?.(flight.scope, notice.scope.conversationId)
        current.current.onTurnFinished?.(notice.scope)
      }
      refresh()
    })
    return () => {
      mounted.current = false
      stop?.()
      screens.current.clear()
    }
  }, [host])

  function resolveDesiredProviderId(targetInfo: Target | null): string | undefined {
    if (!targetInfo) return undefined
    return providerOverrides.current.get(targetInfo.key) ?? preferredProviders?.[targetInfo.scope.conversationId]
  }

  function matchesPreparedProvider(screen: Screen | undefined, desiredProvider: string | undefined): boolean {
    if (!screen) return false
    return desiredProvider === undefined
      ? screen.preparedForProvider === undefined || screen.binding?.providerId === screen.preparedForProvider
      : screen.preparedForProvider === desiredProvider
  }

  const selectedPreferredProvider = target ? preferredProviders?.[target.scope.conversationId] : undefined

  useEffect(() => {
    if (!host || !target) return
    const screen = screens.current.get(target.key) ?? { timeline: emptyLocalExecutionView }
    screens.current.set(target.key, screen)
    if (!target.directory) {
      void host.promptQueue(target.scope, { kind: "read" }).catch(() => {})
      return
    }
    const desiredProvider = resolveDesiredProviderId(target)
    if (
      screen.preparedFor?.directory === target.directory
      && screen.preparedFor.selectionRevision === target.selectionRevision
      && matchesPreparedProvider(screen, desiredProvider)
      && screen.binding
    ) {
      return
    }
    let active = true
    const token = (screen.prepareToken ?? 0) + 1
    screen.prepareToken = token
    screen.retiredBindingId = screen.binding?.bindingId ?? screen.retiredBindingId
    screen.preparedFor = target
    screen.preparedForProvider = desiredProvider
    screen.binding = undefined
    screen.knowledgeStatus = undefined
    screen.availability = preparing
    screen.directoryStatus = "checking"
    current.current.onSessionTitleChange?.(target.scope, undefined)
    const lastTerminal = screen.terminal
    refresh()
    void host.prepare(target.scope, target.directory, desiredProvider).then(result => {
      if (!active || screen.prepareToken !== token) return
      screen.directoryStatus = result.directoryStatus
      screen.binding = result.ok ? result.value : undefined
      if (result.ok) screen.timeline = { ...screen.timeline, failure: null }
      if (!result.ok) {
        screen.availability = { available: false, reason: result.error.message }
      } else {
        screen.preparedForProvider = result.value.providerId
        screen.availability = screen.terminal !== lastTerminal && screen.terminal?.bindingId === result.value.bindingId
          ? screen.terminal.availability
          : result.value
        flushBufferedNotices(target.scope, result.value.bindingId, screen)
        if (!desiredProvider && result.value.available && result.value.providerId) {
          current.current.onProviderChange?.(target.scope, result.value.providerId)
        }
      }
      refresh()
    }).catch(() => {
      if (!active || screen.prepareToken !== token) return
      screen.availability = { available: false, reason: "无法确认本机执行能力，请重新选择工作目录。" }
      screen.directoryStatus = "unavailable"
      refresh()
    }).finally(() => {
      if (active) void host.promptQueue(target.scope, { kind: "read" }).catch(() => {})
    })
    return () => { active = false }
  }, [host, target, selectedPreferredProvider])

  function readAvailability(selected: Target | null, id: string): LocalExecutionAvailability {
    if (id === "__new__") return readyOnOpen
    if (!selected?.directory || selected.scope.conversationId !== id) return { available: false, reason: "请先选择本机工作目录。" }
    const screen = screens.current.get(selected.key)
    if (screen?.flight) return {
      available: false,
      reason: screen.flight.turnId ? "等待当前回复完成。" : screen.flight.unknown ? unknownReason : "正在提交…",
    }
    const desiredProvider = resolveDesiredProviderId(selected)
    return screen?.preparedFor?.directory === selected.directory
      && screen.preparedFor.selectionRevision === selected.selectionRevision
      && matchesPreparedProvider(screen, desiredProvider)
      ? screen.availability ?? preparing : preparing
  }

  if (!host) return undefined
  return {
    textOnly: false,
    async codeCheckpoint(conversationId, action) {
      const selected = current.current.target
      if (!selected?.directory || selected.scope.conversationId !== conversationId) throw new Error("请先确认本机会话的工作目录。")
      const result = await host.codeCheckpoint(selected.scope, action)
      if (!result.ok) throw new Error(result.error.message)
      if (result.value.kind === "restored" && result.value.paths.length > 0 && project) {
        current.current.onWorkspaceRefresh?.(project, conversationId)
      }
      return result.value
    },
    commitsAcceptedDraft: true,
    getAvailability: id => {
      const screen = target && screens.current.get(target.key)
      const preparedForTarget = Boolean(
        target?.directory
        && screen?.preparedFor?.directory === target.directory
        && screen?.preparedFor.selectionRevision === target.selectionRevision
        && matchesPreparedProvider(screen, resolveDesiredProviderId(target)),
      )
      return {
        ...readAvailability(target, id),
        ...(target?.scope.conversationId === id ? {
          ...(preparedForTarget && screen?.knowledgeStatus ? { knowledgeStatus: screen.knowledgeStatus } : {}),
          directoryStatus: !target.directory
            ? undefined
            : preparedForTarget ? screen?.directoryStatus ?? "checking" : "checking",
        } : {}),
      }
    },
    async confirmDirectory(id) {
      const selected = current.current.target
      if (!selected?.directory || selected.scope.conversationId !== id || confirming.current) return
      confirming.current = true
      try {
        const result = await host.confirmDirectory(selected.scope)
        if (!mounted.current || current.current.target !== selected) return
        if (result.ok) {
          if (result.value) retryPreparation()
          else {
            const screen = screens.current.get(selected.key)
            if (screen) {
              screen.availability = { available: false, reason: "已取消目录确认，草稿已保留。确认或重新选择目录后可发送。" }
              refresh()
            }
          }
        } else {
          const screen = screens.current.get(selected.key)
          if (screen) {
            screen.availability = { available: false, reason: result.error.message }
            if (result.error.code === "PROJECT_ROOT_CHANGED") screen.directoryStatus = "invalid"
            refresh()
          }
        }
      } catch {
        const screen = screens.current.get(selected.key)
        if (mounted.current && current.current.target === selected && screen) {
          screen.availability = { available: false, reason: "无法确认目录，请重试或重新选择。" }
          refresh()
        }
      } finally { confirming.current = false }
    },
    getView: id => target?.scope.conversationId === id ? screens.current.get(target.key)?.timeline : undefined,
    getPromptQueue: id => target?.scope.conversationId === id ? screens.current.get(target.key)?.queue : undefined,
    async steerQueued(id, requestId) {
      const source = current.current.target
      const flight = source && screens.current.get(source.key)?.flight
      if (!source || source.scope.conversationId !== id || !flight?.turnId) throw new Error("当前轮已结束，消息已保留。")
      const result = await host.steer(source.scope, flight.bindingId, flight.turnId, { kind: "queued", requestId })
      if (!result.ok) throw new Error(result.error.message)
    },
    async promptQueue(id, action) {
      const source = current.current.target
      const screen = source && screens.current.get(source.key)
      if (!source || !screen || source.scope.conversationId !== id) throw new Error("会话目标已变更。")
      const bindingId = screen.binding?.bindingId
      if (action.kind === "resume" && !bindingId) throw new Error("请先确认 Agent 和工作目录。")
      const result = await host.promptQueue(source.scope, action.kind === "resume" ? { ...action, bindingId: bindingId! } : action)
      if (!result.ok) throw new Error(result.error.message)
      applyQueue(screen, result.value)
    },
    getProviders: () => providersRef.current,
    async refreshProviders() {
      const result = await host.listProviders?.()
      if (!mounted.current || !result?.ok) return providersRef.current
      providersRef.current = result.value
      refresh()
      return result.value
    },
    clearEntries(id) {
      const screen = target?.scope.conversationId === id ? screens.current.get(target.key) : undefined
      if (!screen || screen.flight || screen.timeline.entries.length === 0) return
      screen.timeline = { ...screen.timeline, entries: [] }
      refresh()
    },
    getSelectedProviderId: id => {
      if (!target || target.scope.conversationId !== id) return providersRef.current?.defaultProviderId ?? undefined
      const screen = screens.current.get(target.key)
      return screen?.timeline.sessionState?.providerId
        ?? screen?.binding?.providerId
        ?? providerOverrides.current.get(target.key)
        ?? preferredProviders?.[id]
        ?? providersRef.current?.defaultProviderId
        ?? undefined
    },
    async selectProvider(id, providerId) {
      const source = current.current.target
      if (!source || source.scope.conversationId !== id) throw new Error("会话目标已变更。")
      if (!source.directory) throw new Error("请先选择本机工作目录。")
      const screen = screens.current.get(source.key) ?? { timeline: emptyLocalExecutionView }
      screens.current.set(source.key, screen)
      if (screen.flight) throw new Error("请等待当前回复完成后再切换 Agent。")

      const token = (screen.prepareToken ?? 0) + 1
      screen.prepareToken = token
      providerOverrides.current.set(source.key, providerId)
      screen.retiredBindingId = screen.binding?.bindingId ?? screen.retiredBindingId
      screen.preparedFor = source
      screen.preparedForProvider = providerId
      screen.binding = undefined
      screen.availability = preparing
      screen.directoryStatus = "checking"
      screen.timeline = { ...screen.timeline, sessionState: undefined, supportsImagePrompt: undefined, elicitation: null }
      current.current.onSessionTitleChange?.(source.scope, undefined)
      screen.knowledgeStatus = undefined
      refresh()

      try {
        const result = await host.prepare(source.scope, source.directory, providerId)
        if (!mounted.current || screens.current.get(source.key) !== screen || screen.prepareToken !== token) return
        screen.directoryStatus = result.directoryStatus
        screen.binding = result.ok ? result.value : undefined
        if (!result.ok) {
          screen.availability = { available: false, reason: result.error.message }
          refresh()
          throw new Error(result.error.message)
        }
        screen.timeline = { ...screen.timeline, failure: null }
        screen.preparedForProvider = result.value.providerId
        screen.availability = result.value
        flushBufferedNotices(source.scope, result.value.bindingId, screen)
        if (result.value.providerId) {
          current.current.onProviderChange?.(source.scope, result.value.providerId)
        }
        refresh()
      } catch (error) {
        if (mounted.current && screens.current.get(source.key) === screen && screen.prepareToken === token && screen.directoryStatus === "checking") {
          screen.directoryStatus = "unavailable"
          refresh()
        }
        throw error
      } finally {
        if (mounted.current && screen.prepareToken === token) void host.promptQueue(source.scope, { kind: "read" }).catch(() => {})
      }
    },
    async setMode(id, modeId) {
      const source = current.current.target
      const screen = source && screens.current.get(source.key)
      if (!source || source.scope.conversationId !== id || !screen?.binding) throw new Error("会话尚未准备就绪。")
      if (!host.setMode) throw new Error("当前运行宿主不支持切换模式。")
      // 乐观更新本地状态，保证连续按 Tab / Shift+Tab 或菜单点击能即时轮转；失败时自动回滚。
      const prevState = screen.timeline.sessionState
      if (prevState) {
        screen.timeline = {
          ...screen.timeline,
          failure: null,
          sessionState: {
            ...prevState,
            currentModeId: modeId,
            ...(prevState.modes ? { modes: { ...prevState.modes, currentModeId: modeId } } : {}),
          },
        }
        refresh()
      }
      const result = await host.setMode(source.scope, screen.binding.bindingId, modeId)
      if (!result.ok) {
        if (mounted.current && screens.current.get(source.key) === screen && prevState) {
          screen.timeline = { ...screen.timeline, sessionState: prevState, failure: result.error.message }
          refresh()
        }
        throw new Error(result.error.message)
      }
    },
    async setConfigOption(id, configId, value) {
      const source = current.current.target
      const screen = source && screens.current.get(source.key)
      if (!source || source.scope.conversationId !== id || !screen?.binding) throw new Error("会话尚未准备就绪。")
      if (!host.setConfigOption) throw new Error("当前运行宿主不支持修改配置项。")
      const prevState = screen.timeline.sessionState
      if (prevState) {
        screen.timeline = {
          ...screen.timeline,
          failure: null,
          sessionState: {
            ...prevState,
            configOptions: prevState.configOptions.map(opt => {
              if (opt.id !== configId) return opt
              if (opt.type === "boolean") return { ...opt, currentValue: typeof value === "boolean" ? value : value === "true" }
              if (opt.type === "select" && typeof value === "string") return { ...opt, currentValue: value }
              return opt
            }),
          },
        }
        refresh()
      }
      const result = await host.setConfigOption(source.scope, screen.binding.bindingId, configId, value)
      if (!result.ok) {
        if (mounted.current && screens.current.get(source.key) === screen && prevState) {
          screen.timeline = { ...screen.timeline, sessionState: prevState, failure: result.error.message }
          refresh()
        }
        throw new Error(result.error.message)
      }
    },
    async answerElicitation(id, requestId, answer) {
      const source = current.current.target
      const screen = source && screens.current.get(source.key)
      const pending = screen?.timeline.elicitation
      if (!source || source.scope.conversationId !== id || !screen?.binding || pending?.id !== requestId) {
        throw new Error("交互表单请求已变更。")
      }
      if (!host.answerElicitation) throw new Error("当前运行宿主不支持交互表单应答。")
      const result = await host.answerElicitation(source.scope, screen.binding.bindingId, requestId, answer)
      if (!result.ok) {
        if (screen.timeline.elicitation?.id === requestId) {
          screen.timeline = {
            ...screen.timeline,
            failure: result.error.message,
            elicitationRetryRevision: (screen.timeline.elicitationRetryRevision ?? 0) + 1,
          }
          refresh()
        }
        throw new Error(result.error.message)
      }
      // 提交成功后立即把表单决策写入时间线并关闭交互卡片，防止 host 的置空通知乱序。
      screen.timeline = applyLocalExecutionUpdate(screen.timeline, {
        kind: "elicitation-decision",
        turnId: screen.flight?.turnId ?? `elicitation:${requestId}`,
        requestId,
        title: pending.message,
        statusLabel: summarizeElicitationAnswer(answer),
      })
      refresh()
    },
    async cancel(scope, id) {
      const source = current.current.target
      const flight = source && screens.current.get(source.key)?.flight
      if (!source || !flight?.turnId || source.scope.accountId !== scope.accountId || source.scope.workspaceId !== scope.workspaceId
        || source.scope.projectId !== scope.projectId || source.scope.conversationId !== id) throw new Error("执行目标已变更。")
      const result = await host.cancel(source.scope, flight.bindingId, flight.turnId)
      if (!result.ok) throw new Error(result.error.message)
    },
    async answerPermission(id, requestId, optionId) {
      const source = current.current.target
      const screen = source && screens.current.get(source.key)
      const flight = screen?.flight
      const pendingPermission = screen?.timeline.permission
      if (!source || source.scope.conversationId !== id || !screen || !flight?.turnId || pendingPermission?.id !== requestId) {
        throw new Error("审批请求已变更。")
      }
      const turnId = flight.turnId
      const chosenOption = pendingPermission.options.find(option => option.id === optionId)
      const described = describePermissionRequest(pendingPermission)
      const result = await host.answerPermission(source.scope, flight.bindingId, turnId, requestId, optionId)
      if (!result.ok) {
        if (screen.timeline.permission?.id === requestId) {
          screen.timeline = { ...screen.timeline, failure: result.error.message,
            permissionRetryRevision: (screen.timeline.permissionRetryRevision ?? 0) + 1 }
          refresh()
        }
        throw new Error(result.error.message)
      }
      // 审批确认后立即把用户的真实决策写入本轮时间线历史，即使 permission:null 或 finished 先到达也不丢失。
      screen.timeline = applyLocalExecutionUpdate(screen.timeline, {
        kind: "permission-decision",
        turnId,
        requestId,
        title: pendingPermission.title,
        optionLabel: chosenOption?.label ?? optionId,
        description: described.description,
      })
      refresh()
    },
    ...(host.stageImage ? {
      async stageImage(input) {
        const source = current.current.target
        if (!source) throw new Error("会话目标尚未就绪。")
        const result = await host.stageImage!(source.scope, input)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    } : {}),
    ...(host.readImage ? {
      async readImage(imageId) {
        const source = current.current.target
        if (!source) return null
        const result = await host.readImage!(source.scope, imageId)
        if (!result.ok) return null
        return result.value
      },
    } : {}),
    ...(host.removeStagedImage ? {
      async removeStagedImage(imageId) {
        const source = current.current.target
        if (!source) return
        await host.removeStagedImage!(source.scope, imageId)
      },
    } : {}),
    async send(input) {
      const images = input.images?.length ? [...input.images] : undefined
      const attachments = extractFileAttachments(input.text, input.attachmentIds)
      if (input.attachmentIds.length > attachments.length && attachments.length === 0) {
        return { status: "rejected", message: "仅支持添加有效的本机文件或目录附件。" }
      }
      const source = current.current.target
      const scope = source?.scope
      if (!source || !scope || scope.accountId !== input.scope.accountId || scope.workspaceId !== input.scope.workspaceId
        || scope.projectId !== input.scope.projectId || scope.conversationId !== input.conversationId
        || source.directory !== input.directoryPath) {
        return { status: "rejected", message: "会话或工作目录已变化，请重新确认后发送。" }
      }
      const screen = screens.current.get(source.key)
      const status = readAvailability(source, input.conversationId)
      if (!screen?.binding) return { status: "rejected", message: status.reason ?? "当前无法发送。" }
      if (input.steer) {
        const turnId = screen.flight?.turnId
        if (!turnId || !screen.timeline.activeCanSteer || !isSteerText(input.text) || input.referenceIds.length || input.attachmentIds.length || images?.length) {
          return { status: "rejected", message: "当前轮无法追发这条消息，草稿已保留。" }
        }
        try {
          const result = await host.steer(scope, screen.binding.bindingId, turnId, {
            kind: "draft", requestId: crypto.randomUUID(), text: input.text,
          })
          if (!result.ok) return { status: "rejected", message: result.error.message }
          if (mounted.current) current.current.onAccepted(input.scope, input.conversationId, input.draftRevision)
          return { status: "accepted" }
        } catch {
          return { status: "rejected", message: "追发结果待确认，草稿已保留。请核对会话后再试。" }
        }
      }
      if (input.queue) {
        if (input.text.length > MAX_QUEUED_PROMPT_CHARS) {
          return { status: "rejected", message: "待发消息超过 16,384 字上限，请精简后再加入队列。" }
        }
        try {
          const result = await host.promptQueue(scope, { kind: "add", bindingId: screen.binding.bindingId, item: {
            requestId: crypto.randomUUID(), text: input.text, referenceIds: [...input.referenceIds], attachments,
            ...(images?.length ? { images } : {}),
          } })
          if (!result.ok) return { status: "rejected", message: result.error.message }
          applyQueue(screen, result.value)
          if (mounted.current) current.current.onAccepted(input.scope, input.conversationId, input.draftRevision)
          return { status: "accepted" }
        } catch {
          return { status: "unknown", message: "加入队列的结果待确认，请核对待发列表。" }
        }
      }
      if (!status.available) return { status: "rejected", message: status.reason ?? "当前无法发送。" }

      const flight: Flight = {
        scope: input.scope,
        bindingId: screen.binding.bindingId,
        draftRevision: input.draftRevision,
        referenceIds: [...input.referenceIds],
        ...(images?.length ? { images } : {}),
        requestId: crypto.randomUUID(),
        lastSequence: 0,
        unknown: false,
      }
      screen.flight = flight
      refresh()
      try {
        const result = images?.length
          ? await host.send(scope, flight.bindingId, flight.requestId, input.text, flight.referenceIds, attachments, images)
          : attachments.length > 0
            ? await host.send(scope, flight.bindingId, flight.requestId, input.text, flight.referenceIds, attachments)
            : await host.send(scope, flight.bindingId, flight.requestId, input.text, flight.referenceIds)
        if (flight.turnId) return { status: "accepted" }
        const receipt = result.ok ? result.value : { status: "rejected" as const, reason: result.error.message }
        if (receipt.status === "accepted") {
          if (mounted.current && screens.current.get(source.key) === screen && screen.flight === flight) {
            accept(screen, flight, scope.conversationId, receipt.turnId, input.text, receipt.canSteer, images, receipt.attachments, receipt.knowledgeStatus)
          }
          return { status: "accepted" }
        }
        screen.flight = undefined
        if ("unavailableReferenceId" in receipt && receipt.unavailableReferenceId) {
          screen.timeline = { ...screen.timeline, referenceFailure: { id: receipt.unavailableReferenceId, message: receipt.reason } }
        }
        if (mounted.current) refresh()
        return { status: "rejected", message: receipt.reason }
      } catch {
        if (flight.turnId) return { status: "accepted" }
        flight.unknown = true
        if (mounted.current) refresh()
        return { status: "unknown", message: unknownReason }
      }
    },
  }
}
