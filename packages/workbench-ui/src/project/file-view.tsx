/**
 * 项目只读文件部件：右侧与中央共用同一份受控内容。
 * 页面装配方决定文件身份、缓存和权限；这里不读取磁盘或发起网络请求。
 */
import { ExternalLink, RefreshCw, X } from "lucide-react"
import { useState } from "react"
import type { ReactElement } from "react"
import { FileTypeIcon } from "../common/file-type-icon.js"
import { HighlightedCode } from "../rendering/highlighted-code.js"
import { Markdown } from "../rendering/markdown.js"
import type { RenderingActions } from "../rendering/types.js"
import type { ProjectActionAvailability, ProjectFileView, ProjectScope } from "./types.js"

/** 中央文件页签由总页签控制选中、排列和键盘；关闭是独立按钮。 */
export type ProjectFileTabProps = {
  scope: ProjectScope
  path: string
  name: string
  selected: boolean
  tabId: string
  panelId: string
  onActivate(scope: ProjectScope, path: string): void
  onClose(scope: ProjectScope, path: string): void
}

export function ProjectFileTab({ scope, path, name, selected, tabId, panelId, onActivate, onClose }: ProjectFileTabProps): ReactElement {
  return <div className="project-workbench-tab-item" data-selected={selected}>
    <button type="button" role="tab" id={tabId} aria-controls={panelId} aria-selected={selected}
      tabIndex={selected ? 0 : -1} className="project-workbench-tab" title={path}
      onClick={() => onActivate(scope, path)}>
      <FileTypeIcon name={name} /><span className="project-workbench-tab-name">{name}</span>
    </button>
    <button type="button" className="project-file-tab-close" aria-label={`关闭文件 ${path}`} title="关闭文件"
      onClick={() => onClose(scope, path)}><X size={12} aria-hidden="true" /></button>
  </div>
}

/** 中央文件面板；隐藏时仍挂载，以保留内容与滚动位置。 */
export type ProjectFilePanelProps = {
  scope: ProjectScope
  path: string
  view?: ProjectFileView
  refresh: ProjectActionAvailability
  onRefresh(scope: ProjectScope, path: string): void
  active: boolean
  tabId: string
  panelId: string
  /** Markdown 中的复制与外链沿用公共宿主端口。 */
  rendering?: RenderingActions
  /** 外部分屏顶栏接管 Markdown 预览开关时传入，未传则保留内部切换状态。 */
  preview?: boolean
  onPreviewChange?(preview: boolean): void
}

export function ProjectFilePanel({ scope, path, view, refresh, onRefresh, active, tabId, panelId, rendering, preview, onPreviewChange }: ProjectFilePanelProps): ReactElement {
  return <section id={panelId} role="tabpanel" aria-labelledby={tabId} className="project-workbench-file-panel"
    hidden={!active} inert={!active}>
    <ProjectFileReader scope={scope} path={path} view={view} refresh={refresh} onRefresh={onRefresh} rendering={rendering}
      preview={preview} onPreviewChange={onPreviewChange} />
  </section>
}

type ProjectFileReaderProps = {
  scope: ProjectScope
  path: string
  view?: ProjectFileView
  refresh: ProjectActionAvailability
  onRefresh(scope: ProjectScope, path: string): void
  openCentral?: ProjectActionAvailability
  onOpenCentral?(scope: ProjectScope, path: string): void
  rendering?: RenderingActions
  preview?: boolean
  onPreviewChange?(preview: boolean): void
}

/** 中央与右侧的文件阅读器分别保留源码／预览选择，不改变文件读取与授权。 */
export function ProjectFileReader(props: ProjectFileReaderProps): ReactElement {
  const [internalPreview, setInternalPreview] = useState(true)
  const preview = props.preview ?? internalPreview
  const handlePreviewChange = (next: boolean) => {
    setInternalPreview(next)
    props.onPreviewChange?.(next)
  }
  const view = matchingView(props.path, props.view)
  const isMarkdown = view?.status === "ready" && (view.file.language === "markdown" || /\.(?:md|mdx|markdown)$/i.test(props.path))
  return <>
    <ProjectFileHeader {...props} markdown={isMarkdown} preview={preview} onPreviewChange={handlePreviewChange} />
    <ProjectFileContentView path={props.path} view={view} preview={isMarkdown && preview} rendering={props.rendering} />
  </>
}

/** 路径、元信息与操作独立于内容区，刷新失败时仍保留重试入口。 */
function ProjectFileHeader({ scope, path, view: rawView, refresh, onRefresh, openCentral, onOpenCentral, markdown, preview, onPreviewChange }: ProjectFileReaderProps & {
  markdown: boolean
  preview: boolean
  onPreviewChange(preview: boolean): void
}): ReactElement {
  const view = matchingView(path, rawView)
  const file = view?.status === "ready" ? view.file : undefined
  const info = file
    ? `${file.language ?? "文本"} · ${formatFileSize(file.sizeBytes)} · ${file.lineCount} 行`
    : view && (view.status === "unsupported" || view.status === "too-large") && view.sizeBytes !== undefined
      ? `${view.reason} · ${formatFileSize(view.sizeBytes)}`
      : undefined
  return <div className="project-file-preview-header">
    <div className="project-file-preview-path">
      <span className="project-file-preview-path-text" title={path}>{path}</span>
      {view?.status === "ready" && view.refreshError ? <span className="project-file-preview-error" role="alert">{view.refreshError}</span> : null}
    </div>
    <div className="project-file-preview-actions">
      {markdown ? <div className="wb-seg project-file-view-mode" role="group" aria-label="Markdown 显示方式">
        <button type="button" className={preview ? "is-active" : undefined} aria-pressed={preview} onClick={() => onPreviewChange(true)}>预览</button>
        <button type="button" className={!preview ? "is-active" : undefined} aria-pressed={!preview} onClick={() => onPreviewChange(false)}>源码</button>
      </div> : null}
      {info ? <span className="project-file-preview-meta">{info}</span> : null}
      {file && (file.freshness === "cached" || (view?.status === "ready" && view.refreshError))
        ? <span className="project-file-preview-warning">缓存 / 非实时</span> : null}
      {file?.truncated ? <span className="project-file-preview-warning">
        {file.displayedBytes === undefined ? "文件已截断，仅展示部分内容" : `文件已截断，仅展示 ${formatFileSize(file.displayedBytes)}`}
      </span> : null}
      <div className="project-file-preview-tools" role="group" aria-label="文件预览操作">
        <button type="button" className="wb-icon-button" aria-label="刷新预览"
          title={refresh.enabled ? "刷新" : refresh.reason} disabled={!refresh.enabled}
          onClick={() => onRefresh(scope, path)}><RefreshCw size={14} aria-hidden="true" /></button>
        {openCentral && onOpenCentral ? <button type="button" className="wb-icon-button" aria-label="在主区域打开"
          title={openCentral.enabled ? "在主区域打开" : openCentral.reason} disabled={!openCentral.enabled}
          onClick={() => onOpenCentral(scope, path)}><ExternalLink size={16} aria-hidden="true" /></button> : null}
      </div>
    </div>
  </div>
}

/** 无对应路径的输入按加载中处理，避免把旧请求的内容放进当前文件。 */
function matchingView(path: string, view?: ProjectFileView): ProjectFileView | undefined {
  if (!view) return undefined
  return (view.status === "ready" ? view.file.path : view.path) === path ? view : undefined
}

/** 行号与源码共享滚动容器；Markdown 预览沿用会话的安全渲染器。 */
function ProjectFileContentView({ path, view: rawView, preview, rendering }: { path: string; view?: ProjectFileView; preview: boolean; rendering?: RenderingActions }): ReactElement {
  const view = matchingView(path, rawView)
  if (!view || view.status === "loading") return <div className="project-file-code-view"><p className="project-file-code-status">加载中…</p></div>
  if (view.status === "ready") {
    const { file } = view
    if (preview) return <div className="project-file-markdown-view"><Markdown text={file.content} actions={rendering} /></div>
    const numbers = Array.from({ length: file.lineCount }, (_, index) => String(index + 1)).join("\n")
    return <div className="project-file-code-view">
      <div className="project-line-numbers" aria-hidden="true">{numbers}</div>
      <pre className="project-file-code-pre"><code data-language={file.language ?? undefined}>
        <HighlightedCode code={file.content} language={file.language} />
      </code></pre>
    </div>
  }
  if (view.status === "error") return <div className="project-file-code-view project-file-code-error" role="alert">
    <p className="project-file-code-status">{view.message}</p>
  </div>
  return <div className="project-file-code-view project-file-code-meta">
    <p className="project-file-code-status">{path.split("/").at(-1) ?? path}</p><p className="project-file-code-status">{view.reason}</p>
  </div>
}

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`
}
