/**
 * 通用文本划选浮动工具条：在受控阅读区内捕获有效选区并在上方锚定「添加到对话」浮窗。
 *
 * 1. 功能定义：读取浏览器原生 `Selection`，过滤不可选控件与跨区选区，在视口边界内锚定浮窗。
 * 2. 协作边界：纯 UI 层组件，通过可选 `resolveSource` 回调扩展文件/Diff 来源识别，
 *    点击按钮前锁定当前选区快照并以 `onMouseDown={preventDefault}` 避免失去选区。
 */
import { IconQuote } from "@tabler/icons-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactElement, RefObject } from "react"
import { createPortal } from "react-dom"

import { computeLineRangeFromOffsets } from "./annotations-codec.js"
import type { ConversationSelectionAnnotation } from "./types.js"

export interface SelectionToolbarProps {
  readonly containerRef: RefObject<HTMLElement | null>
  readonly enabled: boolean
  readonly resolveSource?: (range: Range, rawText: string) => ConversationSelectionAnnotation | null
  readonly onAddToChat: (selection: ConversationSelectionAnnotation) => void
  readonly label?: string
}

type PendingToolbar = {
  readonly selection: ConversationSelectionAnnotation
  readonly top: number
  readonly bottom: number
  readonly centerX: number
}

function findSelectionFileHost(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null
  return element?.closest<HTMLElement>("[data-selection-file-path]") ?? null
}

/** 从中央文件/Diff 分屏的 DOM 选区识别文件路径与源码行号区间。 */
export function resolveFileSelectionSource(
  range: Range,
  rawText: string,
): ConversationSelectionAnnotation | null {
  const startHost = findSelectionFileHost(range.startContainer)
  const endHost = findSelectionFileHost(range.endContainer)
  let host: HTMLElement | null = null
  if (startHost && endHost) {
    if (startHost !== endHost) return null
    host = startHost
  } else if (startHost && range.endContainer.contains(startHost)) {
    host = startHost
  } else if (endHost && range.startContainer.contains(endHost)) {
    host = endHost
  }
  if (!host) return null

  const path = host.getAttribute("data-selection-file-path")?.trim()
  const kind = host.getAttribute("data-selection-file-kind")
  if (!path) return null

  if (kind === "code") {
    let textBeforeStart = ""
    if (host.contains(range.startContainer)) {
      try {
        const preRange = host.ownerDocument.createRange()
        preRange.setStart(host, 0)
        preRange.setEnd(range.startContainer, range.startOffset)
        textBeforeStart = preRange.toString()
      } catch {
        textBeforeStart = ""
      }
    }
    const normalizedRaw = rawText.replace(/\r\n?/g, "\n")
    const cleanedSelected = normalizedRaw.endsWith("\n") && normalizedRaw.slice(0, -1).trim().length > 0
      ? normalizedRaw.slice(0, -1)
      : normalizedRaw
    const { startLine, endLine } = computeLineRangeFromOffsets(textBeforeStart, rawText)
    const sourceLabel = startLine === endLine ? `${path}:L${startLine}` : `${path}:L${startLine}-L${endLine}`
    return { selectedText: cleanedSelected, sourceLabel }
  }

  if (kind === "diff") {
    return { selectedText: rawText, sourceLabel: `${path} (Diff)` }
  }

  if (kind === "markdown") {
    return { selectedText: rawText, sourceLabel: path }
  }

  return { selectedText: rawText, sourceLabel: path }
}

function isIgnoredTarget(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement ?? null
  if (!element) return false
  return Boolean(
    element.closest(
      'input, textarea, select, [contenteditable="true"], [data-selection-ignore="true"], button:not(.markdown-file-reference)',
    ),
  )
}

function getVisibleBounds(element: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  let top = 0
  let left = 0
  let bottom = window.innerHeight
  let right = window.innerWidth
  let current: HTMLElement | null = element
  while (current) {
    const style = window.getComputedStyle(current)
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`
    if (/(auto|scroll|hidden|clip)/.test(overflow)) {
      const rect = current.getBoundingClientRect()
      top = Math.max(top, rect.top)
      left = Math.max(left, rect.left)
      bottom = Math.min(bottom, rect.bottom)
      right = Math.min(right, rect.right)
    }
    current = current.parentElement
  }
  return { top, bottom, left, right }
}

function measureToolbarAnchor(
  range: Range,
  container: HTMLElement,
): { top: number; bottom: number; centerX: number } | null {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const anchorNode = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement
  const bounds = getVisibleBounds(anchorNode ?? container)
  if (
    rect.bottom <= bounds.top
    || rect.top >= bounds.bottom
    || rect.right <= bounds.left
    || rect.left >= bounds.right
  ) {
    return null
  }
  return {
    top: rect.top,
    bottom: rect.bottom,
    centerX: rect.left + rect.width / 2,
  }
}

export function SelectionToolbar({
  containerRef,
  enabled,
  resolveSource,
  onAddToChat,
  label = "添加到对话",
}: SelectionToolbarProps): ReactElement | null {
  const [pending, setPending] = useState<PendingToolbar | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const activeRangeRef = useRef<Range | null>(null)
  const resolveSourceRef = useRef(resolveSource)
  resolveSourceRef.current = resolveSource

  const clearToolbar = useCallback(() => {
    activeRangeRef.current = null
    setPending(null)
  }, [])

  const evaluateSelection = useCallback(() => {
    const container = containerRef.current
    if (!enabled || !container) {
      clearToolbar()
      return
    }
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      clearToolbar()
      return
    }
    const rawText = selection.toString()
    if (rawText.trim().length === 0) {
      clearToolbar()
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      clearToolbar()
      return
    }
    if (isIgnoredTarget(range.startContainer) || isIgnoredTarget(range.endContainer)) {
      clearToolbar()
      return
    }
    const resolved = resolveSourceRef.current
      ? resolveSourceRef.current(range, rawText)
      : { selectedText: rawText }
    if (!resolved || resolved.selectedText.trim().length === 0) {
      clearToolbar()
      return
    }
    const anchor = measureToolbarAnchor(range, container)
    if (!anchor) {
      clearToolbar()
      return
    }
    activeRangeRef.current = range.cloneRange()
    setPending({ selection: resolved, ...anchor })
  }, [containerRef, enabled, clearToolbar])

  useEffect(() => {
    if (!enabled) {
      clearToolbar()
      return
    }
    const container = containerRef.current
    if (!container) return

    let frame = 0
    const scheduleEvaluate = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        evaluateSelection()
      })
    }

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (toolbarRef.current && target && toolbarRef.current.contains(target)) return
      clearToolbar()
    }
    const onMouseUp = () => scheduleEvaluate()
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearToolbar()
        return
      }
      if (event.shiftKey || event.key === "a" || event.key === "A") {
        scheduleEvaluate()
      }
    }
    const onSelectionChange = () => {
      if (!activeRangeRef.current) return
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        clearToolbar()
        return
      }
      const range = selection.getRangeAt(0)
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        clearToolbar()
      }
    }
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeRangeRef.current) {
        clearToolbar()
      }
    }
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!activeRangeRef.current) return
      const target = event.target as Node | null
      if (toolbarRef.current && target && toolbarRef.current.contains(target)) return
      if (target && !container.contains(target)) {
        clearToolbar()
      }
    }

    container.addEventListener("mousedown", onMouseDown)
    container.addEventListener("mouseup", onMouseUp)
    container.addEventListener("keyup", onKeyUp)
    document.addEventListener("selectionchange", onSelectionChange)
    document.addEventListener("keydown", onDocumentKeyDown)
    document.addEventListener("pointerdown", onDocumentPointerDown)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      container.removeEventListener("mousedown", onMouseDown)
      container.removeEventListener("mouseup", onMouseUp)
      container.removeEventListener("keyup", onKeyUp)
      document.removeEventListener("selectionchange", onSelectionChange)
      document.removeEventListener("keydown", onDocumentKeyDown)
      document.removeEventListener("pointerdown", onDocumentPointerDown)
    }
  }, [containerRef, enabled, evaluateSelection, clearToolbar])

  useEffect(() => {
    if (!pending) return
    const updatePosition = () => {
      const container = containerRef.current
      const range = activeRangeRef.current
      if (!container || !range) {
        clearToolbar()
        return
      }
      const anchor = measureToolbarAnchor(range, container)
      if (!anchor) {
        clearToolbar()
        return
      }
      setPending(prev => (prev ? { ...prev, ...anchor } : null))
    }
    document.addEventListener("scroll", updatePosition, { capture: true, passive: true })
    window.addEventListener("resize", updatePosition)
    return () => {
      document.removeEventListener("scroll", updatePosition, { capture: true })
      window.removeEventListener("resize", updatePosition)
    }
  }, [pending !== null, containerRef, clearToolbar])

  useLayoutEffect(() => {
    const el = toolbarRef.current
    if (!el || !pending) return
    const rect = el.getBoundingClientRect()
    const width = rect.width || 96
    const height = rect.height || 34
    const maxLeft = Math.max(12, window.innerWidth - width - 12)
    const left = Math.max(12, Math.min(maxLeft, pending.centerX - width / 2))
    const aboveTop = pending.top - height - 8
    const top = aboveTop >= 8
      ? aboveTop
      : Math.max(8, Math.min(window.innerHeight - height - 8, pending.bottom + 8))
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
  }, [pending])

  if (!enabled || !pending || typeof document === "undefined") return null

  return createPortal(
    <div
      ref={toolbarRef}
      className="wb-selection-toolbar"
      role="toolbar"
      aria-label="选区操作"
      data-selection-ignore="true"
    >
      <button
        type="button"
        className="wb-selection-toolbar-btn"
        onMouseDown={event => {
          // 阻止默认焦点转移，确保点击瞬间原生选区不丢失。
          event.preventDefault()
          event.stopPropagation()
        }}
        onClick={() => {
          const payload = pending.selection
          clearToolbar()
          window.getSelection()?.removeAllRanges()
          onAddToChat(payload)
        }}
      >
        <IconQuote size={14} aria-hidden="true" />
        <span>{label}</span>
      </button>
    </div>,
    document.body,
  )
}
