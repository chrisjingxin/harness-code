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
import { localExecutionKey } from "../../../local-execution-host.js"
import type {
  DesktopLocalExecutionHost,
  LocalExecutionAvailability,
  LocalExecutionBinding,
  LocalExecutionElicitationAnswer,
  LocalExecutionElicitationRequest,
  LocalExecutionNotice,
  LocalExecutionProviderList,
  LocalExecutionScope,
  LocalExecutionSessionState,
} from "../../../local-execution-host.js"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"
import type { LocalSessionExecutionPort } from "./contracts.js"
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
  readonly key: string
  readonly directory: string | null
  readonly selectionRevision: number
}

type Flight = {
  readonly scope: ProjectNavigationScope
  readonly bindingId: string
  readonly draftRevision: number
  readonly referenceIds: readonly string[]
  readonly requestId: string
  turnId?: string
  lastSequence: number
  unknown: boolean
}

type BufferedBindingNotices = {
  sessionState?: LocalExecutionSessionState
  elicitation?: LocalExecutionElicitationRequest | null
}

type Screen = {
  timeline: LocalExecutionView
  preparedFor?: Target
  preparedForProvider?: string
  prepareToken?: number
  retiredBindingId?: string
  binding?: LocalExecutionBinding
  availability?: LocalExecutionAvailability
  terminal?: { readonly bindingId: string; readonly availability: LocalExecutionAvailability }
  flight?: Flight
  pendingBindingNotices?: Map<string, BufferedBindingNotices>
}

function summarizeElicitationAnswer(answer: LocalExecutionElicitationAnswer): string {
  if (answer.action === "decline") return "已跳过（拒绝填写）"
  if (answer.action === "cancel") return "已取消"
  const decision = typeof answer.content?.decision === "string" ? answer.content.decision : undefined
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
  project: ProjectNavigationScope | null,
  conversationId: string | null,
  directory: string | null,
  selectionRevision: number,
  ownerName: string,
  onAccepted: (scope: ProjectNavigationScope, conversationId: string, revision: number) => void,
  onWorkspaceRefresh?: (scope: ProjectNavigationScope, conversationId: string) => void,
  preferredProviders?: Readonly<Record<string, string>>,
): LocalSessionExecutionPort | undefined {
  const accountId = project?.accountId
  const workspaceId = project?.workspaceId
  const projectId = project?.projectId
  const target = useMemo<Target | null>(() => {
    if (!accountId || !workspaceId || !projectId || !conversationId) return null
    const scope = { accountId, workspaceId, projectId, conversationId }
    return { scope, key: localExecutionKey(scope), directory, selectionRevision }
  }, [accountId, workspaceId, projectId, conversationId, directory, selectionRevision])

  const screens = useRef(new Map<string, Screen>())
  const providersRef = useRef<LocalExecutionProviderList | undefined>(undefined)
  const providerOverrides = useRef(new Map<string, string>())
  const current = useRef({ target, onAccepted, onWorkspaceRefresh, ownerName, preferredProviders })
  const mounted = useRef(false)
  const [, refresh] = useReducer(revision => revision + 1, 0)

  useLayoutEffect(() => {
    current.current = { target, onAccepted, onWorkspaceRefresh, ownerName, preferredProviders }
  }, [target, onAccepted, onWorkspaceRefresh, ownerName, preferredProviders])

  function applyElicitationNotice(
    scope: LocalExecutionScope,
    bindingId: string,
    screen: Screen,
    request: LocalExecutionElicitationRequest | null,
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
      screen.timeline = applyLocalExecutionUpdate(screen.timeline, { kind: "session-state", state: buffered.sessionState })
    }
    if (buffered.elicitation !== undefined) {
      applyElicitationNotice(scope, bindingId, screen, buffered.elicitation)
    }
  }

  function accept(screen: Screen, flight: Flight, conversationId: string, turnId: string, text: string): void {
    if (flight.turnId !== undefined) return
    flight.turnId = turnId
    screen.timeline = applyLocalExecutionUpdate(screen.timeline, {
      kind: "accepted",
      turnId,
      text,
      referenceIds: flight.referenceIds,
      author: { id: flight.scope.accountId, displayName: current.current.ownerName },
    })
    current.current.onAccepted(flight.scope, conversationId, flight.draftRevision)
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
        if (!screen && !notice.failure) return
        const nextScreen = screen ?? { timeline: emptyLocalExecutionView }
        nextScreen.timeline = applyLocalExecutionUpdate(nextScreen.timeline, notice)
        screens.current.set(key, nextScreen)
        refresh()
        return
      }
      if (!screen) return

      if (notice.kind === "session-state") {
        if (screen.binding?.bindingId === notice.bindingId) {
          screen.timeline = applyLocalExecutionUpdate(screen.timeline, { kind: "session-state", state: notice.state })
          refresh()
        } else if (!screen.binding && notice.bindingId !== screen.retiredBindingId) {
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

      const flight = screen?.flight
      if (!flight) {
        // 窗口页面重载时可能只恢复了当前绑定。旧轮正文不回放，但终态仍可解除忙状态。
        if (notice.kind === "finished" && screen.preparedFor) {
          screen.terminal = notice
          if (screen.binding?.bindingId === notice.bindingId) {
            screen.availability = notice.availability
            refresh()
          }
        }
        return
      }
      if (flight.bindingId !== notice.bindingId) return
      if (notice.kind === "accepted") {
        if (flight.requestId === notice.requestId) accept(screen, flight, notice.scope.conversationId, notice.turnId, notice.text)
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
            : { kind: "finished", turnId: notice.turnId, failure: notice.failure })
      if (notice.kind === "tool"
        && (notice.tool.status === "completed" || notice.tool.status === "failed")
        && (WORKSPACE_MUTATING_TOOL_KINDS.has(notice.tool.kind ?? "") || Boolean(notice.tool.diffs?.length))) {
        current.current.onWorkspaceRefresh?.(flight.scope, notice.scope.conversationId)
      }
      if (notice.kind === "finished") {
        screen.flight = undefined
        screen.terminal = notice
        if (screen.binding?.bindingId === notice.bindingId) screen.availability = notice.availability
        current.current.onWorkspaceRefresh?.(flight.scope, notice.scope.conversationId)
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
    return providerOverrides.current.get(targetInfo.key) ?? current.current.preferredProviders?.[targetInfo.scope.conversationId]
  }

  useEffect(() => {
    if (!host || !target?.directory) return
    const desiredProvider = resolveDesiredProviderId(target)
    const screen = screens.current.get(target.key) ?? { timeline: emptyLocalExecutionView }
    screens.current.set(target.key, screen)
    if (
      screen.preparedFor?.directory === target.directory
      && screen.preparedFor.selectionRevision === target.selectionRevision
      && screen.preparedForProvider === desiredProvider
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
    screen.availability = preparing
    const lastTerminal = screen.terminal
    refresh()
    void host.prepare(target.scope, target.directory, desiredProvider).then(result => {
      if (!active || screen.prepareToken !== token) return
      screen.binding = result.ok ? result.value : undefined
      if (!result.ok) {
        screen.availability = { available: false, reason: result.error.message }
      } else {
        screen.availability = screen.terminal !== lastTerminal && screen.terminal?.bindingId === result.value.bindingId
          ? screen.terminal.availability
          : result.value
        flushBufferedNotices(target.scope, result.value.bindingId, screen)
      }
      refresh()
    }).catch(() => {
      if (!active || screen.prepareToken !== token) return
      screen.availability = { available: false, reason: "无法确认本机执行能力，请重新选择工作目录。" }
      refresh()
    })
    return () => { active = false }
  }, [host, target, preferredProviders])

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
      && screen.preparedForProvider === desiredProvider
      ? screen.availability ?? preparing : preparing
  }

  if (!host) return undefined
  return {
    textOnly: false,
    commitsAcceptedDraft: true,
    getAvailability: id => readAvailability(target, id),
    getView: id => target?.scope.conversationId === id ? screens.current.get(target.key)?.timeline : undefined,
    getProviders: () => providersRef.current,
    getSelectedProviderId: id => {
      if (!target || target.scope.conversationId !== id) return providersRef.current?.defaultProviderId ?? undefined
      const screen = screens.current.get(target.key)
      return screen?.timeline.sessionState?.providerId
        ?? screen?.binding?.providerId
        ?? providerOverrides.current.get(target.key)
        ?? current.current.preferredProviders?.[id]
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
      screen.timeline = { ...screen.timeline, sessionState: undefined, elicitation: null }
      refresh()

      const result = await host.prepare(source.scope, source.directory, providerId)
      if (!mounted.current || screens.current.get(source.key) !== screen || screen.prepareToken !== token) return
      screen.binding = result.ok ? result.value : undefined
      if (!result.ok) {
        screen.availability = { available: false, reason: result.error.message }
        refresh()
        throw new Error(result.error.message)
      }
      screen.availability = result.value
      flushBufferedNotices(source.scope, result.value.bindingId, screen)
      refresh()
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
    async send(input) {
      const attachments = extractFileAttachments(input.text, input.attachmentIds)
      if (input.attachmentIds.length > attachments.length && attachments.length === 0) {
        return { status: "rejected", message: "仅支持添加当前工作区内的相对路径文件附件。" }
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
      if (!screen?.binding || !status.available) return { status: "rejected", message: status.reason ?? "当前无法发送。" }

      const flight: Flight = {
        scope: input.scope,
        bindingId: screen.binding.bindingId,
        draftRevision: input.draftRevision,
        referenceIds: [...input.referenceIds],
        requestId: crypto.randomUUID(),
        lastSequence: 0,
        unknown: false,
      }
      screen.flight = flight
      refresh()
      try {
        const result = attachments.length > 0
          ? await host.send(scope, flight.bindingId, flight.requestId, input.text, flight.referenceIds, attachments)
          : await host.send(scope, flight.bindingId, flight.requestId, input.text, flight.referenceIds)
        if (flight.turnId) return { status: "accepted" }
        const receipt = result.ok ? result.value : { status: "rejected" as const, reason: result.error.message }
        if (receipt.status === "accepted") {
          if (mounted.current && screens.current.get(source.key) === screen && screen.flight === flight) {
            accept(screen, flight, scope.conversationId, receipt.turnId, input.text)
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
