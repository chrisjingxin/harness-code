/** 在既有引用预览里关联本人副本；确认结果即时保存，选择动作不改变会话起始目录。 */
import { useEffect, useRef, useState } from "react"
import type { LocalExecutionScope, ProjectMemoryDirectory, WorkbenchContextHost } from "../../../shared/index.js"

export function DirectoryMemory({ scope, host }: { scope: LocalExecutionScope; host: WorkbenchContextHost }) {
  const [entries, setEntries] = useState<readonly ProjectMemoryDirectory[]>([])
  const [selected, select] = useState("")
  const [name, setName] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const key = JSON.stringify(scope)
  useEffect(() => {
    const version = ++generation.current
    setEntries([]); select(""); setName(""); setNotice(""); setBusy(false)
    void host.listDirectories(scope).then(result => {
      if (generation.current !== version) return
      if (result.ok) setEntries(result.value)
      else setNotice(result.error.message)
    }).catch(() => { if (generation.current === version) setNotice("目录记忆暂不可读。") })
    return () => { generation.current++ }
  }, [key, host])
  const entry = entries.find(item => item.entryId === selected)
  async function save(remove = false) {
    const version = generation.current
    setBusy(true); setNotice("")
    try {
      const result = remove && entry
        ? await host.removeDirectory(scope, entry.entryId, entry.entryRevision)
        : await host.confirmDirectory(scope, { name, ...(entry ? { entryId: entry.entryId } : {}), baseEntryRevision: entry?.entryRevision ?? 0 })
      if (generation.current !== version) return
      setNotice(result.ok ? result.value.message : result.error.message)
      const fresh = await host.listDirectories(scope)
      if (generation.current === version && fresh.ok) setEntries(fresh.value)
    } catch { if (generation.current === version) setNotice("本机目录记忆保存失败，请重试。") }
    finally { if (generation.current === version) setBusy(false) }
  }
  return <fieldset className="conversation-reference-targets" disabled={busy}>
    <legend>关联本机工程</legend>
    <p>保存本人副本的目录，当前会话继续使用原起始目录。</p>
    <label>工程记录 <select value={selected} onChange={event => { select(event.target.value); setName(entries.find(item => item.entryId === event.target.value)?.name ?? "") }}>
      <option value="">新增本机副本</option>
      {entries.map(item => <option key={item.entryId} value={item.entryId}>{item.name} · {item.directory}</option>)}
    </select></label>
    <label>工程名称 <input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
    <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={!name.trim()} onClick={() => { void save() }}>{entry ? "重新选择目录" : "关联本机目录"}</button>
    {entry && <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => { void save(true) }}>移除该条记录</button>}
    {notice && <p role="status">{notice}</p>}
  </fieldset>
}
