/** 居中设置窗口：复用既有能力面板，隔离焦点并保留底层工作上下文。 */
/** @jsxImportSource react */

import { useEffect, useRef } from "react"
import { Activity, Bot, Boxes, CircleHelp, Cpu, Plug, X } from "lucide-react"

import { selectNavigationView } from "../../interactive/selectors"
import type { SettingsPanel, WebAdapterSnapshot, WebIntent } from "../application/adapter"
import { AgentsPanel } from "./context-dock/agents-panel"
import { HelpPanel } from "./context-dock/help-panel"
import { McpPanel } from "./context-dock/mcp-panel"
import { ModelsPanel } from "./context-dock/models-panel"
import { SkillsPanel } from "./context-dock/skills-panel"
import { StatusPanel } from "./context-dock/status-panel"
import { SETTINGS_PANELS, tabLabel, tabVisible } from "./context-dock/panel-common"

const PANEL_ICONS = {
  models: Cpu,
  skills: Boxes,
  mcp: Plug,
  agents: Bot,
  status: Activity,
  help: CircleHelp,
}

/** 设置窗口独立开合；确认框和运行查看浮层优先接管焦点。 */
export function SettingsDialog({ snapshot, dispatch, disabled = false }: {
  snapshot: WebAdapterSnapshot
  dispatch: (intent: WebIntent) => void
  disabled?: boolean
}): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const { open } = snapshot.settings
  const suspended = Boolean(snapshot.interactive.confirmation || snapshot.inspectOverlay.visible || snapshot.btw.visible)
  const { availability } = selectNavigationView(snapshot.interactive)
  const panels = SETTINGS_PANELS.filter(panel => tabVisible(panel, availability))
  // 能力变化后不显示不可用分类；运行状态和帮助始终可达。
  const activePanel = panels.includes(snapshot.settings.activePanel) ? snapshot.settings.activePanel : panels[0]!
  const busyReason = snapshot.interactive.activeRun || snapshot.interactive.interaction ? "当前任务结束后可用" : null

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    return () => {
      const fallback = document.querySelector<HTMLButtonElement>('[data-settings-trigger]')
      const target = previous?.isConnected && !previous.closest('[inert]') ? previous : fallback
      target?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || suspended) return
    const dialog = dialogRef.current
    if (!dialog?.contains(document.activeElement)) closeRef.current?.focus()
    const keepFocusInside = (event: FocusEvent) => {
      if (!dialog?.contains(event.target as Node)) closeRef.current?.focus()
    }
    document.addEventListener("focusin", keepFocusInside)
    return () => document.removeEventListener("focusin", keepFocusInside)
  }, [open, suspended])

  if (!open) return null

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (suspended || event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      dispatch({ type: "settings-close" })
      return
    }
    if (event.key !== "Tab") return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
    )).filter(element => element.tabIndex >= 0 && !element.closest('[hidden], [inert]'))
    const first = controls[0]
    const last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="settings-overlay" inert={suspended} aria-hidden={suspended || undefined}
      onClick={event => {
        if (event.target === event.currentTarget && !suspended) dispatch({ type: "settings-close" })
      }}>
      <div className="settings-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={handleKeyDown}>
        <header className="settings-header">
          <h2 id="settings-title">设置与工具</h2>
          <button ref={closeRef} type="button" className="icon-button" aria-label="关闭设置" onClick={() => dispatch({ type: "settings-close" })}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical" onKeyDown={event => handleCategoryKeyDown(event, dispatch)}>
            {panels.map(panel => {
              const Icon = PANEL_ICONS[panel]
              return (
                <button key={panel} type="button" role="tab" id={`settings-tab-${panel}`} data-panel={panel}
                  className={`settings-tab${panel === activePanel ? " is-selected" : ""}`}
                  aria-selected={panel === activePanel} aria-controls="settings-panel" tabIndex={panel === activePanel ? 0 : -1}
                  onClick={() => dispatch({ type: "settings-panel-select", panel })}>
                  <Icon size={17} aria-hidden="true" />{tabLabel(panel)}
                </button>
              )
            })}
          </nav>
          <section className="settings-content" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${activePanel}`} key={activePanel}>
            <h3>{tabLabel(activePanel)}</h3>
            {activePanel === "models" ? <ModelsPanel snapshot={snapshot} dispatch={dispatch} disabled={disabled} busyReason={busyReason} /> : null}
            {activePanel === "skills" ? <SkillsPanel snapshot={snapshot} dispatch={dispatch} disabled={disabled} /> : null}
            {activePanel === "mcp" ? <McpPanel snapshot={snapshot} dispatch={dispatch} disabled={disabled} /> : null}
            {activePanel === "agents" ? <AgentsPanel snapshot={snapshot} dispatch={dispatch} disabled={disabled} /> : null}
            {activePanel === "status" ? <StatusPanel snapshot={snapshot} /> : null}
            {activePanel === "help" ? <HelpPanel snapshot={snapshot} /> : null}
          </section>
        </div>
      </div>
    </div>
  )
}

/** 垂直分类导航使用方向键与 Home/End 切换，保持单个可 Tab 聚焦入口。 */
function handleCategoryKeyDown(event: React.KeyboardEvent<HTMLElement>, dispatch: (intent: WebIntent) => void): void {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const current = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement))
  let next: number | null = null
  if (event.key === "ArrowDown") next = (current + 1) % tabs.length
  if (event.key === "ArrowUp") next = (current - 1 + tabs.length) % tabs.length
  if (event.key === "Home") next = 0
  if (event.key === "End") next = tabs.length - 1
  if (next === null) return
  event.preventDefault()
  const tab = tabs[next]
  tab?.focus()
  if (tab) dispatch({ type: "settings-panel-select", panel: tab.dataset.panel as SettingsPanel })
}
