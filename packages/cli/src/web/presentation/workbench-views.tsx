/** 中央工作区页签：切换时保留对话与轨迹实例，展示模式只影响 Trace。 */
/** @jsxImportSource react */
import { useState, type ReactNode } from "react"
import { Activity, MessageSquare } from "lucide-react"
import type { WebAdapterSnapshot, WebIntent } from "../application/adapter"
import { TraceView } from "./trace"

/** 聊天保留 DOM、滚动和局部展开；hidden 与 inert 同时屏蔽隐藏区域。 */
export function WorkbenchViews({ snapshot, dispatch, disabled, children }: {
  snapshot: WebAdapterSnapshot
  dispatch: (intent: WebIntent) => void
  disabled: boolean
  children: ReactNode
}) {
  const [mode, setMode] = useState<"dev" | "simple">("dev")
  const trace = snapshot.viewMode === "trace"
  return <>
    <div className="workbench-view-toolbar">
      <div role="tablist" aria-label="工作区视图" className="workbench-view-tabs" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
        event.preventDefault()
        const next = event.key === "Home" ? "chat" : event.key === "End" ? "trace" : trace ? "chat" : "trace"
        dispatch({ type: "view-mode-set", mode: next })
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus()
      }}>
        {(["chat", "trace"] as const).map(view => <button key={view} type="button" role="tab" id={`view-tab-${view}`} data-view={view}
          className="workbench-view-tab" aria-controls={`view-panel-${view}`} aria-selected={snapshot.viewMode === view} tabIndex={snapshot.viewMode === view ? 0 : -1}
          onClick={() => dispatch({ type: "view-mode-set", mode: view })}>
          {view === "chat" ? <MessageSquare size={14} aria-hidden="true" /> : <Activity size={14} aria-hidden="true" />}{view === "chat" ? "对话" : "轨迹"}
        </button>)}
      </div>
      {trace ? <div className="trace-mode-switch" role="group" aria-label="轨迹显示模式">
        <button type="button" aria-pressed={mode === "dev"} onClick={() => setMode("dev")}>开发者</button>
        <button type="button" aria-pressed={mode === "simple"} onClick={() => setMode("simple")}>简化</button>
      </div> : null}
    </div>
    <section id="view-panel-chat" role="tabpanel" aria-labelledby="view-tab-chat" className="conversation-chat" hidden={trace} inert={trace}>{children}</section>
    <section id="view-panel-trace" role="tabpanel" aria-labelledby="view-tab-trace" className="conversation-trace" hidden={!trace} inert={!trace}>
      <TraceView state={snapshot.trace} disabled={disabled} mode={mode} />
    </section>
  </>
}
