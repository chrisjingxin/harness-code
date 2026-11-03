/** Context Dock：右侧常驻面板；文件与变更共用同一层主 tab，代码预览填满剩余高度。 */
/** @jsxImportSource react */

import { useEffect, useRef, useState } from "react"
import { FolderTree, GitCompareArrows, PanelRightClose } from "lucide-react"

import type { ContextDockPanel, WebAdapterSnapshot, WebIntent } from "../../application/adapter"
import { FileExplorer } from "../workspace-sidebar/file-explorer"
import { CodePanel } from "./code/code-panel"
import { GitPanel } from "./git-panel"
import { DOCK_TABS, tabLabel } from "./panel-common"

/** 关闭时保持挂载（inert + aria-hidden，CSS visibility 隐藏），供开关平移过渡；所有面板共享同一组主 tab 和内容区域。 */
export function ContextDock({
  snapshot,
  dispatch,
  disabled = false,
  hidden = false,
}: {
  snapshot: WebAdapterSnapshot
  dispatch: (intent: WebIntent) => void
  disabled?: boolean
  hidden?: boolean
}): React.ReactElement {
  const { activePanel, widthPx } = snapshot.contextDock
  const open = snapshot.contextDock.open && !hidden
  const interactive = snapshot.interactive
  const header = (
    <header className="context-dock-header">
      <div className="context-dock-tabs" role="tablist" aria-label="Context Dock 面板" onKeyDown={event => handleTabListKeyDown(event, dispatch)}>
        {DOCK_TABS.map(tab => (
          <button
            type="button"
            key={tab}
            role="tab"
            id={`dock-tab-${tab}`}
            aria-selected={activePanel === tab}
            tabIndex={activePanel === tab ? 0 : -1}
            aria-controls="context-dock-panel"
            data-panel={tab}
            className={activePanel === tab ? "dock-tab is-selected" : "dock-tab"}
            disabled={disabled}
            onClick={() => dispatch({ type: "dock-panel-select", panel: tab })}
          >
            {tab === "code" ? <FolderTree size={16} aria-hidden="true" /> : tab === "changes" ? <GitCompareArrows size={16} aria-hidden="true" /> : null}{tabLabel(tab)}{tab === "changes" && interactive.git.repository ? <span className="git-count">{interactive.git.repository.files.length}</span> : null}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="icon-button panel-close"
        onClick={() => dispatch({ type: "dock-close" })}
        disabled={disabled}
        aria-label="关闭 Dock"
      >
        <PanelRightClose aria-hidden="true" />
      </button>
    </header>
  )

  return (
    <aside
      className="context-dock"
      data-active-panel={activePanel}
      aria-label="Context Dock"
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <DockResizeHandle widthPx={widthPx} dispatch={dispatch} disabled={disabled} />
      {header}
      <div
        className={`context-dock-body${activePanel === "code" ? " context-dock-code-body" : ""}`}
        id="context-dock-panel"
        role="tabpanel"
        aria-labelledby={`dock-tab-${activePanel}`}
      >
        {activePanel === "code" ? (
          <div className={`context-dock-code-scroll${snapshot.contextDock.code.tabs.length ? " has-file-preview" : ""}`}>
            <FileExplorer snapshot={snapshot} dispatch={dispatch} disabled={disabled} />
            {snapshot.contextDock.code.tabs.length ? <CodePanel snapshot={snapshot} dispatch={dispatch} disabled={disabled} /> : null}
          </div>
        ) : null}
        {activePanel === "changes" ? <GitPanel snapshot={snapshot} dispatch={dispatch} disabled={disabled} /> : null}
      </div>
    </aside>
  )
}

/** tablist 内使用方向键/Home/End 循环移动并立即激活对应面板。 */
function handleTabListKeyDown(event: React.KeyboardEvent<HTMLDivElement>, dispatch: (intent: WebIntent) => void): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
  if (tabs.length === 0) return
  const currentIndex = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement))
  let nextIndex: number | null = null
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
  if (event.key === "Home") nextIndex = 0
  if (event.key === "End") nextIndex = tabs.length - 1
  if (nextIndex === null) return
  event.preventDefault()
  const next = tabs[nextIndex]
  next?.focus()
  const nextPanel = next?.dataset.panel as ContextDockPanel | undefined
  if (nextPanel) dispatch({ type: "dock-panel-select", panel: nextPanel })
}

/** Dock 左缘拖动条：宽度 = 起始宽度 - 水平位移，dispatch dock-width-change（Adapter 夹取 330-760）。 */
function DockResizeHandle({
  widthPx,
  dispatch,
  disabled,
}: {
  widthPx: number
  dispatch: (intent: WebIntent) => void
  disabled: boolean
}): React.ReactElement {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: widthPx }
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      dispatch({ type: "dock-width-change", widthPx: drag.startWidth - (event.clientX - drag.startX) })
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [dragging, dispatch])

  return (
    <div
      className={`dock-resize-handle${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整 Dock 宽度"
      onPointerDown={onPointerDown}
    />
  )
}
