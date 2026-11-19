/**
 * 右侧 Git 变更与提交历史视图（1:1 还原原型稿 .git-pane）：
 * 支持工作区 / 提交记录子视图切换、路径搜索、M/A/U 状态胶囊筛选、压缩目录树、提交记录展开与 Diff 查看。
 */
import {
  IconChevronRight,
  IconFileDiff,
  IconFolder,
  IconGitBranch,
  IconGitCommit,
  IconList,
  IconListTree,
  IconRefresh,
  IconSearch,
  IconUpload,
  IconX,
} from "@tabler/icons-react"
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReactElement } from "react"
import { FileTypeIcon } from "../common/file-type-icon.js"
import { ProjectGitDiff } from "./git-diff.js"
import type { ProjectActionAvailability, ProjectChangedFile, ProjectDockProps, ProjectGitCommitItem } from "./types.js"

type GitSubView = "changes" | "history"
type GitStatusFilter = "all" | "M" | "A" | "U"
type GitViewMode = "auto" | "tree" | "list"

type GitDirNode = {
  name: string
  path: string
  children: GitDirNode[]
  files: { name: string; file: ProjectChangedFile }[]
  allFiles: ProjectChangedFile[]
}

type GitTreeFlatRow =
  | { kind: "dir"; name: string; path: string; depth: number; open: boolean; allFiles: ProjectChangedFile[] }
  | { kind: "file"; name: string; path: string; depth: number; file: ProjectChangedFile }

/** 受控变更面板；工作区实时变更与产品暂缓状态严格按宿主输入展示。 */
export function ProjectGitPanel({
  scope,
  availability,
  changes,
  gates,
  personal,
  actions,
  gitDeferred,
  gitCommits,
  onOpenDiffInCentral,
}: ProjectDockProps): ReactElement {
  const id = useId()
  const allRef = useRef<HTMLInputElement>(null)
  const [subView, setSubView] = useState<GitSubView>("changes")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<GitStatusFilter>("all")
  const [viewMode, setViewMode] = useState<GitViewMode>("auto")
  const [closedDirs, setClosedDirs] = useState<Record<string, boolean>>({})

  const [logQuery, setLogQuery] = useState("")
  const [logScope, setLogScope] = useState<"all" | "ahead">("all")
  const [openCommit, setOpenCommit] = useState<string | null>(null)
  const [openCommitAll, setOpenCommitAll] = useState<Record<string, boolean>>({})

  const repository = changes.repository
  const files = repository?.files ?? []
  const commits: readonly ProjectGitCommitItem[] = gitCommits ?? []
  const aheadCount = repository?.upstream?.ahead ?? commits.filter(c => c.ahead).length

  const selectedByPath = useMemo(
    () => new Map<string, string>(personal.selectedChanges.map(item => [item.path, item.version])),
    [personal.selectedChanges],
  )
  const selected = files.filter(file => selectedByPath.get(file.path) === file.version)
  const validSelection = selected.map(file => ({ path: file.path, version: file.version }))

  const statusCounts = useMemo(() => {
    const counts = { all: files.length, M: 0, A: 0, U: 0 }
    for (const file of files) {
      const code = normalizeGitStatus(file.status)
      if (code === "M") counts.M += 1
      else if (code === "A") counts.A += 1
      else if (code === "U") counts.U += 1
    }
    return counts
  }, [files])

  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter(file => {
      if (statusFilter !== "all" && normalizeGitStatus(file.status) !== statusFilter) return false
      if (!q) return true
      return file.path.toLowerCase().includes(q) || (file.oldPath ? file.oldPath.toLowerCase().includes(q) : false)
    })
  }, [files, query, statusFilter])

  const filteredCommits = useMemo(() => {
    const q = logQuery.trim().toLowerCase()
    return commits.filter(c => {
      if (logScope === "ahead" && !c.ahead) return false
      if (!q) return true
      const hitFile = (c.files ?? []).some(f => f.path.toLowerCase().includes(q))
      return c.message.toLowerCase().includes(q) || c.sha.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || hitFile
    })
  }, [commits, logQuery, logScope])

  const resolvedView: "tree" | "list" = viewMode === "auto" ? (files.length > 6 ? "tree" : "list") : viewMode
  const treeRows = useMemo(
    () => (resolvedView === "tree" ? flattenGitTree(compressGitTree(buildGitTree(filteredFiles)), 0, [], closedDirs) : []),
    [resolvedView, filteredFiles, closedDirs],
  )

  const filteredAllSelected = filteredFiles.length > 0 && filteredFiles.every(file => selectedByPath.get(file.path) === file.version)
  const filteredSomeSelected = filteredFiles.some(file => selectedByPath.get(file.path) === file.version)

  useLayoutEffect(() => {
    if (allRef.current) allRef.current.indeterminate = filteredSomeSelected && !filteredAllSelected
  }, [filteredSomeSelected, filteredAllSelected])

  useLayoutEffect(() => {
    if (!repository) {
      if (changes.status === "ready" && personal.selectedChanges.length) actions.setSelectedChanges(scope, [])
      return
    }
    const versions = new Map<string, string>(repository.files.map(file => [file.path, file.version]))
    const retained = personal.selectedChanges.filter(item => versions.get(item.path) === item.version)
    if (retained.length !== personal.selectedChanges.length) actions.setSelectedChanges(scope, retained)
  }, [actions, changes.status, personal.selectedChanges, repository, scope])

  const unavailable = availability.state === "available" ? null : availability.message || "当前项目不可用。"
  const busyReason = changes.busy ? "操作进行中，请等待结果。" : null
  const refreshReason = unavailable ?? busyReason ?? disabledReason(gates.refreshChanges)
  const diffReason = unavailable ?? busyReason ?? disabledReason(gates.readDiff)
  const commitReason = unavailable ?? busyReason ?? disabledReason(gates.commit)
    ?? (!repository?.snapshot ? "缺少当前变更快照。" : null)
    ?? (selected.length === 0 ? "请先选择变更文件。" : null)
    ?? (!personal.commitMessage.trim() ? "请填写提交说明。" : null)
    ?? (personal.commitMessage.length > 8192 ? "提交说明不能超过 8192 个字符。" : null)
  const pushReason = unavailable ?? busyReason ?? disabledReason(gates.push)
    ?? (!repository?.snapshot ? "缺少当前变更快照。" : null)
    ?? (!repository?.upstream ? "没有可用的推送目标。" : null)
  const diff = repository && changes.diff?.snapshot === repository.snapshot
    && files.some(file => file.path === changes.diff?.path) ? changes.diff : undefined
  const confirmed = changes.result?.commit === "succeeded" ? changes.result : undefined

  const submit = (alsoPush: boolean): void => {
    if (!repository || commitReason || (alsoPush && pushReason)) return
    actions.commit(scope, {
      snapshot: repository.snapshot,
      paths: selected.map(file => file.path),
      message: personal.commitMessage,
      alsoPush,
    })
  }
  const openDiff = (path: string) => {
    if (!repository) return
    actions.readDiff(scope, repository.snapshot, path)
    onOpenDiffInCentral?.(path, repository.snapshot)
  }
  const selectFile = (file: ProjectChangedFile, checked: boolean): void => {
    const next = validSelection.filter(item => item.path !== file.path)
    if (checked) next.push({ path: file.path, version: file.version })
    actions.setSelectedChanges(scope, next)
  }
  const toggleFilteredAll = (): void => {
    if (filteredFiles.length === files.length) {
      actions.setSelectedChanges(scope, filteredAllSelected ? [] : files.map(file => ({ path: file.path, version: file.version })))
      return
    }
    const filteredPaths = new Set(filteredFiles.map(file => file.path))
    const next = validSelection.filter(item => !filteredPaths.has(item.path))
    if (!filteredAllSelected) {
      for (const file of filteredFiles) next.push({ path: file.path, version: file.version })
    }
    actions.setSelectedChanges(scope, next)
  }
  const toggleDirSelection = (dirFiles: readonly ProjectChangedFile[]): void => {
    const dirPaths = new Set(dirFiles.map(file => file.path))
    const allInDir = dirFiles.length > 0 && dirFiles.every(file => selectedByPath.get(file.path) === file.version)
    const next = validSelection.filter(item => !dirPaths.has(item.path))
    if (!allInDir) {
      for (const file of dirFiles) next.push({ path: file.path, version: file.version })
    }
    actions.setSelectedChanges(scope, next)
  }

  if (!repository) {
    if (changes.status === "loading") {
      return (
        <section className="project-git-panel" aria-label="Git 变更与提交" aria-busy="true">
          <div className="project-git-non-repo">
            <span className="project-git-non-repo-badge" aria-hidden="true">
              <IconGitBranch size={18} />
            </span>
            <h3>正在检测 Git 仓库…</h3>
          </div>
        </section>
      )
    }
    if (changes.status === "error") {
      return (
        <section className="project-git-panel" aria-label="Git 变更与提交" aria-busy={changes.busy}>
          <div className="project-git-non-repo" role="alert">
            <span className="project-git-non-repo-badge is-error" aria-hidden="true">
              <IconGitBranch size={18} />
            </span>
            <h3>暂时无法读取 Git 状态</h3>
            <p>{changes.message || "读取当前目录的 Git 状态失败，请重试。"}</p>
            <button
              type="button"
              className="wb-button wb-button-secondary wb-button-small"
              disabled={Boolean(refreshReason)}
              title={refreshReason ?? "重试检测"}
              onClick={() => actions.refreshChanges(scope)}
            >
              <IconRefresh size={13} aria-hidden="true" />
              <span>重试</span>
            </button>
          </div>
        </section>
      )
    }
    const friendlyMessage = changes.message && !changes.message.includes("不是 Git 仓库")
      ? changes.message
      : "你仍可正常浏览文件、用 @ 引用文件并与 Agent 对话。如需在此查看代码变更与提交记录，可在该目录执行 git init 后点击重新检测。"
    return (
      <section className="project-git-panel" aria-label="Git 变更与提交" aria-busy={changes.busy}>
        <div className="project-git-non-repo">
          <span className="project-git-non-repo-badge" aria-hidden="true">
            <IconGitBranch size={18} />
          </span>
          <h3>当前文件夹未启用 Git</h3>
          <p>{friendlyMessage}</p>
          <button
            type="button"
            className="wb-button wb-button-secondary wb-button-small"
            disabled={Boolean(refreshReason)}
            title={refreshReason ?? "重新检测当前目录是否已初始化 Git"}
            onClick={() => actions.refreshChanges(scope)}
          >
            <IconRefresh size={13} aria-hidden="true" />
            <span>重新检测</span>
          </button>
        </div>
      </section>
    )
  }

  const branchName = repository.branch ?? "未检出分支"

  return <section className="project-git-panel" aria-label="Git 变更与提交" aria-busy={changes.busy}>
    <div className="project-git-top">
      <div className="project-git-info">
        <span className="project-git-branch" title={`当前分支：${branchName}`}>
          <IconGitBranch size={13} aria-hidden="true" />
          <span>{branchName}</span>
        </span>
        {repository?.upstream ? (
          <span className="project-git-ahead" title={`领先远端 ${aheadCount} 个提交`}>↑{aheadCount}</span>
        ) : null}
        <button type="button" className="wb-icon-button" disabled={Boolean(refreshReason)} title={refreshReason ?? "刷新变更与日志"}
          aria-label="刷新 Git 变更" onClick={() => actions.refreshChanges(scope)}><IconRefresh size={14} aria-hidden="true" /></button>
      </div>

      {/* 子视图分段切换：工作区 vs 提交记录 */}
      <div className="seg project-git-seg" role="tablist" aria-label="变更面板子视图">
        <button
          type="button"
          role="tab"
          className={subView === "changes" ? "is-active" : undefined}
          aria-selected={subView === "changes"}
          onClick={() => setSubView("changes")}
        >
          <span>工作区</span>
          <span className="gs-pill">{files.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          className={subView === "history" ? "is-active" : undefined}
          aria-selected={subView === "history"}
          onClick={() => setSubView("history")}
        >
          <span>提交记录</span>
          <span className="gs-pill">{aheadCount > 0 ? `↑${aheadCount}` : commits.length}</span>
        </button>
      </div>

      {subView === "changes" && repository && files.length > 0 ? (
        <div className="project-git-toolbar">
          <div className="project-git-search-row">
            <div className="project-git-search-box">
              <IconSearch size={13} aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={event => setQuery(event.currentTarget.value)}
                placeholder="筛选文件路径…"
                aria-label="筛选变更文件"
              />
              {query ? (
                <button type="button" className="project-git-search-clear" aria-label="清空筛选" onClick={() => setQuery("")}>
                  <IconX size={12} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="project-git-view-seg" role="group" aria-label="变更展示方式">
              <button type="button" className={`project-git-view-btn${resolvedView === "tree" ? " is-active" : ""}`}
                onClick={() => setViewMode("tree")} aria-label="目录树视图" title="目录树（按目录分组）">
                <IconListTree size={13} aria-hidden="true" />
              </button>
              <button type="button" className={`project-git-view-btn${resolvedView === "list" ? " is-active" : ""}`}
                onClick={() => setViewMode("list")} aria-label="平铺列表视图" title="平铺列表">
                <IconList size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="project-git-chip-row" role="group" aria-label="按变更类型筛选">
            {([
              ["all", "全部"],
              ["M", "M 修改"],
              ["A", "A 新增"],
              ["U", "U 未跟踪"],
            ] as const).map(([key, label]) => (
              <button key={key} type="button" className={`project-git-chip${statusFilter === key ? " is-active" : ""}`}
                onClick={() => setStatusFilter(key)}>
                {label} {statusCounts[key]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {subView === "history" && (
        <div className="project-git-toolbar">
          <div className="project-git-search-box">
            <IconSearch size={13} aria-hidden="true" />
            <input
              type="text"
              value={logQuery}
              onChange={event => setLogQuery(event.currentTarget.value)}
              placeholder="搜索提交信息、Hash、作者…"
              aria-label="搜索提交记录"
            />
            {logQuery ? (
              <button type="button" className="project-git-search-clear" aria-label="清空搜索" onClick={() => setLogQuery("")}>
                <IconX size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <div className="project-git-chip-row" role="group" aria-label="提交范围">
            <button type="button" className={`project-git-chip${logScope === "all" ? " is-active" : ""}`} onClick={() => setLogScope("all")}>
              全部 {commits.length}
            </button>
            <button type="button" className={`project-git-chip${logScope === "ahead" ? " is-active" : ""}`} onClick={() => setLogScope("ahead")}>
              仅未推送 ↑{aheadCount}
            </button>
          </div>
        </div>
      )}
    </div>

    {subView === "changes" ? (
      <>
        {repository && files.length > 0 ? (
          <div className="project-git-select-all">
            <label className="project-git-select-label">
              <input ref={allRef} type="checkbox" aria-label="全选变更文件" checked={filteredAllSelected}
                disabled={!filteredFiles.length} onChange={toggleFilteredAll} />
              <span>{filteredFiles.length === files.length ? "全选" : "全选筛选结果"}</span>
            </label>
            <span className="project-git-selection-count">已选 {selected.length} / {files.length}</span>
            {selected.length > 0 ? (
              <button type="button" className="project-git-sel-clear" onClick={() => actions.setSelectedChanges(scope, [])}>清空</button>
            ) : null}
          </div>
        ) : null}

        <div className="project-git-review">
          {changes.freshness === "cached" && repository ? <p className="project-git-notice" role="status">缓存 / 非实时</p> : null}
          {changes.message ? <p className={changes.status === "error" ? "project-git-error" : "project-git-notice"}
            role={changes.status === "error" ? "alert" : "status"}>{changes.message}</p> : null}
          {!repository ? <p className="project-git-empty">{changes.status === "loading" ? "正在读取 Git 状态…" : "当前目录不是 Git 仓库或暂无变更。"}</p> : <>
            <div className="project-git-files" aria-label="变更文件">
              {files.length === 0 ? (
                <p className="project-git-empty">工作区与 HEAD 一致，没有未提交变更。</p>
              ) : filteredFiles.length === 0 ? (
                <p className="project-git-empty">没有匹配当前筛选条件的文件。</p>
              ) : resolvedView === "tree" ? (
                <div className="project-git-tree" role="tree" aria-label="变更文件目录树">
                  {treeRows.map(row => {
                    if (row.kind === "dir") {
                      const dirAllChecked = row.allFiles.length > 0 && row.allFiles.every(file => selectedByPath.get(file.path) === file.version)
                      const dirSomeChecked = row.allFiles.some(file => selectedByPath.get(file.path) === file.version)
                      return (
                        <div key={`dir:${row.path}`} className="project-git-tree-row" role="treeitem"
                          aria-level={row.depth + 1} aria-expanded={row.open} style={{ paddingInlineStart: 2 + row.depth * 10 }}>
                          <button type="button" className={`project-git-caret${row.open ? " is-open" : ""}`}
                            aria-label={`${row.open ? "折叠" : "展开"} ${row.name}`}
                            onClick={() => setClosedDirs(prev => ({ ...prev, [row.path]: row.open }))}>
                            <IconChevronRight size={12} aria-hidden="true" />
                          </button>
                          <DirCheckbox checked={dirAllChecked} indeterminate={dirSomeChecked && !dirAllChecked}
                            label={`选择目录 ${row.name}`} onChange={() => toggleDirSelection(row.allFiles)} />
                          <button type="button" className="project-git-tree-btn" title={`${row.path}（${row.allFiles.length} 个文件）`}
                            onClick={() => setClosedDirs(prev => ({ ...prev, [row.path]: row.open }))}>
                            <IconFolder size={13} aria-hidden="true" />
                            <span className="project-git-tree-name project-git-dir-name">{row.name}</span>
                            <span className="project-git-dir-count">{row.allFiles.length}</span>
                          </button>
                        </div>
                      )
                    }
                    const file = row.file
                    const code = normalizeGitStatus(file.status)
                    const active = diff?.path === file.path
                    return (
                      <div key={file.path} className={`project-git-tree-row project-git-file${active ? " is-active" : ""}`}
                        data-active={active} role="treeitem" aria-level={row.depth + 1} aria-selected={active}
                        style={{ paddingInlineStart: 2 + row.depth * 10 }}>
                        <span className="project-git-caret is-leaf" aria-hidden="true" />
                        <input type="checkbox" aria-label={`选择 ${file.path}`}
                          checked={selectedByPath.get(file.path) === file.version}
                          onChange={event => selectFile(file, event.currentTarget.checked)} />
                        <button type="button" className="project-git-tree-btn"
                          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          aria-label={`查看 ${file.path} 的变更`}
                          disabled={Boolean(diffReason) || !repository.snapshot}
                          onClick={() => openDiff(file.path)}>
                          <FileTypeIcon name={row.name} size={13} />
                          <span className="project-git-tree-name">{row.name}</span>
                          <span className={`project-git-file-status is-${statusTone(code)}`}>{code}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                filteredFiles.map(file => {
                  const code = normalizeGitStatus(file.status)
                  const active = diff?.path === file.path
                  return <div className="project-git-file" key={file.path} data-active={active}>
                    <input type="checkbox" aria-label={`选择 ${file.path}`} checked={selectedByPath.get(file.path) === file.version}
                      onChange={event => selectFile(file, event.currentTarget.checked)} />
                    <button type="button" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                      aria-label={`查看 ${file.path} 的变更`} disabled={Boolean(diffReason) || !repository.snapshot}
                      onClick={() => openDiff(file.path)}>
                      <FileTypeIcon name={file.path.split("/").at(-1) ?? file.path} size={13} />
                      <span className="project-git-file-identity"><span className="project-git-file-name">{file.path.split("/").at(-1) ?? file.path}</span>
                        <span className="project-git-file-location">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span></span>
                      <span className={`project-git-file-status is-${statusTone(code)}`}>{code}</span>
                    </button>
                  </div>
                })
              )}
            </div>

            {!onOpenDiffInCentral && diff ? <div className="project-git-diff" aria-label={`${diff.path} Diff`}>
              <div className="project-git-diff-title"><IconFileDiff size={14} aria-hidden="true" />
                <span>{diff.path.split("/").at(-1)}</span><span className="project-git-diff-comparison">工作区 ↔ HEAD</span></div>
              <div className="project-git-diff-path">{diff.path}</div><ProjectGitDiff text={diff.text} />
              {diff.truncated ? <p className="project-git-hint">Diff 已截断，当前只展示部分内容。</p> : null}
            </div> : null}
            {diffReason ? <p className="project-git-hint">查看 Diff：{diffReason}</p> : null}
          </>}
          {changes.busy ? <p className="project-git-hint project-git-progress" role="status">Git 操作进行中…</p> : null}
        </div>

        {/* 底部提交区：正式工作台当前暂缓写操作，按原型稿渲染 .git-note；预览/完整模式渲染提交区 */}
        {gitDeferred ? (
          <div className="git-note">
            <label className="gn-label" htmlFor={`${id}-deferred-msg`}>提交说明</label>
            <input id={`${id}-deferred-msg`} type="text" placeholder="暂缓：当前不支持提交" disabled />
            <div className="gn-actions">
              <button type="button" className="btn btn-secondary btn-sm" disabled>提交</button>
              <button type="button" className="btn btn-secondary btn-sm" disabled>推送</button>
            </div>
            <p className="gn-help">产品 Git 提交与推送暂缓，可点击上方变更文件在中央分屏查看 Diff。</p>
          </div>
        ) : repository ? <div className="project-git-commit">
          <label htmlFor={`${id}-message`}>提交说明</label><textarea id={`${id}-message`} value={personal.commitMessage}
            maxLength={8192} placeholder="描述这次修改…" onChange={event => actions.setCommitMessage(scope, event.currentTarget.value)} />
          {repository.upstream ? <p className="project-git-target"><IconUpload size={12} aria-hidden="true" />
            推送到 {repository.upstream.remote}/{repository.upstream.branch} · 当前 {repository.upstream.ahead} 个未推送提交
            {repository.upstream.behind ? ` · 落后 ${repository.upstream.behind} 个提交` : ""}</p>
            : <p className="project-git-hint">没有可用的推送目标。</p>}
          {commitReason ? <p className="project-git-hint" role="status">提交：{commitReason}</p> : null}
          {pushReason ? <p className="project-git-hint">推送：{pushReason}</p> : null}
          <div className="project-git-commit-actions">
            <button type="button" className="wb-button wb-button-primary" disabled={Boolean(commitReason)} title={commitReason ?? "提交"}
              onClick={() => submit(false)}><IconGitCommit size={15} aria-hidden="true" />提交 {selected.length} 个文件</button>
            <button type="button" className="wb-button wb-button-secondary" disabled={Boolean(commitReason || pushReason)}
              title={commitReason ?? pushReason ?? "提交并推送"} onClick={() => submit(true)}>提交并推送</button>
          </div>
        </div> : null}

        {!gitDeferred && changes.result ? <div className="project-git-result" role="status">
          {changes.result.commit === "succeeded" ? <>
            <p>已提交 <code>{changes.result.commitSha}</code></p>
            {changes.result.push === "succeeded" ? <p>已推送</p> : null}
            {changes.result.push === "failed" ? <p className="project-git-error">推送失败</p> : null}
            {changes.result.push === "unknown" ? <p className="project-git-warning">推送结果待确认</p> : null}
            {changes.result.push === "not-requested" ? <p>尚未请求推送</p> : null}
            {changes.result.warning ? <p className="project-git-warning">{changes.result.warning}</p> : null}
            {changes.result.message ? <p>{changes.result.message}</p> : null}
            {confirmed && confirmed.push !== "succeeded" && confirmed.push !== "unknown" && repository
              && repository.head === confirmed.commitSha && repository.upstream ? <button type="button" className="wb-button wb-button-secondary wb-button-small"
                disabled={Boolean(pushReason)} title={pushReason ?? "推送已提交内容"}
                onClick={() => actions.push(scope, { snapshot: repository.snapshot, commitSha: confirmed.commitSha })}>
                {confirmed.push === "failed" ? "重试推送" : "推送已提交内容"}</button> : null}
          </> : <>
            <p className={changes.result.commit === "failed" ? "project-git-error" : "project-git-warning"}>
              {changes.result.commit === "failed" ? "提交失败" : "提交结果待确认"}：{changes.result.message}</p>
            {changes.result.push === "unknown" ? <p className="project-git-warning">推送结果待确认</p> : null}
            {changes.result.warning ? <p className="project-git-warning">{changes.result.warning}</p> : null}
          </>}
        </div> : null}
      </>
    ) : (
      /* 提交记录子视图（.git-log） */
      <>
        <div className="project-git-review" style={{ padding: "8px 10px 14px" }}>
          {commits.length === 0 ? (
            <p className="project-git-empty">
              {repository
                ? "当前宿主（LocalDirectoryHost）尚未提供 Git 提交历史查询端口（gitLog），暂只支持实时工作区变更与单文件 Diff。"
                : "当前目录不是 Git 仓库，暂无提交记录。"}
            </p>
          ) : filteredCommits.length === 0 ? (
            <p className="project-git-empty">没有匹配当前过滤条件的提交。</p>
          ) : (
            <div className="git-log">
              {filteredCommits.map((c, idx) => {
                const isOpen = openCommit === c.sha
                const cFiles = c.files ?? []
                const showAll = !!openCommitAll[c.sha]
                const shownFiles = showAll ? cFiles : cFiles.slice(0, 6)
                const hiddenCount = cFiles.length - shownFiles.length
                const showBaseline = idx > 0 && filteredCommits[idx - 1]?.ahead && !c.ahead
                const itemCls = `gl-item${idx === 0 ? " is-first" : ""}${idx === filteredCommits.length - 1 ? " is-last" : ""}${c.ahead ? " is-ahead" : ""}`
                return (
                  <div key={c.sha}>
                    {showBaseline && (
                      <div className="git-baseline" role="separator">
                        <span>以上待推送 · origin/{branchName}</span>
                      </div>
                    )}
                    <div className={itemCls}>
                      <button
                        type="button"
                        className={`gl-btn${isOpen ? " is-open" : ""}`}
                        aria-expanded={isOpen}
                        onClick={() => setOpenCommit(isOpen ? null : c.sha)}
                      >
                        <span className="gl-dot" aria-hidden="true" />
                        <span className="gl-main">
                          <span className="gl-msg">{c.message}</span>
                          <span className="gl-meta">
                            <span className="gl-sha">{c.sha}</span>
                            {c.head ? <span className="gl-head-tag">HEAD</span> : null}
                            <span>{c.author}</span>
                            <span>·</span>
                            <span>{c.timeLabel}</span>
                            <span style={{ marginLeft: "auto" }}>{cFiles.length} 个文件</span>
                          </span>
                        </span>
                      </button>
                      {isOpen && cFiles.length > 0 && (
                        <div className="gl-files">
                          {shownFiles.map(cf => {
                            const fn = cf.path.split("/").at(-1) ?? cf.path
                            const dir = cf.path.slice(0, Math.max(0, cf.path.length - fn.length)).replace(/\/+$/, "")
                            const code = normalizeGitStatus(cf.status)
                            return (
                              <button
                                key={cf.path}
                                type="button"
                                className="gl-file"
                                title={cf.path}
                                onClick={() => openDiff(cf.path)}
                              >
                                <span className="gl-fn">{fn}</span>
                                <span className="gl-fp">{dir}</span>
                                <span className={`project-git-file-status is-${statusTone(code)}`}>{code}</span>
                              </button>
                            )
                          })}
                          {hiddenCount > 0 && (
                            <button type="button" className="gl-more" onClick={() => setOpenCommitAll(prev => ({ ...prev, [c.sha]: true }))}>
                              展开全部 {cFiles.length} 个文件（还有 {hiddenCount} 个）
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="git-hist-foot">
          <IconGitBranch size={12} aria-hidden="true" />
          <span className="gh-branch">origin/{branchName}</span>
          <span>{aheadCount ? `领先 ${aheadCount} 个提交` : "已同步"}</span>
        </div>
      </>
    )}
  </section>
}

function DirCheckbox({ checked, indeterminate, label, onChange }: {
  checked: boolean
  indeterminate: boolean
  label: string
  onChange: () => void
}): ReactElement {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={onChange} />
}

function disabledReason(gate: ProjectActionAvailability): string | null {
  return gate.enabled ? null : gate.reason || "当前不可用。"
}

function normalizeGitStatus(raw: string): string {
  const trimmed = raw.trim()
  return trimmed === "??" ? "U" : trimmed || "M"
}

function statusTone(code: string): "a" | "u" | "m" {
  if (code === "A") return "a"
  if (code === "U") return "u"
  return "m"
}

function buildGitTree(files: readonly ProjectChangedFile[]): GitDirNode {
  const root: GitDirNode = { name: "", path: "", children: [], files: [], allFiles: [] }
  for (const file of files) {
    const parts = file.path.split("/")
    let node = root
    let acc = ""
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!
      acc = acc ? `${acc}/${seg}` : seg
      let next = node.children.find(child => child.path === acc)
      if (!next) {
        next = { name: seg, path: acc, children: [], files: [], allFiles: [] }
        node.children.push(next)
      }
      node = next
    }
    node.files.push({ name: parts.at(-1) ?? file.path, file })
  }
  return root
}

function compressGitTree(node: GitDirNode): GitDirNode {
  node.children = node.children.map(child => {
    let cur = child
    while (cur.children.length === 1 && cur.files.length === 0) {
      const only = cur.children[0]!
      cur = {
        name: `${cur.name}/${only.name}`,
        path: only.path,
        children: only.children,
        files: only.files,
        allFiles: [],
      }
    }
    return compressGitTree(cur)
  })
  const allFiles = node.files.map(item => item.file)
  for (const child of node.children) allFiles.push(...child.allFiles)
  node.allFiles = allFiles
  return node
}

function flattenGitTree(
  node: GitDirNode,
  depth: number,
  out: GitTreeFlatRow[],
  closedDirs: Record<string, boolean>,
): GitTreeFlatRow[] {
  for (const child of node.children) {
    const open = closedDirs[child.path] !== true
    out.push({ kind: "dir", name: child.name, path: child.path, depth, open, allFiles: child.allFiles })
    if (open) flattenGitTree(child, depth + 1, out, closedDirs)
  }
  for (const leaf of node.files) {
    out.push({ kind: "file", name: leaf.name, path: leaf.file.path, depth, file: leaf.file })
  }
  return out
}
