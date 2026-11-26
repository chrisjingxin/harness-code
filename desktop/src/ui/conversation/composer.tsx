/**
 * 受控输入区：提供消息编辑、@ 分类引用（文件/知识库/会话/任务/成员）、/ 斜杠命令与 Tab 模式轮转。
 *
 * 草稿及身份由调用方保存；所有候选列表与操作意图均经回调上报装配方，组件自身不保存第二份真实数据源。
 */
import {
  IconAlertTriangle,
  IconApps,
  IconArrowUp,
  IconAt,
  IconBolt,
  IconBook,
  IconCheck,
  IconChecklist,
  IconChevronDown,
  IconCpu,
  IconFolder,
  IconGitBranch,
  IconLock,
  IconMessages,
  IconPaperclip,
  IconPencil,
  IconPlayerStopFilled,
  IconPlus,
  IconSearch,
  IconShield,
  IconShieldExclamation,
  IconSlash,
  IconUser,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ClipboardEvent, FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react"

import { FileTypeIcon } from "../common/file-type-icon.js"
import { ComposerAnnotationsBar } from "./annotations.js"
import { ComposerImagesBar } from "./image-attachments.js"
import {
  extractMentionToken,
  insertMentionTrigger,
  mentionWindow,
  removeLeadingCommandOnBackspace,
  replaceMentionToken,
  splitComposerHighlightSegments,
} from "./mention-policy.js"
import type {
  ConversationActions,
  ConversationCollaborationCandidate,
  ConversationCollaborationCandidateResult,
  ConversationComposerView,
  ConversationContextActionItem,
  ConversationContextMenuIcon,
  ConversationContextMenuItem,
  ConversationDraft,
  ConversationFileCandidate,
  ConversationFileCandidateResult,
  ConversationMenuItemView,
  ConversationScope,
  ConversationTimelineActivity,
} from "./types.js"

type BrowseState = { targetKey: string; tokenStart: number; baseQuery: string; directory: string }
type ComposerPopover = null | "context-menu" | "directory" | "git" | "command" | "agent-model" | `control:${string}`
type CandidateState<T> = { key: string; result?: T }
type MentionCandidate = ConversationFileCandidate | ConversationCollaborationCandidate
type MentionGroup = "file" | "knowledge" | "conversation" | "task" | "member"
type MentionTab = "all" | MentionGroup
type MentionEntry = { readonly key: string; readonly group: MentionGroup; readonly item: MentionCandidate }
type Control = ConversationComposerView["controls"][number]

const permissionIcons = {
  read: IconLock,
  supervised: IconShield,
  edit: IconPencil,
  auto: IconBolt,
  full: IconShieldExclamation,
} as const

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
  readonly onSteer?: () => void
  readonly onCancel: () => void
  /** 新建准备页使用 Enter 换行，提交仍由该页的明确开始动作处理。 */
  readonly submitOnEnter?: boolean
  readonly placeholder?: string
  readonly children?: ReactNode
  readonly aboveComposer?: ReactNode
}

/** 不持有唯一草稿副本；卸载后由调用方重新传入文字、选择范围及修订。 */
export function ConversationComposer(props: ComposerProps): ReactElement {
  const { scope, visible, activity, model, draft, actions, sendBlocked, cancelBlocked, localStatus, onSend, onCancel, children } = props
  const rootRef = useRef<HTMLFormElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dirWrapRef = useRef<HTMLDivElement | null>(null)
  const dirTriggerRef = useRef<HTMLButtonElement | null>(null)
  const dirPopoverRef = useRef<HTMLDivElement | null>(null)
  const gitWrapRef = useRef<HTMLDivElement | null>(null)
  const gitTriggerRef = useRef<HTMLButtonElement | null>(null)
  const gitPopoverRef = useRef<HTMLDivElement | null>(null)
  const addWrapRef = useRef<HTMLDivElement | null>(null)
  const addTriggerRef = useRef<HTMLButtonElement | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const composing = useRef(false)
  const [isComposing, setIsComposing] = useState(false)
  const pendingCaret = useRef<number | null>(null)
  const wasEditableRef = useRef(false)
  // 单一互斥浮层状态：同时只允许打开一个弹出层，避免顶部菜单、+ 菜单、@ 与 / 彼此遮挡。
  const [openPopover, setOpenPopover] = useState<ComposerPopover>(null)
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

  const commandOpen = openPopover === "command"
  const contextMenuOpen = openPopover === "context-menu"
  const directoryOpen = openPopover === "directory"
  const gitOpen = openPopover === "git"

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
  const annotations = draft.annotations ?? []
  const images = draft.images ?? []
  const hasPreparingImage = images.some(item => item.status === "preparing")
  const hasContent = draft.text.trim().length > 0
    || draft.referenceIds.length > 0
    || draft.attachmentIds.length > 0
    || annotations.length > 0
    || images.length > 0
  const allowsSend = model.primaryActions === "send" || model.primaryActions === "both"
  const allowsCancel = model.primaryActions === "cancel" || model.primaryActions === "both"
  const showStop = allowsCancel && (!allowsSend || !hasContent)
  const canSend = Boolean(allowsSend && visible && canEdit && actions.onSend && model.send.enabled && !sendBlocked && !hasPreparingImage && hasContent)
  const canStop = Boolean(visible && actions.onCancel && model.cancel.enabled && !cancelBlocked)

  const invalidateCandidates = () => {
    requestSequence.current += 1
    setFileState(null)
    setCollaborationState(null)
  }

  const openExclusivePopover = (next: ComposerPopover) => {
    setOpenPopover(next)
    if (next !== null && token) {
      setDismissed(tokenKey)
      invalidateCandidates()
    }
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
    if (!mentionVisible) {
      setMentionTab("all")
      return
    }
    setOpenPopover(current => current && current !== "command" ? null : current)
  }, [mentionVisible])

  useEffect(() => {
    setOpenPopover(null)
  }, [targetKey])

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
    setOpenPopover(null)
    setBrowse(null)
    setMentionTab("all")
    setDismissed(null)
    pendingCaret.current = null
  }, [visible])

  useEffect(() => {
    if (openPopover === "directory") {
      dirPopoverRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    } else if (openPopover === "git") {
      gitPopoverRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    } else if (openPopover === "context-menu") {
      contextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    }
  }, [openPopover])

  useEffect(() => {
    if (!openPopover && !mentionVisible) return
    const onPointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node
      if (openPopover === "directory") {
        if (!dirWrapRef.current?.contains(targetNode)) setOpenPopover(null)
        return
      }
      if (openPopover === "git") {
        if (!gitWrapRef.current?.contains(targetNode)) setOpenPopover(null)
        return
      }
      if (openPopover === "context-menu") {
        if (!addWrapRef.current?.contains(targetNode)) setOpenPopover(null)
        return
      }
      if (rootRef.current?.contains(targetNode)) return
      if (openPopover === "command") setOpenPopover(null)
      if (token) setDismissed(tokenKey)
      invalidateCandidates()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [openPopover, mentionVisible, tokenKey])

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
    if (slash) {
      openExclusivePopover("command")
      setCommandIndex(0)
    } else {
      setOpenPopover(current => (current === "command" || current === "directory" || current === "git" || current === "context-menu") ? null : current)
    }
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

  const insertDirectoryMention = (item: ConversationFileCandidate) => {
    if (!token || !mentionVisible || !actions.onPersonalChange || item.kind !== "directory") return
    const dirPath = `${item.relativePath.replace(/\/+$/, "")}/`
    const next = replaceMentionToken(draft.text, token, dirPath)
    invalidateCandidates()
    setDismissed(null)
    setBrowse(null)
    pendingCaret.current = next.cursor
    actions.onPersonalChange(scope, {
      kind: "draft-text",
      text: next.text,
      selectionStart: next.cursor,
      selectionEnd: next.cursor,
    })
  }

  const selectCommand = (item: ConversationMenuItemView | undefined) => {
    if (!item || !item.availability.enabled || !actions.onCommand) return
    setOpenPopover(null)
    actions.onCommand(scope, item.id)
    textareaRef.current?.focus()
  }

  const handleContextMenuSelect = (item: ConversationContextMenuItem) => {
    if (!item.availability.enabled) return
    if (item.behavior === "mention") {
      openExclusivePopover(null)
      if (!actions.onPersonalChange) return
      const next = insertMentionTrigger(draft.text, draft.selectionStart, draft.selectionEnd)
      invalidateCandidates()
      setDismissed(null)
      setBrowse(null)
      pendingCaret.current = next.cursor
      actions.onPersonalChange(scope, {
        kind: "draft-text",
        text: next.text,
        selectionStart: next.cursor,
        selectionEnd: next.cursor,
      })
      return
    }
    if (item.behavior === "command") {
      setCommandIndex(0)
      openExclusivePopover("command")
      textareaRef.current?.focus()
      return
    }
    openExclusivePopover(null)
    actions.onContextMenuAction?.(scope, item.id)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
    if (event.key === "Tab" && (event.ctrlKey || event.metaKey || event.altKey)) return
    if (
      event.key === "Backspace"
      && !event.shiftKey
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !commandOpen
      && !mentionVisible
      && actions.onPersonalChange
    ) {
      const removed = removeLeadingCommandOnBackspace(draft.text, draft.selectionStart, draft.selectionEnd)
      if (removed) {
        event.preventDefault()
        event.stopPropagation()
        invalidateCandidates()
        setDismissed(null)
        setHint("")
        pendingCaret.current = removed.cursor
        actions.onPersonalChange(scope, {
          kind: "draft-text",
          text: removed.text,
          selectionStart: removed.cursor,
          selectionEnd: removed.cursor,
        })
        return
      }
    }
    if (commandOpen && !event.shiftKey) {
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab", "Escape"].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === "Escape") setOpenPopover(null)
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
    if (event.key === "Escape" && openPopover) {
      event.preventDefault()
      event.stopPropagation()
      openExclusivePopover(null)
      return
    }
    if (event.key === "Enter" && !event.shiftKey && props.submitOnEnter !== false) {
      event.preventDefault()
      event.stopPropagation()
      if (canSend) {
        if (props.onSteer && (event.metaKey || event.ctrlKey)) {
          if (!cancelBlocked) props.onSteer()
        } else onSend()
      } else if (hasPreparingImage && hasContent) {
        setHint("正在处理粘贴的图片，请稍候发送。")
      }
      return
    }
    if (event.key === "Escape" && (activity?.active || allowsCancel)) {
      event.preventDefault()
      event.stopPropagation()
      if (showStop) setHint(canStop ? "可使用停止按钮请求中断。" : model.cancel.reason || "当前没有可用的停止操作。")
      return
    }
    // 支持“空输入按 Tab”以及“任意编辑态按 Shift+Tab”快速轮转模式（或配置项）。
    if (
      event.key === "Tab"
      && visible
      && canEdit
      && !activity?.active
      && !allowsCancel
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

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasteHandler = actions.onPasteImages
    if (!visible || !canEdit || !pasteHandler || !event.clipboardData) return
    const clipboard = event.clipboardData
    const files: File[] = []
    if (clipboard.items && clipboard.items.length > 0) {
      for (const item of Array.from(clipboard.items)) {
        if (item.kind !== "file") continue
        const file = item.getAsFile()
        if (file && (file.type.toLowerCase().startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name))) {
          files.push(file)
        }
      }
    }
    if (files.length === 0 && clipboard.files && clipboard.files.length > 0) {
      for (const file of Array.from(clipboard.files)) {
        if (file.type.toLowerCase().startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
          files.push(file)
        }
      }
    }
    if (files.length === 0) return
    const plainText = clipboard.getData("text/plain").trim()
    // 剪贴板仅包含图片（或系统复制图片文件附带的文件名文本）时阻止将文件名插入输入框。
    if (!plainText || files.some(file => file.name && file.name.trim() === plainText)) {
      event.preventDefault()
    }
    pasteHandler(scope, files)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (canSend) onSend() }
  const displayStatus = localStatus || hint || model.statusText
  const fullAccess = model.controls.some(control => control.kind === "permission"
    && control.items.some(item => item.id === control.selectedId && item.permissionKind === "full"))

  const commandHighlightIds = !commandOpen ? model.commands.map(item => item.id) : undefined
  const highlightSegments = !isComposing
    ? splitComposerHighlightSegments(draft.text, commandHighlightIds ? { commandIds: commandHighlightIds } : undefined)
    : null
  const showHighlight = Boolean(highlightSegments?.some(segment => segment.kind !== "plain"))

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

  const hasContextBar = Boolean(model.contextBar?.directory || model.contextBar?.git)
  const dirContext = model.contextBar?.directory
  const gitContext = model.contextBar?.git
  const contextMenu = model.contextMenu && model.contextMenu.items.length > 0 ? model.contextMenu : null
  const contextMenuTitle = contextMenu?.title ?? "添加上下文"
  const contextMenuTooltip = contextMenu?.tooltip ?? "添加上下文"

  const renderContextBar = () => {
    if (!hasContextBar) return null
    return (
      <div className="wb-composer-context-bar" role="group" aria-label="工作区上下文">
        {dirContext ? (
          <div
            ref={dirWrapRef}
            className="wb-composer-context-item"
            onBlur={event => {
              if (directoryOpen && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
                setOpenPopover(current => current === "directory" ? null : current)
              }
            }}
          >
            <button
              ref={dirTriggerRef}
              type="button"
              className="wb-composer-context-trigger"
              data-context-trigger="directory"
              data-tone={dirContext.statusTone}
              disabled={!dirContext.availability.enabled}
              title={dirContext.availability.reason || dirContext.fullPath || dirContext.label}
              aria-haspopup="menu"
              aria-expanded={directoryOpen}
              onClick={() => openExclusivePopover(directoryOpen ? null : "directory")}
            >
              <IconFolder size={14} aria-hidden="true" />
              <span className="wb-composer-context-label">{dirContext.label}</span>
              {dirContext.statusLabel ? (
                <span className="wb-composer-context-status" data-tone={dirContext.statusTone}>
                  · {dirContext.statusLabel}
                </span>
              ) : null}
              <IconChevronDown size={12} className="wb-composer-context-chev" aria-hidden="true" />
            </button>
            {dirContext.quickAction ? (
              <button
                type="button"
                className="wb-composer-context-quick"
                disabled={!dirContext.quickAction.availability.enabled || !actions.onDirectoryContextAction}
                title={dirContext.quickAction.availability.reason}
                onClick={() => actions.onDirectoryContextAction?.(scope, dirContext.quickAction!.id)}
              >
                {dirContext.quickAction.label}
              </button>
            ) : null}
            {directoryOpen ? (
              <div
                ref={dirPopoverRef}
                className="wb-composer-context-popover"
                role="menu"
                aria-label="工作目录操作"
                onKeyDown={event => handleMenuListKeyDown(event, '[role="menuitem"]:not(:disabled)', () => {
                  setOpenPopover(null)
                  dirTriggerRef.current?.focus()
                })}
              >
                <div className="wb-composer-context-popover-head" onMouseDown={event => event.preventDefault()}>
                  <span className="wb-composer-context-popover-title">工作目录</span>
                  {dirContext.fullPath ? (
                    <span className="wb-composer-context-popover-path" title={dirContext.fullPath}>
                      {dirContext.fullPath}
                    </span>
                  ) : null}
                </div>
                <ContextPopoverOptions
                  items={dirContext.items}
                  emptyText="暂无可用目录操作"
                  disabled={!actions.onDirectoryContextAction}
                  onSelect={itemId => {
                    setOpenPopover(null)
                    actions.onDirectoryContextAction?.(scope, itemId)
                    dirTriggerRef.current?.focus()
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {gitContext ? (
          <div
            ref={gitWrapRef}
            className="wb-composer-context-item"
            onBlur={event => {
              if (gitOpen && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
                setOpenPopover(current => current === "git" ? null : current)
              }
            }}
          >
            <button
              ref={gitTriggerRef}
              type="button"
              className="wb-composer-context-trigger"
              data-context-trigger="git"
              disabled={!gitContext.availability.enabled}
              title={gitContext.availability.reason || [gitContext.branch, gitContext.upstreamLabel].filter(Boolean).join(" · ")}
              aria-haspopup="menu"
              aria-expanded={gitOpen}
              onClick={() => openExclusivePopover(gitOpen ? null : "git")}
            >
              <IconGitBranch size={14} aria-hidden="true" />
              <span className="wb-composer-context-label">{gitContext.branch}</span>
              {gitContext.changedCount && gitContext.changedCount > 0 ? (
                <span className="wb-composer-context-count">· {gitContext.changedCount}</span>
              ) : null}
              <IconChevronDown size={12} className="wb-composer-context-chev" aria-hidden="true" />
            </button>
            {gitOpen ? (
              <div
                ref={gitPopoverRef}
                className="wb-composer-context-popover"
                role="menu"
                aria-label="Git 仓库摘要"
                onKeyDown={event => handleMenuListKeyDown(event, '[role="menuitem"]:not(:disabled)', () => {
                  setOpenPopover(null)
                  gitTriggerRef.current?.focus()
                })}
              >
                <div className="wb-composer-context-popover-head" onMouseDown={event => event.preventDefault()}>
                  <span className="wb-composer-context-popover-title">Git 仓库（只读）</span>
                  <div className="wb-composer-git-meta">
                    <span className="wb-composer-git-branch">{gitContext.branch}</span>
                    {gitContext.head ? <code className="wb-composer-git-head">{gitContext.head.slice(0, 7)}</code> : null}
                  </div>
                  {gitContext.upstreamLabel || gitContext.changedCount !== undefined ? (
                    <span className="wb-composer-context-popover-sub">
                      {[
                        gitContext.upstreamLabel,
                        gitContext.changedCount !== undefined
                          ? (gitContext.changedCount > 0 ? `${gitContext.changedCount} 个未提交变更` : "工作区干净")
                          : undefined,
                      ].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </div>
                <ContextPopoverOptions
                  items={gitContext.items}
                  emptyText="暂无 Git 操作"
                  disabled={!actions.onGitContextAction}
                  onSelect={itemId => {
                    setOpenPopover(null)
                    actions.onGitContextAction?.(scope, itemId)
                    gitTriggerRef.current?.focus()
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  const composerBox = (
    <div className="wb-composer-box" data-queue-mode={model.queue ? "" : undefined}>
      <ComposerImagesBar
        images={images}
        canEdit={canEdit && visible}
        onRemove={target => {
          const next = images.filter(item => item.id !== target.id)
          actions.onPersonalChange?.(scope, { kind: "draft-images", images: next })
        }}
        onResolvePreview={actions.onResolveImagePreview ? imageId => actions.onResolveImagePreview!(scope, imageId) : undefined}
      />
      {draft.referenceIds.length ? <div className="wb-composer-references" aria-label="引用材料">{draft.referenceIds.map(id => {
        const reference = model.references.find(item => item.id === id)
        if (!reference) return <div key={id} className="wb-composer-reference" role="status">引用资料暂不可用。</div>
        return <div key={reference.id} className="wb-composer-reference">
          <div className="wb-composer-reference-head">
            <div className="wb-composer-reference-meta">
              <strong>{reference.sourceLabel}</strong>
              {reference.rangeLabel ? <span className="wb-composer-reference-badge">{reference.rangeLabel}</span> : null}
            </div>
            <div className="wb-composer-reference-actions">{(["open", "refresh"] as const).map(action => <button key={action} type="button" disabled={!actions.onReferenceAction || !reference.actions[action].enabled} title={reference.actions[action].reason || (!actions.onReferenceAction ? "当前无法操作引用" : undefined)} onClick={() => actions.onReferenceAction?.(scope, reference.id, action)}>{action === "open" ? "定位" : "刷新"}</button>)}</div>
          </div>
          <button
            type="button"
            className="wb-composer-reference-remove"
            aria-label={`取消引用 ${reference.sourceLabel}`}
            title={reference.actions.remove.reason || (!actions.onReferenceAction ? "当前无法取消引用" : "取消这次引用")}
            disabled={!actions.onReferenceAction || !reference.actions.remove.enabled}
            onClick={() => actions.onReferenceAction?.(scope, reference.id, "remove")}
          ><IconX size={14} aria-hidden="true" /></button>
          {reference.snapshotText ? <p>{reference.snapshotText}</p> : null}
          {reference.status !== "ready" ? <p role="status">{reference.message || (reference.status === "loading" ? "正在读取引用…" : "引用来源暂不可用")}</p> : null}
        </div>
      })}</div> : null}
      {draft.attachmentIds.length ? <div className="wb-composer-attachments" aria-label="附件">{draft.attachmentIds.map(id => {
        const item = model.attachments.find(attachment => attachment.id === id)
        if (!item) return <span key={id}>附件资料暂不可用</span>
        return (
          <span key={item.id} data-kind={item.kind ?? "file"} title={item.path ?? item.label}>
            <span className="wb-composer-attachment-icon" aria-hidden="true">
              {item.kind === "directory"
                ? <IconFolder size={13} />
                : item.path
                  ? <FileTypeIcon name={item.label} size={13} />
                  : <IconPaperclip size={13} />}
            </span>
            <span className="wb-composer-attachment-label">{item.label}</span>
            <button
              type="button"
              aria-label={`移除 ${item.label}`}
              title={item.availability.reason || (!canEdit ? "当前无法修改草稿" : undefined)}
              disabled={!canEdit || !item.availability.enabled}
              onClick={() => actions.onPersonalChange?.(scope, { kind: "draft-attachments", attachmentIds: draft.attachmentIds.filter(currentId => currentId !== item.id) })}
            >
              <IconX aria-hidden="true" />
            </button>
          </span>
        )
      })}</div> : null}
      <ComposerAnnotationsBar
        annotations={annotations}
        canEdit={canEdit && visible}
        onUpdate={(id, patch) => {
          const next = annotations.map(item => {
            if (item.id !== id) return item
            return {
              id: item.id,
              selectedText: patch.selectedText,
              ...(patch.comment ? { comment: patch.comment } : {}),
              ...(item.sourceLabel ? { sourceLabel: item.sourceLabel } : {}),
            }
          })
          actions.onPersonalChange?.(scope, { kind: "draft-annotations", annotations: next })
        }}
        onRemove={id => {
          const next = annotations.filter(item => item.id !== id)
          actions.onPersonalChange?.(scope, { kind: "draft-annotations", annotations: next })
        }}
      />
      <div className="wb-composer-editor" data-highlighted={showHighlight || undefined}>
        {showHighlight && highlightSegments ? (
          <div ref={backdropRef} className="wb-composer-backdrop" aria-hidden="true">
            {highlightSegments.map((segment, index) => (
              segment.kind === "command"
                ? <mark key={index} className="wb-composer-inline-command">{segment.text}</mark>
                : segment.kind === "mention"
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
          placeholder={canEdit ? (props.placeholder ?? (props.submitOnEnter === false ? "输入你想推进的事项…" : "输入消息 · @ 引用 · / 命令")) : "当前无法编辑草稿"}
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
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="wb-composer-rail">
        <div className="wb-composer-rail-left">
          {contextMenu ? (
            <div
              ref={addWrapRef}
              className="wb-composer-add-wrap"
              onBlur={event => {
                if (contextMenuOpen && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
                  setOpenPopover(current => current === "context-menu" ? null : current)
                }
              }}
            >
              <button
                ref={addTriggerRef}
                type="button"
                className="wb-composer-add-btn"
                aria-label={contextMenuTooltip}
                aria-haspopup="menu"
                aria-expanded={contextMenuOpen}
                disabled={!canEdit}
                onClick={() => openExclusivePopover(contextMenuOpen ? null : "context-menu")}
              >
                <IconPlus size={15} aria-hidden="true" />
              </button>
              <span className="wb-composer-add-tooltip" role="tooltip" aria-hidden="true">
                {contextMenuTooltip}
              </span>
              {contextMenuOpen ? (
                <div
                  ref={contextMenuRef}
                  className="wb-context-menu"
                  role="menu"
                  aria-label={contextMenuTitle}
                  onKeyDown={event => handleMenuListKeyDown(event, '[role="menuitem"]:not(:disabled)', () => {
                    setOpenPopover(null)
                    addTriggerRef.current?.focus()
                  })}
                >
                  <div className="wb-context-menu-title" onMouseDown={event => event.preventDefault()}>
                    {contextMenuTitle}
                  </div>
                  <div className="wb-context-menu-list">
                    {contextMenu.items.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className="wb-context-menu-item"
                        disabled={!item.availability.enabled}
                        title={item.availability.reason}
                        onClick={() => handleContextMenuSelect(item)}
                      >
                        <span className="wb-context-menu-icon" aria-hidden="true">
                          {renderContextMenuIcon(item.icon)}
                        </span>
                        <span className="wb-context-menu-label">{item.label}</span>
                        {item.badge ? (
                          <span className="wb-context-menu-badge" data-tone={item.badgeTone ?? "default"}>
                            {item.badge}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {model.agentModel?.length ? (
            <CapabilityMenu
              scope={scope}
              controls={model.agentModel}
              label="Agent 和模型"
              split
              open={openPopover === "agent-model"}
              onOpenChange={next => {
                if (next) openExclusivePopover("agent-model")
                else setOpenPopover(current => current === "agent-model" ? null : current)
              }}
              onSelect={actions.onCapabilitySelect}
            />
          ) : null}
          {model.controls.map(control => {
            const controlPopoverId = `control:${control.id}` as const
            return (
              <CapabilityMenu
                key={control.id}
                scope={scope}
                controls={[control]}
                label={control.label}
                isTabCycle={model.tabCycle?.controlId === control.id}
                open={openPopover === controlPopoverId}
                onOpenChange={next => {
                  if (next) openExclusivePopover(controlPopoverId)
                  else setOpenPopover(current => current === controlPopoverId ? null : current)
                }}
                onSelect={actions.onCapabilitySelect}
              />
            )
          })}
          {children}
        </div>
        <div className="wb-composer-rail-right">
          {allowsSend || allowsCancel ? (
            <button type={showStop ? "button" : "submit"}
              className={showStop ? "wb-composer-cancel" : "wb-composer-send"}
              aria-label={showStop ? "取消当前任务" : "发送消息"}
              disabled={showStop ? !canStop : !canSend}
              title={showStop
                ? model.cancel.reason || (actions.onCancel ? "请求停止" : "当前无法停止")
                : model.send.reason || (!actions.onSend ? "当前无法发送" : model.queue ? "发送到待发队列" : "发送消息")}
              onClick={showStop ? onCancel : undefined}>
              {showStop ? <IconPlayerStopFilled size={14} aria-hidden="true" /> : <IconArrowUp aria-hidden="true" />}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )

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
                          {item.kind === "directory" ? (
                            <span className="wb-mention-open">
                              <button
                                type="button"
                                title={`插入目录提及 @${item.relativePath.replace(/\/+$/, "")}/`}
                                aria-label={`引用目录 ${item.relativePath}`}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => insertDirectoryMention(item)}
                              >
                                引用目录
                              </button>
                            </span>
                          ) : (
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
                          )}
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
              <span className="wb-mention-footer-hint">↵ 展开目录/插入 · ↑↓ 选择 · Esc 关闭</span>
              {fileResult?.truncated || (fileResult?.items.length ?? 0) > 1000 ? <span> · 结果已截断（最多 1000 项）</span> : null}
            </div>
          </div>
        ) : null}
        {props.aboveComposer}
        {hasContextBar ? (
          <div className="wb-composer-shell">
            {renderContextBar()}
            {composerBox}
          </div>
        ) : composerBox}
        {displayStatus ? <p className="wb-composer-status" role="status"><IconAlertTriangle aria-hidden="true" />{displayStatus}</p> : null}
        {fullAccess ? <p className="wb-composer-permission-warning" role="status"><IconShieldExclamation aria-hidden="true" />完全访问已开启，部分操作无需确认。</p> : null}
      </form>
    </div>
  )
}

function renderContextMenuIcon(icon: ConversationContextMenuIcon): ReactElement {
  switch (icon) {
    case "file": return <IconPaperclip size={16} />
    case "folder": return <IconFolder size={16} />
    case "mention": return <IconAt size={16} />
    case "action": return <IconSlash size={16} />
    case "knowledge": return <IconBook size={16} />
    case "conversation": return <IconMessages size={16} />
    case "external": return <IconApps size={16} />
  }
}

function handleMenuListKeyDown(
  event: KeyboardEvent<HTMLElement>,
  itemSelector: string,
  onClose: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    onClose()
    return
  }
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(itemSelector))
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  let next: number | null = null
  if (event.key === "ArrowDown") next = (current + 1) % items.length
  if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length
  if (event.key === "Home") next = 0
  if (event.key === "End") next = items.length - 1
  if (next !== null) {
    event.preventDefault()
    event.stopPropagation()
    items[next]?.focus()
  }
}

function ContextPopoverOptions({
  items,
  emptyText,
  disabled,
  onSelect,
}: {
  items: readonly ConversationContextActionItem[]
  emptyText: string
  disabled: boolean
  onSelect: (itemId: string) => void
}): ReactElement {
  return (
    <div className="wb-composer-context-popover-list">
      {items.length === 0 ? (
        <p className="wb-composer-menu-empty">{emptyText}</p>
      ) : items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="wb-composer-context-option"
          data-active={item.active || undefined}
          data-tone={item.tone}
          disabled={disabled || !item.availability.enabled}
          title={item.availability.reason ?? item.description}
          onClick={() => onSelect(item.id)}
        >
          <span className="wb-composer-context-option-text">
            <span>{item.label}</span>
            {item.description ? <small>{item.description}</small> : null}
          </span>
          {item.active ? <IconCheck size={13} aria-hidden="true" /> : null}
        </button>
      ))}
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

/** Agent 切换保留分栏打开，新会话公布模型后立即更新右侧。 */
function CapabilityMenu({ scope, controls, label, split, isTabCycle, open, onOpenChange, onSelect }: {
  scope: ConversationScope
  controls: readonly Control[]
  label: string
  split?: boolean
  isTabCycle?: boolean
  open: boolean
  onOpenChange: (next: boolean) => void
  onSelect?: ConversationActions["onCapabilitySelect"]
}): ReactElement {
  const [search, setSearch] = useState("")
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const menu = useRef<HTMLDivElement | null>(null)
  const firstControl = controls[0]
  const selectedItem = firstControl?.items.find(item => item.id === firstControl.selectedId)
  const permission = firstControl?.kind === "permission"
  const TriggerIcon = split ? IconCpu : permission ? permissionIcons[selectedItem?.permissionKind ?? "supervised"] : null
  const enabled = Boolean(onSelect && controls.some(control => control.availability.enabled))
  const displayLabel = controls.filter(control => control.kind !== "effort")
    .map(control => control.items.find(item => item.id === control.selectedId)?.label)
    .filter(Boolean).join(" · ") || label
  const tooltip = enabled ? `${label}：${displayLabel}${isTabCycle ? "（按 Tab 或 Shift+Tab 轮转）" : ""}`
    : controls[0]?.availability.reason ?? "当前不可切换"

  useEffect(() => {
    if (!open) return
    const searchField = menu.current?.querySelector<HTMLInputElement>('input:not(:disabled)')
    const current = menu.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]:not(:disabled)')
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    ;(searchField ?? current ?? first)?.focus()
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onOpenChange(false) }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [open])

  useEffect(() => { if (!enabled && open) onOpenChange(false) }, [enabled, open])

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onOpenChange(false); trigger.current?.focus(); return }
    if (split) {
      // 搜索框在消息表单内。回车只留在搜索，避免误发原来的草稿。
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault()
      return
    }
    handleMenuListKeyDown(event, '[role="menuitemradio"]:not(:disabled)', () => {
      onOpenChange(false)
      trigger.current?.focus()
    })
  }

  const modelControls = split ? controls.slice(1) : controls
  const modelControl = modelControls.find(control => control.kind === "model")
  const query = search.trim().toLowerCase()
  const renderOptions = (control: Control) => {
    const items = query && control.kind === "model"
      ? control.items.filter(item => `${item.label} ${item.id}`.toLowerCase().includes(query))
      : control.items
    return <div className="wb-capability-group" role="group" aria-label={control.label} key={control.id}>
      {split && control.kind === "effort" ? <div className="wb-capability-heading">{control.label}</div> : null}
      {items.length === 0 ? <p className="wb-composer-menu-empty">{query && control.kind === "model" ? "没有匹配的模型" : "暂无可用选项"}</p> : items.map(item => {
        const selected = item.id === control.selectedId
        const PermissionIcon = item.permissionKind ? permissionIcons[item.permissionKind] : null
        return (
          <button key={item.id} type="button"
            role={split ? undefined : "menuitemradio"} tabIndex={split ? undefined : -1}
            aria-checked={split ? undefined : selected} aria-pressed={split ? selected : undefined}
            data-model-option={control.kind === "model" || undefined}
            data-full-access={item.permissionKind === "full" || undefined}
            disabled={!control.availability.enabled || !item.availability.enabled}
            title={item.availability.reason ?? control.availability.reason ?? (control.kind === "model" ? item.label : undefined)}
            onClick={() => { onOpenChange(false); onSelect?.(scope, control.id, item.id); trigger.current?.focus() }}>
            {PermissionIcon ? <PermissionIcon className="wb-permission-icon" size={15} aria-hidden="true" /> : null}
            <span>{item.label}{item.description || item.availability.reason ? <small>{item.description ?? item.availability.reason}</small> : null}</span>
            {selected ? <IconCheck size={13} aria-hidden="true" /> : null}
          </button>
        )
      })}
    </div>
  }

  return <div ref={root} className="wb-composer-control" data-agent-model={split || undefined} onBlur={event => {
    // 焦点在触发按钮与菜单选项之间移动时保持打开；离开整个控件后及时收起。
    if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) onOpenChange(false)
  }}>
    <button
      ref={trigger}
      type="button"
      className={`wb-composer-chip${isTabCycle ? " is-tab-cycle" : ""}`}
      data-full-access={permission && selectedItem?.permissionKind === "full" || undefined}
      disabled={!enabled}
      title={tooltip}
      aria-label={`${label}：${displayLabel}`}
      aria-haspopup={split ? "dialog" : "menu"}
      aria-expanded={open}
      onClick={() => { setSearch(""); onOpenChange(!open) }}
    >
      {TriggerIcon ? <TriggerIcon className={permission ? "wb-permission-icon" : undefined} aria-hidden="true" /> : null}
      <span className="wb-composer-chip-label">{displayLabel}</span>
      {isTabCycle ? <kbd className="wb-composer-tab-badge" aria-hidden="true">Tab</kbd> : null}
      <IconChevronDown aria-hidden="true" />
    </button>
    {open ? <div ref={menu} className="wb-capability-menu" role={split ? "dialog" : "menu"} aria-label={label} onKeyDown={onMenuKey}>
      {split && firstControl ? <>
        <div className="wb-agent-picker-list" role="group" aria-label="Agent">
          {firstControl.items.map(agent => <button key={agent.id} type="button"
            aria-pressed={agent.id === firstControl.selectedId}
            aria-label={agent.label}
            disabled={!firstControl.availability.enabled || !agent.availability.enabled}
            title={agent.availability.reason ? `${agent.label} · ${agent.availability.reason}` : agent.label}
            onClick={() => {
              if (agent.id === firstControl.selectedId) return
              setSearch("")
              onSelect?.(scope, firstControl.id, agent.id)
            }}>
            {agent.id === "harness" ? <IconCpu size={16} aria-hidden="true" /> : <span aria-hidden="true">{agent.label.slice(0, 2)}</span>}
          </button>)}
        </div>
        <div className="wb-agent-picker-models">
          <label className="wb-agent-picker-search">
            <IconSearch size={14} aria-hidden="true" />
            <input type="search" aria-label="搜索模型" placeholder="搜索模型" value={search}
              disabled={!modelControl?.items.length} onChange={event => setSearch(event.currentTarget.value)} />
          </label>
          {modelControl ? renderOptions(modelControl) : <p className="wb-composer-menu-empty">暂无可选模型</p>}
          {modelControls.filter(control => control !== modelControl).map(renderOptions)}
        </div>
      </> : controls.map(renderOptions)}
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
