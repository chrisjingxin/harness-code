/** Web React 工作台：组合桌面三栏布局与可访问性，不拥有 Agent 或命令业务状态。 */
/** @jsxImportSource react */

import { Ellipsis, FolderOpen, GitCompareArrows, Moon, PanelRight, Sun, Terminal, X } from "lucide-react"
import { useCallback, useEffect, useRef } from "react"
import { useSyncExternalStore } from "react"
import { selectWorkItemView } from "../../interactive/selectors"
import type { WebInteractiveAdapter, WebAdapterSnapshot, WebIntent, WebTheme } from "../application/adapter"
import { workspaceLabel, type InteractiveRuntime } from "../../interactive/runtime"
import { activityLabel } from "../../presentation-shared/timeline-presenter"
import { HarnessBrandLogo } from "./brand-logo"
import { WorkbenchViews } from "./workbench-views"
import { Composer } from "./composer"
import { ContextDock } from "./context-dock/context-dock"
import { SettingsDialog } from "./settings-dialog"
import { DialogHost } from "./dialog"
import { RuntimeOverlays } from "./runtime-overlays"
import { InteractionForm } from "./interaction-form"
import { WorkspaceSidebar } from "./workspace-sidebar/workspace-sidebar"
import { Timeline } from "./timeline"
import { WorkItemBanner } from "./work-item-view"
import { GoalBanner } from "./goal-view"

/** 订阅 WebAdapterSnapshot 并转发 dispatch；页面唯一的状态来源。 */
export function WebApp(props: {
  adapter: WebInteractiveAdapter
  active: boolean
}) {
  const subscribe = useCallback(
    (listener: (snapshot: WebAdapterSnapshot) => void) => props.adapter.subscribe(listener),
    [props.adapter],
  )
  const getSnapshot = useCallback(() => props.adapter.getSnapshot(), [props.adapter])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const onIntent = useCallback(
    (intent: WebIntent) => props.adapter.dispatch(intent),
    [props.adapter],
  )
  const showingTrace = snapshot.viewMode === "trace"
  const dockVisible = snapshot.contextDock.open && !showingTrace
  const interactive = snapshot.interactive
  const connectionReadOnly = interactive.connection.status !== "open"
  const readOnly = !props.active || snapshot.leaving || connectionReadOnly || interactive.git.busy
  const returnBlocked = Boolean(interactive.activeRun || interactive.interaction || interactive.git.busy)
  const workItemView = selectWorkItemView(interactive)

  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const wasHeaderMenuOpenRef = useRef(false)

  // 打开 header menu 后焦点进入第一项；关闭后焦点返回 overflow trigger。
  useEffect(() => {
    if (snapshot.headerMenuOpen) {
      headerMenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    } else if (wasHeaderMenuOpenRef.current && !snapshot.settings.open) {
      overflowTriggerRef.current?.focus()
    }
    wasHeaderMenuOpenRef.current = snapshot.headerMenuOpen
  }, [snapshot.headerMenuOpen, snapshot.settings.open])

  // 点击菜单外任意位置关闭 header menu。
  useEffect(() => {
    if (!snapshot.headerMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (headerMenuRef.current?.contains(target) || overflowTriggerRef.current?.contains(target)) return
      onIntent({ type: "header-menu-toggle", open: false })
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [snapshot.headerMenuOpen, onIntent])

  /** Overflow 菜单按 APG menu 习惯在可用项间循环移动焦点。 */
  const handleHeaderMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (items.length === 0) return
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    let nextIndex: number | null = null
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length
    if (event.key === "Home") nextIndex = 0
    if (event.key === "End") nextIndex = items.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    items[nextIndex]?.focus()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        if (!readOnly && !snapshot.settings.open) onIntent({ type: "command-menu-open" })
        return
      }
      if (event.key !== "Escape") return
      // Composer rail 下拉等内层浮层已 preventDefault 并自行关闭，这里不重复处理。
      if (event.defaultPrevented) return
      // Escape 关闭顺序：确认 Dialog → BTW/查看浮层 → 设置 → 命令菜单 → header overflow 菜单 → Context Dock → 执行中提示中断。
      if (interactive.confirmation) {
        // DialogHost 自己注册了 Escape handler；这里不再重复派发一次 resolve。
        return
      } else if (snapshot.btw.visible) {
        event.preventDefault()
        onIntent({ type: "btw-close" })
      } else if (snapshot.inspectOverlay.visible) {
        event.preventDefault()
        onIntent({ type: "inspect-overlay-close" })
      } else if (snapshot.settings.open) {
        event.preventDefault()
        onIntent({ type: "settings-close" })
      } else if (snapshot.commandMenuOpen) {
        event.preventDefault()
        onIntent({ type: "command-menu-close" })
      } else if (snapshot.headerMenuOpen) {
        event.preventDefault()
        onIntent({ type: "header-menu-toggle", open: false })
      } else if (dockVisible) {
        event.preventDefault()
        onIntent({ type: "dock-close" })
      } else if (!readOnly && interactive.activeRun) {
        event.preventDefault()
        onIntent({ type: "interrupt-hint" })
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [interactive.activeRun, interactive.confirmation, onIntent, readOnly, snapshot.btw.visible, snapshot.commandMenuOpen, dockVisible, snapshot.headerMenuOpen, snapshot.inspectOverlay.visible, snapshot.settings.open])

  return (
    <div
      className="web-shell"
      data-theme={snapshot.theme}
      data-active={props.active ? "true" : "false"}
        style={{
        "--sidebar-width": `${snapshot.workspaceSidebar.widthPx}px`,
        "--dock-width": `${snapshot.contextDock.widthPx}px`,
      } as React.CSSProperties}
    >
      <div className="workbench-content" inert={snapshot.settings.open} aria-hidden={snapshot.settings.open || undefined}>
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"><HarnessBrandLogo /></span>
            <span className="brand-copy">
              <span className="brand-name">Harness Code</span>
              <span className="brand-version">{interactive.runtime.cliVersion}</span>
            </span>
          </div>
          <div className="topbar-main">
            <div className="topbar-project" title={interactive.runtime.workspace}>
              <FolderOpen size={16} aria-hidden="true" /><span className="topbar-project-name">{projectLabel(interactive.runtime)}</span>
            </div>
            <div className="topbar-actions">
              <button type="button" className="button return-button" disabled={!props.active || snapshot.leaving || returnBlocked} title={returnBlocked ? "当前任务结束或交互完成后可返回 TUI" : "归还控制权并恢复 TUI"} onClick={() => { onIntent({ type: "return-to-tui" }) }}><Terminal aria-hidden="true" size={15} />返回 TUI</button>
              {/* 主题切换提到顶栏：单图标按钮表达下一动作（light 显示 Moon/切深色，dark 显示 Sun/切浅色），不再占用菜单项。 */}
              <button
                type="button"
                className="icon-button theme-toggle"
                aria-label={snapshot.theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
                title={snapshot.theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
                onClick={() => { onIntent({ type: "theme-set", theme: nextTheme(snapshot.theme) }) }}
              >
                {snapshot.theme === "light" ? <Moon aria-hidden="true" size={16} /> : <Sun aria-hidden="true" size={16} />}
              </button>
              <button type="button" className="icon-button dock-toggle" hidden={showingTrace} disabled={readOnly}
                aria-label={snapshot.contextDock.open ? "收起右侧面板" : "展开右侧面板"}
                aria-expanded={snapshot.contextDock.open}
                onClick={() => onIntent(snapshot.contextDock.open ? { type: "dock-close" } : { type: "dock-open", panel: snapshot.contextDock.activePanel })}>
                <PanelRight aria-hidden="true" size={16} />
              </button>
              <button
                type="button"
                ref={overflowTriggerRef}
                className="icon-button overflow-trigger"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={snapshot.headerMenuOpen}
                onClick={() => { onIntent({ type: "header-menu-toggle", open: !snapshot.headerMenuOpen }) }}
              >
                <Ellipsis aria-hidden="true" size={16} />
              </button>
              {snapshot.headerMenuOpen ? (
                <div ref={headerMenuRef} className="header-menu" role="menu" aria-label="更多操作" onKeyDown={handleHeaderMenuKeyDown}>
                  <button type="button" role="menuitem" className="header-menu-item" onClick={() => { onIntent({ type: "settings-open", panel: "help" }) }}>帮助</button>
                  <button type="button" role="menuitem" className="header-menu-item" disabled={!props.active || snapshot.leaving} onClick={() => { onIntent({ type: "exit-harness" }) }}>退出 Harness</button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {snapshot.transientNotice ? <div className="notice-banner" role="status"><span>{snapshot.transientNotice}</span><button type="button" className="icon-button" aria-label="关闭通知" title="关闭通知" onClick={() => { onIntent({ type: "notice-dismiss" }) }}><X aria-hidden="true" size={14} /></button></div> : null}
        {interactive.connection.status !== "open" ? <div className="connection-banner" role="alert">{interactive.connection.message}</div> : null}
        {!props.active ? <div className="handoff-banner" role="status">浏览器正在等待 CLI 确认控制权，页面保持只读。</div> : null}

        <div className={`desktop-workspace${dockVisible ? " has-context-dock" : ""}${showingTrace ? " is-trace-view" : ""}`}>
          <WorkspaceSidebar snapshot={snapshot} dispatch={onIntent} disabled={readOnly} />
          <main className="conversation-column">
            <WorkbenchViews snapshot={snapshot} dispatch={onIntent} disabled={!props.active || snapshot.leaving} toolbarEnd={
              <div className="conversation-heading-actions"><span className="conversation-run-status" role="status"><span className={`status-dot status-dot-${interactive.activity.kind}`} />{activityLabel(interactive.activity.kind)}</span><button type="button" className="icon-button" aria-label="查看文件变更" disabled={readOnly} onClick={() => onIntent({ type: "dock-open", panel: "changes" })}><GitCompareArrows size={16} aria-hidden="true" /></button></div>
            }>
            <WorkItemBanner view={workItemView} />
            <GoalBanner interactive={interactive} />
            <div className="timeline-scroll">
              <Timeline snapshot={snapshot} dispatch={onIntent} />
            </div>
            {/* Interaction 卡固定在 composer 上方；无待处理请求时渲染空占位。 */}
            <div className="interaction-dock">
              <InteractionForm snapshot={snapshot} dispatch={onIntent} disabled={readOnly} />
            </div>
            <Composer snapshot={snapshot} dispatch={onIntent} disabled={readOnly} />
            </WorkbenchViews>
          </main>
          {/* Context Dock 常驻渲染：关闭时 inert + aria-hidden + CSS visibility 隐藏，开关才有平移过渡的载体。 */}
          <ContextDock snapshot={snapshot} dispatch={onIntent} disabled={readOnly} hidden={showingTrace} />
        </div>

      </div>
      <SettingsDialog snapshot={snapshot} dispatch={onIntent} disabled={readOnly} />
      <DialogHost snapshot={snapshot} dispatch={onIntent} disabled={readOnly} />
      <RuntimeOverlays snapshot={snapshot} dispatch={onIntent} />
    </div>
  )
}

/** 主题切换的下一状态：浅色 ↔ 深色；顶栏图标按钮的 icon 与 aria-label 始终表达下一动作。 */
function nextTheme(theme: WebTheme): WebTheme {
  return theme === "light" ? "dark" : "light"
}

/** 顶部只表达项目位置；已知 Git 根目录时附上工作区的相对路径。 */
function projectLabel(runtime: InteractiveRuntime): string {
  const { workspace, gitWorkspace } = runtime
  if (gitWorkspace?.kind !== "branch" && gitWorkspace?.kind !== "detached") return workspaceLabel(workspace)
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")
  const root = normalize(gitWorkspace.root)
  const current = normalize(workspace)
  // Windows 路径不区分大小写；前缀必须落在目录边界，避免把同名前缀的相邻仓库当成子目录。
  const windowsPath = /^[a-z]:\//i.test(current) || current.startsWith("//")
  const comparable = (path: string) => windowsPath ? path.toLowerCase() : path
  if (comparable(current) === comparable(root)) return workspaceLabel(gitWorkspace.root)
  if (!comparable(current).startsWith(`${comparable(root)}/`)) return workspaceLabel(workspace)
  return `${workspaceLabel(gitWorkspace.root)} / ${current.slice(root.length + 1)}`
}
