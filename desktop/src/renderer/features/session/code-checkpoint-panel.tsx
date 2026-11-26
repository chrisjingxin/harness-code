/**
 * 轮次代码变更卡片、分栏差异查看器与回退确认弹窗（对齐 T3 Code 体验）。
 *
 * 【功能定义】
 * 1. `TurnChangedFilesCard`：仅在某一轮确实改动了文件时挂在对应 AI 回复底部，展示可折叠变更文件树；
 * 2. `TurnDiffPane`：复用右侧分栏面板（`.filepane`）展示该轮逐文件代码差异，并仅在此处提供只读隔离提示；
 * 3. `CheckpointRestoreDialog`：由消息悬停按钮或差异面板触发，预览本机受影响文件并二次确认还原。
 */
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconChevronDown,
  IconChevronRight,
  IconChevronsDown,
  IconChevronsUp,
  IconFileDiff,
  IconFolder,
  IconFolderOpen,
  IconRotate2,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import type {
  CodeCheckpointAction,
  CodeCheckpointFileChange,
  CodeCheckpointReply,
  CodeCheckpointTurn,
} from "../../../shared/local-execution-host.js"
import { FileTypeIcon } from "../../../ui/index.js"
import { ProjectGitDiff } from "../../../ui/project/git-diff.js"
import {
  buildTurnDiffTree,
  summarizeCheckpointFiles,
  type TurnDiffTreeNode,
} from "./turn-checkpoint-model.js"

type DiffState =
  | { readonly status: "loading"; readonly path: string }
  | { readonly status: "ready"; readonly path: string; readonly text: string; readonly truncated: boolean }
  | { readonly status: "error"; readonly path: string; readonly message: string }

type RestoreTarget =
  | { readonly target: "base" }
  | { readonly target: "post" }
  | { readonly target: "guard"; readonly guardId: string }

type PreviewResult = Extract<CodeCheckpointReply, { kind: "preview" }>

function baseFileName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || path
}

function FileStatBadge({ added, removed }: { readonly added: number | null; readonly removed: number | null }): ReactElement {
  if (added === null || removed === null) {
    return <span className="turn-diff-stat-muted">二进制</span>
  }
  return (
    <span className="turn-diff-stats">
      {added > 0 ? <span className="turn-diff-stat-add">+{added}</span> : null}
      {removed > 0 ? <span className="turn-diff-stat-del">−{removed}</span> : null}
      {added === 0 && removed === 0 ? <span className="turn-diff-stat-muted">0</span> : null}
    </span>
  )
}

function renderTreeNodes(params: {
  readonly nodes: readonly TurnDiffTreeNode[]
  readonly depth: number
  readonly allExpanded: boolean
  readonly overrides: Readonly<Record<string, boolean>>
  readonly onToggleDir: (path: string, currentlyExpanded: boolean) => void
  readonly onOpenFile: (filePath: string) => void
}): readonly ReactElement[] {
  const { nodes, depth, allExpanded, overrides, onToggleDir, onOpenFile } = params
  return nodes.map(node => {
    if (node.kind === "directory") {
      const expanded = overrides[node.path] ?? allExpanded
      return (
        <div key={`dir:${node.path}`} className="turn-diff-dir-group">
          <button
            type="button"
            className="turn-diff-row turn-diff-dir-row"
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            aria-expanded={expanded}
            onClick={() => onToggleDir(node.path, expanded)}
          >
            {expanded
              ? <IconChevronDown size={13} className="turn-diff-chevron" aria-hidden="true" />
              : <IconChevronRight size={13} className="turn-diff-chevron" aria-hidden="true" />}
            {expanded
              ? <IconFolderOpen size={14} className="turn-diff-folder-icon" aria-hidden="true" />
              : <IconFolder size={14} className="turn-diff-folder-icon" aria-hidden="true" />}
            <span className="turn-diff-row-name">{node.name}</span>
          </button>
          {expanded
            ? renderTreeNodes({
                nodes: node.children,
                depth: depth + 1,
                allExpanded,
                overrides,
                onToggleDir,
                onOpenFile,
              })
            : null}
        </div>
      )
    }
    const { file } = node
    const displayName = file.oldPath ? `${file.oldPath} → ${node.name}` : node.name
    return (
      <button
        key={`file:${file.path}`}
        type="button"
        className="turn-diff-row turn-diff-file-row"
        style={{ paddingLeft: `${10 + depth * 14 + (depth > 0 ? 17 : 0)}px` }}
        title={file.path}
        onClick={() => onOpenFile(file.path)}
      >
        <FileTypeIcon name={node.name} size={14} />
        <span className="turn-diff-row-name">{displayName}</span>
        <FileStatBadge added={file.added} removed={file.removed} />
      </button>
    )
  })
}

/**
 * 挂在已改动文件的 AI 回复底部的紧凑文件树卡片；纯问答或无文件改动时不占任何空间。
 */
export function TurnChangedFilesCard({
  turn,
  onOpenDiff,
}: {
  readonly turn: CodeCheckpointTurn
  readonly onOpenDiff: (turn: CodeCheckpointTurn, filePath?: string) => void
}): ReactElement | null {
  const files = turn.files
  const tree = useMemo(() => (files?.length ? buildTurnDiffTree(files) : []), [files])
  const totals = useMemo(() => (files?.length ? summarizeCheckpointFiles(files) : null), [files])
  const defaultExpanded = (files?.length ?? 0) <= 8
  const [treeState, setTreeState] = useState<{
    readonly turnId: string
    readonly allExpanded: boolean
    readonly overrides: Record<string, boolean>
  }>(() => ({
    turnId: turn.turnId,
    allExpanded: defaultExpanded,
    overrides: {},
  }))

  if (!files?.length || !totals) return null

  const activeState = treeState.turnId === turn.turnId
    ? treeState
    : { turnId: turn.turnId, allExpanded: defaultExpanded, overrides: {} }
  const hasDirectories = tree.some(node => node.kind === "directory")

  const toggleAllDirectories = () => {
    const nextExpanded = !activeState.allExpanded
    setTreeState({ turnId: turn.turnId, allExpanded: nextExpanded, overrides: {} })
  }

  const toggleDir = (dirPath: string, currentlyExpanded: boolean) => {
    setTreeState({
      turnId: turn.turnId,
      allExpanded: activeState.allExpanded,
      overrides: { ...activeState.overrides, [dirPath]: !currentlyExpanded },
    })
  }

  return (
    <div className="turn-diff-card" role="region" aria-label={`第 ${turn.ordinal} 轮变更文件`}>
      <div className="turn-diff-card-head">
        <div className="turn-diff-card-summary">
          <span className="turn-diff-card-count">{totals.count} 个变更文件</span>
          {totals.additions > 0 || totals.deletions > 0 ? (
            <span className="turn-diff-card-totals">
              {totals.additions > 0 ? <span className="turn-diff-stat-add">+{totals.additions}</span> : null}
              {totals.deletions > 0 ? <span className="turn-diff-stat-del">−{totals.deletions}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="turn-diff-card-actions">
          {hasDirectories ? (
            <button
              type="button"
              className="turn-diff-icon-btn"
              aria-label={activeState.allExpanded ? "折叠全部目录" : "展开全部目录"}
              title={activeState.allExpanded ? "折叠全部目录" : "展开全部目录"}
              onClick={toggleAllDirectories}
            >
              {activeState.allExpanded
                ? <IconChevronsUp size={14} aria-hidden="true" />
                : <IconChevronsDown size={14} aria-hidden="true" />}
            </button>
          ) : null}
          <button
            type="button"
            className="turn-diff-open-btn"
            onClick={() => onOpenDiff(turn, files[0]?.path)}
          >
            <IconFileDiff size={13} aria-hidden="true" />
            <span>查看差异</span>
          </button>
        </div>
      </div>
      <div className="turn-diff-tree">
        {renderTreeNodes({
          nodes: tree,
          depth: 0,
          allExpanded: activeState.allExpanded,
          overrides: activeState.overrides,
          onToggleDir: toggleDir,
          onOpenFile: path => onOpenDiff(turn, path),
        })}
      </div>
    </div>
  )
}

/**
 * 右侧分栏展示单轮各文件的 Git Diff，仅在当前查看分栏时按需拉取文本差异。
 */
export function TurnDiffPane({
  turn,
  selectedPath,
  restoreBlocked,
  running,
  maximized = false,
  onSelectPath,
  onToggleMaximized,
  onClose,
  onRequestRestore,
  run,
}: {
  readonly turn: CodeCheckpointTurn
  readonly selectedPath: string
  readonly restoreBlocked?: string
  readonly running: boolean
  readonly maximized?: boolean
  readonly onSelectPath: (path: string) => void
  readonly onToggleMaximized?: () => void
  readonly onClose: () => void
  readonly onRequestRestore?: (turn: CodeCheckpointTurn) => void
  readonly run: (action: CodeCheckpointAction) => Promise<CodeCheckpointReply>
}): ReactElement {
  const paneRef = useRef<HTMLElement>(null)
  const runRef = useRef(run)
  runRef.current = run
  const files: readonly CodeCheckpointFileChange[] = turn.files ?? []
  const activeFile = files.find(f => f.path === selectedPath) ?? files[0]
  const activePath = activeFile?.path ?? selectedPath
  const [diffState, setDiffState] = useState<DiffState | null>(null)
  const requestSeq = useRef(0)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (paneRef.current && paneRef.current.contains(document.activeElement)) {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  useEffect(() => {
    if (!activePath) return
    const seq = ++requestSeq.current
    setDiffState({ status: "loading", path: activePath })
    void runRef.current({ kind: "diff", turnId: turn.turnId, path: activePath }).then(
      reply => {
        if (requestSeq.current !== seq) return
        if (reply.kind === "diff") {
          setDiffState({ status: "ready", path: activePath, text: reply.text, truncated: reply.truncated })
        }
      },
      error => {
        if (requestSeq.current !== seq) return
        setDiffState({
          status: "error",
          path: activePath,
          message: error instanceof Error && error.message ? error.message : "读取轮次代码差异失败。",
        })
      },
    )
  }, [turn.turnId, activePath])

  const canRestore = !restoreBlocked && Boolean(onRequestRestore) && (!turn.unavailable || turn.guards.length > 0)

  return (
    <section ref={paneRef} className="filepane turn-diff-pane" aria-label={`第 ${turn.ordinal} 轮代码差异`}>
      <div className="filepane-head">
        <div className="fp-tabs" role="tablist" aria-label="本轮变更文件">
          {files.map(item => {
            const on = item.path === activePath
            const name = baseFileName(item.path)
            return (
              <div key={item.path} className={`fp-tab-wrap${on ? " is-active" : ""}`} role="presentation">
                <button
                  type="button"
                  role="tab"
                  className={`fp-tab${on ? " is-active" : ""}`}
                  aria-selected={on}
                  title={item.path}
                  onClick={() => onSelectPath(item.path)}
                >
                  <FileTypeIcon name={name} size={13} />
                  <span className="t-mono">{name}</span>
                </button>
              </div>
            )
          })}
        </div>
        <div className="fp-tools">
          {canRestore ? (
            <button
              type="button"
              className="turn-diff-restore-btn"
              disabled={running}
              onClick={() => onRequestRestore?.(turn)}
            >
              <IconRotate2 size={14} aria-hidden="true" />
              <span>回退代码</span>
            </button>
          ) : restoreBlocked ? (
            <span className="turn-diff-pane-hint" title={restoreBlocked}>仅查看 Diff</span>
          ) : null}
          {onToggleMaximized ? (
            <button
              type="button"
              className={`icon-btn${maximized ? " is-on" : ""}`}
              aria-label={maximized ? "还原分屏" : "放大预览"}
              title={maximized ? "还原分屏" : "放大预览"}
              onClick={onToggleMaximized}
            >
              {maximized ? <IconArrowsMinimize size={15} aria-hidden="true" /> : <IconArrowsMaximize size={15} aria-hidden="true" />}
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭差异预览"
            title="关闭差异预览"
            onClick={onClose}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {activePath ? (
        <div className="fp-meta">
          <span className="turn-diff-pane-badge">第 {turn.ordinal} 轮</span>
          <span className="fp-full" title={activePath}>
            {activeFile?.oldPath ? `${activeFile.oldPath} → ${activePath}` : activePath}
          </span>
          {activeFile ? <FileStatBadge added={activeFile.added} removed={activeFile.removed} /> : null}
        </div>
      ) : null}

      <div className="turn-diff-pane-body">
        {!activePath ? (
          <p className="filepane-diff-empty">本轮没有可展示的文件差异。</p>
        ) : diffState?.status === "loading" && diffState.path === activePath ? (
          <p className="filepane-diff-empty">正在读取本轮代码差异…</p>
        ) : diffState?.status === "error" && diffState.path === activePath ? (
          <p className="filepane-diff-empty turn-diff-pane-error" role="alert">{diffState.message}</p>
        ) : diffState?.status === "ready" && diffState.path === activePath ? (
          <div className="filepane-diff-scroll">
            {diffState.truncated ? <p className="filepane-diff-empty">差异文本较长，已截断展示。</p> : null}
            <ProjectGitDiff text={diffState.text} />
          </div>
        ) : null}
      </div>
    </section>
  )
}

function targetKey(target: RestoreTarget): string {
  return target.target === "guard" ? `guard:${target.guardId}` : target.target
}

/**
 * 代码回退预览与确认弹窗：打开即预览将修改的文件清单，确认后自动留存保护快照再落盘还原。
 */
export function CheckpointRestoreDialog({
  turn,
  running,
  run,
  onClose,
  onRestored,
}: {
  readonly turn: CodeCheckpointTurn
  readonly running: boolean
  readonly run: (action: CodeCheckpointAction) => Promise<CodeCheckpointReply>
  readonly onClose: () => void
  readonly onRestored: () => Promise<void>
}): ReactElement {
  const headingId = useId()
  const runRef = useRef(run)
  runRef.current = run
  const initialTarget: RestoreTarget = !turn.unavailable
    ? { target: "base" }
    : turn.guards[0]
      ? { target: "guard", guardId: turn.guards[0].id }
      : { target: "base" }

  const [selected, setSelected] = useState<RestoreTarget>(initialTarget)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const previewSeq = useRef(0)

  const loadPreview = async (target: RestoreTarget) => {
    const seq = ++previewSeq.current
    setBusy(true)
    setError("")
    setPreview(null)
    try {
      const reply = await runRef.current({
        kind: "preview",
        turnId: turn.turnId,
        target: target.target,
        ...(target.target === "guard" ? { guardId: target.guardId } : {}),
      })
      if (previewSeq.current !== seq) return
      if (reply.kind === "preview") setPreview(reply)
    } catch (err) {
      if (previewSeq.current !== seq) return
      setError(err instanceof Error && err.message ? err.message : "预览还原变更失败。")
    } finally {
      if (previewSeq.current === seq) setBusy(false)
    }
  }

  useEffect(() => {
    void loadPreview(initialTarget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn.turnId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [busy, onClose])

  const targets: readonly { readonly target: RestoreTarget; readonly label: string }[] = [
    ...(!turn.unavailable
      ? [
          { target: { target: "base" as const }, label: "回退到轮前" },
          { target: { target: "post" as const }, label: "恢复到轮后" },
        ]
      : []),
    ...turn.guards.map(guard => ({
      target: { target: "guard" as const, guardId: guard.id },
      label: `保护快照 · ${new Date(guard.createdAtMs).toLocaleTimeString()}`,
    })),
  ]

  const confirmRestore = async () => {
    if (!preview || busy || running || preview.paths.length === 0) return
    setBusy(true)
    setError("")
    try {
      const reply = await runRef.current({ kind: "restore", token: preview.token })
      if (reply.kind !== "restored") return
      if (reply.failure) {
        const applied = reply.paths.length ? `。已更新 ${reply.paths.join("、")}` : ""
        setError(`${reply.failure}${applied}。可从保护快照恢复。`)
        await onRestored()
        return
      }
      await onRestored()
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "还原文件失败。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="turn-restore-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="turn-restore-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="turn-restore-head">
          <h3 id={headingId}>回退第 {turn.ordinal} 轮代码变更？</h3>
          <button
            type="button"
            className="session-plan-zoom-close"
            aria-label="关闭弹窗"
            disabled={busy}
            onClick={onClose}
          >
            <IconX size={16} aria-hidden="true" />
          </button>
        </div>

        <p className="turn-restore-desc">
          仅还原本地工作区文件，不会撤回对话消息；改写前会自动保留一份保护快照以便恢复。
        </p>

        {targets.length > 1 ? (
          <div className="turn-restore-targets" role="group" aria-label="目标快照">
            {targets.map(item => {
              const active = targetKey(item.target) === targetKey(selected)
              return (
                <button
                  key={targetKey(item.target)}
                  type="button"
                  className={`turn-restore-target${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => {
                    setSelected(item.target)
                    void loadPreview(item.target)
                  }}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        ) : null}

        {busy ? <p className="turn-restore-status" role="status">正在比对或写入本机工作区…</p> : null}
        {error ? <p className="turn-restore-error" role="alert">{error}</p> : null}

        {preview ? (
          <div className="turn-restore-preview">
            <p className="turn-restore-preview-label">
              {preview.paths.length > 0
                ? `将改写或删除以下 ${preview.paths.length} 个本机文件：`
                : "当前工作区文件与目标快照一致，无需还原。"}
            </p>
            {preview.paths.length > 0 ? (
              <ul className="turn-restore-files">
                {preview.paths.map(path => <li key={path}>{path}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="turn-restore-foot">
          <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="wb-button wb-button-primary wb-button-small"
            disabled={busy || running || !preview?.paths.length}
            onClick={() => { void confirmRestore() }}
          >
            确认还原文件
          </button>
        </div>
      </div>
    </div>
  )
}
