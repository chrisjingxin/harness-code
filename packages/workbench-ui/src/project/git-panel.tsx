/**
 * 右侧 Git 变更视图：沿用旧列表、Diff 与提交区，由宿主提供快照、个人状态和结果。
 * 组件只派发意图；项目服务负责校验目标、权限、快照及实际写入，回调本身不代表成功。
 */
import { FileDiff, GitBranch, GitCommitHorizontal, RefreshCw, Upload } from "lucide-react"
import { useId, useLayoutEffect, useRef } from "react"
import type { ReactElement } from "react"
import { FileTypeIcon } from "../common/file-type-icon.js"
import { ProjectGitDiff } from "./git-diff.js"
import type { ProjectActionAvailability, ProjectChangedFile, ProjectDockProps } from "./types.js"

/** 受控变更面板；已确认结果和推送重试只使用宿主输入，不自行推断 Git 状态。 */
export function ProjectGitPanel({ scope, availability, changes, gates, personal, actions }: ProjectDockProps): ReactElement {
  const id = useId()
  const allRef = useRef<HTMLInputElement>(null)
  const repository = changes.repository
  const files = repository?.files ?? []
  const selectedByPath = new Map<string, string>(personal.selectedChanges.map(item => [item.path, item.version]))
  const selected = files.filter(file => selectedByPath.get(file.path) === file.version)
  const all = files.length > 0 && selected.length === files.length
  const validSelection = selected.map(file => ({ path: file.path, version: file.version }))

  useLayoutEffect(() => {
    if (allRef.current) allRef.current.indeterminate = selected.length > 0 && !all
  }, [selected.length, all])
  useLayoutEffect(() => {
    if (!repository) {
      if (changes.status === "ready" && personal.selectedChanges.length) actions.setSelectedChanges(scope, [])
      return
    }
    const versions = new Map<string, string>(repository.files.map(file => [file.path, file.version]))
    const retained = personal.selectedChanges.filter(item => versions.get(item.path) === item.version)
    // 在画面可交互前撤销失效选择，避免清理旧选择时覆盖用户随后添加的新选择。
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
    actions.commit(scope, { snapshot: repository.snapshot, paths: selected.map(file => file.path),
      message: personal.commitMessage, alsoPush })
  }
  const selectFile = (file: ProjectChangedFile, checked: boolean): void => {
    const next = validSelection.filter(item => item.path !== file.path)
    if (checked) next.push({ path: file.path, version: file.version })
    actions.setSelectedChanges(scope, next)
  }

  return <section className="project-git-panel" aria-label="Git 变更与提交" aria-busy={changes.busy}>
    <div className="project-git-review">
      <div className="project-git-info"><GitBranch size={14} aria-hidden="true" /><span>{repository?.branch ?? "Git 工作区"}</span>
        <button type="button" className="wb-icon-button" disabled={Boolean(refreshReason)} title={refreshReason ?? "刷新 Git 变更"}
          aria-label="刷新 Git 变更" onClick={() => actions.refreshChanges(scope)}><RefreshCw size={14} aria-hidden="true" /></button>
      </div>
      {changes.freshness === "cached" && repository ? <p className="project-git-notice" role="status">缓存 / 非实时</p> : null}
      {changes.message ? <p className={changes.status === "error" ? "project-git-error" : "project-git-notice"}
        role={changes.status === "error" ? "alert" : "status"}>{changes.message}</p> : null}
      {!repository ? <p className="project-git-empty">{changes.status === "loading" ? "正在读取 Git 状态…" : "打开或刷新变更以检查当前仓库。"}</p> : <>
        <label className="project-git-select-all"><input ref={allRef} type="checkbox" aria-label="全选变更文件" checked={all}
          disabled={!files.length} onChange={() => actions.setSelectedChanges(scope,
            all ? [] : files.map(file => ({ path: file.path, version: file.version })))} />
          <span>全选</span><span className="project-git-selection-count">已选 {selected.length} / {files.length}</span></label>
        <div className="project-git-files" aria-label="变更文件">
          {files.length === 0 ? <p className="project-git-empty">工作区没有待提交的变更。</p> : files.map(file => <div
            className="project-git-file" key={file.path} data-active={diff?.path === file.path}>
            <input type="checkbox" aria-label={`选择 ${file.path}`} checked={selectedByPath.get(file.path) === file.version}
              onChange={event => selectFile(file, event.currentTarget.checked)} />
            <button type="button" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              aria-label={`查看 ${file.path} 的变更`} disabled={Boolean(diffReason) || !repository.snapshot}
              onClick={() => actions.readDiff(scope, repository.snapshot, file.path)}>
              <FileTypeIcon name={file.path.split("/").at(-1) ?? file.path} size={13} />
              <span className="project-git-file-identity"><span className="project-git-file-name">{file.path.split("/").at(-1) ?? file.path}</span>
                <span className="project-git-file-location">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span></span>
              <span className="project-git-file-status">{file.status.trim() === "??" ? "U" : file.status.trim()}</span>
            </button>
          </div>)}
        </div>
        {diff ? <div className="project-git-diff" aria-label={`${diff.path} Diff`}>
          <div className="project-git-diff-title"><FileDiff size={14} aria-hidden="true" />
            <span>{diff.path.split("/").at(-1)}</span><span className="project-git-diff-comparison">工作区 ↔ HEAD</span></div>
          <div className="project-git-diff-path">{diff.path}</div><ProjectGitDiff text={diff.text} />
          {diff.truncated ? <p className="project-git-hint">Diff 已截断，当前只展示部分内容。</p> : null}
        </div> : null}
        {diffReason ? <p className="project-git-hint">查看 Diff：{diffReason}</p> : null}
      </>}
      {changes.busy ? <p className="project-git-hint project-git-progress" role="status">Git 操作进行中…</p> : null}
    </div>
    {repository ? <div className="project-git-commit">
      <label htmlFor={`${id}-message`}>提交说明</label><textarea id={`${id}-message`} value={personal.commitMessage}
        maxLength={8192} placeholder="描述这次修改…" onChange={event => actions.setCommitMessage(scope, event.currentTarget.value)} />
      {repository.upstream ? <p className="project-git-target"><Upload size={12} aria-hidden="true" />
        推送到 {repository.upstream.remote}/{repository.upstream.branch} · 当前 {repository.upstream.ahead} 个未推送提交
        {repository.upstream.behind ? ` · 落后 ${repository.upstream.behind} 个提交` : ""}</p>
        : <p className="project-git-hint">没有可用的推送目标。</p>}
      {commitReason ? <p className="project-git-hint" role="status">提交：{commitReason}</p> : null}
      {pushReason ? <p className="project-git-hint">推送：{pushReason}</p> : null}
      <div className="project-git-commit-actions">
        <button type="button" className="wb-button wb-button-primary" disabled={Boolean(commitReason)} title={commitReason ?? "提交"}
          onClick={() => submit(false)}><GitCommitHorizontal size={16} aria-hidden="true" />提交 {selected.length} 个文件</button>
        <button type="button" className="wb-button wb-button-secondary" disabled={Boolean(commitReason || pushReason)}
          title={commitReason ?? pushReason ?? "提交并推送"} onClick={() => submit(true)}>提交并推送</button>
      </div>
    </div> : null}
    {changes.result ? <div className="project-git-result" role="status">
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
  </section>
}

function disabledReason(gate: ProjectActionAvailability): string | null {
  return gate.enabled ? null : gate.reason || "当前不可用。"
}
