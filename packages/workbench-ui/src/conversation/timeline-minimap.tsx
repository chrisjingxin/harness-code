/**
 * 会话锚定刻度列：左侧一列短横线对应每条用户提问，悬停或聚焦浮出提问预览，
 * 点击平滑跳转到该提问。组件只读条目位置并回调跳转，不掌握会话数据。
 *
 * 刻度列表 → 滚动监听计算当前提问 → 悬停/聚焦显示预览 → 点击/回车执行跳转。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent, RefObject } from "react"

import type { MinimapItem } from "./timeline-model.js"

interface TimelineMinimapProps {
  readonly scrollerRef: RefObject<HTMLDivElement | null>
  readonly items: readonly MinimapItem[]
  readonly onJump: (entryId: string) => void
}

/** 少于两条提问时跳转没有意义，整条刻度列不渲染。 */
export function TimelineMinimap({ scrollerRef, items, onJump }: TimelineMinimapProps) {
  const navRef = useRef<HTMLElement | null>(null)
  const tickRefs = useRef(new Map<string, HTMLButtonElement>())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [popover, setPopover] = useState<{ entryId: string; top: number } | null>(null)

  const firstId = items[0]?.entryId ?? null
  const activeFocusId = focusId !== null && items.some(item => item.entryId === focusId) ? focusId : firstId

  /* 当前提问 = 顶部越过视口三分之一线的最后一条用户消息；全都没越线时取第一条。 */
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || items.length === 0) return
    let frame = 0
    const update = () => {
      frame = 0
      const viewport = scroller.getBoundingClientRect()
      const threshold = viewport.top + viewport.height / 3
      let current: string | null = items[0]?.entryId ?? null
      for (const item of items) {
        const element = scroller.querySelector(`[data-conversation-entry-id="${CSS.escape(item.entryId)}"]`)
        if (element instanceof HTMLElement && element.getBoundingClientRect().top <= threshold) current = item.entryId
      }
      setCurrentId(current)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    scroller.addEventListener("scroll", schedule, { passive: true })
    update()
    return () => {
      scroller.removeEventListener("scroll", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scrollerRef, items])

  const showPopover = useCallback((entryId: string, tick: HTMLButtonElement) => {
    const nav = navRef.current
    if (!nav) return
    const navRect = nav.getBoundingClientRect()
    const tickRect = tick.getBoundingClientRect()
    setPopover({ entryId, top: tickRect.top + tickRect.height / 2 - navRect.top })
  }, [])

  const focusTick = useCallback((entryId: string | null) => {
    if (entryId === null) return
    setFocusId(entryId)
    tickRefs.current.get(entryId)?.focus()
  }, [])

  /* 漫游 tabindex：方向键在刻度间移动焦点，Home/End 到两端，Enter/Space 跳转。 */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = items.findIndex(item => item.entryId === activeFocusId)
    if (event.key === "ArrowDown") focusTick(items[Math.min(index + 1, items.length - 1)]?.entryId ?? null)
    else if (event.key === "ArrowUp") focusTick(items[Math.max(index - 1, 0)]?.entryId ?? null)
    else if (event.key === "Home") focusTick(firstId)
    else if (event.key === "End") focusTick(items.at(-1)?.entryId ?? null)
    else if ((event.key === "Enter" || event.key === " ") && activeFocusId !== null) onJump(activeFocusId)
    else return
    event.preventDefault()
  }

  if (items.length < 2) return null

  const popoverItem = popover ? items.find(item => item.entryId === popover.entryId) ?? null : null
  const popoverTime = popoverItem?.createdAtMs !== undefined && Number.isFinite(popoverItem.createdAtMs)
    ? new Date(popoverItem.createdAtMs).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : null

  return (
    <nav ref={navRef} className="wb-conversation-minimap" aria-label="提问锚点" onKeyDown={onKeyDown}>
      <div className="wb-conversation-minimap-track">
        {items.map(item => (
          <button
            key={item.entryId}
            type="button"
            ref={element => {
              if (element) tickRefs.current.set(item.entryId, element)
              else tickRefs.current.delete(item.entryId)
            }}
            className="wb-conversation-minimap-tick"
            data-current={item.entryId === currentId || undefined}
            tabIndex={item.entryId === activeFocusId ? 0 : -1}
            aria-label={`跳到提问：${item.text.slice(0, 40)}`}
            aria-describedby={popover?.entryId === item.entryId ? "wb-conversation-minimap-tip" : undefined}
            onMouseEnter={event => showPopover(item.entryId, event.currentTarget)}
            onMouseLeave={event => {
              if (document.activeElement !== event.currentTarget) setPopover(null)
            }}
            onFocus={event => {
              setFocusId(item.entryId)
              showPopover(item.entryId, event.currentTarget)
            }}
            onBlur={event => {
              if (!event.currentTarget.matches(":hover")) setPopover(null)
            }}
            onClick={() => onJump(item.entryId)}
          />
        ))}
      </div>
      {popoverItem ? (
        <div
          role="tooltip"
          id="wb-conversation-minimap-tip"
          className="wb-conversation-minimap-popover"
          style={{ top: popover?.top ?? 0 }}
        >
          {popoverTime ? <div className="wb-conversation-minimap-popover-time">{popoverTime}</div> : null}
          <div className="wb-conversation-minimap-popover-text">{popoverItem.text}</div>
        </div>
      ) : null}
    </nav>
  )
}
