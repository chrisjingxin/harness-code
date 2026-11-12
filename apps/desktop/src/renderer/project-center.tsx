/** 中央文件页签和常驻对话；页签只切换可见性，不停止会话订阅。 */
import { useId, useLayoutEffect, useRef } from "react"
import type { KeyboardEvent, ReactNode, RefObject, UIEvent } from "react"
import { ProjectFilePanel, ProjectFileTab } from "@workbench/ui"
import type { ProjectActions, ProjectFileView, ProjectGates, ProjectScope } from "@workbench/ui"
import type { ProjectPersonal } from "./project-workspace.js"
import { projectScopeKey } from "./project-workspace.js"

export type ProjectScrollPositions = Map<string, { top: number; left: number }>

/** 等展开目录加载完成再恢复树位置，避免加载期间的短列表截断位置。 */
export function useProjectTreeScroll(
  root: RefObject<HTMLDivElement | null>, scope: ProjectScope, ready: boolean, positions: ProjectScrollPositions,
  onPositionChanged: (scope: ProjectScope) => void,
) {
  const restored = useRef(new WeakMap<Element, string>())
  useLayoutEffect(() => {
    if (!ready || !root.current) return
    const tree = root.current.querySelector<HTMLElement>(".project-file-tree")
    if (!tree) return
    const key = JSON.stringify([projectScopeKey(scope), "tree", ""])
    if (restored.current.get(tree) === key) return
    restored.current.set(tree, key)
    const position = positions.get(key)
    if (position) { tree.scrollTop = position.top; tree.scrollLeft = position.left }
  }, [ready, root, scope, positions])
  return (event: UIEvent<HTMLDivElement>) => {
    if (!ready || !(event.target instanceof HTMLElement) || !event.target.classList.contains("project-file-tree")) return
    const key = JSON.stringify([projectScopeKey(scope), "tree", ""])
    positions.set(key, { top: event.target.scrollTop, left: event.target.scrollLeft })
    onPositionChanged(scope)
  }
}

/** 记录已授权文件在两个区域各自的阅读位置，重新挂载后恢复。 */
export function useProjectScroll(
  root: RefObject<HTMLDivElement | null>, scope: ProjectScope | null, area: "central" | "dock",
  activePath: string | null, files: Readonly<Record<string, ProjectFileView>>, positions: ProjectScrollPositions,
  onPositionChanged: (scope: ProjectScope) => void,
) {
  const restored = useRef(new WeakMap<Element, string>())
  useLayoutEffect(() => {
    if (!root.current || !scope || !activePath || files[activePath]?.status !== "ready") return
    const code = root.current.querySelector<HTMLElement>(area === "central"
      ? '[role="tabpanel"]:not([hidden]) .project-file-code-view' : '.project-dock-file-panel:not([hidden]) .project-file-code-view')
    if (!code) return
    const key = JSON.stringify([projectScopeKey(scope), area, activePath])
    if (restored.current.get(code) === key) return
    restored.current.set(code, key)
    const position = positions.get(key)
    if (position) { code.scrollTop = position.top; code.scrollLeft = position.left }
  }, [scope, area, activePath, files, positions, root])

  return (event: UIEvent<HTMLDivElement>) => {
    if (!scope || !activePath || !(event.target instanceof HTMLElement) || !event.target.classList.contains("project-file-code-view")) return
    const key = JSON.stringify([projectScopeKey(scope), area, activePath])
    positions.set(key, { top: event.target.scrollTop, left: event.target.scrollLeft })
    onPositionChanged(scope)
  }
}

export function ProjectCenter({ scope, personal, files, gates, actions, updatePersonal, scrollPositions, onPositionChanged, children, permitted }: {
  scope: ProjectScope
  personal: ProjectPersonal
  files: Readonly<Record<string, ProjectFileView>>
  gates: ProjectGates
  actions: ProjectActions
  updatePersonal(scope: ProjectScope, update: (value: ProjectPersonal) => ProjectPersonal): void
  scrollPositions: ProjectScrollPositions
  onPositionChanged(scope: ProjectScope): void
  children(visible: boolean): ReactNode
  permitted: boolean
}) {
  const uid = useId(), tabList = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null)
  const closing = useRef<string | null>(null)
  const paths = permitted ? personal.centralPaths : []
  const active = permitted && personal.activeCentral && paths.includes(personal.activeCentral) ? personal.activeCentral : null
  const onScroll = useProjectScroll(root, scope, "central", active, files, scrollPositions, onPositionChanged)
  const fileId = (path: string) => `${uid}-file-${encodeURIComponent(path)}`

  useLayoutEffect(() => {
    if (closing.current === null || paths.includes(closing.current)) return
    closing.current = null
    tabList.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [paths, active])
  const activate = (_scope: ProjectScope, path: string) => updatePersonal(scope, value => ({ ...value, activeCentral: path }))
  const close = (_scope: ProjectScope, path: string) => {
    closing.current = path
    updatePersonal(scope, value => {
      const index = value.centralPaths.indexOf(path)
      if (index < 0) return value
      const remaining = value.centralPaths.filter(item => item !== path)
      return { ...value, centralPaths: remaining,
        activeCentral: value.activeCentral === path ? remaining[Math.min(index, remaining.length - 1)] ?? null : value.activeCentral }
    })
  }
  const onKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || event.target.getAttribute("role") !== "tab") return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = tabs.indexOf(event.target)
    if (event.key === "Delete" && index > 0 && paths[index - 1]) { event.preventDefault(); close(scope, paths[index - 1]!); return }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    if (next === 0) updatePersonal(scope, value => ({ ...value, activeCentral: null }))
    else if (paths[next - 1]) activate(scope, paths[next - 1]!)
    tabs[next]?.focus()
  }

  return <div className="desktop-project-center" ref={root} onScrollCapture={onScroll}>
    <div ref={tabList} role="tablist" aria-label="中央页签" className="desktop-center-tabs" onKeyDown={onKeys}>
      <div className="desktop-conversation-tab" data-selected={active === null}>
        <button type="button" role="tab" id={`${uid}-conversation-tab`} aria-controls={`${uid}-conversation-panel`}
          aria-selected={active === null} tabIndex={active === null ? 0 : -1}
          onClick={() => updatePersonal(scope, value => ({ ...value, activeCentral: null }))}>对话</button>
      </div>
      {paths.map(path => <ProjectFileTab key={path} scope={scope} path={path} name={path.split("/").at(-1) ?? path}
        selected={active === path} tabId={`${fileId(path)}-tab`} panelId={`${fileId(path)}-panel`} onActivate={activate} onClose={close} />)}
    </div>
    <section className="desktop-center-conversation" id={`${uid}-conversation-panel`} role="tabpanel" aria-labelledby={`${uid}-conversation-tab`}
      hidden={active !== null} inert={active !== null}>{children(active === null)}</section>
    {paths.map(path => <ProjectFilePanel key={path} scope={scope} path={path} view={files[path]} refresh={gates.refreshFile}
      onRefresh={actions.refreshFile} active={active === path} tabId={`${fileId(path)}-tab`} panelId={`${fileId(path)}-panel`} />)}
  </div>
}
