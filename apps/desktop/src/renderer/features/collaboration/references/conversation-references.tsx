/**
 * 会话引用从取材、确认到草稿应用。会话数据、目录选择、草稿和定位由桌面装配方提供。
 * 加入草稿 → 应用固定材料 → 定位目标会话。定位失败时只重试最后一步。
 */
import { useId, useLayoutEffect, useRef, useState } from "react"
import type { SnapshotRequestedRange } from "@workbench/contracts"
import type { ConversationActions, ConversationMentionOrigin, ConversationReferenceView, ConversationScope } from "@workbench/ui"
import type { SessionDraftScope, SessionDraftTarget, SessionReferenceDraftResult } from "../../session/index.js"
import "./references.css"

/** 取材与草稿变更使用发起会话的账号、项目及当前设备。 */
export type ReferenceScope = SessionDraftScope & { readonly pageKey?: string }

/** 同一个快照标识对应一份固定材料。展示和草稿动作消费同一份正文。 */
export interface ConversationSnapshot {
  readonly id: string
  readonly title: string
  readonly owner: string
  readonly version: string
  readonly uploadedAt: string
  readonly rangeLabel: string
  readonly text: string
  readonly sourceConversationId?: string
  readonly archived?: boolean
}

/** 装配方已确认属于当前账号、项目及设备的可选会话。 */
export interface ReferenceSession {
  readonly id: string
  readonly title: string
  readonly directory?: string | null
}

export type SnapshotRequest =
  | { readonly kind: "preview"; readonly conversationId: string; readonly range?: SnapshotRequestedRange }
  | { readonly kind: "fixed"; readonly referenceId: string }
  | { readonly kind: "refresh"; readonly referenceId: string }

export type ReferenceDraftChange =
  | { readonly kind: "add"; readonly target: SessionDraftTarget; readonly snapshot: ConversationSnapshot; readonly mention?: ConversationMentionOrigin }
  | { readonly kind: "replace"; readonly referenceId: string; readonly snapshot: ConversationSnapshot }
  | { readonly kind: "remove"; readonly referenceId: string }

type Failure = { readonly ok: false; readonly message: string }
export type ReferenceResult<T> = { readonly ok: true; readonly value: T } | Failure
/** 草稿回调成功表示已应用变更。若新会话已经建成但合并失败，返回其 ID 供重试。 */
export interface ReferenceActions {
  readSnapshot(scope: ReferenceScope, request: SnapshotRequest): Promise<ReferenceResult<ConversationSnapshot>>
  chooseDirectory(scope: ReferenceScope): Promise<ReferenceResult<string | null>>
  applyDraft(scope: ReferenceScope, change: ReferenceDraftChange): Promise<SessionReferenceDraftResult | (Failure & { readonly materialUnavailable: true })>
  locateConversation(scope: ReferenceScope, conversationId: string): Promise<ReferenceResult<null>>
  openSource?(scope: ReferenceScope, referenceId: string): Promise<ReferenceResult<null>>
}

type Selection = SessionDraftTarget | { readonly kind: "new"; readonly directory: null }

type Flow = { readonly key: string; readonly request: SnapshotRequest; readonly mention?: ConversationMentionOrigin } & (
  | { readonly phase: "reading" }
  | { readonly phase: "read-error"; readonly message: string }
  | {
      readonly phase: "preview"
      readonly snapshot: ConversationSnapshot
      readonly selection: Selection | null
      readonly busy?: "directory" | "applying"
      readonly message?: string
    }
  | { readonly phase: "locating"; readonly conversationId: string }
  | { readonly phase: "location-error"; readonly conversationId: string; readonly message: string }
)

type Preview = Extract<Flow, { phase: "preview" }>

function conversationKey(scope: ConversationScope | ReferenceScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId])
}

async function runAction<T>(action: () => Promise<T>, message: string): Promise<T | Failure> {
  try {
    return await action()
  } catch {
    return { ok: false, message }
  }
}

/** 用固定材料装配现有输入区引用卡。无权读取时只显示不可用提示。 */
export function snapshotReferenceView(
  snapshot: ConversationSnapshot,
  availability: { readonly enabled: boolean; readonly reason?: string } = { enabled: true },
  canOpenSource = false,
): ConversationReferenceView {
  return {
    id: snapshot.id,
    sourceLabel: availability.enabled ? `${snapshot.owner} · ${snapshot.title}` : "引用不可用",
    rangeLabel: availability.enabled ? `${snapshot.version} · ${snapshot.rangeLabel}` : "",
    snapshotText: availability.enabled ? snapshot.text : "",
    status: availability.enabled ? "ready" : "unavailable",
    message: availability.reason,
    actions: {
      open: availability.enabled && canOpenSource ? { enabled: true } : { enabled: false, reason: "来源定位暂不可用。" },
      refresh: availability,
      remove: { enabled: true },
    },
  }
}

/** 供单一 ConversationView 装配引用交互。切换账号、项目、设备或会话时丢弃旧预览结果。 */
export function useConversationReferences(
  scope: ReferenceScope | null,
  sessions: readonly ReferenceSession[],
  actions: ReferenceActions,
  supportsRange = false,
) {
  const origin = scope ? conversationKey(scope) : ""
  const key = scope ? JSON.stringify([origin, scope.projectId, scope.deviceId, scope.pageKey]) : ""
  const [flow, setFlow] = useState<Flow | null>(null)
  const [notice, setNotice] = useState("")
  const active = useRef<Flow | null>(null)
  const cardAction = useRef<symbol | null>(null)

  useLayoutEffect(() => {
    setFlow(null)
    setNotice("")
    return () => { active.current = null; cardAction.current = null }
  }, [key])

  function show(next: Flow | null): void {
    active.current = next
    setFlow(next)
  }

  async function load(request: SnapshotRequest, mention?: ConversationMentionOrigin): Promise<void> {
    if (!scope) return
    const pending: Flow = { key, request, mention, phase: "reading" }
    show(pending)
    const result = await runAction(() => actions.readSnapshot(scope, request), "无法读取会话快照，请重试。")
    if (active.current !== pending) return
    show(result.ok
      ? { ...pending, phase: "preview", snapshot: Object.freeze({ ...result.value }), selection: null }
      : { ...pending, phase: "read-error", message: result.message })
  }

  async function chooseDirectory(current: Preview): Promise<void> {
    if (!scope) return
    const pending: Preview = { ...current, busy: "directory", message: undefined }
    show(pending)
    const result = await runAction(() => actions.chooseDirectory(scope), "无法选择工作目录，请重试。")
    if (active.current !== pending) return
    if (!result.ok) {
      show({ ...current, message: result.message })
      return
    }
    const previousDirectory = current.selection?.kind === "new" ? current.selection.directory : null
    if (!result.value || result.value === previousDirectory) {
      show(current)
      return
    }
    show({ ...current, selection: { kind: "new", directory: result.value, requestId: crypto.randomUUID() } })
  }

  async function locate(request: SnapshotRequest, conversationId: string): Promise<void> {
    if (!scope) return
    const pending: Flow = { key, request, phase: "locating", conversationId }
    show(pending)
    const result = await runAction(() => actions.locateConversation(scope, conversationId), "无法打开目标会话。")
    if (active.current !== pending) return
    show(result.ok ? null : { ...pending, phase: "location-error", message: result.message })
  }

  async function apply(current: Preview): Promise<void> {
    if (!scope) return
    const { request, snapshot, selection, mention } = current
    let change: ReferenceDraftChange
    if (request.kind === "refresh") {
      change = { kind: "replace", referenceId: request.referenceId, snapshot }
    } else if (selection?.kind === "existing") {
      if (!sessions.some(session => session.id === selection.conversationId)) {
        show({ ...current, message: "目标会话不可用，请重新选择。" })
        return
      }
      change = { kind: "add", target: selection, snapshot, mention }
    } else if (selection?.directory) {
      change = { kind: "add", target: selection, snapshot, mention }
    } else {
      return
    }

    const pending: Preview = { ...current, busy: "applying", message: undefined }
    show(pending)
    const result = await runAction(() => actions.applyDraft(scope, change), "无法应用草稿变更，请重试。")
    if (active.current !== pending) return
    if (!result.ok) {
      if ("materialUnavailable" in result) {
        show({ key, request, mention, phase: "read-error", message: result.message })
      } else if (selection?.kind === "new" && selection.directory && "preparedConversationId" in result && result.preparedConversationId) {
        show({
          ...current,
          selection: { ...selection, preparedConversationId: result.preparedConversationId },
          message: `会话已登记。重试将继续使用该会话。${result.message}`,
        })
      } else {
        show({ ...current, message: result.message })
      }
      return
    }
    if (request.kind === "refresh") show(null)
    else await locate(request, result.value.conversationId)
  }

  async function runCardAction<T>(perform: () => Promise<ReferenceResult<T>>, failureMessage: string): Promise<void> {
    const request = Symbol()
    cardAction.current = request
    setNotice("")
    const result = await runAction(perform, failureMessage)
    if (cardAction.current !== request) return
    cardAction.current = null
    if (!result.ok) setNotice(result.message)
  }

  const onReferenceAction: NonNullable<ConversationActions["onReferenceAction"]> = (source, id, action) => {
    if (!scope || conversationKey(source) !== origin || active.current || cardAction.current) return
    if (action === "refresh") void load({ kind: "refresh", referenceId: id })
    if (action === "remove") void runCardAction(() => actions.applyDraft(scope, { kind: "remove", referenceId: id }), "无法移除引用，请重试。")
    if (action === "open" && actions.openSource) {
      const openSource = actions.openSource
      void runCardAction(() => openSource(scope, id), "无法打开引用来源。")
    }
  }

  const dialog = flow?.key === key ? (
    <ReferenceDialog
      flow={flow}
      sessions={sessions}
      onRange={supportsRange ? range => {
        if (active.current === flow && flow.request.kind === "preview") void load({ ...flow.request, range }, flow.mention)
      } : undefined}
      onClose={() => {
        if (active.current === flow && flow.phase !== "locating" && !(flow.phase === "preview" && flow.busy)) show(null)
      }}
      onRetry={() => {
        if (active.current !== flow) return
        if (flow.phase === "read-error") void load(flow.request, flow.mention)
        if (flow.phase === "location-error") void locate(flow.request, flow.conversationId)
      }}
      onSelect={selection => {
        if (active.current === flow && flow.phase === "preview" && !flow.busy) show({ ...flow, selection, message: undefined })
      }}
      onChooseDirectory={() => {
        if (active.current === flow && flow.phase === "preview" && !flow.busy) void chooseDirectory(flow)
      }}
      onApply={() => {
        if (active.current === flow && flow.phase === "preview" && !flow.busy) void apply(flow)
      }}
    />
  ) : null

  return {
    previewConversation(conversationId: string, mention?: ConversationMentionOrigin) {
      if (!active.current && !cardAction.current) void load({ kind: "preview", conversationId }, mention)
    },
    previewFixed(referenceId: string, mention?: ConversationMentionOrigin) {
      if (!active.current && !cardAction.current) void load({ kind: "fixed", referenceId }, mention)
    },
    onReferenceAction,
    dialog,
    notice,
  }
}

const ranges: readonly { id: string; label: string; range?: SnapshotRequestedRange }[] = [
  { id: "auto", label: "默认范围" },
  { id: "latest5", label: "最近 5 条", range: { type: "latest", count: 5 } },
  { id: "latest1", label: "最近 1 条", range: { type: "latest", count: 1 } },
  { id: "brief", label: "已同步简报", range: { type: "brief" } },
]

function ReferenceDialog({ flow, sessions, onRange, onClose, onRetry, onSelect, onChooseDirectory, onApply }: {
  flow: Flow
  sessions: readonly ReferenceSession[]
  onRange?(range?: SnapshotRequestedRange): void
  onClose(): void
  onRetry(): void
  onSelect(selection: Selection): void
  onChooseDirectory(): void
  onApply(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const targets = useId()
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])

  const preview = flow.phase === "preview" ? flow : null
  const refreshing = flow.request.kind === "refresh"
  const busy = flow.phase === "locating" || Boolean(preview?.busy)
  const selection = preview?.selection
  const canApply = refreshing || (selection?.kind === "existing"
    ? sessions.some(session => session.id === selection.conversationId)
    : Boolean(selection?.directory))
  const retry = flow.phase === "read-error" || flow.phase === "location-error"
  const range = flow.request.kind === "preview" ? flow.request.range : undefined
  const rangeId = ranges.find(item => JSON.stringify(item.range) === JSON.stringify(range))?.id ?? "auto"
  return (
    <dialog ref={dialog} className="conversation-reference-dialog" aria-labelledby={title} onCancel={event => {
      event.preventDefault()
      onClose()
    }}>
      <h2 id={title}>{refreshing ? "刷新引用预览" : "会话引用预览"}</h2>
      {onRange && flow.request.kind === "preview" && (flow.phase === "preview" || flow.phase === "reading" || flow.phase === "read-error") &&
        <label>取材范围 <select value={rangeId} disabled={busy || flow.phase === "reading"}
          onChange={event => onRange(ranges.find(item => item.id === event.target.value)?.range)}>
          {ranges.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select></label>}
      {flow.phase === "reading" && <p role="status">正在读取引用…</p>}
      {flow.phase === "locating" && <p role="status">已加入草稿，正在打开目标会话…</p>}
      {flow.phase === "location-error" && <p role="alert">已加入草稿。{flow.message}</p>}
      {flow.phase === "read-error" && <p role="alert">{flow.message}</p>}
      {preview && <>
        <div className="conversation-reference-material">
          <h3>{preview.snapshot.title}</h3>
          <dl>
            <div><dt>所有者</dt><dd>{preview.snapshot.owner}</dd></div>
            <div><dt>版本</dt><dd>{preview.snapshot.version}</dd></div>
            <div><dt>上传时间</dt><dd>{preview.snapshot.uploadedAt}</dd></div>
            <div><dt>范围</dt><dd>{preview.snapshot.rangeLabel}</dd></div>
          </dl>
          <div className="conversation-reference-text" aria-label="快照正文" role="region" tabIndex={0}>{preview.snapshot.text}</div>
        </div>
        {!refreshing && <fieldset className="conversation-reference-targets" disabled={busy}>
          <legend>加入我的会话</legend>
          {sessions.map(session => (
            <label key={session.id}>
              <input
                type="radio"
                name={targets}
                checked={selection?.kind === "existing" && selection.conversationId === session.id}
                onChange={() => onSelect({ kind: "existing", conversationId: session.id })}
              />
              <span>{session.title}{session.directory && <small>{session.directory}</small>}</span>
            </label>
          ))}
          <label>
            <input
              type="radio"
              name={targets}
              checked={selection?.kind === "new"}
              onChange={() => onSelect({ kind: "new", directory: null })}
            />
            <span>新建会话</span>
          </label>
          {selection?.kind === "new" && (
            <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={"preparedConversationId" in selection} onClick={onChooseDirectory}>
              {selection.directory ?? "选择文件夹"}
            </button>
          )}
        </fieldset>}
        {preview.message && <p role="alert">{preview.message}</p>}
        {preview.busy && <p role="status">{preview.busy === "directory" ? "正在选择目录…" : "正在应用草稿变更…"}</p>}
      </>}
      <div className="conversation-reference-footer">
        <button type="button" className="wb-button wb-button-secondary" disabled={busy} onClick={onClose}>
          {flow.phase === "location-error" ? "关闭" : "取消"}
        </button>
        {retry && <button type="button" className="wb-button wb-button-primary" onClick={onRetry}>
          {flow.phase === "location-error" ? "重试定位" : "重试读取"}
        </button>}
        {preview && <button type="button" className="wb-button wb-button-primary" disabled={busy || !canApply} onClick={onApply}>
          {refreshing ? "替换草稿引用" : "加入草稿"}
        </button>}
      </div>
    </dialog>
  )
}
