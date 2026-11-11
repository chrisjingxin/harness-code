/**
 * 受控输入区：复用旧 Web 的聊天输入、上弹菜单、文件提及和发送/停止布局。
 *
 * 草稿及身份由调用方保存；候选只来自调用方的原设备/项目查询，选择不会读取文件。
 * 输入或光标变化 → 匹配 @ token → 绑定 scope/目标/修订发请求 → 仅接收当前请求结果。
 */
import { AlertTriangle, ChevronDown, Send, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react"

import { extractMentionToken, mentionWindow, replaceMentionToken } from "./mention-policy.js"
import type { MentionToken } from "./mention-policy.js"
import type {
  ConversationActions,
  ConversationComposerView,
  ConversationDraft,
  ConversationFileCandidate,
  ConversationFileCandidateResult,
  ConversationMenuItemView,
  ConversationScope,
  ConversationTimelineActivity,
} from "./types.js"

type BrowseState = { targetKey: string; tokenStart: number; baseQuery: string; directory: string }
type CandidateState = { key: string; loading: boolean; result?: ConversationFileCandidateResult }
type Control = ConversationComposerView["controls"][number]

interface ComposerProps {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly activity?: ConversationTimelineActivity | null
  readonly model: ConversationComposerView
  readonly draft: ConversationDraft
  readonly actions: ConversationActions
  readonly sendBlocked: boolean
  readonly cancelBlocked: boolean
  readonly localStatus?: string
  readonly onSend: () => void
  readonly onCancel: () => void
  readonly children?: ReactNode
}

/** 不持有唯一草稿副本；卸载后由调用方重新传入文字、选择范围及修订。 */
export function ConversationComposer(props: ComposerProps): ReactElement {
  const { scope, visible, activity, model, draft, actions, sendBlocked, cancelBlocked, localStatus, onSend, onCancel, children } = props
  const rootRef = useRef<HTMLFormElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)
  const pendingCaret = useRef<number | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [browse, setBrowse] = useState<BrowseState | null>(null)
  const [candidateState, setCandidateState] = useState<CandidateState | null>(null)
  const [selected, setSelected] = useState(0)
  const [windowStart, setWindowStart] = useState(0)
  const [hint, setHint] = useState("")
  const requestSequence = useRef(0)
  const requestCallback = useRef(actions.onRequestFileCandidates)
  requestCallback.current = actions.onRequestFileCandidates

  const token = draft.selectionStart === draft.selectionEnd ? extractMentionToken(draft.text, draft.selectionStart) : null
  const target = model.projectTarget
  const targetKey = JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId, target?.deviceId, target?.projectId])
  const tokenKey = token ? JSON.stringify([targetKey, draft.revision, token.start, token.end]) : ""
  const validBrowse = token && browse && browse.targetKey === targetKey && browse.tokenStart === token.start && token.query.startsWith(browse.baseQuery) ? browse : null
  const directory = validBrowse?.directory ?? ""
  const query = token ? token.query.slice(validBrowse?.baseQuery.length ?? 0) : ""
  const mentionVisible = Boolean(visible && !commandOpen && token && dismissed !== tokenKey && actions.onPersonalChange)
  const requestKey = mentionVisible && token ? JSON.stringify([targetKey, draft.revision, draft.selectionStart, draft.selectionEnd, token.start, token.end, query, directory]) : ""
  const currentRequest = useRef(requestKey)
  currentRequest.current = requestKey
  const matchedCommands = filterCommands(model.commands, draft.text)
  const candidateResult = candidateState?.key === requestKey ? candidateState : null
  const candidates = candidateResult?.result?.status === "ready" ? candidateResult.result.items.slice(0, 1000) : []
  const candidateIndex = clamp(selected, candidates.length)
  const candidateWindow = mentionWindow(candidateIndex, windowStart, candidates.length)
  const canEdit = Boolean(actions.onPersonalChange)
  const hasContent = draft.text.trim().length > 0 || draft.referenceIds.length > 0 || draft.attachmentIds.length > 0
  const showSend = model.primaryActions === "send" || model.primaryActions === "both"
  const showCancel = model.primaryActions === "cancel" || model.primaryActions === "both"
  const canSend = Boolean(showSend && visible && canEdit && actions.onSend && model.send.enabled && !sendBlocked && hasContent)

  const invalidateCandidates = () => {
    requestSequence.current += 1
    setCandidateState(null)
  }

  useEffect(() => {
    if (!requestKey || !token) return
    const requestId = ++requestSequence.current
    let active = true
    setSelected(0)
    setWindowStart(0)
    if (!target || !requestCallback.current) {
      setCandidateState({ key: requestKey, loading: false, result: { status: "unavailable", items: [], truncated: false, message: target ? "当前未提供文件候选。" : "当前会话没有可用的项目目标。" } })
      return () => { active = false }
    }
    const request = requestCallback.current
    const sourceScope = { ...scope }
    const sourceTarget = { ...target }
    setCandidateState({ key: requestKey, loading: true })
    void Promise.resolve().then(() => request(sourceScope, sourceTarget, {
      requestId, draftRevision: draft.revision, tokenStart: token.start, tokenEnd: token.end, query, directory,
    })).then(result => {
      if (active && requestSequence.current === requestId && currentRequest.current === requestKey) {
        setCandidateState({ key: requestKey, loading: false, result })
      }
    }).catch(() => {
      if (active && requestSequence.current === requestId && currentRequest.current === requestKey) {
        setCandidateState({ key: requestKey, loading: false, result: { status: "error", items: [], truncated: false, message: "文件候选暂不可用。" } })
      }
    })
    return () => { active = false }
  }, [requestKey, Boolean(actions.onRequestFileCandidates)])

  useEffect(() => {
    if (visible) return
    requestSequence.current += 1
    setCandidateState(null)
    setCommandOpen(false)
    setBrowse(null)
    setDismissed(null)
    pendingCaret.current = null
  }, [visible])

  useEffect(() => {
    if (!commandOpen && !mentionVisible) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setCommandOpen(false)
      if (token) setDismissed(tokenKey)
      invalidateCandidates()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [commandOpen, mentionVisible, tokenKey])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "auto"
    const style = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(style.lineHeight) || 21
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
    const maxHeight = lineHeight * 8 + padding
    textarea.style.height = `${Math.min(maxHeight, Math.max(52, textarea.scrollHeight))}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [draft.text])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || !visible) return
    if (pendingCaret.current !== null) {
      const cursor = pendingCaret.current
      pendingCaret.current = null
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    } else if (document.activeElement === textarea && !composing.current) {
      textarea.setSelectionRange(draft.selectionStart, draft.selectionEnd)
    }
  }, [visible, draft.text, draft.selectionStart, draft.selectionEnd])

  const updateDraft = (text: string, start: number, end: number) => {
    if (!actions.onPersonalChange) return
    if (text !== draft.text || start !== draft.selectionStart || end !== draft.selectionEnd) invalidateCandidates()
    setDismissed(null)
    setHint("")
    const slash = isSlashQuery(text)
    setCommandOpen(slash)
    if (slash) setCommandIndex(0)
    actions.onPersonalChange(scope, { kind: "draft-text", text, selectionStart: start, selectionEnd: end })
  }

  const updateSelection = (text: string, start: number, end: number) => {
    if (text !== draft.text) { updateDraft(text, start, end); return }
    if (!actions.onPersonalChange || (start === draft.selectionStart && end === draft.selectionEnd)) return
    invalidateCandidates()
    setDismissed(null)
    actions.onPersonalChange(scope, { kind: "draft-text", text: draft.text, selectionStart: start, selectionEnd: end })
  }

  const browseDirectory = (item: ConversationFileCandidate) => {
    if (!token) return
    invalidateCandidates()
    setBrowse({ targetKey, tokenStart: token.start, baseQuery: token.query, directory: item.relativePath })
    setSelected(0)
    setWindowStart(0)
  }

  const selectCandidate = (item: ConversationFileCandidate) => {
    if (!token || !mentionVisible || !candidateResult || candidateResult.loading || !actions.onPersonalChange) return
    if (item.kind === "directory") { browseDirectory(item); return }
    const next = replaceMentionToken(draft.text, token, item.relativePath)
    invalidateCandidates()
    setDismissed(null)
    setBrowse(null)
    pendingCaret.current = next.cursor
    actions.onPersonalChange(scope, { kind: "draft-text", text: next.text, selectionStart: next.cursor, selectionEnd: next.cursor })
  }

  const moveCandidate = (delta: number) => {
    const next = clamp(candidateIndex + delta, candidates.length)
    setSelected(next)
    setWindowStart(mentionWindow(next, candidateWindow.start, candidates.length).start)
  }

  const selectCommand = (item: ConversationMenuItemView | undefined) => {
    if (!item || !item.availability.enabled || !actions.onCommand) return
    setCommandOpen(false)
    actions.onCommand(scope, item.id)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault()
      event.stopPropagation()
      invalidateCandidates()
      setCommandIndex(0)
      setCommandOpen(true)
      return
    }
    // 反向或带修饰键的 Tab 留给系统和浏览器焦点导航。
    if (event.key === "Tab" && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) return
    if (commandOpen) {
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab", "Escape"].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === "Escape") setCommandOpen(false)
        else if (event.key === "Enter" || event.key === "Tab") selectCommand(matchedCommands[clamp(commandIndex, matchedCommands.length)])
        else if (event.key === "Home") setCommandIndex(0)
        else if (event.key === "End") setCommandIndex(Math.max(0, matchedCommands.length - 1))
        else setCommandIndex(clamp(commandIndex + (event.key === "ArrowDown" ? 1 : -1), matchedCommands.length))
        return
      }
    }
    if (mentionVisible && token) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(tokenKey); invalidateCandidates(); return }
      if (event.key === "ArrowLeft" && directory && !query) {
        event.preventDefault()
        event.stopPropagation()
        invalidateCandidates()
        setBrowse({ targetKey, tokenStart: token.start, baseQuery: token.query, directory: parentDirectory(directory) })
        return
      }
      if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        moveCandidate(event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : event.key === "PageDown" ? 8 : -8)
        return
      }
      if (event.key === "ArrowRight" && candidates[candidateIndex]?.kind === "directory") {
        event.preventDefault(); event.stopPropagation(); selectCandidate(candidates[candidateIndex]); return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        event.stopPropagation()
        if (candidates[candidateIndex]) selectCandidate(candidates[candidateIndex])
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); if (canSend) onSend(); return }
    if (event.key === "Escape" && (activity?.active || showCancel)) {
      event.preventDefault()
      event.stopPropagation()
      setHint(actions.onCancel && model.cancel.enabled ? "可使用停止按钮请求中断。" : model.cancel.reason || "当前没有可用的停止操作。")
      return
    }
    if (event.key === "Tab" && visible && canEdit && !hasContent && !activity?.active && !showCancel && !sendBlocked && !cancelBlocked && model.tabCycle && actions.onCapabilitySelect) {
      const control = model.controls.find(item => item.id === model.tabCycle?.controlId)
      if (!control?.availability.enabled) return
      // 按装配方名单去重并跳过无效选项，不能从控件名称或排列猜测模式。
      const availableIds = [...new Set(model.tabCycle.itemIds)].filter(id => control.items.some(item => item.id === id && item.availability.enabled))
      if (availableIds.length < 2) return
      const index = availableIds.indexOf(control.selectedId ?? "")
      const next = availableIds[index < 0 ? 0 : (index + 1) % availableIds.length]
      actions.onCapabilitySelect(scope, control.id, next)
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (canSend) onSend() }
  const displayStatus = localStatus || hint || model.statusText

  return (
    <div className="wb-composer-bar">
      <form ref={rootRef} className="wb-composer-inner" onSubmit={handleSubmit}>
        {commandOpen ? (
          <div className="wb-command-menu" role="listbox" aria-label="命令菜单">
            {matchedCommands.length === 0 ? <p className="wb-composer-menu-empty">无匹配命令</p> : matchedCommands.map((item, index) => (
              <button key={item.id} type="button" role="option" aria-selected={index === clamp(commandIndex, matchedCommands.length)} aria-disabled={!item.availability.enabled || !actions.onCommand} data-selected={index === clamp(commandIndex, matchedCommands.length)} className="wb-command-item" title={item.availability.reason} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setCommandIndex(index)} onClick={() => selectCommand(item)}>
                <span>{item.label}</span><small>{item.availability.enabled ? item.description : item.availability.reason || "当前不可用"}</small>
              </button>
            ))}
          </div>
        ) : null}
        {mentionVisible && token ? (
          <div className="wb-mention-menu" aria-label="文件提及菜单" onWheel={event => { event.preventDefault(); moveCandidate(event.deltaY >= 0 ? 1 : -1) }}>
            <div role="listbox" aria-label="文件候选">
              {candidateResult?.loading || !candidateResult ? <p className="wb-composer-menu-empty">正在查找文件…</p>
                : candidateResult.result?.status !== "ready" ? <p className="wb-composer-menu-empty">{candidateResult.result?.message || "文件候选不可用"}</p>
                  : candidates.length === 0 ? <p className="wb-composer-menu-empty">没有匹配的文件</p>
                    : candidates.slice(candidateWindow.start, candidateWindow.end).map((item, localIndex) => {
                      const index = candidateWindow.start + localIndex
                      return (
                        <div className="wb-mention-row" key={`${item.kind}:${item.relativePath}`}>
                          <button type="button" role="option" aria-selected={index === candidateIndex} data-selected={index === candidateIndex} className="wb-mention-item" title={item.relativePath} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => selectCandidate(item)}>
                            <HighlightedPath item={item} />
                          </button>
                          {item.kind !== "directory" ? <span className="wb-mention-open">
                            <button type="button" disabled={!actions.onOpenFile || !target} title={!actions.onOpenFile ? "当前无法打开文件" : "在右侧预览"} aria-label={`预览 ${item.relativePath}`} onClick={() => { if (target) actions.onOpenFile?.(scope, target, item.relativePath, "preview") }}>预览</button>
                            <button type="button" disabled={!actions.onOpenFile || !target} title={!actions.onOpenFile ? "当前无法打开文件" : "在中央打开"} aria-label={`打开 ${item.relativePath}`} onClick={() => { if (target) actions.onOpenFile?.(scope, target, item.relativePath, "central") }}>打开</button>
                          </span> : null}
                        </div>
                      )
                    })}
            </div>
            <div className="wb-mention-footer">@ /{directory ? ` ${directory}` : ""}{candidates.length ? ` · ${candidateIndex + 1}/${candidateResult?.result?.total ?? "?"}` : ""}{candidateResult?.result?.truncated || (candidateResult?.result?.items.length ?? 0) > 1000 ? " · 结果已截断（最多展示 1000 项）" : ""}</div>
          </div>
        ) : null}
        <div className="wb-composer-box">
          <div className="wb-composer-tabs" aria-hidden="true"><span className="wb-composer-tab">聊天</span></div>
          {draft.referenceIds.length ? <div className="wb-composer-references" aria-label="引用材料">{draft.referenceIds.map(id => {
            const reference = model.references.find(item => item.id === id)
            if (!reference) return <div key={id} className="wb-composer-reference" role="status">引用资料暂不可用。</div>
            return <div key={reference.id} className="wb-composer-reference">
              <div><strong>{reference.sourceLabel}</strong> <span>{reference.rangeLabel}</span></div>
              {reference.snapshotText ? <p>{reference.snapshotText}</p> : null}
              {reference.status !== "ready" ? <p role="status">{reference.message || (reference.status === "loading" ? "正在读取引用…" : "引用来源暂不可用")}</p> : null}
              <div>{(["open", "refresh", "remove"] as const).map(action => <button key={action} type="button" disabled={!actions.onReferenceAction || !reference.actions[action].enabled} title={reference.actions[action].reason || (!actions.onReferenceAction ? "当前无法操作引用" : undefined)} onClick={() => actions.onReferenceAction?.(scope, reference.id, action)}>{action === "open" ? "定位" : action === "refresh" ? "刷新" : "移除"}</button>)}</div>
            </div>
          })}</div> : null}
          {draft.attachmentIds.length ? <div className="wb-composer-attachments" aria-label="附件">{draft.attachmentIds.map(id => {
            const item = model.attachments.find(attachment => attachment.id === id)
            if (!item) return <span key={id}>附件资料暂不可用</span>
            return <span key={item.id}>{item.label}<button type="button" aria-label={`移除 ${item.label}`} title={item.availability.reason || (!canEdit ? "当前无法修改草稿" : undefined)} disabled={!canEdit || !item.availability.enabled} onClick={() => actions.onPersonalChange?.(scope, { kind: "draft-attachments", attachmentIds: draft.attachmentIds.filter(id => id !== item.id) })}><X aria-hidden="true" /></button></span>
          })}</div> : null}
          <textarea ref={textareaRef} className="wb-composer-textarea" rows={1} value={draft.text} disabled={!canEdit} placeholder={canEdit ? "输入消息…（输入 / 唤起命令）" : "当前无法编辑草稿"} aria-label="消息，Enter 发送，Shift+Enter 换行" onChange={event => updateDraft(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} onSelect={event => updateSelection(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)} onFocus={event => { if (visible) event.currentTarget.setSelectionRange(draft.selectionStart, draft.selectionEnd) }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={handleKeyDown} />
          <div className="wb-composer-rail">
            <div className="wb-composer-rail-left">{model.controls.map(control => <CapabilityMenu key={control.id} scope={scope} control={control} onSelect={actions.onCapabilitySelect} />)}{children}</div>
            <div className="wb-composer-rail-right">
              {showCancel ? <button type="button" className="wb-composer-cancel" aria-label="取消当前任务" disabled={!visible || !actions.onCancel || !model.cancel.enabled || cancelBlocked} title={model.cancel.reason || (!actions.onCancel ? "当前无法停止" : "请求停止")} onClick={onCancel}><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3.5" fill="currentColor" /></svg></button> : null}
              {showSend ? <button type="submit" className="wb-composer-send" aria-label="发送消息" disabled={!canSend} title={model.send.reason || (!actions.onSend ? "当前无法发送" : "发送消息")}><Send aria-hidden="true" /></button> : null}
            </div>
          </div>
        </div>
        {displayStatus ? <p className="wb-composer-status" role="status"><AlertTriangle aria-hidden="true" />{displayStatus}</p> : null}
      </form>
    </div>
  )
}

function CapabilityMenu({ scope, control, onSelect }: { scope: ConversationScope; control: Control; onSelect?: ConversationActions["onCapabilitySelect"] }): ReactElement {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const selected = control.items.find(item => item.id === control.selectedId)

  useEffect(() => {
    if (!open) return
    const current = menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)')
    const first = menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)')
    ;(current ?? first)?.focus()
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [open])

  useEffect(() => { if (!control.availability.enabled || !onSelect) setOpen(false) }, [control.availability.enabled, onSelect])

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'))
    if (!items.length) return
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    let next: number | null = null
    if (event.key === "ArrowDown") next = (current + 1) % items.length
    if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length
    if (event.key === "Home") next = 0
    if (event.key === "End") next = items.length - 1
    if (next !== null) { event.preventDefault(); event.stopPropagation(); items[next]?.focus() }
  }

  return <div ref={root} className="wb-composer-control" onBlur={event => {
    // 焦点在触发按钮与菜单选项之间移动时保持打开；离开整个控件后及时收起。
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="wb-composer-chip" disabled={!control.availability.enabled || !onSelect} title={control.availability.reason || (!onSelect ? "当前不可切换" : undefined)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><span>{control.label}{selected ? `：${selected.label}` : ""}</span><ChevronDown aria-hidden="true" /></button>
    {open ? <div ref={menu} className="wb-capability-menu" role="menu" aria-label={control.label} onKeyDown={onMenuKey}>
      {control.items.length === 0 ? <p className="wb-composer-menu-empty">暂无可用选项</p> : control.items.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === control.selectedId} disabled={!item.availability.enabled} title={item.availability.reason} onClick={() => { setOpen(false); onSelect?.(scope, control.id, item.id); trigger.current?.focus() }}><span>{item.label}{item.description ? <small>{item.description}</small> : null}{!item.availability.enabled && item.availability.reason ? <small>{item.availability.reason}</small> : null}</span>{item.id === control.selectedId ? <span aria-hidden="true">✓</span> : null}</button>)}
    </div> : null}
  </div>
}

function HighlightedPath({ item }: { item: ConversationFileCandidate }): ReactElement {
  const range = item.matchRanges[0]
  const start = range ? Math.max(0, Math.min(item.relativePath.length, range.start)) : 0
  const end = range ? Math.max(start, Math.min(item.relativePath.length, range.end)) : 0
  return <span className="wb-mention-path">{item.relativePath.slice(0, start)}{end > start ? <mark>{item.relativePath.slice(start, end)}</mark> : null}{item.relativePath.slice(end)}{item.kind === "directory" ? "/" : ""}</span>
}

function isSlashQuery(text: string): boolean {
  const query = text.trimStart()
  return query.startsWith("/") && !query.startsWith("//") && !/\s/.test(query.slice(1))
}

function filterCommands(items: readonly ConversationMenuItemView[], text: string): readonly ConversationMenuItemView[] {
  const query = isSlashQuery(text) ? text.trimStart().slice(1).toLowerCase() : ""
  return query ? items.filter(item => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query)) : items
}

function clamp(index: number, count: number): number { return count ? Math.max(0, Math.min(count - 1, index)) : 0 }
function parentDirectory(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "" : path.slice(0, index) }
