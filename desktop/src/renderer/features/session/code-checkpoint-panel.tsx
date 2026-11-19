/** 本机会话内按轮次呈现快照。主进程提供预览，保存保护快照并核对写入授权。 */
import { useId, useRef, useState } from "react"
import type { CodeCheckpointAction, CodeCheckpointReply } from "../../../shared/local-execution-host.js"
import { ProjectGitDiff } from "../../../ui/project/git-diff.js"

type History = Extract<CodeCheckpointReply, { kind: "history" }>
type Changes = Extract<CodeCheckpointReply, { kind: "changes" }>
type Diff = Extract<CodeCheckpointReply, { kind: "diff" }>
type Preview = Extract<CodeCheckpointReply, { kind: "preview" }>

const statusLabel = { completed: "完成", cancelled: "取消", failed: "失败" }
const button = "wb-button wb-button-secondary wb-button-small"

export function CodeCheckpointPanel({ run, running }: {
  run(action: CodeCheckpointAction): Promise<CodeCheckpointReply>
  running: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useId()
  const [history, setHistory] = useState<History | null>(null)
  const [turnId, setTurnId] = useState("")
  const [changes, setChanges] = useState<Changes | null>(null)
  const [file, setFile] = useState("")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const turn = history?.turns.find(row => row.turnId === turnId)

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError("")
    try { await action() }
    catch (error) { setError(error instanceof Error ? error.message : "轮次快照操作失败。") }
    finally { setBusy(false) }
  }

  async function loadTurn(next: string, source: History) {
    setTurnId(next)
    setChanges(null)
    setDiff(null)
    setFile("")
    setPreview(null)
    const item = source.turns.find(row => row.turnId === next)
    if (!item || item.unavailable) return
    const value = await run({ kind: "changes", turnId: next })
    if (value.kind === "changes") setChanges(value)
  }

  async function refresh(preferred = "") {
    const value = await run({ kind: "history" })
    if (value.kind !== "history") return
    setHistory(value)
    await loadTurn(value.turns.some(row => row.turnId === preferred) ? preferred : value.turns[0]?.turnId ?? "", value)
  }

  function previewRestore(target: "base" | "post" | "guard", guardId?: string) {
    void perform(async () => {
      setResult("")
      setPreview(null)
      const value = await run({ kind: "preview", target, turnId, ...(guardId ? { guardId } : {}) })
      if (value.kind === "preview") setPreview(value)
    })
  }

  return <div className="session-checkpoint">
    <button type="button" className={button} onClick={() => {
      dialog.current?.showModal()
      setResult("")
      void perform(() => refresh())
    }}>轮次代码变更</button>
    <dialog ref={dialog} className="session-checkpoint-dialog" aria-labelledby={heading} onCancel={event => {
      if (busy) event.preventDefault()
    }}>
      <header className="session-checkpoint-head">
        <h3 id={heading}>轮次代码变更</h3>
        <button type="button" className={button} disabled={busy} onClick={() => { void perform(() => refresh(turnId)) }}>刷新</button>
        <button type="button" className={button} disabled={busy} onClick={() => dialog.current?.close()}>关闭</button>
      </header>
      {history?.restoreBlocked && <p>{history.restoreBlocked}</p>}
      {busy && <p role="status">正在读取或应用快照…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <p role="status">{result}</p>}
      {history && history.turns.length === 0 && <p>当前工作目录还没有轮次快照。</p>}
      {history && history.turns.length > 0 && <>
        <label>轮次 <select value={turnId} disabled={busy} onChange={event => {
          const next = event.currentTarget.value
          setResult("")
          void perform(() => loadTurn(next, history))
        }}>
          {history.turns.map(row => <option key={row.turnId} value={row.turnId}>
            第 {row.ordinal} 轮 · {statusLabel[row.status]} · {new Date(row.createdAtMs).toLocaleString()}
          </option>)}
        </select></label>
        {turn?.unavailable && turn.unavailable !== history.restoreBlocked && <p>{turn.unavailable}</p>}
        {changes?.files.length === 0 && <p>本轮没有文件变更。</p>}
        {!!changes?.files.length && <ul className="session-checkpoint-files">
          {changes.files.map(item => <li key={item.path}>
            <button type="button" className={button} aria-pressed={file === item.path} disabled={busy} onClick={() => {
              void perform(async () => {
                setFile(item.path)
                setDiff(null)
                const value = await run({ kind: "diff", turnId, path: item.path })
                if (value.kind === "diff") setDiff(value)
              })
            }}>{item.oldPath ? item.oldPath + " → " : ""}{item.path}
              {item.added === null ? " · 二进制" : " · +" + item.added + " −" + item.removed}
            </button>
          </li>)}
        </ul>}
        {diff && <div className="session-checkpoint-diff">
          {diff.truncated && <p>差异文本已截断。</p>}
          <ProjectGitDiff text={diff.text} />
        </div>}
        {turn && !history.restoreBlocked && <div className="session-checkpoint-buttons">
          {!turn.unavailable && <>
            <button type="button" className={button} disabled={busy || running} onClick={() => previewRestore("base")}>回退到轮前</button>
            <button type="button" className={button} disabled={busy || running} onClick={() => previewRestore("post")}>恢复到轮后</button>
          </>}
          {turn.guards.map(guard => <button type="button" key={guard.id} className={button} disabled={busy || running}
            onClick={() => previewRestore("guard", guard.id)}>保护快照 · {new Date(guard.createdAtMs).toLocaleTimeString()}</button>)}
        </div>}
      </>}
      {preview && <>
        <p>{preview.paths.length ? "将改写或删除以下本机文件" : "当前文件与目标快照一致。"}</p>
        <ul className="session-checkpoint-files">{preview.paths.map(path => <li key={path}>{path}</li>)}</ul>
        <div className="session-checkpoint-buttons">
          <button type="button" className={button} disabled={busy} onClick={() => setPreview(null)}>取消预览</button>
          <button type="button" className="wb-button wb-button-primary wb-button-small" disabled={busy || running || !preview.paths.length}
            onClick={() => { void perform(async () => {
              setPreview(null)
              const value = await run({ kind: "restore", token: preview.token })
              if (value.kind !== "restored") return
              if (value.failure) {
                const applied = value.paths.length ? "。已更新 " + value.paths.join("、") : ""
                setError(value.failure + applied + "。可从保护快照恢复。")
              } else setResult("已更新 " + value.paths.length + " 个本机文件。")
              await refresh(turnId)
            }) }}>确认还原文件</button>
        </div>
      </>}
    </dialog>
  </div>
}
