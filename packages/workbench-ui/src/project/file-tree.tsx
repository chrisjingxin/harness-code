/** 右侧文件树：只消费项目视图值，目录展开与文件打开由装配方处理。 */
import { ChevronDown, ChevronRight, FileSymlink, Folder, FolderOpen, RefreshCw } from "lucide-react"
import { useId, useMemo, useRef, useState } from "react"
import type { KeyboardEvent, ReactElement, RefObject } from "react"
import { FileTypeIcon } from "../common/file-type-icon.js"
import type { ProjectActionAvailability, ProjectActions, ProjectScope, ProjectTreeRow, ProjectTreeView } from "./types.js"

type FileExplorerProps = {
  scope: ProjectScope
  projectName: string
  tree: ProjectTreeView
  selectedPath: string | null
  refresh: ProjectActionAvailability
  open: ProjectActionAvailability
  actions: ProjectActions
  treeRef: RefObject<HTMLDivElement | null>
}

/** 文件树仍位于右侧，标题由装配方提供，不暴露本机绝对路径。 */
export function ProjectFileExplorer({ scope, projectName, tree, selectedPath, refresh, open, actions, treeRef }: FileExplorerProps): ReactElement {
  return <section className="project-file-explorer" aria-label="文件列表">
    <div className="project-file-explorer-header">
      <span className="project-file-explorer-title" title={projectName}>
        <FolderOpen size={14} aria-hidden="true" /><span>{projectName}</span>
      </span>
      <button type="button" className="wb-icon-button" aria-label="刷新文件树" title={refresh.enabled ? "刷新" : refresh.reason}
        disabled={!refresh.enabled} onClick={() => actions.refreshTree(scope)}><RefreshCw size={14} aria-hidden="true" /></button>
    </div>
    {tree.freshness === "cached" ? <p className="project-tree-notice">文件列表为缓存 / 非实时</p> : null}
    {tree.status === "ready" && tree.message ? <p className="project-tree-notice" role="status">{tree.message}</p> : null}
    {!open.enabled ? <p className="project-tree-notice">{open.reason}</p> : null}
    <ProjectFileTree scope={scope} tree={tree} selectedPath={selectedPath} open={open} actions={actions} treeRef={treeRef} />
  </section>
}

type FileTreeProps = {
  scope: ProjectScope
  tree: ProjectTreeView
  selectedPath: string | null
  open: ProjectActionAvailability
  actions: ProjectActions
  treeRef: RefObject<HTMLDivElement | null>
}

/** 键盘焦点按路径保存，目录展开或刷新不会把焦点误移到另一行。 */
function ProjectFileTree({ scope, tree, selectedPath, open, actions, treeRef }: FileTreeProps): ReactElement {
  const id = useId()
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const visible = useMemo(() => visibleRows(tree.rows), [tree.rows])
  const focusedIndex = focusedPath === null ? 0 : Math.max(0, visible.findIndex(row => row.path === focusedPath))
  const focused = visible[focusedIndex]
  const rowElements = useRef(new Map<string, HTMLDivElement>())

  const focusRow = (index: number): void => {
    const row = visible[Math.max(0, Math.min(visible.length - 1, index))]
    if (!row) return
    setFocusedPath(row.path)
    rowElements.current.get(row.path)?.scrollIntoView?.({ block: "nearest" })
  }
  const activate = (row: ProjectTreeRow): void => {
    if (row.kind === "directory") {
      if (row.hasChildren) actions.toggleDirectory(scope, row.path)
    } else if (open.enabled) actions.openFile(scope, row.path)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!focused) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      focusRow(focusedIndex + (event.key === "ArrowDown" ? 1 : -1))
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault()
      focusRow(event.key === "Home" ? 0 : visible.length - 1)
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      activate(focused)
    } else if (event.key === "ArrowRight" && focused.kind === "directory") {
      event.preventDefault()
      if (!focused.expanded && focused.hasChildren) actions.toggleDirectory(scope, focused.path)
      else if (focused.expanded && visible[focusedIndex + 1]?.depth === focused.depth + 1) focusRow(focusedIndex + 1)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      if (focused.kind === "directory" && focused.expanded) actions.toggleDirectory(scope, focused.path)
      else {
        const parent = focused.path.includes("/") ? focused.path.slice(0, focused.path.lastIndexOf("/")) : ""
        const parentIndex = visible.findIndex(row => row.path === parent)
        if (parentIndex >= 0) focusRow(parentIndex)
      }
    }
  }
  return <div ref={treeRef} className="project-file-tree" role="tree" aria-label="文件列表" tabIndex={0}
    aria-activedescendant={focused ? `${id}-row-${focusedIndex}` : undefined} onKeyDown={onKeyDown}>
    {tree.status === "loading" && visible.length === 0 ? <p className="project-tree-status">加载中…</p> : null}
    {tree.status === "error" ? <p className="project-tree-status project-tree-error" role="alert">{tree.message ?? "文件树加载失败"}</p> : null}
    {tree.status === "ready" && visible.length === 0 ? <p className="project-tree-status">空目录</p> : null}
    {visible.map((row, index) => {
      const disabled = row.kind === "directory" ? !row.hasChildren : !open.enabled
      return <div key={row.path} ref={element => {
        if (element) rowElements.current.set(row.path, element)
        else rowElements.current.delete(row.path)
      }} id={`${id}-row-${index}`} role="treeitem" aria-level={row.depth + 1}
        aria-expanded={row.kind === "directory" ? row.expanded : undefined}
        aria-selected={row.path === selectedPath} aria-disabled={disabled || undefined}
        className={`project-file-row${row.path === selectedPath ? " is-selected" : ""}${index === focusedIndex ? " is-focused" : ""}`}
        style={{ paddingInlineStart: 8 + row.depth * 12 }}
        onClick={() => { treeRef.current?.focus(); setFocusedPath(row.path); activate(row) }}>
        <span className="project-file-row-arrow" aria-hidden="true">
          {row.kind === "directory" ? row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        {row.kind === "directory" ? <Folder size={14} aria-hidden="true" className="project-file-row-icon" />
          : row.kind === "symlink" ? <FileSymlink size={14} aria-hidden="true" className="project-file-row-icon" />
            : <FileTypeIcon name={row.name} />}
        <span className="project-file-row-name" title={row.path}>{row.name}</span>
        {row.loading ? <span className="project-file-row-loading">…</span> : null}
      </div>
    })}
    {tree.limited ? <p className="project-tree-limited">工作区文件较多，仅展示部分内容</p> : null}
  </div>
}

function visibleRows(rows: readonly ProjectTreeRow[]): readonly ProjectTreeRow[] {
  const collapsed = new Set<string>()
  const visible: ProjectTreeRow[] = []
  for (const row of rows) {
    const segments = row.path.split("/")
    if (segments.some((_, index) => index > 0 && collapsed.has(segments.slice(0, index).join("/")))) continue
    visible.push(row)
    if (row.kind === "directory" && !row.expanded) collapsed.add(row.path)
  }
  return visible
}
