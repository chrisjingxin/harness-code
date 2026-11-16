/** 本机会话执行的页面适配。切换会话时保留在途提交和回复，只在原草稿修订上确认受理。 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react"
import { localExecutionKey } from "../../../local-execution-host.js"
import type {
  DesktopLocalExecutionHost,
  LocalExecutionAvailability,
  LocalExecutionBinding,
  LocalExecutionScope,
} from "../../../local-execution-host.js"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"
import type { LocalSessionExecutionPort } from "./contracts.js"
import { applyLocalExecutionUpdate, emptyLocalExecutionView } from "./local-execution-view.js"
import type { LocalExecutionView } from "./local-execution-view.js"

export const textOnlyReason = "本机 Agent 首轮仅支持纯文本。移除引用或附件后可发送，当前草稿已保留。"
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
  readonly requestId: string
  turnId?: string
  lastSequence: number
  unknown: boolean
}

type Screen = {
  timeline: LocalExecutionView
  preparedFor?: Target
  binding?: LocalExecutionBinding
  availability?: LocalExecutionAvailability
  terminal?: { readonly bindingId: string; readonly availability: LocalExecutionAvailability }
  flight?: Flight
}

/** 只为当前选中的本人原设备会话准备执行，其他本人本机会话仍可完成已受理的一轮。 */
export function useLocalExecution(
  host: DesktopLocalExecutionHost | undefined,
  project: ProjectNavigationScope | null,
  deviceId: string | null,
  conversationId: string | null,
  directory: string | null,
  selectionRevision: number,
  ownerName: string,
  onAccepted: (scope: ProjectNavigationScope, conversationId: string, revision: number) => void,
): LocalSessionExecutionPort | undefined {
  const accountId = project?.accountId
  const workspaceId = project?.workspaceId
  const projectId = project?.projectId
  const target = useMemo<Target | null>(() => {
    if (!accountId || !workspaceId || !projectId || !deviceId || !conversationId) return null
    const scope = { accountId, workspaceId, projectId, deviceId, conversationId }
    return { scope, key: localExecutionKey(scope), directory, selectionRevision }
  }, [accountId, workspaceId, projectId, deviceId, conversationId, directory, selectionRevision])
  const screens = useRef(new Map<string, Screen>())
  const current = useRef({ target, onAccepted, ownerName })
  const mounted = useRef(false)
  const [, refresh] = useReducer(revision => revision + 1, 0)

  useLayoutEffect(() => {
    current.current = { target, onAccepted, ownerName }
  }, [target, onAccepted, ownerName])

  function accept(screen: Screen, flight: Flight, conversationId: string, turnId: string, text: string): void {
    if (flight.turnId !== undefined) return
    flight.turnId = turnId
    screen.timeline = applyLocalExecutionUpdate(screen.timeline, {
      kind: "accepted",
      turnId,
      text,
      author: { id: flight.scope.accountId, displayName: current.current.ownerName },
    })
    current.current.onAccepted(flight.scope, conversationId, flight.draftRevision)
    refresh()
  }

  useEffect(() => {
    mounted.current = true
    const stop = host?.onNotice(notice => {
      const key = localExecutionKey(notice.scope)
      const screen = screens.current.get(key)
      if (notice.kind === "upload") {
        if (!screen && !notice.failure) return
        const target = screen ?? { timeline: emptyLocalExecutionView }
        target.timeline = applyLocalExecutionUpdate(target.timeline, notice)
        screens.current.set(key, target)
        refresh()
        return
      }
      if (!screen) return
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
        screen.timeline = { ...screen.timeline, permission: notice.request }
        refresh()
        return
      }
      screen.timeline = applyLocalExecutionUpdate(screen.timeline, notice.kind === "text"
        ? { kind: "assistant-text", turnId: notice.turnId, text: notice.text }
        : notice.kind === "tool" ? notice
          : { kind: "finished", turnId: notice.turnId, failure: notice.failure })
      if (notice.kind === "finished") {
        screen.flight = undefined
        screen.terminal = notice
        if (screen.binding?.bindingId === notice.bindingId) screen.availability = notice.availability
      }
      refresh()
    })
    return () => { mounted.current = false; stop?.(); screens.current.clear() }
  }, [host])

  useEffect(() => {
    if (!host || !target?.directory) return
    const screen = screens.current.get(target.key) ?? { timeline: emptyLocalExecutionView }
    screens.current.set(target.key, screen)
    if (screen.preparedFor?.directory === target.directory
      && screen.preparedFor.selectionRevision === target.selectionRevision && screen.binding) return
    let active = true
    screen.preparedFor = target
    screen.binding = undefined
    screen.availability = preparing
    const lastTerminal = screen.terminal
    refresh()
    void host.prepare(target.scope, target.directory).then(result => {
      if (!active) return
      screen.binding = result.ok ? result.value : undefined
      if (!result.ok) screen.availability = { available: false, reason: result.error.message }
      else screen.availability = screen.terminal !== lastTerminal && screen.terminal?.bindingId === result.value.bindingId
        ? screen.terminal.availability : result.value
      refresh()
    }).catch(() => {
      if (!active) return
      screen.availability = { available: false, reason: "无法确认本机执行能力，请重新选择工作目录。" }
      refresh()
    })
    return () => { active = false }
  }, [host, target])

  function readAvailability(selected: Target | null, id: string): LocalExecutionAvailability {
    if (id === "__new__") return readyOnOpen
    if (!selected?.directory || selected.scope.conversationId !== id) return { available: false, reason: "请先选择本机工作目录。" }
    const screen = screens.current.get(selected.key)
    if (screen?.flight) return {
      available: false,
      reason: screen.flight.turnId ? "等待当前回复完成。" : screen.flight.unknown ? unknownReason : "正在提交…",
    }
    return screen?.preparedFor?.directory === selected.directory && screen.preparedFor.selectionRevision === selected.selectionRevision
      ? screen.availability ?? preparing : preparing
  }

  if (!host) return undefined
  return {
    textOnly: true,
    commitsAcceptedDraft: true,
    getAvailability: id => readAvailability(target, id),
    getView: id => target?.scope.conversationId === id ? screens.current.get(target.key)?.timeline : undefined,
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
      if (!source || source.scope.conversationId !== id || !screen || !flight?.turnId || screen.timeline.permission?.id !== requestId) {
        throw new Error("审批请求已变更。")
      }
      const result = await host.answerPermission(source.scope, flight.bindingId, flight.turnId, requestId, optionId)
      if (!result.ok) {
        if (screen.timeline.permission?.id === requestId) {
          screen.timeline = { ...screen.timeline, failure: result.error.message,
            permissionRetryRevision: (screen.timeline.permissionRetryRevision ?? 0) + 1 }
          refresh()
        }
        throw new Error(result.error.message)
      }
    },
    async send(input) {
      if (input.referenceIds.length || input.attachmentIds.length) return { status: "rejected", message: textOnlyReason }
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
        requestId: crypto.randomUUID(),
        lastSequence: 0,
        unknown: false,
      }
      screen.flight = flight
      refresh()
      try {
        const result = await host.send(scope, flight.bindingId, flight.requestId, input.text)
        if (flight.turnId) return { status: "accepted" }
        const receipt = result.ok ? result.value : { status: "rejected" as const, reason: result.error.message }
        if (receipt.status === "accepted") {
          if (mounted.current && screens.current.get(source.key) === screen && screen.flight === flight) {
            accept(screen, flight, scope.conversationId, receipt.turnId, input.text)
          }
          return { status: "accepted" }
        }
        screen.flight = undefined
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
