/**
 * 项目资料页：概况、成员、关联仓库。所有人可读；只有服务端返回 role = owner 且项目未归档时才显示管理操作。
 * 每个操作是独立请求，结果分别反馈；失败保留输入并说明原因，成功后重新读取详情，以服务端结果为准。
 */
import { useState } from "react"
import type { CollaborationResult, MemberSummary, ProjectDetailResponse } from "@workbench/contracts"
import { MemberAvatar } from "@workbench/ui"
import type { NavigationAvailability } from "@workbench/ui"
import type { OrganizationHost } from "../../../organization-host.js"
import { resolveUserPhoto } from "../../demo-avatars.js"
import { organizationMessage } from "./organization-errors.js"
import { useRepositories } from "./use-organization.js"

type Section = "overview" | "members" | "repositories"
type Notice = { section: Section; tone: "error" | "status"; text: string }

export function ProjectInfoPage({ host, workspaceId, detail, availability, team, selfUserId, justCreated, onChanged, onRetry }: {
  host: OrganizationHost
  workspaceId: string
  detail: ProjectDetailResponse | null
  availability: NavigationAvailability
  team: readonly MemberSummary[]
  selfUserId: string
  justCreated: boolean
  /** 资料已改动：重新读取详情与项目列表。 */
  onChanged(): void
  onRetry(): void
}) {
  const project = detail?.project
  const archived = project?.status === "archived"
  const manage = project?.role === "owner" && !archived
  const repositories = useRepositories(host, workspaceId, manage)
  const [notice, setNotice] = useState<Notice | null>(justCreated ? { section: "overview", tone: "status", text: "项目已创建，可以继续添加成员和关联仓库。" } : null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null)
  const [candidate, setCandidate] = useState("")
  const [repository, setRepository] = useState("")

  if (!detail || !project) {
    return <section className="pnav-page" aria-label="项目资料">
      <p role={availability.state === "failed" ? "alert" : "status"} className="pnav-page-status">
        {availability.state === "failed" ? availability.message ?? "无法读取项目资料。" : "正在读取项目资料…"}
      </p>
      {availability.state === "failed" && <button className="wb-button wb-button-secondary wb-button-small" onClick={onRetry}>重试</button>}
    </section>
  }

  const names = new Map(team.map(item => [item.user.id, item.user]))
  const nameOf = (userId: string) => names.get(userId)?.userName ?? `成员 ${userId.slice(0, 8)}`
  const metaOf = (userId: string) => {
    const user = names.get(userId)
    if (!user) return ""
    return user.orgName ? `${user.userNo} · ${user.orgName}` : user.userNo
  }
  const active = detail.members.filter(member => member.status === "active")
  const candidates = team.filter(item => !active.some(member => member.userId === item.user.id))
  const linkable = repositories.repositories.filter(item => item.status === "active" && !detail.repositories.some(linked => linked.repositoryId === item.repositoryId))

  /** 统一执行一个管理请求：成功提示并刷新；失败显示原因，冲突或失效时也刷新以展示最新事实。 */
  async function run<T>(section: Section, request: () => Promise<CollaborationResult<T>>, success: string, after?: () => void) {
    if (busy) return
    setBusy(true); setNotice(null)
    const result = await request().catch(() => null)
    setBusy(false)
    if (!result) { setNotice({ section, tone: "error", text: "操作未完成，请重试。" }); return }
    if (!result.ok) {
      setNotice({ section, tone: "error", text: organizationMessage(result.error) })
      if (["VERSION_CONFLICT", "PROJECT_OWNER_REQUIRED", "PROJECT_ARCHIVED", "RESOURCE_NOT_FOUND"].includes(result.error.code)) onChanged()
      return
    }
    after?.()
    setNotice({ section, tone: "status", text: success })
    onChanged()
  }
  const message = (section: Section) => notice?.section === section
    ? <p className={notice.tone === "error" ? "error" : "pnav-page-note"} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p> : null

  return <section className="pnav-page" aria-label="项目资料">
    <div className="pnav-page-content">
      <header className="pnav-page-heading">
        <div>
          <h1>{project.name}</h1>
          <p>{nameOf(project.ownerUserId)}创建 · {project.memberCount} 位成员</p>
        </div>
        {archived ? <span className="pnav-tag">项目已归档</span> : manage && !editing &&
          <button className="wb-button wb-button-secondary wb-button-small" onClick={() => setEditing({ name: project.name, description: project.description })}>编辑资料</button>}
      </header>

      <section className="pnav-section" aria-label="项目说明">
        <h2>项目说明</h2>
        {editing ? <form className="pnav-form" onSubmit={event => {
          event.preventDefault()
          void run("overview", () => host.updateProject(workspaceId, project.projectId, {
            name: editing.name.trim(), description: editing.description.trim(), expectedVersion: project.version,
          }), "资料已保存。", () => setEditing(null))
        }}>
          <label>项目名称<input value={editing.name} maxLength={80} required onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
          <label>项目说明<textarea value={editing.description} maxLength={2000} rows={4} onChange={event => setEditing({ ...editing, description: event.target.value })} /></label>
          <div className="pnav-form-actions">
            <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={busy} onClick={() => { setEditing(null); setNotice(null) }}>取消</button>
            <button type="submit" className="wb-button wb-button-primary wb-button-small" disabled={busy || !editing.name.trim()}>保存</button>
          </div>
        </form> : <p>{project.description || "暂无说明。"}</p>}
        {message("overview")}
      </section>

      <section className="pnav-section" aria-label="项目成员">
        <h2>项目成员</h2>
        <ul className="pnav-list">
          {active.map(member => <li key={member.userId}>
            <MemberAvatar initial={nameOf(member.userId).slice(0, 1)} photo={resolveUserPhoto(names.get(member.userId))} self={member.userId === selfUserId} />
            <span className="pnav-list-copy">
              <strong>{nameOf(member.userId)}</strong>
              {metaOf(member.userId) && <small>{metaOf(member.userId)}</small>}
            </span>
            {member.userId === project.ownerUserId && <span className="pnav-tag">项目负责人</span>}
            {manage && member.userId !== project.ownerUserId &&
              <button className="wb-button wb-button-quiet wb-button-small" disabled={busy}
                onClick={() => { void run("members", () => host.removeMember(workspaceId, project.projectId, member.userId), `已移出${nameOf(member.userId)}。`) }}>移出</button>}
          </li>)}
        </ul>
        {manage && <div className="pnav-form-row">
          <select aria-label="选择要添加的团队成员" value={candidate} disabled={busy || !candidates.length} onChange={event => setCandidate(event.target.value)}>
            <option value="">{candidates.length ? "选择团队成员" : "团队成员都已加入"}</option>
            {candidates.map(item => <option key={item.user.id} value={item.user.id}>{item.user.userName}（{item.user.userNo}{item.user.orgName ? ` · ${item.user.orgName}` : ""}）</option>)}
          </select>
          <button className="wb-button wb-button-secondary wb-button-small" disabled={busy || !candidate}
            onClick={() => { void run("members", () => host.addMember(workspaceId, project.projectId, { userId: candidate, requestId: crypto.randomUUID() }), `已添加${nameOf(candidate)}。`, () => setCandidate("")) }}>添加</button>
        </div>}
        {message("members")}
      </section>

      <section className="pnav-section" aria-label="关联仓库">
        <h2>关联仓库</h2>
        {detail.repositories.length ? <ul className="pnav-list">
          {detail.repositories.map(item => <li key={item.repositoryId}>
            <span className="pnav-list-copy"><strong>{item.name}</strong><small>团队仓库 · {item.defaultBranch}</small></span>
            {item.status === "archived" && <span className="pnav-tag">已归档</span>}
            {manage && <button className="wb-button wb-button-quiet wb-button-small" disabled={busy}
              onClick={() => { void run("repositories", () => host.unlinkRepository(workspaceId, project.projectId, item.repositoryId), `已取消关联 ${item.name}。`) }}>取消关联</button>}
          </li>)}
        </ul> : <p className="pnav-page-note">未关联仓库。</p>}
        {manage && <div className="pnav-form-row">
          <select aria-label="选择要关联的团队仓库" value={repository} disabled={busy || !linkable.length} onChange={event => setRepository(event.target.value)}>
            <option value="">{repositories.availability.state === "loading" ? "正在读取团队仓库…" : linkable.length ? "选择团队仓库" : "没有可关联的仓库"}</option>
            {linkable.map(item => <option key={item.repositoryId} value={item.repositoryId}>{item.name}</option>)}
          </select>
          <button className="wb-button wb-button-secondary wb-button-small" disabled={busy || !repository}
            onClick={() => { void run("repositories", () => host.linkRepository(workspaceId, project.projectId, repository), "仓库已关联。", () => setRepository("")) }}>关联</button>
        </div>}
        {repositories.availability.state === "failed" && manage && <p className="error" role="alert">{repositories.availability.message}
          <button className="wb-button wb-button-quiet wb-button-small" onClick={() => { void repositories.reload() }}>重试</button></p>}
        {message("repositories")}
      </section>
    </div>
  </section>
}
