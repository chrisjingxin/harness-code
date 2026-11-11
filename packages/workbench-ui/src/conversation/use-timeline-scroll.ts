/**
 * 时间线个人滚动：记录可见条目的锚点，在内容更新与隐藏/重开之间恢复阅读位置。
 *
 * 输入是当前视图、条目变化及调用方保存的个人状态；这里只发出局部状态变化，
 * 不读取会话服务，也不因其他人发消息而把正在上滚的用户拉到底部。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type { RefObject } from "react"

import type {
  ConversationScope,
  ConversationTimelineChange,
  ConversationTimelineScroll,
} from "./types.js"

const BOTTOM_THRESHOLD_PX = 48

interface TimelineScrollInput {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly contentRevision: number
  readonly entryIds: readonly string[]
  readonly saved: ConversationTimelineScroll
  readonly onChange?: (scope: ConversationScope, change: ConversationTimelineChange) => void
}

interface TimelineScrollResult {
  readonly scrollerRef: RefObject<HTMLDivElement | null>
  readonly showBottomButton: boolean
  readonly hasNewOutput: boolean
  readonly anchorUnavailable: boolean
  readonly onScroll: () => void
  readonly scrollToBottom: () => void
}

/** 实例由 scope 隔离；调用方保存回调中的锚点，供切换会话或重新挂载时恢复。 */
export function useTimelineScroll(input: TimelineScrollInput): TimelineScrollResult {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const savedRef = useRef(input.saved)
  const followingRef = useRef(input.saved.following)
  const scopeRef = useRef(input.scope)
  const changeRef = useRef(input.onChange)
  const entryIdsRef = useRef(input.entryIds)
  const visibleRef = useRef(false)
  const currentRevisionRef = useRef(input.contentRevision)
  const seenRevisionRef = useRef(input.saved.seenContentRevision)
  const suppliedSeenRef = useRef(input.saved.seenContentRevision)
  const visibleIdsRef = useRef(input.entryIds)
  const programmedTopRef = useRef<number | null>(null)
  const [showBottomButton, setShowBottomButton] = useState(!input.saved.following)
  const [hasNewOutput, setHasNewOutput] = useState(false)
  const [anchorUnavailable, setAnchorUnavailable] = useState(false)

  scopeRef.current = input.scope
  changeRef.current = input.onChange
  entryIdsRef.current = input.entryIds
  currentRevisionRef.current = input.contentRevision
  if (visibleRef.current && input.visible) visibleIdsRef.current = input.entryIds

  const publish = useCallback((scroller: HTMLDivElement, following: boolean) => {
    const next = readPosition(scroller, following, seenRevisionRef.current)
    if (samePosition(savedRef.current, next)) return
    savedRef.current = next
    changeRef.current?.(scopeRef.current, { kind: "scroll", value: next })
  }, [])

  const setProgrammedTop = useCallback((scroller: HTMLDivElement, top: number) => {
    scroller.scrollTop = top
    // 程序恢复位置产生的 scroll 事件不能覆盖用户原来的跟随选择。
    programmedTopRef.current = scroller.scrollTop
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const wasVisible = visibleRef.current
    visibleRef.current = input.visible

    // 装配层重建版本时会清空已读基线；不要把新旧生命周期的版本互相比较。
    if (input.saved.seenContentRevision === null && suppliedSeenRef.current !== null) {
      seenRevisionRef.current = null
      savedRef.current = input.saved
    }
    suppliedSeenRef.current = input.saved.seenContentRevision

    if (!input.visible) return

    const noBaseline = seenRevisionRef.current === null
    if (noBaseline) seenRevisionRef.current = input.contentRevision
    const hasUnseenOutput = seenRevisionRef.current !== null && input.contentRevision > seenRevisionRef.current

    if (!wasVisible) {
      const saved = savedRef.current
      const restored = findRestoreAnchor(scroller, saved.anchorEntryId, visibleIdsRef.current)
      if (restored.element) {
        const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop
        const delta = restored.element.getBoundingClientRect().top - viewportTop - saved.offsetPx
        setProgrammedTop(scroller, scroller.scrollTop + delta)
      } else if (saved.anchorEntryId === null && saved.following && !hasUnseenOutput) {
        setProgrammedTop(scroller, scroller.scrollHeight)
      } else {
        setProgrammedTop(scroller, 0)
      }
      setAnchorUnavailable(restored.missing)
      // 重新挂载期间内容或窗口大小可能变化；恢复后如果已离开底部，
      // 不能沿用旧的“贴底”标记，让下一条消息强行覆盖刚恢复的位置。
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD_PX
      followingRef.current = !hasUnseenOutput && saved.following && nearBottom
      setShowBottomButton(!followingRef.current)
      setHasNewOutput(hasUnseenOutput)
      publish(scroller, followingRef.current)
      visibleIdsRef.current = entryIdsRef.current
      return
    }

    if (hasUnseenOutput) {
      if (followingRef.current) {
        seenRevisionRef.current = input.contentRevision
        setProgrammedTop(scroller, scroller.scrollHeight)
        setShowBottomButton(false)
        setHasNewOutput(false)
        publish(scroller, true)
      } else {
        setShowBottomButton(true)
        setHasNewOutput(true)
      }
    } else if (noBaseline) {
      setHasNewOutput(false)
      publish(scroller, followingRef.current)
    }
    visibleIdsRef.current = entryIdsRef.current
  }, [input.visible, input.contentRevision, input.saved, publish, setProgrammedTop])

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !visibleRef.current) return
    const programmedTop = programmedTopRef.current
    programmedTopRef.current = null
    if (programmedTop !== null && Math.abs(programmedTop - scroller.scrollTop) < 1) return
    const following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD_PX
    followingRef.current = following
    setShowBottomButton(!following)
    if (following) {
      seenRevisionRef.current = currentRevisionRef.current
      setHasNewOutput(false)
    }
    publish(scroller, following)
  }, [publish])

  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !visibleRef.current) return
    setProgrammedTop(scroller, scroller.scrollHeight)
    followingRef.current = true
    seenRevisionRef.current = currentRevisionRef.current
    setShowBottomButton(false)
    setHasNewOutput(false)
    setAnchorUnavailable(false)
    publish(scroller, true)
  }, [publish, setProgrammedTop])

  return { scrollerRef, showBottomButton, hasNewOutput, anchorUnavailable, onScroll, scrollToBottom }
}

/** 选择视口内最上方的实际条目，避免把像素偏移误当成另一会话的位置。 */
function readPosition(scroller: HTMLDivElement, following: boolean, seenContentRevision: number | null): ConversationTimelineScroll {
  const viewport = scroller.getBoundingClientRect()
  const top = viewport.top + scroller.clientTop
  const bottom = top + scroller.clientHeight
  const entries = entryElements(scroller)
  const anchor = entries.find(element => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > top && rect.top < bottom
  })
  return {
    anchorEntryId: anchor?.dataset.conversationEntryId ?? null,
    offsetPx: anchor ? anchor.getBoundingClientRect().top - top : 0,
    following,
    seenContentRevision,
  }
}

/** 原锚点消失时优先使用之前顺序中最近仍存在的条目，并告知界面位置已变化。 */
function findRestoreAnchor(
  scroller: HTMLDivElement,
  anchorId: string | null,
  previousIds: readonly string[],
): { element: HTMLElement | null; missing: boolean } {
  if (anchorId === null) return { element: null, missing: false }
  const elements = entryElements(scroller)
  const byId = new Map<string, HTMLElement>()
  for (const element of elements) {
    const id = element.dataset.conversationEntryId
    if (id !== undefined) byId.set(id, element)
  }
  const exact = byId.get(anchorId)
  if (exact) return { element: exact, missing: false }
  const previousIndex = previousIds.indexOf(anchorId)
  if (previousIndex >= 0) {
    for (let distance = 1; distance < previousIds.length; distance += 1) {
      const before = previousIds[previousIndex - distance]
      const after = previousIds[previousIndex + distance]
      const candidate = (before ? byId.get(before) : undefined) ?? (after ? byId.get(after) : undefined)
      if (candidate) return { element: candidate, missing: true }
    }
  }
  return { element: elements[0] ?? null, missing: true }
}

function entryElements(scroller: HTMLDivElement): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-conversation-entry-id]"))
}

function samePosition(left: ConversationTimelineScroll, right: ConversationTimelineScroll): boolean {
  return left.anchorEntryId === right.anchorEntryId
    && Math.abs(left.offsetPx - right.offsetPx) < 1
    && left.following === right.following
    && left.seenContentRevision === right.seenContentRevision
}
