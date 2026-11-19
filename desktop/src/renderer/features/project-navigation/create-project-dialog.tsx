/**
 * 新建 Project 弹窗（1:1 还原原型稿 #dlgProject）：
 * 填写名称与说明 + 可选勾选 Workspace 初始成员，提交后创建项目并自动邀请选中成员。
 */
import { useEffect, useRef, useState } from "react"
import { IconX } from "@tabler/icons-react"
import type { MemberSummary } from "@workbench/collaboration-client/types"
import type { OrganizationHost } from "../../../shared/index.js"
import { memberRoleLabel, UserAvatar } from "../collaboration-views/index.js"
import { organizationMessage } from "./organization-errors.js"

export function CreateProjectDialog({
  host,
  workspaceId,
  workspaceName,
  teamMembers,
  selfUserId,
  onClose,
  onCreated,
}: {
  host: OrganizationHost
  workspaceId: string
  workspaceName?: string
  teamMembers?: readonly MemberSummary[]
  selfUserId?: string
  onClose(): void
  onCreated(projectId: string): void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [selectedMembers, setSelectedMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const requestId = useRef(crypto.randomUUID())
  const dialog = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLInputElement>("#projName")?.focus()
    return () => { returnTo?.focus() }
  }, [])

  const edit = (apply: () => void) => {
    requestId.current = crypto.randomUUID()
    apply()
  }

  const toggleMember = (userId: string) => {
    setSelectedMembers(prev => (prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]))
  }

  async function submit() {
    if (busy) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError("请填写项目名称，之后可以在项目资料里改。")
      dialog.current?.querySelector<HTMLInputElement>("#projName")?.focus()
      return
    }
    setBusy(true)
    setError("")
    const result = await host.createProject(workspaceId, {
      name: trimmed,
      description: description.trim(),
      requestId: requestId.current,
    }).catch(() => null)
    if (!result) {
      setBusy(false)
      setError("创建未完成，请重试。")
      return
    }
    if (!result.ok) {
      setBusy(false)
      setError(organizationMessage(result.error))
      return
    }
    const projectId = result.value.projectId
    // 顺序添加已勾选的初始成员；单个失败不阻断项目创建本身
    for (const userId of selectedMembers) {
      if (userId === selfUserId) continue
      await host.addMember(workspaceId, projectId, { userId, requestId: crypto.randomUUID() }).catch(() => null)
    }
    setBusy(false)
    onCreated(projectId)
  }

  const selfUser = teamMembers?.find(m => m.user.id === selfUserId)?.user

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}
      onKeyDown={event => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose() } }}
    >
      <form
        ref={dialog}
        className="dlg pnav-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlgProjectTitle"
        noValidate
        onSubmit={event => { event.preventDefault(); void submit() }}
      >
        <div className="dlg-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h2 id="dlgProjectTitle">新建 Project</h2>
            <p className="dlg-sub">{workspaceName ? `会创建在「${workspaceName}」下` : "在当前 Workspace 下创建协作事项"}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            style={{ marginLeft: "auto" }}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="dlg-body">
          <div className="fld">
            <label htmlFor="projName">项目名称<span className="req" aria-hidden="true">*</span></label>
            <input
              id="projName"
              type="text"
              value={name}
              maxLength={80}
              required
              placeholder="例如：结账台拆分支付重构"
              onChange={event => { setError(""); edit(() => setName(event.target.value)) }}
            />
            {error && <p className="err" role="alert">{error}</p>}
          </div>

          <div className="fld">
            <label htmlFor="projDesc">项目说明</label>
            <textarea
              id="projDesc"
              value={description}
              maxLength={2000}
              rows={3}
              placeholder="简述项目目标、负责模块或协作边界（可选）"
              onChange={event => edit(() => setDescription(event.target.value))}
            />
          </div>

          {teamMembers && teamMembers.length > 0 && (
            <div className="fld">
              <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>从当前 Workspace 勾选成员</span>
              <p className="help">创建者{selfUser ? ` ${selfUser.userName} ` : ""}默认是项目管理员，不可取消。</p>
              <div style={{ maxHeight: 168, overflowY: "auto" }}>
                {teamMembers.map(item => {
                  const u = item.user
                  const isMe = u.id === selfUserId
                  const checked = isMe || selectedMembers.includes(u.id)
                  return (
                    <label key={u.id} className="member-pick">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isMe || busy}
                        onChange={() => toggleMember(u.id)}
                      />
                      <UserAvatar user={u} size={22} self={isMe} />
                      <span className="mp-name">
                        {u.userName}
                        {isMe ? <span className="meta"> (管理员)</span> : null}
                      </span>
                      <span className="mp-role">{memberRoleLabel(u)}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          <p className="meta" style={{ fontSize: "var(--text-xs)" }}>
            关联仓库可在创建后于「Project 资料与成员」中绑定 Workspace 下已有仓库。
          </p>
        </div>

        <div className="dlg-foot">
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? "正在创建…" : "创建并进入"}
          </button>
        </div>
      </form>
    </div>
  )
}
