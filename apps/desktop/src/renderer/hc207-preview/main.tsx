/** 独立文件与变更视图夹具：用本地固定数据驱动真实组件，不连接业务服务或 Agent。 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { KeyboardEvent, ReactElement } from "react"
import { createRoot } from "react-dom/client"
import type { ThemeMode, WindowState } from "@workbench/contracts"
import { ProjectDock, ProjectFilePanel, ProjectFileTab } from "@workbench/ui"
import type { ProjectActionAvailability, ProjectActions, ProjectFileView, ProjectGates, ProjectScope, ProjectTreeView } from "@workbench/ui"
import "@workbench/ui/theme.css"
import "@workbench/ui/project.css"
import "./preview.css"
import { initialPreviewProject, previewFile, previewRows, previewScopeKey, previewScopes } from "./fixtures.js"
import type { PreviewCondition, PreviewGitOutcome, PreviewProject, PreviewTreeMode } from "./fixtures.js"
import { restrictPreviewGit, usePreviewGit } from "./use-preview-git.js"

const allowed: ProjectActionAvailability = { enabled: true }
const unavailable = (reason: string): ProjectActionAvailability => ({ enabled: false, reason })

function Preview(): ReactElement {
  const [windowState, setWindowState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  const [windowError, setWindowError] = useState("")
  const [scopeIndex, setScopeIndex] = useState(0)
  const [failRefresh, setFailRefresh] = useState(false)
  const [slowResponse, setSlowResponse] = useState(false)
  const [projects, setProjects] = useState<Record<string, PreviewProject>>(() =>
    Object.fromEntries(previewScopes.map(item => [previewScopeKey(item.scope), initialPreviewProject(item.scope)])))
  const requests = useRef(new Map<string, number>())

  useEffect(() => {
    let active = true
    const apply = (state: WindowState) => { if (active) setWindowState(state) }
    const unsubscribe = window.workbench.onWindowStateChanged(apply)
    window.workbench.getWindowState().then(apply).catch(() => { if (active) setWindowError("无法读取窗口外观。") })
    return () => { active = false; unsubscribe() }
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = windowState.colorScheme }, [windowState.colorScheme])

  const updateProject = (scope: ProjectScope, update: (project: PreviewProject) => PreviewProject): void => {
    const key = previewScopeKey(scope)
    setProjects(previous => {
      const project = previous[key]
      return project ? { ...previous, [key]: update(project) } : previous
    })
  }
  const git = usePreviewGit(projects, updateProject, slowResponse)
  const requestFile = (scope: ProjectScope, path: string, refresh = false): void => {
    const scopeKey = previewScopeKey(scope)
    const requestKey = `${scopeKey}\0${path}`
    const sequence = (requests.current.get(requestKey) ?? 0) + 1
    requests.current.set(requestKey, sequence)
    updateProject(scope, project => {
      if (project.condition === "offline" || project.condition === "denied") return project
      const previous = project.files[path]
      // 刷新旧内容时先保留正文，只有首次打开才显示加载态。
      const next = previous?.status === "ready" ? previous : { status: "loading" as const, path }
      return { ...project, files: { ...project.files, [path]: next } }
    })
    const shouldFail = refresh && failRefresh
    window.setTimeout(() => {
      if (requests.current.get(requestKey) !== sequence) return
      updateProject(scope, project => {
        const referenced = project.personal.fileTabs.some(tab => tab.path === path) || project.centralPaths.includes(path)
        if (!referenced || project.condition === "offline" || project.condition === "denied") return project
        const previous = project.files[path]
        const view = shouldFail
          ? previous?.status === "ready"
            ? { ...previous, file: { ...previous.file, freshness: "cached" as const }, refreshError: "刷新失败（受控示例）" }
            : { status: "error" as const, path, message: "刷新失败（受控示例）" }
          : previewFile(scope, path)
        return { ...project, files: { ...project.files, [path]: view } }
      })
    }, slowResponse ? 1800 : 160)
  }
  const changeCondition = (scope: ProjectScope, condition: PreviewCondition): void => {
    const key = previewScopeKey(scope)
    if (condition !== "online") git.invalidate(scope)
    if (condition === "denied" || condition === "offline") {
      // 权限失效或离线后，即使很快恢复，之前在途的结果也不能重新写回。
      for (const [requestKey, value] of requests.current) {
        if (requestKey.startsWith(`${key}\0`)) requests.current.set(requestKey, value + 1)
      }
    }
    updateProject(scope, project => {
      const changes = condition === "online" ? project.changes : restrictPreviewGit(project, condition)
      if (condition === "denied") return { ...project, condition, changes, files: {},
        selectionRevision: project.selectionRevision + 1, personal: { ...project.personal, selectedChanges: [] } }
      const files: Record<string, ProjectFileView> = Object.fromEntries(Object.entries(project.files).map(([path, view]) => [path,
        condition === "offline" && view.status === "ready" ? { ...view, file: { ...view.file, freshness: "cached" as const } }
          : condition === "offline" && view.status === "loading" ? { status: "error", path, message: "设备离线，请恢复后刷新。" } : view]))
      if (project.condition === "denied") {
        for (const path of new Set([...project.personal.fileTabs.map(tab => tab.path), ...project.centralPaths])) {
          files[path] = { status: "error", path, message: "访问恢复后，请刷新文件预览。" }
        }
      }
      return { ...project, condition, changes, files }
    })
  }
  const actions: ProjectActions = {
    setDockOpen: (scope, dockOpen) => updateProject(scope, project => ({ ...project, personal: { ...project.personal, dockOpen } })),
    setDockWidth: (scope, dockWidthPx) => updateProject(scope, project => ({ ...project, personal: { ...project.personal, dockWidthPx } })),
    selectPanel: (scope, panel) => updateProject(scope, project => ({ ...project, personal: { ...project.personal, panel } })),
    toggleDirectory: (scope, path) => updateProject(scope, project => ({ ...project,
      expanded: project.expanded.includes(path) ? project.expanded.filter(value => value !== path) : [...project.expanded, path],
    })),
    refreshTree: scope => updateProject(scope, project => ({ ...project, treeMode: "normal", treeMessage: "已更新受控样例，没有读取真实项目。" })),
    openFile: (scope, path) => {
      updateProject(scope, project => {
        const tabs = [{ path, name: path.split("/").at(-1) ?? path }, ...project.personal.fileTabs.filter(tab => tab.path !== path)]
        const retained = tabs.slice(0, 12)
        const evicted = tabs.slice(12)
        const files = { ...project.files }
        for (const tab of evicted) if (!project.centralPaths.includes(tab.path)) delete files[tab.path]
        return { ...project, files, personal: { ...project.personal, dockOpen: true, panel: "files", selectedPath: path,
          activeFilePath: path, fileTabs: retained } }
      })
      requestFile(scope, path)
    },
    selectFileTab: (scope, path) => updateProject(scope, project => {
      const tab = project.personal.fileTabs.find(item => item.path === path)
      return tab ? { ...project, personal: { ...project.personal, selectedPath: path, activeFilePath: path,
        fileTabs: [tab, ...project.personal.fileTabs.filter(item => item.path !== path)] } } : project
    }),
    closeFileTab: (scope, path) => updateProject(scope, project => {
      const index = project.personal.fileTabs.findIndex(tab => tab.path === path)
      if (index < 0) return project
      const tabs = project.personal.fileTabs.filter(tab => tab.path !== path)
      const activeFilePath = project.personal.activeFilePath === path ? tabs[Math.min(index, tabs.length - 1)]?.path ?? null : project.personal.activeFilePath
      const files = { ...project.files }
      if (!project.centralPaths.includes(path)) delete files[path]
      return { ...project, files, personal: { ...project.personal, fileTabs: tabs, activeFilePath } }
    }),
    refreshFile: (scope, path) => requestFile(scope, path, true),
    openCentralFile: (scope, path) => {
      updateProject(scope, project => ({ ...project, centralPaths: project.centralPaths.includes(path) ? project.centralPaths : [...project.centralPaths, path], centralActive: path }))
      // 右侧已经持有文件，两个视图消费同一份样例内容。
    },
    ...git.actions,
  }
  const changeWindow = async (action: () => Promise<WindowState>) => {
    try { setWindowError(""); setWindowState(await action()) }
    catch { setWindowError("窗口外观未能更新，请重试。") }
  }
  const currentScope = previewScopes[scopeIndex]!.scope
  const currentProject = projects[previewScopeKey(currentScope)]!
  return <div className="hc207-preview">
    <header className="hc207-preview-header"><strong>文件与变更</strong><span>受控预览 · 未连接项目服务</span>
      <div className="hc207-window-controls">
        <label>外观<select value={windowState.themeMode} aria-label="外观" onChange={event => { void changeWindow(() => window.workbench.setThemeMode(event.target.value as ThemeMode)) }}>
          <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
        </select></label>
        <button type="button" className="wb-icon-button" aria-label="缩小" onClick={() => { void changeWindow(() => window.workbench.adjustZoom("out")) }}>−</button>
        <button type="button" className="wb-button wb-button-small" aria-label="恢复缩放" onClick={() => { void changeWindow(() => window.workbench.adjustZoom("reset")) }}>{windowState.zoomPercent}%</button>
        <button type="button" className="wb-icon-button" aria-label="放大" onClick={() => { void changeWindow(() => window.workbench.adjustZoom("in")) }}>+</button>
      </div>
    </header>
    <div className="hc207-preview-controls">
      <label>项目范围<select aria-label="项目范围" value={scopeIndex} onChange={event => setScopeIndex(Number(event.target.value))}>
        {previewScopes.map((item, index) => <option key={previewScopeKey(item.scope)} value={index}>{item.label}</option>)}
      </select></label>
      <label>受控状态<select aria-label="受控状态" value={currentProject.condition} onChange={event => changeCondition(currentScope, event.target.value as PreviewCondition)}>
        <option value="online">在线示例</option><option value="offline">设备离线</option><option value="denied">无权限</option><option value="readonly">只读项目</option>
      </select></label>
      <label>文件树<select aria-label="文件树状态" value={currentProject.treeMode} onChange={event => {
        const treeMode = event.target.value as PreviewTreeMode
        updateProject(currentScope, project => ({ ...project, treeMode, treeMessage: undefined }))
      }}><option value="normal">正常</option><option value="loading">加载中</option><option value="empty">空目录</option>
        <option value="error">读取失败</option><option value="limited">部分列出</option></select></label>
      <label><input type="checkbox" checked={failRefresh} onChange={event => setFailRefresh(event.target.checked)} />模拟刷新失败</label>
      <label><input type="checkbox" checked={slowResponse} onChange={event => setSlowResponse(event.target.checked)} />延迟返回</label>
      {!currentProject.personal.dockOpen ? <button type="button" className="wb-button wb-button-small" onClick={() => actions.setDockOpen(currentScope, true)}>打开右侧面板</button> : null}
    </div>
    {currentProject.personal.dockOpen && currentProject.personal.panel === "changes" ? <div className="hc207-preview-controls hc207-preview-git-controls">
      <label>受控结果<select aria-label="受控提交结果" value={currentProject.gitOutcome}
        onChange={event => git.setOutcome(currentScope, event.target.value as PreviewGitOutcome)}>
        <option value="push-failed">提交成功，推送失败</option><option value="success">提交及请求的推送成功</option>
        <option value="push-unknown">提交成功，推送结果未知</option><option value="commit-unknown">提交结果未知</option>
        <option value="commit-failed">提交失败</option>
      </select></label>
      <button type="button" className="wb-button wb-button-small wb-button-secondary"
        disabled={!currentProject.changes.repository || currentProject.condition === "offline" || currentProject.condition === "denied"}
        onClick={() => git.changeVersion(currentScope)}>模拟文件版本变化</button>
      <label><input type="checkbox" checked={Boolean(currentProject.changes.repository?.upstream)}
        disabled={!currentProject.changes.repository || currentProject.condition === "offline" || currentProject.condition === "denied"}
        onChange={() => git.toggleUpstream(currentScope)} />受控推送目标</label>
      <span className="hc207-preview-git-log" role="status">最近意图：{currentProject.gitAction}</span>
    </div> : null}
    {windowError ? <p className="hc207-window-error" role="alert">{windowError}</p> : null}
    {previewScopes.map((item, index) => {
      const project = projects[previewScopeKey(item.scope)]!
      return <div key={previewScopeKey(item.scope)} className="hc207-preview-scope" hidden={scopeIndex !== index} inert={scopeIndex !== index}>
        <PreviewWorkspace scope={item.scope} project={project} actions={actions} updateProject={updateProject} />
      </div>
    })}
  </div>
}

type PreviewWorkspaceProps = {
  scope: ProjectScope
  project: PreviewProject
  actions: ProjectActions
  updateProject(scope: ProjectScope, update: (project: PreviewProject) => PreviewProject): void
}

function PreviewWorkspace({ scope, project, actions, updateProject }: PreviewWorkspaceProps): ReactElement {
  const uid = useId()
  const tabList = useRef<HTMLDivElement>(null)
  const closing = useRef<string | null>(null)
  const denied = project.condition === "denied"
  const offline = project.condition === "offline"
  const reason = denied ? "当前无权访问原项目" : offline ? "原设备离线，无法实时读取" : ""
  const read = denied || offline ? unavailable(reason) : allowed
  const write = denied || offline ? unavailable(reason) : project.condition === "readonly" ? unavailable("当前项目只读") : allowed
  const gates: ProjectGates = { refreshTree: read, openFile: read, refreshFile: read,
    openCentral: denied ? unavailable(reason) : allowed, refreshChanges: read, readDiff: read,
    commit: write, push: write }
  const allRows = previewRows(project.expanded)
  const tree: ProjectTreeView = {
    status: project.treeMode === "loading" ? "loading" : project.treeMode === "error" ? "error" : "ready",
    rows: ["loading", "empty", "error"].includes(project.treeMode) ? [] : project.treeMode === "limited" ? allRows.slice(0, 4) : allRows,
    limited: project.treeMode === "limited", freshness: offline ? "cached" : "live",
    message: project.treeMode === "error" ? "文件树读取失败（受控示例）" : project.treeMessage,
  }
  const paths = denied ? [] : project.centralPaths
  const activePath = denied ? null : project.centralActive
  const fileId = (path: string) => `${uid}-central-${encodeURIComponent(path)}`

  useLayoutEffect(() => {
    const closed = closing.current
    if (closed === null || paths.includes(closed)) return
    closing.current = null
    tabList.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [paths, activePath])
  const activate = (_scope: ProjectScope, path: string): void => updateProject(scope, value => ({ ...value, centralActive: path }))
  const close = (_scope: ProjectScope, path: string): void => {
    closing.current = path
    updateProject(scope, value => {
      const index = value.centralPaths.indexOf(path)
      if (index < 0) return value
      const remaining = value.centralPaths.filter(candidate => candidate !== path)
      const active = value.centralActive === path ? remaining[Math.min(index, remaining.length - 1)] ?? null : value.centralActive
      const files = { ...value.files }
      if (!value.personal.fileTabs.some(tab => tab.path === path)) delete files[path]
      return { ...value, files, centralPaths: remaining, centralActive: active }
    })
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    const focused = event.target
    if (!(focused instanceof HTMLButtonElement) || focused.getAttribute("role") !== "tab") return
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = tabs.indexOf(focused)
    if (event.key === "Delete" && index > 0 && paths[index - 1]) { event.preventDefault(); close(scope, paths[index - 1]!); return }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
    if (next === 0) updateProject(scope, value => ({ ...value, centralActive: null }))
    else if (paths[next - 1]) activate(scope, paths[next - 1]!)
    tabs[next]?.focus()
  }
  return <div className="hc207-preview-workspace">
    <main className="hc207-preview-center">
      <div ref={tabList} role="tablist" aria-label="预览中的中央页签" className="hc207-preview-tabs" onKeyDown={keyboard}>
        <div className="hc207-chat-tab" data-selected={activePath === null}><button type="button" role="tab" id={`${uid}-chat-tab`}
          aria-controls={`${uid}-chat-panel`} aria-selected={activePath === null} tabIndex={activePath === null ? 0 : -1}
          onClick={() => updateProject(scope, value => ({ ...value, centralActive: null }))}>对话</button></div>
        {paths.map(path => <ProjectFileTab key={path} scope={scope} path={path} name={path.split("/").at(-1) ?? path}
          selected={activePath === path} tabId={`${fileId(path)}-tab`} panelId={`${fileId(path)}-panel`}
          onActivate={activate} onClose={close} />)}
      </div>
      <section id={`${uid}-chat-panel`} role="tabpanel" aria-labelledby={`${uid}-chat-tab`} className="hc207-chat-placeholder"
        hidden={activePath !== null} inert={activePath !== null}>
        <h1>文件视图预览</h1><p>从右侧文件树打开文件，再选择“在主区域打开”。这里的文本和动作仅用于界面演示。</p>
        {project.condition === "readonly" ? <p>当前是只读项目示例。</p> : null}
        {denied ? <p role="status">当前无权查看项目文件。</p> : null}
        <label>保留的个人草稿<textarea defaultValue="切换文件页签后，这段预览草稿仍在。" /></label>
      </section>
      {paths.map(path => <ProjectFilePanel key={path} scope={scope} path={path} view={project.files[path]} refresh={gates.refreshFile}
        onRefresh={actions.refreshFile} active={activePath === path} tabId={`${fileId(path)}-tab`} panelId={`${fileId(path)}-panel`} />)}
    </main>
    <ProjectDock scope={scope} projectName="示例项目" availability={denied ? { state: "denied", message: reason }
      : offline ? { state: "offline", message: reason } : { state: "available" }} tree={tree} files={project.files}
      changes={project.changes} gates={gates} personal={project.personal} actions={actions} />
  </div>
}

createRoot(document.getElementById("root")!).render(<Preview />)
