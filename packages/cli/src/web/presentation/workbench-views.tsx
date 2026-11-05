/** 中央工作区页签：对话、轨迹与只读文件切换时保留各自内容和滚动。 */
/** @jsxImportSource react */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Activity, FileCode2, MessageSquare, X } from "lucide-react"
import type { WebAdapterSnapshot, WebIntent } from "../application/adapter"
import { TraceView } from "./trace"
import { FilePreviewHeader } from "./context-dock/code/file-preview-header"
import { FileCodeView } from "./context-dock/code/file-code-view"

/** 保留已打开视图的 DOM；隐藏区域同时使用 hidden 与 inert。 */
export function WorkbenchViews({ snapshot, dispatch, disabled, children }: {
  snapshot: WebAdapterSnapshot
  dispatch: (intent: WebIntent) => void
  disabled: boolean
  children: ReactNode
}) {
  const [mode, setMode] = useState<"dev" | "simple">("dev")
  const tabList = useRef<HTMLDivElement>(null)
  const focusAfterClose = useRef(false)
  const trace = snapshot.viewMode === "trace"
  const { paths, activePath } = snapshot.fileViews
  const selected = snapshot.viewMode === "file" && activePath ? fileId(activePath) : snapshot.viewMode
  const views = ["chat", "trace", ...paths.map(fileId)]

  useLayoutEffect(() => {
    const active = tabList.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    if (focusAfterClose.current) {
      active?.focus()
      focusAfterClose.current = false
    }
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [selected, paths.length])

  const activate = (index: number) => {
    if (index < 2) dispatch({ type: "view-mode-set", mode: index === 0 ? "chat" : "trace" })
    else if (paths[index - 2]) dispatch({ type: "workbench-file-open", path: paths[index - 2]! })
  }
  const close = (path: string) => {
    focusAfterClose.current = true
    dispatch({ type: "workbench-file-close", path })
  }

  return <>
    <div className="workbench-view-toolbar">
      <div ref={tabList} role="tablist" aria-label="工作区视图" className="workbench-view-tabs" onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const current = tabs.indexOf(event.target as HTMLButtonElement)
        if (event.key === "Delete" && current >= 2 && !disabled) {
          event.preventDefault()
          close(paths[current - 2]!)
          return
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
        activate(next)
        tabs[next]?.focus()
      }}>
        {views.map((view, index) => {
          const path = paths[index - 2]
          const label = path ? path.split("/").at(-1) : index === 0 ? "对话" : "轨迹"
          return <div key={view} className="workbench-tab-item" data-selected={selected === view}>
            <button type="button" role="tab" id={`view-tab-${view}`} data-view={view}
              className="workbench-view-tab" title={path} aria-controls={`view-panel-${view}`}
              aria-selected={selected === view} tabIndex={selected === view ? 0 : -1}
              onClick={() => activate(index)}>
              {path ? <FileCode2 size={14} aria-hidden="true" /> : index === 0 ? <MessageSquare size={14} aria-hidden="true" /> : <Activity size={14} aria-hidden="true" />}
              <span className="workbench-tab-name">{label}</span>
            </button>
            {path ? <button type="button" className="file-tab-close" aria-label={`关闭文件 ${path}`} title="关闭文件"
              disabled={disabled} onClick={() => close(path)}><X size={12} aria-hidden="true" /></button> : null}
          </div>
        })}
      </div>
      {trace ? <div className="trace-mode-switch" role="group" aria-label="轨迹显示模式">
        <button type="button" aria-pressed={mode === "dev"} onClick={() => setMode("dev")}>开发者</button>
        <button type="button" aria-pressed={mode === "simple"} onClick={() => setMode("simple")}>简化</button>
      </div> : null}
    </div>
    <section id="view-panel-chat" role="tabpanel" aria-labelledby="view-tab-chat" className="conversation-chat" hidden={snapshot.viewMode !== "chat"} inert={snapshot.viewMode !== "chat"}>{children}</section>
    <section id="view-panel-trace" role="tabpanel" aria-labelledby="view-tab-trace" className="conversation-trace" hidden={!trace} inert={!trace}>
      <TraceView state={snapshot.trace} disabled={disabled} mode={mode} />
    </section>
    {paths.map(path => {
      const visible = snapshot.viewMode === "file" && path === activePath
      const id = fileId(path)
      return <section key={path} id={`view-panel-${id}`} role="tabpanel" aria-labelledby={`view-tab-${id}`}
        className="workbench-file-panel" hidden={!visible} inert={!visible}>
        <FilePreviewHeader path={path} preview={snapshot.contextDock.code.previews[path]}
          error={snapshot.contextDock.code.previewErrors[path]} dispatch={dispatch} disabled={disabled} />
        <FileCodeView preview={snapshot.contextDock.code.previews[path]} />
      </section>
    })}
  </>
}

/** 路径编码为稳定且与固定页签不冲突的 DOM 标识。 */
function fileId(path: string): string {
  return `file-${encodeURIComponent(path)}`
}
