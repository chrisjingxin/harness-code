/** 右侧 Git 工作台：选择与输入是本地表现状态，所有读写经 WebIntent 交给共享 Core。 */
/** @jsxImportSource react */
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { FileCode2, FileDiff, GitBranch, GitCommitHorizontal, RefreshCw, Upload } from "lucide-react"
import { parseFileDiff } from "../../../presentation-shared/file-diff"
import { gitWriteBlockedReason } from "../../../interactive/selectors"
import type { WebAdapterSnapshot, WebIntent } from "../../application/adapter"

/** 显示真实仓库事实、文件 Diff 与提交/推送的分离结果。 */
export function GitPanel({snapshot,dispatch,disabled=false}: {snapshot:WebAdapterSnapshot;dispatch:(intent:WebIntent)=>void;disabled?:boolean}): React.ReactElement {
  const git=snapshot.interactive.git, repository=git.repository
  const [selection,setSelection]=useState<Record<string,string>>({}), [message,setMessage]=useState("")
  const allRef=useRef<HTMLInputElement>(null), resultRef=useRef(git.result?.sha)
  const files=repository?.files ?? [], selected=files.filter(file=>selection[file.path]===file.fingerprint)
  const all=files.length>0 && selected.length===files.length
  useEffect(()=>{
    setSelection(previous=>Object.fromEntries(files.filter(file=>previous[file.path]===file.fingerprint).map(file=>[file.path,file.fingerprint])))
  },[repository?.snapshot])
  useEffect(()=>{if(allRef.current) allRef.current.indeterminate=selected.length>0&&!all},[selected.length,all])
  useEffect(()=>{
    if(git.result?.sha && resultRef.current!==git.result.sha) {setMessage("");setSelection({})}
    resultRef.current=git.result?.sha
  },[git.result?.sha])
  const locked=disabled||git.busy
  const reason=gitWriteBlockedReason(snapshot.interactive)||repository?.blockedReason
  const canCommit=!locked&&!reason&&Boolean(repository)&&selected.length>0&&Boolean(message.trim())
  const commit=(push:boolean)=>{if(canCommit&&repository) dispatch({type:"git.commit",snapshot:repository.snapshot,paths:selected.map(file=>file.path),message,push})}
  return <section className="git-panel" aria-label="Git 变更与提交" aria-busy={git.busy}>
    <div className="git-review">
    <div className="git-info"><GitBranch size={14} aria-hidden="true" /><span>{repository?.branch ?? "Git 工作区"}</span><button type="button" className="icon-button" disabled={locked} aria-label="刷新 Git 变更" onClick={()=>dispatch({type:"git.refresh"})}><RefreshCw size={14} aria-hidden="true" /></button></div>
    {git.error ? <p className="git-error" role="alert">{git.error}</p> : null}
    {!repository ? <p className="panel-empty">{git.busy?"正在读取 Git 状态…":"打开或刷新变更以检查当前仓库。"}</p> : <>
      <label className="git-select-all"><input ref={allRef} type="checkbox" aria-label="全选变更文件" checked={all} disabled={locked||!files.length} onChange={()=>setSelection(all?{}:Object.fromEntries(files.map(file=>[file.path,file.fingerprint])))} /><span>全选</span><span className="git-selection-count">已选 {selected.length} / {files.length}</span></label>
      <div className="git-files" aria-label="变更文件">
        {files.length===0 ? <p className="panel-empty">工作区没有待提交的变更。</p> : files.map(file=><div className="git-file" key={file.path} data-active={git.diff?.path===file.path}>
          <input type="checkbox" data-file-check aria-label={`选择 ${file.path}`} checked={selection[file.path]===file.fingerprint} disabled={locked} onChange={event=>{const checked=event.currentTarget.checked;setSelection(previous=>{const next={...previous};if(checked) next[file.path]=file.fingerprint;else delete next[file.path];return next})}} />
          <button type="button" title={file.oldPath?`${file.oldPath} → ${file.path}`:file.path} aria-label={`查看 ${file.path} 的变更`} disabled={locked} onClick={()=>dispatch({type:"git.diff",snapshot:repository.snapshot,path:file.path})}><FileCode2 size={13} aria-hidden="true" /><span className="git-file-path">{file.path.split("/").pop()}</span><span className="git-file-status">{file.status.trim()==="??"?"U":file.status.trim()}</span></button>
        </div>)}
      </div>
      {git.diff ? <div className="git-diff" aria-label={`${git.diff.path} Diff`}><div className="git-diff-title"><FileDiff size={14} aria-hidden="true" /><span>{git.diff.path.split("/").pop()}</span><span className="git-diff-comparison">工作区 ↔ HEAD</span></div><div className="git-diff-path">{git.diff.path.includes("/") ? git.diff.path.slice(0,git.diff.path.lastIndexOf("/")+1) : "工作区根目录"}</div><GitDiffContent text={git.diff.text} />{git.diff.truncated?<p className="git-hint">Diff 已截断；提交包含所选文件完整内容。</p>:null}</div> : null}
    </>}
    {git.busy?<p className="git-hint git-progress" role="status">Git 操作进行中…</p>:null}
    </div>
    {repository ? <div className="git-commit">
        <label htmlFor="git-commit-message">提交说明</label><textarea id="git-commit-message" value={message} maxLength={8192} disabled={locked} placeholder="描述这次修改…" onInput={event=>setMessage(event.currentTarget.value)} />
        <p className="git-hint">提交勾选文件的当前完整内容；其他文件的暂存状态保留。</p>
        {repository.upstream ? <p className="git-target"><Upload size={12} aria-hidden="true" />推送到 {repository.upstream.remote}/{repository.upstream.branch} · 当前 {repository.upstream.ahead} 个未推送提交{repository.upstream.behind?` · 落后 ${repository.upstream.behind} 个提交`:""}</p> : <p className="git-hint">尚无可用 upstream；可提交，请在终端配置推送目标。</p>}
        {reason?<p className="git-hint" role="status">{reason}</p>:null}
        {repository.upstream?<p className="git-hint">推送会发送当前分支的全部未推送提交。</p>:null}
        <div className="git-commit-actions"><button type="button" className="button button-primary" disabled={!canCommit} onClick={()=>commit(false)}><GitCommitHorizontal size={16} aria-hidden="true" />提交 {selected.length} 个文件</button><button type="button" className="button button-secondary" disabled={!canCommit||!repository.upstream} onClick={()=>commit(true)}>提交并推送</button></div>
      </div> : null}
    {git.result?<div className="git-result" role="status"><p>已提交 <code>{git.result.sha.slice(0,12)}</code>{git.result.pushed?" · 已推送":""}</p>{git.result.warning?<p>{git.result.warning}</p>:null}{git.result.pushError?<p className="git-error">推送失败：{git.result.pushError}</p>:null}{!git.result.pushed&&repository?.head===git.result.sha&&repository.upstream?<button type="button" className="button button-secondary" disabled={locked||Boolean(reason)} onClick={()=>dispatch({type:"git.push",snapshot:repository.snapshot,head:git.result!.sha})}>{git.result.pushError?"重试推送":"推送已提交内容"}</button>:null}</div>:null}
  </section>
}

/** 复用统一 diff 解析器呈现真实行号；二进制或非标准输出保持原文可见。 */
function GitDiffContent({ text }: { text: string }): React.ReactElement {
  const parsed = useMemo(() => {
    const start = text.search(/^@@ /m)
    return start < 0 ? null : parseFileDiff(text.slice(start))
  }, [text])
  if (!parsed || parsed.status !== "parsed" || !parsed.hunks.length) return <pre className="git-diff-fallback">{text}</pre>
  return <>
    <div className="git-diff-lines">
      {parsed.hunks.map((hunk, index) => <Fragment key={index}>
        <div className="git-line-hunk">{hunk.header}</div>
        {hunk.lines.map((line, row) => <div key={row} className={`git-diff-line git-line-${line.kind}`}>
          <span className="git-line-number" aria-hidden="true">{line.newLine ?? line.oldLine}</span>
          <span className="git-line-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
          <span className="git-line-text">{line.text || " "}</span>
        </div>)}
      </Fragment>)}
    </div>
    <details className="git-diff-raw"><summary>查看原始 Diff</summary><pre>{text}</pre></details>
  </>
}
