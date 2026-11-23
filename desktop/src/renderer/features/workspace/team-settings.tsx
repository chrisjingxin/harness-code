/** 团队设置消费真实角色与交接预览；先读完完整清单，再明确确认新增阅读权和提交。 */
import { useEffect, useRef, useState } from "react"
import type { CollaborationHost, MemberSummary, RepositorySummary, WorkspaceSummary, WorkspaceRemovalPreview, WorkspaceRemovalItem, WorkspaceMemberRemovalRequest, WorkspaceRole } from "@workbench/collaboration-client/types"
import type { OrganizationHost } from "../../../shared/index.js"
import "./team-settings.css"

type Props = { host: CollaborationHost; organization: OrganizationHost; workspace: WorkspaceSummary; accountId: string }
/** 不读取他人的会话正文或本机目录；列表中的责任来自服务端完整预览。 */
export function TeamSettings({ host, organization, workspace, accountId }: Props) {
  const [members, setMembers] = useState<MemberSummary[]>([])
  const [repositories, setRepositories] = useState<RepositorySummary[]>([])
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [userNo, setUserNo] = useState("")
  const [target, setTarget] = useState<MemberSummary | null>(null)
  const [revision, setRevision] = useState(0)
  const [name, setName] = useState("")
  const [remoteUrl, setRemoteUrl] = useState("")
  const active = useRef(0)
  const admin = workspace.role === "admin"
  const admins = members.filter(m => m.status === "active" && m.enabled && m.role === "admin").length
  useEffect(() => {
    const version = ++active.current
    setReady(false); setNotice(""); setTarget(null)
    void host.refreshIdentity().then(() => Promise.all([host.listMembers(workspace.id), organization.listRepositories(workspace.id)]))
      .then(([list, repos]) => {
        if (active.current !== version) return
        if (!list.ok || !repos.ok) { setNotice(!list.ok ? list.error.message : !repos.ok ? repos.error.message : "无法读取团队设置。"); return }
        setMembers(list.value.members); setRepositories(repos.value.repositories); setReady(true)
      }).catch(() => { if (active.current === version) setNotice("团队设置暂时无法读取，请重试。") })
    return () => { active.current++ }
  }, [host, organization, workspace.id, workspace.accessVersion, revision])
  useEffect(() => { if (!admin) setTarget(null) }, [admin])
  async function change(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) {
    if (busy) return
    const version = active.current
    setBusy(true); setNotice("")
    try {
      const result = await action()
      if (version !== active.current) return
      if (!result.ok) setNotice(result.error.message)
      else { setTarget(null); setRevision(v => v + 1) }
    } catch { if (version === active.current) setNotice("操作未确认，请刷新后重试。") }
    finally { setBusy(false) }
  }
  const candidates = members.filter(m => m.status === "active" && m.enabled)
  const displayName = (id: string) => members.find(m => m.user.id === id)?.user.userName ?? "成员"
  return <section className="team-settings" aria-labelledby="team-settings-title">
    <div className="identity-actions"><h2 id="team-settings-title">团队设置 · {workspace.name}</h2>
      <button className="wb-button wb-button-secondary" disabled={busy} onClick={() => setRevision(v => v + 1)}>刷新团队</button></div>
    <p>{admin ? "管理员可管理成员、角色与仓库负责人。" : "开发者可查看团队成员与知识。团队知识由管理员发布，可联系管理员维护。"}</p>
    {notice && <p className="error" role="alert">{notice}</p>}
    {!ready ? <p role="status">{notice ? "团队设置未能读取。" : "正在读取团队设置…"}</p> : <>
      {admin && <form className="identity-actions" onSubmit={event => { event.preventDefault(); void change(() => host.addWorkspaceMember(workspace.id, { userNo: userNo.trim(), requestId: crypto.randomUUID() })) }}>
        <label>成员工号<input aria-label="成员工号" value={userNo} onChange={e => setUserNo(e.target.value)} disabled={busy} /></label>
        <button className="wb-button wb-button-secondary" disabled={busy || !userNo.trim()}>添加开发者</button>
      </form>}
      <table className="team-settings-table"><thead><tr><th>成员</th><th>角色</th><th>状态</th>{admin && <th>操作</th>}</tr></thead><tbody>
        {members.map(m => {
          const last = m.role === "admin" && m.status === "active" && m.enabled && admins === 1
          return <tr key={m.user.id}><td>{m.user.userName}{m.user.id === accountId ? "（本人）" : ""}<small>{m.user.userNo}</small></td>
            <td>{admin && m.status === "active" && m.enabled ? <select aria-label={`${m.user.userName}的团队角色`} value={m.role} disabled={busy || last} title={last ? "团队至少需要一名有效管理员" : undefined}
              onChange={e => { const role = e.target.value; if (role !== "admin" && role !== "developer") return; void change(() => host.changeWorkspaceRole(workspace.id, m.user.id, { role, expectedVersion: m.version, requestId: crypto.randomUUID() })) }}>
              <option value="admin">管理员</option><option value="developer">开发者</option></select> : m.role === "admin" ? "管理员" : "开发者"}</td>
            <td>{m.status === "removed" ? "原成员已离开" : !m.enabled ? "账号已停用" : "在册"}{last && <small>最后一名有效管理员</small>}</td>
            {admin && <td>{m.status === "active" && <button className="wb-button wb-button-quiet" disabled={busy || last} title={last ? "请先设置另一名管理员" : undefined} onClick={() => setTarget(m)}>移除与交接</button>}</td>}</tr>
        })}</tbody></table>
      <h3>团队仓库</h3>
      <p>负责人是团队内的协作职责，不改变 Git 仓库访问权限。</p>
      {admin && <form className="identity-actions" onSubmit={event => { event.preventDefault(); void change(() => organization.createRepository(workspace.id, { name: name.trim(), remoteUrl: remoteUrl.trim(), requestId: crypto.randomUUID() })) }}>
        <label>仓库名称<input aria-label="仓库名称" value={name} onChange={e => setName(e.target.value)} /></label>
        <label>远端地址<input aria-label="仓库远端地址" value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} /></label>
        <button className="wb-button wb-button-secondary" disabled={busy || !name.trim() || !remoteUrl.trim()}>登记仓库</button></form>}
      {repositories.length ? <ul className="team-repositories">{repositories.map(r => <li key={r.repositoryId}><span>{r.name}{r.status === "archived" ? "（已归档）" : ""}</span>
        {admin && r.status === "active" ? <select aria-label={`${r.name}的负责人`} value={r.ownerUserId ?? ""} disabled={busy} onChange={e => { const ownerUserId = e.target.value || null; void change(() => organization.updateRepository(workspace.id, r.repositoryId, { ownerUserId, expectedVersion: r.version })) }}>
          <option value="">待认领</option>{candidates.map(m => <option key={m.user.id} value={m.user.id}>{m.user.userName}</option>)}</select> : <span>{r.ownerUserId ? displayName(r.ownerUserId) : "待认领"}</span>}</li>)}</ul> : <p>尚未登记仓库。</p>}
    </>}
    {target && admin && <RemovalDialog key={`${target.user.id}:${workspace.accessVersion}`} {...{ host, workspace, members, target }} onClose={() => setTarget(null)} onRemoved={() => { setTarget(null); setRevision(v => v + 1) }} />}
  </section>
}

function itemName(item: WorkspaceRemovalItem) { return item.kind === "task" ? item.title : item.name }
function archived(item: WorkspaceRemovalItem) { return item.kind === "task" ? item.archived : item.status === "archived" }
function itemId(item: WorkspaceRemovalItem) { return item.kind === "task" ? item.taskId : item.kind === "project" ? item.projectId : item.repositoryId }

/** 预览变化必须重新读取；新 Project 阅读权逐项确认，失败不先从名单删除成员。 */
function RemovalDialog({ host, workspace, members, target, onClose, onRemoved }: Pick<Props, "host" | "workspace"> & { members: MemberSummary[]; target: MemberSummary; onClose(): void; onRemoved(): void }) {
  const [preview, setPreview] = useState<WorkspaceRemovalPreview | null>(null)
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [successor, setSuccessor] = useState("")
  const [projects, setProjects] = useState<Record<string, string>>({})
  const [tasks, setTasks] = useState<Record<string, string>>({})
  const [repositories, setRepositories] = useState<Record<string, string | null>>({})
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [accept, setAccept] = useState(false)
  const replay = useRef<{ signature: string; requestId: string } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(true)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let current = true
    setPreview(null); setNotice(""); setConfirmed(new Set()); setAccept(false)
    void (async () => {
      let next: string | null = null, first: WorkspaceRemovalPreview | null = null
      const items: WorkspaceRemovalItem[] = [], seen = new Set<string>()
      do {
        const result = await host.previewWorkspaceRemoval(workspace.id, target.user.id, next, first?.previewVersion)
        if (!current) return
        if (!result.ok) throw Error(result.error.message)
        if (result.value.workspaceId !== workspace.id || result.value.targetMember.user.id !== target.user.id || first && first.previewVersion !== result.value.previewVersion) throw Error("交接清单已变化，请重新读取。")
        first ??= result.value
        items.push(...result.value.items); next = result.value.nextAfterId
        if (next && seen.has(next)) throw Error("交接分页未能完整读取。")
        if (next) seen.add(next)
      } while (next)
      if (current && first) setPreview({ ...first, items, nextAfterId: null })
    })().catch(error => { if (current) setNotice(error instanceof Error ? error.message : "交接清单未能读取。") })
    return () => { current = false }
  }, [host, workspace.id, target.user.id, attempt])
  const candidates = members.filter(m => m.enabled && m.status === "active" && m.user.id !== target.user.id)
  const name = (id: string) => members.find(m => m.user.id === id)?.user.userName ?? "成员"
  const creatorProjects = new Set(preview?.items.flatMap(i => i.kind === "task" && !i.archived && i.duties.includes("creator") ? [i.projectId] : []))
  const needsOwner = (item: WorkspaceRemovalItem) => item.kind === "project" && item.status === "active" && (item.targetIsOwner || creatorProjects.has(item.projectId) && !preview?.projectEligibility.find(p => p.projectId === item.projectId)?.activeSuccessorUserIds.includes(item.ownerUserId))
  const required: { projectId: string; userId: string }[] = []
  let incomplete = false
  for (const item of preview?.items ?? []) {
    if (archived(item)) continue
    if (item.kind === "project" && needsOwner(item)) { const userId = projects[item.projectId] ?? successor; if (!userId) incomplete = true; else required.push({ projectId: item.projectId, userId }) }
    if (item.kind === "task" && item.duties.includes("assignee")) { const userId = tasks[item.taskId] ?? successor; if (!userId) incomplete = true; else required.push({ projectId: item.projectId, userId }) }
  }
  const additions = required.filter((p, i) => required.findIndex(v => v.projectId === p.projectId && v.userId === p.userId) === i && !preview?.projectEligibility.find(v => v.projectId === p.projectId)?.activeSuccessorUserIds.includes(p.userId))
  const additionKey = (p: { projectId: string; userId: string }) => `${p.projectId}:${p.userId}`
  async function submit() {
    if (!preview || busy || !accept || incomplete || additions.some(p => !confirmed.has(additionKey(p)))) return
    const choice = { expectedMemberVersion: preview.targetMember.version, previewVersion: preview.previewVersion, defaultSuccessorUserId: successor || null,
      projectSuccessors: Object.entries(projects).map(([projectId, userId]) => ({ projectId, userId })), taskSuccessors: Object.entries(tasks).map(([taskId, userId]) => ({ taskId, userId })), repositorySuccessors: Object.entries(repositories).map(([repositoryId, userId]) => ({ repositoryId, userId })), addToProjects: additions, confirmResetTasks: true as const, confirmRetainHistory: true as const }
    const signature = JSON.stringify(choice)
    if (replay.current?.signature !== signature) replay.current = { signature, requestId: crypto.randomUUID() }
    const request: WorkspaceMemberRemovalRequest = { ...choice, requestId: replay.current.requestId }
    setBusy(true); setNotice("")
    try {
      const result = await host.removeWorkspaceMember(workspace.id, target.user.id, request)
      if (!mounted.current) return
      if (result.ok) onRemoved()
      else {
        setNotice(result.error.message)
        if (["HANDOFF_PREVIEW_STALE", "VERSION_CONFLICT"].includes(result.error.code)) setPreview(null)
      }
    } catch { if (mounted.current) setNotice("提交结果未确认，可按原选择重试。") }
    finally { if (mounted.current) setBusy(false) }
  }
  function assignment(item: WorkspaceRemovalItem) {
    const id = itemId(item), repo = item.kind === "repository"
    if (archived(item) || item.kind === "project" && !needsOwner(item) || item.kind === "task" && !item.duties.includes("assignee")) return null
    const choices = repo ? repositories : item.kind === "task" ? tasks : projects
    const value = Object.hasOwn(choices, id) ? choices[id] ?? "$unclaimed" : "$default"
    return <select aria-label={`${itemName(item)}的接手人`} value={value} disabled={busy} onChange={e => {
      const value = e.target.value
      if (repo) setRepositories(old => { const next = { ...old }; if (value === "$default") delete next[id]; else next[id] = value === "$unclaimed" ? null : value; return next })
      else (item.kind === "task" ? setTasks : setProjects)(old => { const next = { ...old }; if (value === "$default") delete next[id]; else next[id] = value; return next })
    }}><option value="$default">使用默认接手人</option>{repo && <option value="$unclaimed">待认领</option>}{candidates.map(m => <option key={m.user.id} value={m.user.id}>{m.user.userName}</option>)}</select>
  }
  return <dialog ref={dialog} className="team-removal-dialog" aria-labelledby="team-removal-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id="team-removal-title">移除与交接 · {target.user.userName}</h2>
    <p>移除会撤销团队访问权。历史会话、知识与贡献保留原作者，不能收回已同步内容，也不会转交他人的 Agent 执行权。</p>
    {notice && <p className="error" role="alert">{notice}</p>}
    {!preview ? <><p role="status">{notice ? "交接清单未能确认。" : "正在读取全部交接清单…"}</p><button className="wb-button wb-button-secondary" disabled={busy} onClick={() => setAttempt(v => v + 1)}>重新读取清单</button></> : <>
      <p>已读完全部清单：任务 {preview.counts.tasks}、项目 {preview.counts.projects}、仓库 {preview.counts.repositories}；已发布会话 {preview.counts.sharedConversations}。</p>
      <label>默认接手人<select aria-label="默认接手人" value={successor} disabled={busy} onChange={e => setSuccessor(e.target.value)}><option value="">请选择（仓库可待认领）</option>{candidates.map(m => <option key={m.user.id} value={m.user.id}>{m.user.userName}</option>)}</select></label>
      {(["project", "task", "repository"] as const).map(kind => <div key={kind}><h3>{kind === "project" ? "项目与成员身份" : kind === "task" ? "未完结任务" : "仓库负责人"}</h3>
        <ul className="team-handoff-items">{preview.items.filter(i => i.kind === kind).map(i => <li key={itemId(i)}><span>{itemName(i)}{archived(i) ? " · 已归档，保留历史" : ""}{i.kind === "task" && !i.archived && <small>{i.duties.includes("assignee") ? "执行交接后回到待接收，原会话保留只读" : "原作者保留，验收由有效项目负责人代管"}</small>}{i.kind === "project" && <small>{needsOwner(i) ? "必须指定新的项目负责人" : "移除原成员的项目访问权"}</small>}</span>{assignment(i)}</li>)}</ul></div>)}
      {additions.length > 0 && <div><h3>确认新增项目阅读权</h3>{additions.map(p => <label className="team-confirm" key={additionKey(p)}><input type="checkbox" checked={confirmed.has(additionKey(p))} disabled={busy} onChange={e => setConfirmed(old => { const next = new Set(old); e.target.checked ? next.add(additionKey(p)) : next.delete(additionKey(p)); return next })} />将 {name(p.userId)} 加入“{preview.items.find(i => i.kind === "project" && i.projectId === p.projectId) && preview.items.filter(i => i.kind === "project" && i.projectId === p.projectId).map(itemName)[0]}”，可读取该项目已共享内容</label>)}</div>}
      <label className="team-confirm"><input type="checkbox" checked={accept} disabled={busy} onChange={e => setAccept(e.target.checked)} />我已核对交接清单，确认执行中的任务回到待接收，历史产出保留只读。</label>
      {incomplete && <p role="status">仍有任务或项目未选择接手人。</p>}
    </>}
    <div className="identity-actions"><button className="wb-button wb-button-secondary" disabled={busy} onClick={onClose}>取消</button><button className="wb-button wb-button-primary" disabled={!preview || busy || !accept || incomplete || additions.some(p => !confirmed.has(additionKey(p))) || target.role === "admin" && target.enabled && preview.effectiveAdminCount <= 1} onClick={() => void submit()}>{busy ? "正在交接…" : "确认交接并移除"}</button></div>
  </dialog>
}
