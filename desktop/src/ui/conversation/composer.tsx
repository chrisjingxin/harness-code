/**
 * 受控输入区：提供消息编辑、@ 分类引用（文件/知识库/会话/任务/成员）、/ 斜杠命令与 Tab 模式轮转。
 *
 * 草稿及身份由调用方保存；所有候选列表与操作意图均经回调上报装配方，组件自身不保存第二份真实数据源。
 */
import {
  IconAlertTriangle,
  IconArrowUp,
  IconBook,
  IconCheck,
  IconChecklist,
  IconChevronDown,
  IconFolder,
  IconMessages,
  IconPlayerStopFilled,
  IconUser,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react"

import { FileTypeIcon } from "../common/file-type-icon.js"
import { extractMentionToken, mentionWindow, replaceMentionToken } from "./mention-policy.js"
import type {
  ConversationActions,
  ConversationCollaborationCandidate,
  ConversationCollaborationCandidateResult,
  ConversationComposerView,
  ConversationDraft,
  ConversationFileCandidate,
  ConversationFileCandidateResult,
  ConversationMenuItemView,
  ConversationScope,
  ConversationTimelineActivity,
} from "./types.js"

type BrowseState = { targetKey: string; tokenStart: number; baseQuery: string; directory: string }
type CandidateState<T> = { key: string; result?: T }
type MentionCandidate = ConversationFileCandidate | ConversationCollaborationCandidate
type MentionGroup = "file" | "knowledge" | "conversation" | "task" | "member"
type MentionTab = "all" | MentionGroup
type MentionEntry = { readonly key: string; readonly group: MentionGroup; readonly item: MentionCandidate }
type Control = ConversationComposerView["controls"][number]

function candidateKey(item: MentionCandidate): string {
  return `${item.kind}:${"relativePath" in item ? item.relativePath : item.id}`
}

const MENTION_GROUP_LABELS: Record<MentionGroup, string> = {
  file: "工作区文件",
  knowledge: "团队知识库",
  conversation: "项目会话",
  task: "项目任务",
  member: "项目成员",
}

const MENTION_TAB_LABELS: Record<MentionTab, string> = {
  all: "全部",
  file: "文件",
  knowledge: "知识库",
  conversation: "会话",
  task: "任务",
  member: "成员",
}

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
  /** 新建准备页使用 Enter 换行，提交仍由该页的明确开始动作处理。 */
  readonly submitOnEnter?: boolean
  readonly children?: ReactNode
}

/** 不持有唯一草稿副本；卸载后由调用方重新传入文字、选择范围及修订。 */
export function ConversationComposer(props: ComposerProps): ReactElement {
  const { scope, visible, activity, model, draft, actions, sendBlocked, cancelBlocked, localStatus, onSend, onCancel, children } = props
  const rootRef = useRef<HTMLFormElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)
  const [isComposing, setIsComposing] = useState(false)
  const pendingCaret = useRef<number | null>(null)
  const wasEditableRef = useRef(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [browse, setBrowse] = useState<BrowseState | null>(null)
  const [mentionTab, setMentionTab] = useState<MentionTab>("all")
  const [fileState, setFileState] = useState<CandidateState<ConversationFileCandidateResult> | null>(null)
  const [collaborationState, setCollaborationState] = useState<CandidateState<ConversationCollaborationCandidateResult> | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [windowStart, setWindowStart] = useState(0)
  const [hint, setHint] = useState("")
  const requestSequence = useRef(0)
  const requestFiles = useRef(actions.onRequestFileCandidates)
  requestFiles.current = actions.onRequestFileCandidates
  const requestCollaboration = useRef(actions.onRequestCollaborationCandidates)
  requestCollaboration.current = actions.onRequestCollaborationCandidates

  const token = draft.selectionStart === draft.selectionEnd ? extractMentionToken(draft.text, draft.selectionStart) : null
  const target = model.projectTarget
  const targetKey = JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId, target?.deviceId, target?.projectId])
  const tokenKey = token ? JSON.stringify([targetKey, draft.revision, token.start, token.end]) : ""
  const validBrowse = token && browse && browse.targetKey === targetKey && browse.tokenStart === token.start && token.query.startsWith(browse.baseQuery) ? browse : null
  const directory = validBrowse?.directory ?? ""
  const query = token ? token.query.slice(validBrowse?.baseQuery.length ?? 0) : ""
  const tokenText = token ? draft.text.slice(token.start, token.end) : ""
  const showCollaboration = Boolean(target && !directory && actions.onRequestCollaborationCandidates && actions.onSelectCollaborationCandidate)
  const mentionVisible = Boolean(visible && !commandOpen && token && dismissed !== tokenKey && actions.onPersonalChange)
  const requestKey = mentionVisible && token
    ? JSON.stringify([targetKey, draft.revision, token.start, token.end, tokenText, query, directory, showCollaboration, Boolean(actions.onRequestFileCandidates)])
    : ""
  const currentRequest = useRef(requestKey)
  currentRequest.current = requestKey
  const matchedCommands = filterCommands(model.commands, draft.text)
  const fileResult = fileState?.key === requestKey ? fileState.result : undefined
  const collaborationResult = showCollaboration && collaborationState?.key === requestKey ? collaborationState.result : undefined
  const files = fileResult?.status === "ready" ? fileResult.items.slice(0, 1000) : []
  const collaborationItems = collaborationResult?.status === "ready" ? collaborationResult.items.slice(0, 1000) : []

  // 将所有候选按语义分组排列（文件 → 知识库 → 会话 → 任务 → 成员），确保视觉分组与键盘上下键顺序完全一致。
  const knowledgeItems = collaborationItems.filter(item => item.kind === "knowledge")
  const conversationItems = collaborationItems.filter(item => item.kind === "conversation")
  const taskItems = collaborationItems.filter(item => item.kind === "task")
  const memberItems = collaborationItems.filter(item => item.kind === "member")
  const allEntries: MentionEntry[] = [
    ...files.map(item => ({ key: candidateKey(item), group: "file" as const, item })),
    ...knowledgeItems.map(item => ({ key: candidateKey(item), group: "knowledge" as const, item })),
    ...conversationItems.map(item => ({ key: candidateKey(item), group: "conversation" as const, item })),
    ...taskItems.map(item => ({ key: candidateKey(item), group: "task" as const, item })),
    ...memberItems.map(item => ({ key: candidateKey(item), group: "member" as const, item })),
  ]
  const hasFileMention = Boolean(actions.onRequestFileCandidates)
  const groupCounts: Record<MentionTab, number> = {
    all: allEntries.length,
    file: files.length,
    knowledge: knowledgeItems.length,
    conversation: conversationItems.length,
    task: taskItems.length,
    member: memberItems.length,
  }
  const availableTabs: readonly MentionTab[] = [
    "all",
    ...(hasFileMention ? (["file"] as const) : []),
    "knowledge",
    "conversation",
    "task",
    ...(groupCounts.member > 0 ? (["member"] as const) : []),
  ]
  const activeTab: MentionTab = showCollaboration && !directory && availableTabs.includes(mentionTab) ? mentionTab : "all"
  const filteredEntries = activeTab === "all" ? allEntries : allEntries.filter(entry => entry.group === activeTab)

  // 一组结果比另一组更早返回时，仍保留用户已选中的条目。
  const candidateIndex = Math.max(0, filteredEntries.findIndex(entry => entry.key === selected))
  const candidateWindow = mentionWindow(candidateIndex, windowStart, filteredEntries.length)
  const visibleEntries = filteredEntries.slice(candidateWindow.start, candidateWindow.end)
  const candidateTotal = activeTab === "file"
    ? (fileResult?.total ?? files.length)
    : activeTab === "all" && fileResult?.total !== undefined
      ? collaborationItems.length + fileResult.total
      : filteredEntries.length
  const canEdit = Boolean(actions.onPersonalChange)
  const hasContent = draft.text.trim().length > 0 || draft.referenceIds.length > 0 || draft.attachmentIds.length > 0
  const showSend = model.primaryActions === "send" || model.primaryActions === "both"
  const showCancel = model.primaryActions === "cancel" || model.primaryActions === "both"
  const canSend = Boolean(showSend && visible && canEdit && actions.onSend && model.send.enabled && !sendBlocked && hasContent)

  const invalidateCandidates = () => {
    requestSequence.current += 1
    setFileState(null)
    setCollaborationState(null)
  }

  // 进入可编辑会话且焦点停留在 body 时自动聚焦输入框，方便用户直接输入或按 Tab 切换模式。
  useEffect(() => {
    const editableNow = Boolean(visible && canEdit)
    const justEntered = editableNow && !wasEditableRef.current
    wasEditableRef.current = editableNow
    if (!justEntered) return
    const active = document.activeElement
    if (!active || active === document.body) {
      textareaRef.current?.focus()
    }
  }, [visible, canEdit])

  useEffect(() => {
    if (!mentionVisible) setMentionTab("all")
  }, [mentionVisible])

  useEffect(() => {
    if (!requestKey || !token) return
    const requestId = ++requestSequence.current
    let active = true
    setSelected(null)
    setWindowStart(0)
    const isCurrent = () => active && requestSequence.current === requestId && currentRequest.current === requestKey
    const loadFiles = requestFiles.current
    const loadCollaboration = requestCollaboration.current
    setFileState({ key: requestKey })
    setCollaborationState(showCollaboration ? { key: requestKey } : null)
    if (target && loadFiles) {
      void Promise.resolve().then(() => {
        if (isCurrent()) return loadFiles(scope, target, {
          requestId, draftRevision: draft.revision, tokenStart: token.start, tokenEnd: token.end, query, directory,
        })
      }).then(result => {
        if (result && isCurrent()) setFileState({ key: requestKey, result })
      }).catch(() => {
        if (isCurrent()) setFileState({ key: requestKey, result: { status: "error", items: [], truncated: false, message: "文件候选暂不可用。" } })
      })
    } else {
      const message = target ? "当前未提供文件候选。" : "当前会话没有可用的项目目标。"
      setFileState({ key: requestKey, result: { status: "unavailable", items: [], truncated: false, message } })
    }
    if (target && showCollaboration && loadCollaboration) {
      void Promise.resolve().then(() => {
        if (isCurrent()) return loadCollaboration(scope, target, query)
      }).then(result => {
        if (result && isCurrent()) setCollaborationState({ key: requestKey, result })
      }).catch(() => {
        if (isCurrent()) setCollaborationState({ key: requestKey, result: { status: "error", items: [], message: "协作候选暂不可用。" } })
      })
    }
    return () => { active = false }
  }, [requestKey])

  useEffect(() => {
    if (visible) return
    requestSequence.current += 1
    setFileState(null)
    setCollaborationState(null)
    setCommandOpen(false)
    setBrowse(null)
    setMentionTab("all")
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
    textarea.style.height = `${Math.min(maxHeight, Math.max(44, textarea.scrollHeight))}px`
    // 窗口变矮时 CSS 会进一步限制高度，长草稿仍须能在输入框内滚动。
    textarea.style.overflowY = "auto"
    if (backdropRef.current) backdropRef.current.scrollTop = textarea.scrollTop
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
    const slash = props.submitOnEnter !== false && isSlashQuery(text)
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
    setSelected(null)
    setWindowStart(0)
  }

  const selectCandidate = (item: MentionCandidate) => {
    if (!token || !mentionVisible || !actions.onPersonalChange || !filteredEntries.some(entry => entry.item === item)) return
    if (!("relativePath" in item)) {
      if (!target || !actions.onSelectCollaborationCandidate) return
      invalidateCandidates()
      setDismissed(tokenKey)
      setBrowse(null)
      actions.onSelectCollaborationCandidate(scope, target, item, {
        conversationId: scope.conversationId,
        draftRevision: draft.revision,
        tokenStart: token.start,
        tokenEnd: token.end,
        tokenText,
      })
      return
    }
    if (item.kind === "directory") { browseDirectory(item); return }
    const next = replaceMentionToken(draft.text, token, item.relativePath)
    invalidateCandidates()
    setDismissed(null)
    setBrowse(null)
    pendingCaret.current = next.cursor
    actions.onPersonalChange(scope, { kind: "draft-text", text: next.text, selectionStart: next.cursor, selectionEnd: next.cursor })
  }

  const moveCandidate = (delta: number) => {
    const next = clamp(candidateIndex + delta, filteredEntries.length)
    setSelected(filteredEntries[next] ? filteredEntries[next].key : null)
    setWindowStart(mentionWindow(next, candidateWindow.start, filteredEntries.length).start)
  }

  const selectCommand = (item: ConversationMenuItemView | undefined) => {
    if (!item || !item.availability.enabled || !actions.onCommand) return
    setCommandOpen(false)
    actions.onCommand(scope, item.id)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    if (event.key === "Tab" && (event.ctrlKey || event.metaKey || event.altKey)) return
    if (commandOpen && !event.shiftKey) {
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
    if (mentionVisible && token && !event.shiftKey) {
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
      const activeCandidate = filteredEntries[candidateIndex]?.item
      if (event.key === "ArrowRight" && activeCandidate?.kind === "directory") {
        event.preventDefault(); event.stopPropagation(); selectCandidate(activeCandidate); return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        event.stopPropagation()
        if (activeCandidate) selectCandidate(activeCandidate)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey && props.submitOnEnter !== false) { event.preventDefault(); event.stopPropagation(); if (canSend) onSend(); return }
    if (event.key === "Escape" && (activity?.active || showCancel)) {
      event.preventDefault()
      event.stopPropagation()
      setHint(actions.onCancel && model.cancel.enabled ? "可使用停止按钮请求中断。" : model.cancel.reason || "当前没有可用的停止操作。")
      return
    }
    // 支持“空输入按 Tab”以及“任意编辑态按 Shift+Tab”快速轮转模式（或配置项）。
    if (
      event.key === "Tab"
      && visible
      && canEdit
      && !activity?.active
      && !showCancel
      && !sendBlocked
      && !cancelBlocked
      && model.tabCycle
      && actions.onCapabilitySelect
      && (event.shiftKey || !hasContent)
    ) {
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
  const insertMention = () => {
    if (!canEdit || !visible || !actions.onPersonalChange) return
    const start = Math.max(0, Math.min(draft.text.length, draft.selectionStart))
    const end = Math.max(start, Math.min(draft.text.length, draft.selectionEnd))
    const before = draft.text.slice(0, start)
    const prefix = before.length > 0 && !/\s$/.test(before) ? " @" : "@"
    const nextText = `${before}${prefix}${draft.text.slice(end)}`
    const cursor = before.length + prefix.length
    invalidateCandidates()
    setDismissed(null)
    setCommandOpen(false)
    setHint("")
    pendingCaret.current = cursor
    actions.onPersonalChange(scope, { kind: "draft-text", text: nextText, selectionStart: cursor, selectionEnd: cursor })
    textareaRef.current?.focus()
  }
  const toggleCommandMenu = () => {
    if (!canEdit || !visible || !actions.onPersonalChange) return
    invalidateCandidates()
    setHint("")
    if (commandOpen) {
      setCommandOpen(false)
      textareaRef.current?.focus()
      return
    }
    if (!draft.text.trim()) {
      setCommandIndex(0)
      setCommandOpen(true)
      pendingCaret.current = 1
      actions.onPersonalChange(scope, { kind: "draft-text", text: "/", selectionStart: 1, selectionEnd: 1 })
    } else {
      setCommandIndex(0)
      setCommandOpen(true)
      textareaRef.current?.focus()
    }
  }
  const displayStatus = localStatus || hint || model.statusText

  const highlightSegments = !isComposing ? splitComposerHighlightSegments(draft.text) : null
  const showHighlight = Boolean(highlightSegments?.some(segment => segment.kind === "mention"))

  const showCategoryEmpty = () => {
    if (activeTab === "file") {
      if (!fileResult) return <p className="wb-composer-menu-empty">正在查找工作区文件…</p>
      if (fileResult.status !== "ready") return <p className="wb-composer-menu-empty">{fileResult.message || "文件候选不可用"}</p>
      if (files.length === 0) return <p className="wb-composer-menu-empty">没有匹配的工作区文件</p>
      return null
    }
    if (activeTab === "all") {
      const filesLoading = !fileResult
      const collabLoading = showCollaboration && !collaborationResult
      if (filesLoading && collabLoading) return <p className="wb-composer-menu-empty">正在查找文件与协作内容…</p>
      if (!filesLoading && !collabLoading && filteredEntries.length === 0) {
        return <p className="wb-composer-menu-empty">没有匹配的文件、知识库或会话</p>
      }
      return null
    }
    if (!collaborationResult) return <p className="wb-composer-menu-empty">正在查找{MENTION_TAB_LABELS[activeTab]}…</p>
    if (collaborationResult.status !== "ready") return <p className="wb-composer-menu-empty">{collaborationResult.message || "协作候选暂不可用"}</p>
    if (filteredEntries.length === 0) return <p className="wb-composer-menu-empty">暂无匹配的{MENTION_TAB_LABELS[activeTab]}</p>
    return null
  }

  return (
    <div className="wb-composer-bar">
      <form ref={rootRef} className="wb-composer-inner" onSubmit={handleSubmit}>
        {commandOpen ? (
          <div className="wb-command-menu" role="listbox" aria-label="斜杠命令菜单">
            {model.commands.length === 0 ? (
              <p className="wb-composer-menu-empty">当前 Agent 暂未提供斜杠命令，可直接输入消息。</p>
            ) : matchedCommands.length === 0 ? (
              <p className="wb-composer-menu-empty">无匹配的斜杠命令</p>
            ) : matchedCommands.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === clamp(commandIndex, matchedCommands.length)}
                aria-disabled={!item.availability.enabled || !actions.onCommand}
                data-selected={index === clamp(commandIndex, matchedCommands.length)}
                className="wb-command-item"
                title={item.availability.reason}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setCommandIndex(index)}
                onClick={() => selectCommand(item)}
              >
                <span>{item.label}</span>
                <small>{item.availability.enabled ? item.description : item.availability.reason || "当前不可用"}</small>
              </button>
            ))}
          </div>
        ) : null}
        {mentionVisible && token ? (
          <div className="wb-mention-menu" aria-label={showCollaboration ? "提及与引用菜单" : "文件提及菜单"} onWheel={event => { event.preventDefault(); moveCandidate(event.deltaY >= 0 ? 1 : -1) }}>
            {showCollaboration && !directory ? (
              <div className="wb-mention-tabs" role="tablist" aria-label="引用类别">
                {availableTabs.map(tab => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    className={`wb-mention-tab${activeTab === tab ? " is-active" : ""}`}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => {
                      setMentionTab(tab)
                      setSelected(null)
                      setWindowStart(0)
                    }}
                  >
                    <span>{MENTION_TAB_LABELS[tab]}</span>
                    <span className="wb-mention-tab-count">{groupCounts[tab]}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="wb-mention-list" role="listbox" aria-label={showCollaboration ? "提及候选" : "文件候选"}>
              {showCategoryEmpty()}
              {visibleEntries.map((entry, localIndex) => {
                const index = candidateWindow.start + localIndex
                const showGroupHeader = activeTab === "all" && (localIndex === 0 || visibleEntries[localIndex - 1]?.group !== entry.group)
                const item = entry.item
                const isSelected = index === candidateIndex
                return (
                  <div key={entry.key}>
                    {showGroupHeader ? (
                      <div className="wb-mention-group-title" aria-hidden="true">{MENTION_GROUP_LABELS[entry.group]}</div>
                    ) : null}
                    <div className="wb-mention-row">
                      {"relativePath" in item ? (
                        <>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            data-selected={isSelected}
                            className="wb-mention-item"
                            title={item.relativePath}
                            onMouseDown={event => event.preventDefault()}
                            onMouseEnter={() => setSelected(entry.key)}
                            onClick={() => selectCandidate(item)}
                          >
                            <span className="wb-mention-icon" aria-hidden="true">
                              {item.kind === "directory"
                                ? <IconFolder size={14} />
                                : <FileTypeIcon name={item.relativePath.split("/").at(-1) ?? item.relativePath} size={14} />}
                            </span>
                            <HighlightedPath item={item} />
                          </button>
                          {item.kind !== "directory" ? (
                            <span className="wb-mention-open">
                              <button
                                type="button"
                                disabled={!actions.onOpenFile || !target}
                                title={!actions.onOpenFile ? "当前无法查看文件" : "在右侧分屏打开文件查看内容"}
                                aria-label={`分屏查看 ${item.relativePath}`}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => { if (target) actions.onOpenFile?.(scope, target, item.relativePath, "central") }}
                              >
                                分屏查看
                              </button>
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-selected={isSelected}
                          className="wb-mention-item"
                          onMouseDown={event => event.preventDefault()}
                          onMouseEnter={() => setSelected(entry.key)}
                          onClick={() => selectCandidate(item)}
                        >
                          <span className="wb-mention-icon" aria-hidden="true">
                            {renderCollaborationIcon(item.kind)}
                          </span>
                          <span className="wb-mention-collab-text">
                            <span className="wb-mention-collab-title">{item.title}</span>
                            {item.detail ? <span className="wb-mention-detail">{item.detail}</span> : null}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="wb-mention-footer">
              <span>@ /{directory ? ` ${directory}` : ""}{filteredEntries.length ? ` · ${candidateIndex + 1}/${candidateTotal}` : ""}</span>
              <span className="wb-mention-footer-hint">↵ 插入引用 · ↑↓ 选择 · Esc 关闭</span>
              {fileResult?.truncated || (fileResult?.items.length ?? 0) > 1000 ? <span> · 结果已截断（最多 1000 项）</span> : null}
            </div>
          </div>
        ) : null}
        <div className="wb-composer-box">
          {draft.referenceIds.length ? <div className="wb-composer-references" aria-label="引用材料">{draft.referenceIds.map(id => {
            const reference = model.references.find(item => item.id === id)
            if (!reference) return <div key={id} className="wb-composer-reference" role="status">引用资料暂不可用。</div>
            return <div key={reference.id} className="wb-composer-reference">
              <div className="wb-composer-reference-head">
                <div className="wb-composer-reference-meta">
                  <strong>{reference.sourceLabel}</strong>
                  {reference.rangeLabel ? <span className="wb-composer-reference-badge">{reference.rangeLabel}</span> : null}
                </div>
                <div className="wb-composer-reference-actions">{(["open", "refresh", "remove"] as const).map(action => <button key={action} type="button" disabled={!actions.onReferenceAction || !reference.actions[action].enabled} title={reference.actions[action].reason || (!actions.onReferenceAction ? "当前无法操作引用" : undefined)} onClick={() => actions.onReferenceAction?.(scope, reference.id, action)}>{action === "open" ? "定位" : action === "refresh" ? "刷新" : "移除"}</button>)}</div>
              </div>
              {reference.snapshotText ? <p>{reference.snapshotText}</p> : null}
              {reference.status !== "ready" ? <p role="status">{reference.message || (reference.status === "loading" ? "正在读取引用…" : "引用来源暂不可用")}</p> : null}
            </div>
          })}</div> : null}
          {draft.attachmentIds.length ? <div className="wb-composer-attachments" aria-label="附件">{draft.attachmentIds.map(id => {
            const item = model.attachments.find(attachment => attachment.id === id)
            if (!item) return <span key={id}>附件资料暂不可用</span>
            return <span key={item.id}>{item.label}<button type="button" aria-label={`移除 ${item.label}`} title={item.availability.reason || (!canEdit ? "当前无法修改草稿" : undefined)} disabled={!canEdit || !item.availability.enabled} onClick={() => actions.onPersonalChange?.(scope, { kind: "draft-attachments", attachmentIds: draft.attachmentIds.filter(id => id !== item.id) })}><IconX aria-hidden="true" /></button></span>
          })}</div> : null}
          <div className="wb-composer-editor" data-highlighted={showHighlight || undefined}>
            {showHighlight && highlightSegments ? (
              <div ref={backdropRef} className="wb-composer-backdrop" aria-hidden="true">
                {highlightSegments.map((segment, index) => (
                  segment.kind === "mention"
                    ? <mark key={index} className="wb-composer-inline-mention">{segment.text}</mark>
                    : <span key={index}>{segment.text}</span>
                ))}
                {draft.text.endsWith("\n") ? " " : null}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              className="wb-composer-textarea"
              rows={1}
              value={draft.text}
              disabled={!canEdit}
              placeholder={canEdit ? (props.submitOnEnter === false ? "描述你想讨论或推进的事项，输入 @ 引用项目会话或团队知识…" : "描述任务，@ 引用文件/知识/会话，/ 唤起命令…") : "当前无法编辑草稿"}
              aria-label={props.submitOnEnter === false ? "新会话初始内容，Enter 换行" : "消息，Enter 发送，Shift+Enter 换行"}
              onChange={event => updateDraft(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onSelect={event => updateSelection(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onScroll={event => {
                if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop
              }}
              onFocus={event => { if (visible) event.currentTarget.setSelectionRange(draft.selectionStart, draft.selectionEnd) }}
              onCompositionStart={() => {
                composing.current = true
                setIsComposing(true)
              }}
              onCompositionEnd={() => {
                composing.current = false
                setIsComposing(false)
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="wb-composer-rail">
            <div className="wb-composer-rail-left">
              <button
                type="button"
                className="wb-composer-tool"
                disabled={!canEdit || !visible}
                title={props.submitOnEnter === false ? "输入 @ 引用项目会话或团队知识" : "输入 @ 引用工作区文件、团队知识或项目会话"}
                onMouseDown={event => event.preventDefault()}
                onClick={insertMention}
              >
                <span className="wb-composer-kbd" aria-hidden="true">@</span>
                <span>{props.submitOnEnter === false ? "引用会话" : "引用"}</span>
              </button>
              {props.submitOnEnter !== false ? (
                <button
                  type="button"
                  className="wb-composer-tool"
                  disabled={!canEdit || !visible}
                  aria-expanded={commandOpen}
                  title="输入 / 或点击查看可用斜杠命令"
                  onMouseDown={event => event.preventDefault()}
                  onClick={toggleCommandMenu}
                >
                  <span className="wb-composer-kbd" aria-hidden="true">/</span>
                  <span>命令</span>
                </button>
              ) : null}
              {model.controls.map(control => (
                <CapabilityMenu
                  key={control.id}
                  scope={scope}
                  control={control}
                  isTabCycle={model.tabCycle?.controlId === control.id}
                  onSelect={actions.onCapabilitySelect}
                />
              ))}
              {children}
            </div>
            <div className="wb-composer-rail-right">
              <span className="wb-composer-hint">{props.submitOnEnter === false ? "Enter 换行" : "⏎ 发送"}</span>
              {showCancel ? <button type="button" className="wb-composer-cancel" aria-label="取消当前任务" disabled={!visible || !actions.onCancel || !model.cancel.enabled || cancelBlocked} title={model.cancel.reason || (!actions.onCancel ? "当前无法停止" : "请求停止")} onClick={onCancel}><IconPlayerStopFilled size={14} aria-hidden="true" /></button> : null}
              {showSend ? <button type="submit" className="wb-composer-send" aria-label="发送消息" disabled={!canSend} title={model.send.reason || (!actions.onSend ? "当前无法发送" : "发送消息")}><IconArrowUp aria-hidden="true" /></button> : null}
            </div>
          </div>
        </div>
        {displayStatus ? <p className="wb-composer-status" role="status"><IconAlertTriangle aria-hidden="true" />{displayStatus}</p> : null}
      </form>
    </div>
  )
}

function renderCollaborationIcon(kind: ConversationCollaborationCandidate["kind"]): ReactElement {
  switch (kind) {
    case "knowledge": return <IconBook size={14} />
    case "conversation": return <IconMessages size={14} />
    case "task": return <IconChecklist size={14} />
    case "member": return <IconUser size={14} />
  }
}

function CapabilityMenu({ scope, control, isTabCycle, onSelect }: {
  scope: ConversationScope
  control: Control
  isTabCycle: boolean
  onSelect?: ConversationActions["onCapabilitySelect"]
}): ReactElement {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const selected = control.items.find(item => item.id === control.selectedId)
  const displayLabel = selected ? selected.label : control.label
  const tooltip = control.availability.reason
    || (!onSelect
      ? "当前不可切换"
      : `${control.label}：${displayLabel}${isTabCycle ? "（按 Tab 或 Shift+Tab 轮转）" : ""}`)

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
    <button
      ref={trigger}
      type="button"
      className={`wb-composer-chip${isTabCycle ? " is-tab-cycle" : ""}`}
      disabled={!control.availability.enabled || !onSelect}
      title={tooltip}
      aria-label={`${control.label}：${displayLabel}`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
    >
      <span className="wb-composer-chip-label">{displayLabel}</span>
      {isTabCycle ? <kbd className="wb-composer-tab-badge" aria-hidden="true">Tab</kbd> : null}
      <IconChevronDown aria-hidden="true" />
    </button>
    {open ? <div ref={menu} className="wb-capability-menu" role="menu" aria-label={control.label} onKeyDown={onMenuKey}>
      {control.items.length === 0 ? <p className="wb-composer-menu-empty">暂无可用选项</p> : control.items.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === control.selectedId} disabled={!item.availability.enabled} title={item.availability.reason} onClick={() => { setOpen(false); onSelect?.(scope, control.id, item.id); trigger.current?.focus() }}><span>{item.label}{item.description ? <small>{item.description}</small> : null}{!item.availability.enabled && item.availability.reason ? <small>{item.availability.reason}</small> : null}</span>{item.id === control.selectedId ? <IconCheck size={13} aria-hidden="true" /> : null}</button>)}
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

type ComposerHighlightSegment = { readonly kind: "plain" | "mention"; readonly text: string }

/** 将输入文本切分为普通文本与 `@引用` 词元，避免误伤邮箱等内部 `@`。 */
function splitComposerHighlightSegments(text: string): ComposerHighlightSegment[] {
  if (!text.includes("@")) return [{ kind: "plain", text }]
  const segments: ComposerHighlightSegment[] = []
  const pattern = /(^|\s)(@"(?:[^"\n]*)"|@[^\s@]+)/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    const leadingSpace = match[1] ?? ""
    const mention = match[2] ?? ""
    const mentionStart = start + leadingSpace.length
    if (mentionStart > cursor) {
      segments.push({ kind: "plain", text: text.slice(cursor, mentionStart) })
    }
    if (mention) {
      segments.push({ kind: "mention", text: mention })
    }
    cursor = mentionStart + mention.length
  }
  if (cursor < text.length) {
    segments.push({ kind: "plain", text: text.slice(cursor) })
  }
  return segments
}
