/** 显示本机待发消息和暂停状态，编辑时保留原有引用与附件。 */
import { useId, useRef, useState } from "react"
import { IconArrowRight, IconCheck, IconChevronDown, IconPencil, IconPhoto, IconQuote, IconTrash, IconX } from "@tabler/icons-react"
import { isSteerText, type PromptQueueView } from "../../../shared/index.js"
import { parseAnnotatedUserMessage } from "../../../ui/index.js"
import type { LocalSessionExecutionPort } from "./contracts.js"

export function PromptQueuePanel({
  queue, canResume, onAction, onSteer,
}: {
  readonly queue: PromptQueueView
  readonly canResume: boolean
  readonly onAction: (action: Parameters<NonNullable<LocalSessionExecutionPort["promptQueue"]>>[1]) => Promise<void>
  readonly onSteer?: (requestId: string) => Promise<void>
}) {
  const [edit, setEdit] = useState<{ requestId: string; text: string }>()
  const [expanded, setExpanded] = useState(true)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const listId = useId()

  async function apply(action: Parameters<typeof onAction>[0] | { kind: "steer"; requestId: string }) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError("")
    try {
      if (action.kind === "steer") await onSteer?.(action.requestId)
      else await onAction(action)
      if (action.kind === "edit" || action.kind === "remove") setEdit(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "待发队列操作失败，请重试。")
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  return (
    <section className="session-prompt-queue" aria-label="待发消息">
      <header className="session-queue-header">
        <div className="session-queue-heading">
          <span className="session-queue-title">待发消息</span>
          <span className="session-queue-count">{queue.items.length}</span>
        </div>
        <div className="session-queue-actions">
          {queue.paused && !queue.starting ? (
            <button type="button" className="session-queue-resume" aria-label="继续发送" title="继续发送"
              disabled={!canResume || busy} onClick={() => void apply({ kind: "resume" })}>
              <IconArrowRight size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label={expanded ? "折叠待发消息" : "展开待发消息"}
            title={expanded ? "折叠" : "展开"} aria-expanded={expanded} aria-controls={listId}
            onClick={() => setExpanded(open => !open)}>
            <IconChevronDown size={15} className="session-queue-chevron" aria-hidden="true" />
          </button>
        </div>
      </header>
      {queue.pausedReason ? <p role="status">{queue.pausedReason}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <ol id={listId} aria-label="发送顺序" hidden={!expanded}>
        {queue.items.map((item, index) => {
          const editing = edit?.requestId === item.requestId
          return (
            <li key={item.requestId} className="session-queue-item">
              {editing ? (
                <textarea aria-label={`编辑第 ${index + 1} 条待发消息`} rows={2} maxLength={16_384} value={edit.text}
                  onChange={event => setEdit({ requestId: item.requestId, text: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === "Escape") { event.preventDefault(); setEdit(undefined) }
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      void apply({ kind: "edit", ...edit })
                    }
                  }} />
              ) : (() => {
                const parsed = parseAnnotatedUserMessage(item.text)
                const summaryText = parsed ? parsed.body : item.text
                const annotationCount = parsed?.annotations.length ?? 0
                const imageCount = item.images?.length ?? 0
                const refCount = item.referenceIds.length + item.attachments.length
                return (
                  <span className="session-prompt-queue-text" title={item.text}>
                    {summaryText || (!annotationCount && !imageCount ? "引用或附件" : null)}
                    {annotationCount > 0 ? (
                      <small style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: summaryText ? 6 : 0 }}>
                        <IconQuote size={12} aria-hidden="true" />
                        <span>{annotationCount}</span>
                      </small>
                    ) : null}
                    {imageCount > 0 ? (
                      <small style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: (summaryText || annotationCount) ? 6 : 0 }}>
                        <IconPhoto size={12} aria-hidden="true" />
                        <span>{imageCount}</span>
                      </small>
                    ) : null}
                    {refCount ? <small> · {refCount} 个引用或附件</small> : null}
                  </span>
                )
              })()}
              <span className="session-queue-actions">
                {editing ? (
                  <>
                    <button type="button" aria-label="保存编辑" title="保存编辑" disabled={busy}
                      onClick={() => void apply({ kind: "edit", ...edit })}><IconCheck size={15} aria-hidden="true" /></button>
                    <button type="button" aria-label="取消编辑" title="取消编辑" disabled={busy}
                      onClick={() => setEdit(undefined)}><IconX size={14} aria-hidden="true" /></button>
                  </>
                ) : (
                  <>
                    {onSteer && !queue.starting && isSteerText(item.text) && !item.referenceIds.length && !item.attachments.length && !item.images?.length ? (
                      <button type="button" title="立即发送，引导当前轮" aria-label={`立即发送第 ${index + 1} 条待发消息`}
                        disabled={busy} onClick={() => void apply({ kind: "steer", requestId: item.requestId })}>
                        <IconArrowRight size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                    <button type="button" title="编辑" aria-label={`编辑第 ${index + 1} 条待发消息`}
                      disabled={busy || queue.starting === item.requestId} onClick={() => setEdit({ requestId: item.requestId, text: item.text })}>
                      <IconPencil size={14} aria-hidden="true" />
                    </button>
                    <button type="button" title="移除" aria-label={`移除第 ${index + 1} 条待发消息`}
                      disabled={busy} onClick={() => void apply({ kind: "remove", requestId: item.requestId })}>
                      <IconTrash size={15} aria-hidden="true" />
                    </button>
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
