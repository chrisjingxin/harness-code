/**
 * 本机会话扩展视图组件（HC-218 停点 3）：
 *
 * 【功能定义】
 * 1. `SessionRightDock`：仅用于本人本机会话的右侧栏。未选目录时展示引导卡片；已选目录时复用 `@workbench/ui`
 *    的 `ProjectDock` 展示只读文件树、右侧文件页签与只读 Git 变更（普通非 Git 目录平稳显示无报错提示）。
 * 2. `SessionCentralFileTabs` / `SessionCentralFilePanels`：复用 `@workbench/ui` 的 `ProjectFileTab` 与
 *    `ProjectFilePanel` 在中央对话区旁边打开多个源代码文件，同时保持 `ConversationView` 常驻挂载不丢位置。
 */
import { Fragment, useEffect, useLayoutEffect, useRef } from "react"
import type { ReactElement } from "react"
import { ProjectDock, ProjectFilePanel, ProjectFileTab } from "@workbench/ui"
import type {
  ProjectActionAvailability,
  ProjectChangesView,
  ProjectDockProps,
  ProjectFileView,
  ProjectScope,
  RenderingActions,
} from "@workbench/ui"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FileDocIcon,
  FolderIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "./icons.js"

export type CentralFileTabItem = {
  readonly path: string
  readonly name: string
}

export type SessionCentralFilesState = {
  readonly uiScope: ProjectScope
  readonly tabs: readonly CentralFileTabItem[]
  readonly activeCentral: string | null
  readonly mode?: "code" | "diff"
  readonly files: Readonly<Record<string, ProjectFileView>>
  readonly changes?: ProjectChangesView
  readonly refreshGate: ProjectActionAvailability
  readonly positions: Readonly<Record<string, { area: "central" | "dock" | "tree"; path: string; top: number; left: number }>>
  readonly rendering: RenderingActions
  readonly onSelectConversation: () => void
  readonly onSelectFile: (path: string) => void
  readonly onCloseFile: (path: string) => void
  readonly onRefreshFile: (path: string) => void
  readonly onSetMode?: (mode: "code" | "diff") => void
  readonly onOpenDiffFile?: (path: string) => void
  readonly onSaveScroll: (area: "central" | "dock" | "tree", path: string, top: number, left: number) => void
}

export function SessionCentralTabBar({ state }: { readonly state: SessionCentralFilesState }): ReactElement | null {
  if (state.tabs.length === 0) return null
  return (
    <div className="desktop-center-tabs" role="tablist" aria-label="本机会话与打开的文件">
      <div className="desktop-conversation-tab" data-selected={state.activeCentral === null}>
        <button
          type="button"
          role="tab"
          aria-selected={state.activeCentral === null}
          onClick={state.onSelectConversation}
        >
          对话
        </button>
      </div>
      {state.tabs.map(tab => {
        const encoded = encodeURIComponent(tab.path)
        return (
          <ProjectFileTab
            key={tab.path}
            scope={state.uiScope}
            path={tab.path}
            name={tab.name}
            selected={state.activeCentral === tab.path}
            tabId={`session-central-tab-${encoded}`}
            panelId={`session-central-panel-${encoded}`}
            onActivate={(_s, path) => state.onSelectFile(path)}
            onClose={(_s, path) => state.onCloseFile(path)}
          />
        )
      })}
    </div>
  )
}

function CentralFilePanelWithScroll({
  tab,
  state,
}: {
  readonly tab: CentralFileTabItem
  readonly state: SessionCentralFilesState
}): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const active = state.activeCentral === tab.path
  const encoded = encodeURIComponent(tab.path)
  const saved = state.positions[`central\0${tab.path}`]

  useLayoutEffect(() => {
    if (!active || !wrapRef.current || !saved) return
    const scrollBox = wrapRef.current.querySelector<HTMLElement>(".project-file-content")
    if (scrollBox) {
      scrollBox.scrollTop = saved.top
      scrollBox.scrollLeft = saved.left
    }
  }, [active, saved])

  useEffect(() => {
    const root = wrapRef.current
    if (!root) return
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof HTMLElement && target.classList.contains("project-file-content")) {
        state.onSaveScroll("central", tab.path, target.scrollTop, target.scrollLeft)
      }
    }
    root.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => root.removeEventListener("scroll", onScroll, { capture: true })
  }, [tab.path, state])

  return (
    <div ref={wrapRef} className="session-central-file-wrap" hidden={!active}>
      <ProjectFilePanel
        scope={state.uiScope}
        path={tab.path}
        view={state.files[tab.path]}
        refresh={state.refreshGate}
        onRefresh={(_s, path) => state.onRefreshFile(path)}
        active={active}
        tabId={`session-central-tab-${encoded}`}
        panelId={`session-central-panel-${encoded}`}
        rendering={state.rendering}
      />
    </div>
  )
}

function fileStatusCode(status?: string): { code: string; cls: "m" | "a" | "u" } | null {
  if (!status) return null
  if (status === "??" || status === "U") return { code: "U", cls: "u" }
  if (status === "A") return { code: "A", cls: "a" }
  if (status === "D") return { code: "D", cls: "m" }
  return { code: "M", cls: "m" }
}

function CentralDiffContent({
  path,
  state,
}: {
  readonly path: string
  readonly state: SessionCentralFilesState
}): ReactElement {
  const diff = state.changes?.diff
  if (diff && diff.path === path && diff.text) {
    const lines = diff.text.split("\n")
    return (
      <div className="filepane-diff-scroll">
        <pre className="code">
          {lines.map((line, i) => {
            const cls = line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+") && !line.startsWith("+++")
                ? "add"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "del"
                  : ""
            return (
              <Fragment key={i}>
                <span className="ln">{i + 1}</span>
                <span className={cls}>{line}</span>
                {i < lines.length - 1 ? "\n" : null}
              </Fragment>
            )
          })}
        </pre>
        {diff.truncated && <p className="filepane-diff-empty">Diff 内容较长，已截断展示。</p>}
      </div>
    )
  }

  const fileView = state.files[path]
  const changed = state.changes?.repository?.files.find(f => f.path === path)
  if ((changed?.status === "??" || changed?.status === "U" || changed?.status === "A") && fileView?.status === "ready") {
    const lines = fileView.file.content.split("\n")
    return (
      <div className="filepane-diff-scroll">
        <pre className="code">
          {lines.map((line, i) => (
            <Fragment key={i}>
              <span className="ln">{i + 1}</span>
              <span className="add">+{line}</span>
              {i < lines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    )
  }

  if (state.changes?.busy) {
    return <p className="filepane-diff-empty">正在加载 Git 差异…</p>
  }
  return (
    <p className="filepane-diff-empty">
      {state.changes?.message || "当前文件在 HEAD 中无未提交差异；可切回「代码」浏览完整内容。"}
    </p>
  )
}

export function SessionCentralFilePanels({
  state,
  maximized = false,
  onToggleMaximized,
}: {
  readonly state: SessionCentralFilesState
  readonly maximized?: boolean
  readonly onToggleMaximized?: () => void
}): ReactElement | null {
  const paneRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!state.activeCentral) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (paneRef.current && paneRef.current.contains(document.activeElement)) {
        event.stopPropagation()
        state.onSelectConversation()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [state.activeCentral, state.onSelectConversation])

  if (state.tabs.length === 0 || state.activeCentral === null) return null

  const activePath = state.activeCentral
  const activeFile = state.files[activePath]
  const mode = state.mode ?? "code"
  const changedFiles = state.changes?.repository?.files ?? []
  const cIdx = changedFiles.findIndex(f => f.path === activePath)
  const st = fileStatusCode(cIdx >= 0 ? changedFiles[cIdx]?.status : undefined)

  return (
    <section ref={paneRef} className="filepane" aria-label="文件预览">
      <div className="filepane-head">
        <div className="fp-tabs" role="tablist" aria-label="打开的文件">
          {state.tabs.map(tab => {
            const on = tab.path === activePath
            return (
              <div key={tab.path} className={`fp-tab-wrap${on ? " is-active" : ""}`} role="presentation">
                <button
                  type="button"
                  role="tab"
                  className={`fp-tab${on ? " is-active" : ""}`}
                  aria-selected={on}
                  title={tab.path}
                  onClick={() => state.onSelectFile(tab.path)}
                >
                  <FileDocIcon size={12} />
                  <span className="t-mono">{tab.name}</span>
                </button>
                <button
                  type="button"
                  className="fp-tab-x"
                  aria-label={`关闭 ${tab.name}`}
                  title="关闭"
                  onClick={() => state.onCloseFile(tab.path)}
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <div className="fp-tools">
          {state.onSetMode && (
            <div className="seg" role="tablist" aria-label="预览方式">
              <button
                type="button"
                role="tab"
                className={mode === "code" ? "is-active" : undefined}
                aria-selected={mode === "code"}
                onClick={() => state.onSetMode?.("code")}
              >
                代码
              </button>
              <button
                type="button"
                role="tab"
                className={mode === "diff" ? "is-active" : undefined}
                aria-selected={mode === "diff"}
                onClick={() => state.onSetMode?.("diff")}
              >
                Diff
              </button>
            </div>
          )}
          {onToggleMaximized && (
            <button
              type="button"
              className={`icon-btn${maximized ? " is-on" : ""}`}
              aria-label={maximized ? "还原分屏" : "放大预览"}
              title={maximized ? "还原分屏" : "放大预览"}
              onClick={onToggleMaximized}
            >
              {maximized ? <MinimizeIcon size={15} /> : <MaximizeIcon size={15} />}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭预览"
            title="关闭预览"
            onClick={state.onSelectConversation}
          >
            <CloseIcon size={15} />
          </button>
        </div>
      </div>

      <div className="fp-meta">
        <span className="fp-full" title={activePath}>{activePath}</span>
        <span style={{ flex: "1 1 0" }} />
        {activeFile?.status === "ready" && (
          <>
            {activeFile.file.language && <span className="fp-info">{activeFile.file.language}</span>}
            <span className="fp-info">{activeFile.file.lineCount} 行</span>
          </>
        )}
        {st && <span className={`f-badge ${st.cls}`}>{st.code}</span>}
        {changedFiles.length > 1 && cIdx >= 0 && state.onOpenDiffFile && (
          <div className="fp-step-group" role="group" aria-label="变更文件步进">
            <button
              type="button"
              className="fp-step-btn"
              aria-label="上一个变更文件"
              title="上一个变更文件"
              onClick={() => {
                const nextIdx = (cIdx - 1 + changedFiles.length) % changedFiles.length
                const target = changedFiles[nextIdx]
                if (target) state.onOpenDiffFile?.(target.path)
              }}
            >
              <ChevronLeftIcon size={13} />
            </button>
            <span className="fp-step-count">{cIdx + 1}/{changedFiles.length}</span>
            <button
              type="button"
              className="fp-step-btn"
              aria-label="下一个变更文件"
              title="下一个变更文件"
              onClick={() => {
                const nextIdx = (cIdx + 1) % changedFiles.length
                const target = changedFiles[nextIdx]
                if (target) state.onOpenDiffFile?.(target.path)
              }}
            >
              <ChevronRightIcon size={13} />
            </button>
          </div>
        )}
      </div>

      <div className="filepane-body">
        {mode === "diff" ? (
          <CentralDiffContent path={activePath} state={state} />
        ) : (
          state.tabs.map(tab => (
            <CentralFilePanelWithScroll key={tab.path} tab={tab} state={state} />
          ))
        )}
      </div>
    </section>
  )
}

export type SessionRightDockProps = {
  readonly directoryPath: string | null
  readonly bindingError: string | null
  readonly dockProps: ProjectDockProps | null
  readonly onChooseDirectory: () => void
  readonly onRefreshBind?: () => void
}

export function SessionRightDock({
  directoryPath,
  bindingError,
  dockProps,
  onChooseDirectory,
  onRefreshBind,
}: SessionRightDockProps): ReactElement {
  if (!directoryPath) {
    return (
      <section className="session-right-guide" aria-label="选择本机工作目录">
        <span className="session-right-guide-icon">
          <FolderIcon size={20} />
        </span>
        <h2>尚未绑定工作目录</h2>
        <p>选择一个本机文件夹后，可在此浏览只读文件树、打开正文并在输入 `@` 时联想文件路径（支持普通非 Git 文件夹）。</p>
        <button
          type="button"
          className="wb-button wb-button-primary wb-button-small"
          onClick={onChooseDirectory}
        >
          <FolderIcon size={13} />
          <span>选择工作目录</span>
        </button>
      </section>
    )
  }

  if (!dockProps) {
    return (
      <section className="session-right-guide" aria-label="正在加载工作目录">
        <h2>正在准备工作目录…</h2>
        <p>{directoryPath}</p>
      </section>
    )
  }

  return (
    <div className="desktop-project-dock">
      {bindingError && onRefreshBind ? (
        <button
          type="button"
          className="wb-button wb-button-secondary wb-button-small desktop-project-retry"
          onClick={onRefreshBind}
        >
          重新选择目录
        </button>
      ) : null}
      <ProjectDock {...dockProps} />
    </div>
  )
}
