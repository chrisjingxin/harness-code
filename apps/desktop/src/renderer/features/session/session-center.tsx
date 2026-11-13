/**
 * 本机会话扩展视图组件（HC-218 停点 3）：
 *
 * 【功能定义】
 * 1. `SessionRightDock`：仅用于本人本机会话的右侧栏。未选目录时展示引导卡片；已选目录时复用 `@workbench/ui`
 *    的 `ProjectDock` 展示只读文件树、右侧文件页签与只读 Git 变更（普通非 Git 目录平稳显示无报错提示）。
 * 2. `SessionCentralFileTabs` / `SessionCentralFilePanels`：复用 `@workbench/ui` 的 `ProjectFileTab` 与
 *    `ProjectFilePanel` 在中央对话区旁边打开多个源代码文件，同时保持 `ConversationView` 常驻挂载不丢位置。
 */
import { useEffect, useLayoutEffect, useRef } from "react"
import type { ReactElement } from "react"
import { ProjectDock, ProjectFilePanel, ProjectFileTab } from "@workbench/ui"
import type {
  ProjectActionAvailability,
  ProjectDockProps,
  ProjectFileView,
  ProjectScope,
  RenderingActions,
} from "@workbench/ui"
import { FolderIcon } from "./icons.js"

export type CentralFileTabItem = {
  readonly path: string
  readonly name: string
}

export type SessionCentralFilesState = {
  readonly uiScope: ProjectScope
  readonly tabs: readonly CentralFileTabItem[]
  readonly activeCentral: string | null
  readonly files: Readonly<Record<string, ProjectFileView>>
  readonly refreshGate: ProjectActionAvailability
  readonly positions: Readonly<Record<string, { area: "central" | "dock" | "tree"; path: string; top: number; left: number }>>
  readonly rendering: RenderingActions
  readonly onSelectConversation: () => void
  readonly onSelectFile: (path: string) => void
  readonly onCloseFile: (path: string) => void
  readonly onRefreshFile: (path: string) => void
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

export function SessionCentralFilePanels({ state }: { readonly state: SessionCentralFilesState }): ReactElement | null {
  if (state.tabs.length === 0) return null
  return (
    <>
      {state.tabs.map(tab => (
        <CentralFilePanelWithScroll key={tab.path} tab={tab} state={state} />
      ))}
    </>
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
