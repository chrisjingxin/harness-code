/**
 * 创建项目：填写名称与说明 → 提交（同一次填写复用一个 requestId，重复点击或重试不会建出两个项目）
 * → 成功交回新项目标识；失败保留输入并显示原因。
 */
import { useEffect, useRef, useState } from "react"
import type { OrganizationHost } from "../../../organization-host.js"
import { organizationMessage } from "./organization-errors.js"

export function CreateProjectDialog({ host, workspaceId, onClose, onCreated }: {
  host: OrganizationHost
  workspaceId: string
  onClose(): void
  onCreated(projectId: string): void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const requestId = useRef(crypto.randomUUID())
  const dialog = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector("input")?.focus()
    return () => { returnTo?.focus() }
  }, [])
  // 内容改动后视为新的创建意图，换新编号；仅在内容不变的重试中复用。
  const edit = (apply: () => void) => { requestId.current = crypto.randomUUID(); apply() }
  async function submit() {
    if (busy || !name.trim()) return
    setBusy(true); setError("")
    const result = await host.createProject(workspaceId, { name: name.trim(), description: description.trim(), requestId: requestId.current }).catch(() => null)
    setBusy(false)
    if (!result) setError("创建未完成，请重试。")
    else if (!result.ok) setError(organizationMessage(result.error))
    else onCreated(result.value.projectId)
  }
  return <div className="collaboration-modal-backdrop" onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose() } }}>
    <form ref={dialog} className="collaboration-modal pnav-dialog" role="dialog" aria-modal="true" aria-label="创建项目"
      onSubmit={event => { event.preventDefault(); void submit() }}>
      <button type="button" className="collaboration-modal-close" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
      <h2>创建项目</h2>
      <p className="pnav-dialog-hint">先创建协作事项，再设置成员和关联仓库。</p>
      <label>项目名称
        <input value={name} maxLength={80} required placeholder="例如：支付体验优化" onChange={event => edit(() => setName(event.target.value))} />
      </label>
      <label>项目说明
        <textarea value={description} maxLength={2000} rows={4} placeholder="描述目标和需要对齐的内容…" onChange={event => edit(() => setDescription(event.target.value))} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="pnav-dialog-actions">
        <button type="button" className="wb-button wb-button-secondary" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="wb-button wb-button-primary" disabled={busy || !name.trim()}>{busy ? "正在创建…" : "创建并设置"}</button>
      </div>
    </form>
  </div>
}
