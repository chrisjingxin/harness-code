/**
 * 右侧文件/变更 Dock：两个视图均由受控数据驱动。
 * 宿主保存个人状态并处理回调；本模块不执行文件或 Git 操作。
 */
import { FolderTree, GitCompareArrows, PanelRightClose, X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement, RefObject } from "react"
import { ProjectFileExplorer } from "./file-tree.js"
import { ProjectFileContentView, ProjectFileHeader } from "./file-view.js"
import { ProjectGitPanel } from "./git-panel.js"
import type { ProjectDockProps, ProjectScope } from "./types.js"

/** 独立右侧区域；关闭时保持挂载，调用方控制实际开关及宽度。 */
export function ProjectDock(props: ProjectDockProps): ReactElement {
  const { scope, projectName, availability, tree, files, changes, gates, personal, actions } = props
  const uid = useId()
  const treeRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; width: number } | null>(null)
  const panel = personal.panel
  const denied = availability.state === "denied"
  const showChanges = !denied && (availability.state !== "offline" || changes.freshness === "cached")
  const identity = projectScopeKey(scope)

  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent) => {
      const drag = dragRef.current
      if (drag) actions.setDockWidth(scope, Math.max(330, Math.min(760, drag.width - (event.clientX - drag.x))))
    }
    const up = () => { dragRef.current = null; setDragging(false) }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
  }, [actions, dragging, scope])

  const resizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragRef.current = { x: event.clientX, width: personal.dockWidthPx }
    setDragging(true)
  }
  const onPanelKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLButtonElement) || event.target.getAttribute("role") !== "tab") return
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const current = tabs.indexOf(event.target)
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    const target = tabs[next]
    target?.focus()
    if (target?.dataset.panel === "files" || target?.dataset.panel === "changes") actions.selectPanel(scope, target.dataset.panel)
  }
  return <aside className="project-context-dock" style={{ width: personal.dockOpen ? personal.dockWidthPx : 0 }}
    data-active-panel={panel} aria-label="项目文件与变更" aria-hidden={personal.dockOpen ? undefined : true} inert={!personal.dockOpen}>
    <div className={`project-dock-resize${dragging ? " is-dragging" : ""}`} role="separator" aria-orientation="vertical"
      aria-label="调整右侧面板宽度" onPointerDown={resizeStart} />
    <header className="project-dock-header">
      <div className="project-dock-tabs" role="tablist" aria-label="项目面板" onKeyDown={onPanelKeys}>
        <button type="button" role="tab" id={`${uid}-files-tab`} aria-controls={`${uid}-files-panel`} aria-selected={panel === "files"}
          tabIndex={panel === "files" ? 0 : -1} data-panel="files" className={panel === "files" ? "project-dock-tab is-selected" : "project-dock-tab"}
          onClick={() => actions.selectPanel(scope, "files")}><FolderTree size={16} aria-hidden="true" />文件</button>
        <button type="button" role="tab" id={`${uid}-changes-tab`} aria-controls={`${uid}-changes-panel`} aria-selected={panel === "changes"}
          tabIndex={panel === "changes" ? 0 : -1} data-panel="changes" className={panel === "changes" ? "project-dock-tab is-selected" : "project-dock-tab"}
          onClick={() => actions.selectPanel(scope, "changes")}><GitCompareArrows size={16} aria-hidden="true" />变更
          {showChanges && changes.repository ? <span className="project-git-count">{changes.repository.files.length}</span> : null}
        </button>
      </div>
      <button type="button" className="wb-icon-button project-dock-close" aria-label="关闭右侧面板"
        onClick={() => actions.setDockOpen(scope, false)}><PanelRightClose aria-hidden="true" /></button>
    </header>
    {availability.state !== "available" ? <p className="project-availability" role="status">{availability.message}</p> : null}
    <div id={`${uid}-files-panel`} role="tabpanel" aria-labelledby={`${uid}-files-tab`}
      className="project-dock-body project-dock-code-body" hidden={panel !== "files"} inert={panel !== "files"}>
      {denied ? <p className="project-panel-empty">当前无权查看项目文件。</p> : <div className={`project-code-layout${personal.fileTabs.length ? " has-file-preview" : ""}`} key={identity}>
        <ProjectFileExplorer scope={scope} projectName={projectName} tree={tree} selectedPath={personal.selectedPath}
          refresh={gates.refreshTree} open={gates.openFile} actions={actions} treeRef={treeRef} />
        <ProjectDockFiles {...props} treeRef={treeRef} uid={uid} />
      </div>}
      {!denied && personal.fileTabs.length === 0 ? <p className="project-file-empty">从上方文件树打开文件查看预览</p> : null}
    </div>
    <div id={`${uid}-changes-panel`} role="tabpanel" aria-labelledby={`${uid}-changes-tab`}
      className="project-dock-body" hidden={panel !== "changes"} inert={panel !== "changes"}>
      {denied ? <p className="project-panel-empty">当前无权查看项目变更。</p>
        : showChanges ? <ProjectGitPanel key={identity} {...props} />
          : <p className="project-panel-empty">当前没有可展示的离线变更缓存。</p>}
    </div>
  </aside>
}

type DockFilesProps = ProjectDockProps & { treeRef: RefObject<HTMLDivElement | null>; uid: string }

/** 所有右侧页签的阅读器保持挂载，切换时保留各自滚动。 */
function ProjectDockFiles({ scope, files, gates, personal, actions, treeRef, uid }: DockFilesProps): ReactElement {
  const tabs = personal.fileTabs
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  const closingPath = useRef<string | null>(null)
  useLayoutEffect(() => {
    const closed = closingPath.current
    if (closed === null || tabs.some(tab => tab.path === closed)) return
    closingPath.current = null
    const active = personal.activeFilePath ? buttonRefs.current.get(personal.activeFilePath) : undefined
    if (active) active.focus()
    else treeRef.current?.focus()
  }, [personal.activeFilePath, tabs, treeRef])
  const close = (path: string): void => { closingPath.current = path; actions.closeFileTab(scope, path) }
  const onKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const focused = event.target
    if (!(focused instanceof HTMLButtonElement) || focused.getAttribute("role") !== "tab") return
    const current = tabs.findIndex(tab => tab.path === focused.dataset.path)
    if (current < 0) return
    if (event.key === "Delete") { event.preventDefault(); close(tabs[current]!.path); return }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    const target = tabs[next]
    if (target) { actions.selectFileTab(scope, target.path); buttonRefs.current.get(target.path)?.focus() }
  }
  // 最后一个页签关闭时组件仍挂载一轮，以便把焦点还给文件树。
  if (tabs.length === 0) return <></>
  return <div className="project-code-panel">
    <div className="project-file-tabs" role="tablist" aria-label="右侧已打开文件" onKeyDown={onKeys}>
      {tabs.map(tab => {
        const selected = tab.path === personal.activeFilePath
        const id = `${uid}-file-${encodeURIComponent(tab.path)}`
        return <div key={tab.path} className={`project-file-tab${selected ? " is-active" : ""}`}>
          <button ref={element => { if (element) buttonRefs.current.set(tab.path, element); else buttonRefs.current.delete(tab.path) }}
            type="button" role="tab" id={`${id}-tab`} aria-controls={`${id}-panel`} aria-selected={selected}
            tabIndex={selected ? 0 : -1} className="project-file-tab-select" data-path={tab.path} title={tab.path}
            onClick={() => actions.selectFileTab(scope, tab.path)}><span className="project-file-tab-name">{tab.name}</span></button>
          <button type="button" className="project-file-tab-close" aria-label={`关闭右侧文件 ${tab.path}`} title="关闭"
            onClick={() => close(tab.path)}><X size={12} aria-hidden="true" /></button>
        </div>
      })}
    </div>
    {tabs.map(tab => {
      const active = tab.path === personal.activeFilePath
      const id = `${uid}-file-${encodeURIComponent(tab.path)}`
      return <div key={tab.path} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab`}
        className="project-dock-file-panel" hidden={!active} inert={!active}>
        <ProjectFileHeader scope={scope} path={tab.path} view={files[tab.path]} refresh={gates.refreshFile}
          onRefresh={actions.refreshFile} openCentral={gates.openCentral} onOpenCentral={actions.openCentralFile} />
        <ProjectFileContentView path={tab.path} view={files[tab.path]} />
      </div>
    })}
  </div>
}

function projectScopeKey(scope: ProjectScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.deviceId, scope.projectId])
}
