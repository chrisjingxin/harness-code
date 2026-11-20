/**
 * 输入区行内引用块（含点击浮层修改所选文本与追加批注）及用户消息气泡折叠引用展示。
 *
 * 1. 功能定义：
 *    - `ComposerAnnotationsBar`：直接在输入框上方平铺紧凑行内引用块（`❞ 摘录… ✏️`），
 *      点击任意引用块在上方弹出编辑浮层，同时支持修改所选文本本身和追加/修改可选批注，
 *      全程使用表意图标减少文字噪点；
 *    - `AnnotatedUserMessage`：在时间线用户气泡中解析 `composeAnnotatedPrompt` 产出的消息，
 *      将注释块渲染为紧凑可点击展开的行内引用块与下方提问正文。
 * 2. 协作边界：纯受控 UI 组件，所有变更通过回调上报装配方，不持有持久化状态。
 */
import {
  IconCheck,
  IconFileCode,
  IconMessageDots,
  IconMessagePlus,
  IconPencil,
  IconQuote,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { Fragment, useEffect, useRef, useState } from "react"
import type { KeyboardEvent, ReactElement } from "react"

import {
  MAX_DRAFT_ANNOTATION_COMMENT_CHARS,
  MAX_DRAFT_ANNOTATION_TEXT_CHARS,
  normalizeAnnotationComment,
  normalizeAnnotationSelectedText,
  parseAnnotatedUserMessage,
} from "./annotations-codec.js"
import { splitComposerHighlightSegments } from "./mention-policy.js"
import type { ConversationDraftAnnotation } from "./types.js"

export interface ComposerAnnotationsBarProps {
  readonly annotations: readonly ConversationDraftAnnotation[]
  readonly canEdit: boolean
  readonly onUpdate: (id: string, patch: { readonly selectedText: string; readonly comment?: string }) => void
  readonly onRemove: (id: string) => void
}

function compactSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** 输入区内部的行内引用块列表与上方编辑浮层。 */
export function ComposerAnnotationsBar({
  annotations,
  canEdit,
  onUpdate,
  onRemove,
}: ComposerAnnotationsBarProps): ReactElement | null {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftSelected, setDraftSelected] = useState("")
  const [draftComment, setDraftComment] = useState("")

  useEffect(() => {
    if (annotations.length === 0 || (activeId && !annotations.some(item => item.id === activeId))) {
      setActiveId(null)
      setDraftSelected("")
      setDraftComment("")
    }
  }, [annotations, activeId])

  useEffect(() => {
    if (!activeId) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setActiveId(null)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setActiveId(null)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [activeId])

  if (annotations.length === 0) return null

  const activeItem = activeId ? annotations.find(item => item.id === activeId) ?? null : null

  const openEditor = (item: ConversationDraftAnnotation) => {
    if (!canEdit) return
    if (activeId === item.id) {
      setActiveId(null)
      return
    }
    setActiveId(item.id)
    setDraftSelected(item.selectedText)
    setDraftComment(item.comment ?? "")
  }

  const closeEditor = () => {
    setActiveId(null)
  }

  const saveEditor = (item: ConversationDraftAnnotation) => {
    if (!canEdit) return
    const normalizedText = normalizeAnnotationSelectedText(draftSelected)
    if (!normalizedText) return
    const normalizedComment = normalizeAnnotationComment(draftComment)
    onUpdate(item.id, {
      selectedText: normalizedText.text,
      ...(normalizedComment ? { comment: normalizedComment.text } : {}),
    })
    setActiveId(null)
  }

  const handleFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, item: ConversationDraftAnnotation) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closeEditor()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      saveEditor(item)
    }
  }

  const canSave = canEdit && draftSelected.trim().length > 0

  return (
    <div ref={rootRef} className="wb-composer-quotes" aria-label="已引用内容">
      {activeItem ? (
        <div className="wb-composer-quote-popover" role="dialog" aria-label="编辑引用与批注">
          {activeItem.sourceLabel ? (
            <div className="wb-composer-quote-source" title={activeItem.sourceLabel}>
              <IconFileCode size={13} aria-hidden="true" />
              <span>{activeItem.sourceLabel}</span>
            </div>
          ) : null}

          <label className="wb-composer-quote-field">
            <span className="wb-composer-quote-field-icon" aria-hidden="true">
              <IconQuote size={14} />
            </span>
            <textarea
              rows={2}
              maxLength={MAX_DRAFT_ANNOTATION_TEXT_CHARS}
              aria-label="所选文本"
              value={draftSelected}
              disabled={!canEdit}
              onChange={event => setDraftSelected(event.currentTarget.value)}
              onKeyDown={event => handleFieldKeyDown(event, activeItem)}
            />
          </label>

          <label className="wb-composer-quote-field">
            <span className="wb-composer-quote-field-icon" aria-hidden="true">
              <IconMessagePlus size={14} />
            </span>
            <textarea
              rows={2}
              autoFocus
              maxLength={MAX_DRAFT_ANNOTATION_COMMENT_CHARS}
              aria-label="补充批注"
              placeholder="添加批注…"
              value={draftComment}
              disabled={!canEdit}
              onChange={event => setDraftComment(event.currentTarget.value)}
              onKeyDown={event => handleFieldKeyDown(event, activeItem)}
            />
          </label>

          <div className="wb-composer-quote-footer">
            <button
              type="button"
              className="wb-composer-quote-icon-btn is-danger"
              aria-label="删除"
              title="删除"
              disabled={!canEdit}
              onClick={() => {
                setActiveId(null)
                onRemove(activeItem.id)
              }}
            >
              <IconTrash size={14} aria-hidden="true" />
            </button>
            <div className="wb-composer-quote-footer-right">
              <button
                type="button"
                className="wb-composer-quote-cancel-btn"
                aria-label="取消"
                title="取消"
                onClick={closeEditor}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="wb-composer-quote-save-btn"
                aria-label="保存"
                title="保存"
                disabled={!canSave}
                onClick={() => saveEditor(activeItem)}
              >
                <IconCheck size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="wb-composer-quote-list">
        {annotations.map((item, index) => {
          const active = activeId === item.id
          const snippet = compactSnippet(item.selectedText)
          const tooltipParts = [item.sourceLabel, item.selectedText, item.comment].filter(Boolean)
          return (
            <div key={item.id} className="wb-composer-quote-chip" data-active={active || undefined}>
              <button
                type="button"
                className="wb-composer-quote-trigger"
                aria-expanded={active}
                aria-label={`编辑第 ${index + 1} 条引用`}
                title={tooltipParts.join("\n")}
                disabled={!canEdit}
                onClick={() => openEditor(item)}
              >
                <IconQuote size={14} aria-hidden="true" className="wb-composer-quote-mark" />
                <span className="wb-composer-quote-snippet">{snippet}</span>
                {item.comment ? (
                  <IconMessageDots size={13} aria-hidden="true" className="wb-composer-quote-comment-icon" />
                ) : null}
                <IconPencil size={13} aria-hidden="true" className="wb-composer-quote-edit-icon" />
              </button>
              <button
                type="button"
                className="wb-composer-quote-remove"
                aria-label={`移除第 ${index + 1} 条引用`}
                title="移除"
                disabled={!canEdit}
                onClick={event => {
                  event.stopPropagation()
                  if (active) setActiveId(null)
                  onRemove(item.id)
                }}
              >
                <IconX size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function InlineHighlightedUserText({ text }: { readonly text: string }): ReactElement {
  const segments = splitComposerHighlightSegments(text, { includeBareLeadingCommand: true })
  if (!segments.some(segment => segment.kind !== "plain")) {
    return <>{text}</>
  }
  return (
    <>
      {segments.map((segment, index) => (
        segment.kind === "command"
          ? <span key={index} className="wb-message-inline-command">{segment.text}</span>
          : segment.kind === "mention"
            ? <span key={index} className="wb-message-inline-mention">{segment.text}</span>
            : <Fragment key={index}>{segment.text}</Fragment>
      ))}
    </>
  )
}

/** 时间线用户消息气泡：识别附带引用的文本并渲染紧凑可展开的行内引用块，并同步高亮行首 `/命令` 与 `@引用`。 */
export function AnnotatedUserMessage({ text }: { readonly text: string }): ReactElement {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const parsed = parseAnnotatedUserMessage(text)

  if (!parsed) {
    return <InlineHighlightedUserText text={text} />
  }

  const expandedItem = expandedIndex !== null ? parsed.annotations[expandedIndex] ?? null : null

  return (
    <div className="wb-message-annotated">
      <div className="wb-message-quotes" data-selection-ignore="true">
        <div className="wb-message-quote-chips">
          {parsed.annotations.map((item, index) => {
            const expanded = expandedIndex === index
            const snippet = compactSnippet(item.selectedText)
            return (
              <button
                key={index}
                type="button"
                className="wb-message-quote-chip"
                aria-expanded={expanded}
                title={[item.sourceLabel, item.selectedText, item.comment].filter(Boolean).join("\n")}
                onClick={() => setExpandedIndex(current => (current === index ? null : index))}
              >
                <IconQuote size={13} aria-hidden="true" className="wb-message-quote-mark" />
                <span className="wb-message-quote-snippet">{snippet}</span>
                {item.comment ? (
                  <IconMessageDots size={12} aria-hidden="true" className="wb-message-quote-comment-icon" />
                ) : null}
              </button>
            )
          })}
        </div>
        {expandedItem ? (
          <div className="wb-message-quote-detail">
            {expandedItem.sourceLabel ? (
              <div className="wb-message-quote-detail-row is-source">
                <IconFileCode size={13} aria-hidden="true" />
                <span>{expandedItem.sourceLabel}</span>
              </div>
            ) : null}
            <div className="wb-message-quote-detail-row">
              <IconQuote size={13} aria-hidden="true" />
              <div className="wb-message-quote-detail-text">{expandedItem.selectedText}</div>
            </div>
            {expandedItem.comment ? (
              <div className="wb-message-quote-detail-row is-comment">
                <IconMessageDots size={13} aria-hidden="true" />
                <div className="wb-message-quote-detail-text">{expandedItem.comment}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {parsed.body ? <div className="wb-message-annotated-body"><InlineHighlightedUserText text={parsed.body} /></div> : null}
    </div>
  )
}
