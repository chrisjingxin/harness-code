/**
 * 本机执行结果到中央对话的投影。装配方按会话持有状态，将已排序、去重的文本更新
 * 交给本模块。这里只归并显示条目，不消费 ACP 帧或云端同步历史。
 */
import type { LocalExecutionPermission, LocalExecutionTool } from "../../../local-execution-host.js"
import type { ConversationTimelineEntry, ConversationViewProps } from "@workbench/ui"

type Message = Extract<ConversationTimelineEntry, { kind: "message" }>
type Tool = Extract<ConversationTimelineEntry, { kind: "tool" }>

/** 同一账号、项目、设备和会话的本机增量视图。 */
export type LocalExecutionView = {
  readonly activeTurnId: string | null
  readonly entries: readonly (Message | Tool)[]
  readonly revision: number
  readonly permissionRetryRevision?: number
  readonly permission?: LocalExecutionPermission | null
  readonly failure: string | null
  readonly uploadFailures?: ReadonlyMap<string, string>
}

export const emptyLocalExecutionView: LocalExecutionView = {
  activeTurnId: null,
  entries: [],
  revision: 0,
  failure: null,
}

/** 仅供桌面装配使用的显示更新。已明确受理后才追加用户消息。 */
export type LocalExecutionViewUpdate =
  | { readonly kind: "accepted"; readonly turnId: string; readonly text: string; readonly author: Message["author"] }
  | { readonly kind: "tool"; readonly turnId: string; readonly tool: LocalExecutionTool }
  | { readonly kind: "assistant-text"; readonly turnId: string; readonly text: string }
  | { readonly kind: "finished"; readonly turnId: string; readonly failure?: string }
  | { readonly kind: "upload"; readonly turnId: string; readonly failure?: string }

export function applyLocalExecutionUpdate(state: LocalExecutionView, update: LocalExecutionViewUpdate): LocalExecutionView {
  if (update.kind === "upload") {
    if (state.uploadFailures?.get(update.turnId) === update.failure) return state
    const uploadFailures = new Map(state.uploadFailures)
    if (update.failure) uploadFailures.set(update.turnId, update.failure)
    else uploadFailures.delete(update.turnId)
    return { ...state, uploadFailures }
  }
  const entryPrefix = `local-execution:${update.turnId}`
  if (update.kind === "accepted") {
    const id = `${entryPrefix}:user`
    if (state.activeTurnId !== null || state.entries.some(entry => entry.id === id)) return state
    return {
      ...state,
      activeTurnId: update.turnId,
      entries: [...state.entries, { kind: "message", id, role: "user", text: update.text, author: update.author }],
      revision: state.revision + 1,
      failure: null,
    }
  }
  // 结束后迟到的分段不能重开这轮对话，也不能写进后来开始的另一轮。
  if (state.activeTurnId !== update.turnId) return state

  if (update.kind === "tool") {
    const id = `${entryPrefix}:tool:${update.tool.id}`
    const existing = state.entries.find((item): item is Tool => item.id === id && item.kind === "tool")
    const status = update.tool.status
    const item: Tool = {
      kind: "tool", id, label: update.tool.title ?? existing?.label ?? "Agent 工具", tone: "neutral",
      status: status === "completed" || status === "failed" ? status : status ? "running" : existing?.status ?? "running",
    }
    const entries = existing ? state.entries.map(entry => entry === existing ? item : entry) : [...state.entries, item]
    return { ...state, entries, revision: state.revision + 1 }
  }
  const id = `${entryPrefix}:assistant`
  if (update.kind === "assistant-text") {
    if (!update.text) return state
    const message = state.entries.find(entry => entry.id === id)
    const entries = message?.kind === "message"
      ? state.entries.map(entry => entry === message ? { ...message, text: message.text + update.text } : entry)
      : [...state.entries, { kind: "message", id, role: "assistant", text: update.text, streaming: true } satisfies Message]
    return { ...state, entries, revision: state.revision + 1 }
  }

  const entries = state.entries.map(entry => {
    if (entry.id === id && entry.kind === "message") return { ...entry, streaming: false }
    if (entry.kind === "tool" && entry.id.startsWith(`${entryPrefix}:tool:`) && entry.status === "running") {
      return { ...entry, status: "failed" as const }
    }
    return entry
  })
  return {
    ...state,
    activeTurnId: null,
    permission: null,
    entries,
    revision: state.revision + Number(entries !== state.entries),
    failure: update.failure ?? null,
  }
}

type ConversationExecutionProps = Pick<ConversationViewProps, "entries" | "contentRevision" | "composer" | "activity">

/**
 * 在已有历史之后展示会话本机增量。装配方保证两组条目没有重复，并保留
 * 宿主给出的发送可用性。执行中只暴露已交付且当前可用的停止动作。
 */
export function projectLocalExecution(
  base: Omit<ConversationExecutionProps, "activity">,
  execution: LocalExecutionView,
): ConversationExecutionProps {
  const running = execution.activeTurnId !== null
  const canCancel = base.composer.cancel.enabled
    && (base.composer.primaryActions === "cancel" || base.composer.primaryActions === "both")
  return {
    entries: execution.entries.length ? [...base.entries, ...execution.entries] : base.entries,
    contentRevision: base.contentRevision + execution.revision,
    activity: running ? { active: true, label: "Agent 正在回复" } : null,
    composer: {
      ...base.composer,
      send: running ? { enabled: false, reason: "等待当前回复完成" } : base.composer.send,
      primaryActions: running && canCancel ? "cancel" : base.composer.primaryActions,
      statusText: execution.failure ?? execution.uploadFailures?.values().next().value ?? base.composer.statusText,
    },
  }
}
