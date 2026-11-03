/** 左侧会话导航：新建、搜索、会话列表与工具设置，保留宽度拖动。 */
/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react"
import { SquarePen } from "lucide-react"
import type { WebAdapterSnapshot, WebIntent } from "../../application/adapter"
import { ThreadSection } from "./thread-section"
import { WorkspaceTools } from "./workspace-tools"

/** 文件树迁入右侧，左栏列表独占剩余高度。 */
export function WorkspaceSidebar({ snapshot, dispatch, disabled = false }: {
  snapshot: WebAdapterSnapshot
  dispatch: (intent: WebIntent) => void
  disabled?: boolean
}): React.ReactElement {
  const busy = Boolean(snapshot.interactive.activeRun || snapshot.interactive.interaction)
  return <aside className="workspace-sidebar" aria-label="工作区导航">
    <SidebarResizeHandle widthPx={snapshot.workspaceSidebar.widthPx} dispatch={dispatch} disabled={disabled} />
    <div className="thread-panel-header">
      <button type="button" className="new-thread-button button-secondary"
        onClick={() => dispatch({ type: "thread-new" })}
        disabled={disabled || busy || snapshot.threadNewSubmitting}
        aria-label="新建对话"
        title={disabled ? "接管尚未完成或连接不可用" : busy ? "当前任务结束后可用" : snapshot.threadNewSubmitting ? "正在新建…" : "新建对话"}>
        <SquarePen aria-hidden="true" size={18} /><span>新建对话</span>
      </button>
    </div>
    <div className="workspace-sidebar-thread"><ThreadSection snapshot={snapshot} dispatch={dispatch} disabled={disabled} /></div>
    <WorkspaceTools snapshot={snapshot} dispatch={dispatch} disabled={disabled} />
  </aside>
}

/** 侧栏右缘拖动条：宽度 = 起始宽度 + 水平位移，dispatch sidebar-width-change（Adapter 夹取 220-480）。 */
function SidebarResizeHandle({
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
      dispatch({ type: "sidebar-width-change", widthPx: drag.startWidth + (event.clientX - drag.startX) })
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
      className={`sidebar-resize-handle${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度"
      onPointerDown={onPointerDown}
    />
  )
}
