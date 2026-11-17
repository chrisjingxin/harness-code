/**
 * Project 资料与成员页（1:1 还原原型稿 viewProject）：
 * 顶部 .page-head + 双栏 .info-grid（左栏「项目资料」与关联仓库，右栏「成员 · X 人」）。
 * 只有服务端返回 role = owner 且项目未归档时才展示编辑与成员/仓库管理操作，严格消费真实 OrganizationHost。
 */
import { useState } from "react"
import type { CollaborationResult, MemberSummary, ProjectDetailResponse } from "@workbench/contracts"
import { MemberAvatar } from "@workbench/ui"
import type { NavigationAvailability } from "@workbench/ui"
import type { OrganizationHost } from "../../../organization-host.js"
import { resolveUserPhoto } from "../../demo-avatars.js"
import { memberRoleLabel } from "../collaboration-views/index.js"
import { organizationMessage } from "./organization-errors.js"
import { useRepositories } from "./use-organization.js"

type Section = "overview" | "members" | "repositories"
type Notice = { section: Section; tone: "error" | "status"; text: string }

export function ProjectInfoPage({
  host,
  workspaceId,
  workspaceName,
  detail,
  availability,
  team,
  selfUserId,
  justCreated,
  sessionCount,
  taskCount,
  knowledgeCount,
  onChanged,
  onRetry,
}: {
  host: OrganizationHost
  workspaceId: string
  workspaceName?: string
  detail: ProjectDetailResponse | null
  availability: NavigationAvailability
  team: readonly MemberSummary[]
  selfUserId: string
  justCreated: boolean
  sessionCount?: number
  taskCount?: number
  knowledgeCount?: number
  /** 资料已改动：重新读取详情与项目列表。 */
  onChanged(): void
  onRetry(): void
}) {
  const project = detail?.project
  const archived = project?.status === "archived"
  const manage = project?.role === "owner" && !archived
  const repositories = useRepositories(host, workspaceId, manage)
  const [notice, setNotice] = useState<Notice | null>(
    justCreated ? { section: "overview", tone: "status", text: "项目已创建，可以继续添加成员和关联仓库。" } : null,
  )
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null)
  const [candidate, setCandidate] = useState("")
  const [repository, setRepository] = useState("")

  if (!detail || !project) {
    return (
      <section className="pnav-page" aria-label="项目资料">
        <div className="pnav-empty-block">
          <p role={availability.state === "failed" ? "alert" : "status"} className="pnav-page-status">
            {availability.state === "failed" ? availability.message ?? "无法读取项目资料。" : "正在读取项目资料…"}
          </p>
          {availability.state === "failed" && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>重试</button>
          )}
        </div>
      </section>
    )
  }

  const names = new Map(team.map(item => [item.user.id, item.user]))
  const nameOf = (userId: string) => names.get(userId)?.userName ?? `成员 ${userId.slice(0, 8)}`
  const roleOf = (userId: string) => {
    const user = names.get(userId)
    if (!user) return "研发成员"
    const role = memberRoleLabel(user)
    return user.userNo ? `${role} · ${user.userNo}` : role
  }
  const active = detail.members.filter(member => member.status === "active")
  const candidates = team.filter(item => !active.some(member => member.userId === item.user.id))
  const linkable = repositories.repositories.filter(
    item => item.status === "active" && !detail.repositories.some(linked => linked.repositoryId === item.repositoryId),
  )

  async function run<T>(section: Section, request: () => Promise<CollaborationResult<T>>, success: string, after?: () => void) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    const result = await request().catch(() => null)
    setBusy(false)
    if (!result) {
      setNotice({ section, tone: "error", text: "操作未完成，请重试。" })
      return
    }
    if (!result.ok) {
      setNotice({ section, tone: "error", text: organizationMessage(result.error) })
      if (["VERSION_CONFLICT", "PROJECT_OWNER_REQUIRED", "PROJECT_ARCHIVED", "RESOURCE_NOT_FOUND"].includes(result.error.code)) {
        onChanged()
      }
      return
    }
    after?.()
    setNotice({ section, tone: "status", text: success })
    onChanged()
  }

  const message = (section: Section) => notice?.section === section
    ? <p className={notice.tone === "error" ? "error" : "pnav-page-note"} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>
    : null

  const repoDisplay = detail.repositories.length
    ? detail.repositories.map(item => item.name).join("、")
    : "未关联"

  return (
    <section className="pnav-page" aria-label="项目资料">
      <div className="pnav-page-content">
        <div className="page-head">
          <div className="od-stack" style={{ ["--od-gap" as string]: "2px" }}>
            <h1>Project 资料与成员</h1>
            <span className="sub">{workspaceName ? `${workspaceName} / ` : ""}{project.name}</span>
          </div>
          <span className="spacer" />
          {archived ? (
            <span className="status-badge">项目已归档</span>
          ) : manage && !editing ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setEditing({ name: project.name, description: project.description })}
            >
              编辑资料与成员
            </button>
          ) : null}
        </div>

        <div className="info-grid">
          <div className="pnav-info-col">
            <section className="panel" aria-label="项目资料">
              <div className="panel-head">
                <h2>项目资料</h2>
              </div>
              {editing ? (
                <form
                  className="pnav-form"
                  onSubmit={event => {
                    event.preventDefault()
                    void run("overview", () => host.updateProject(workspaceId, project.projectId, {
                      name: editing.name.trim(),
                      description: editing.description.trim(),
                      expectedVersion: project.version,
                    }), "已更新 Project 资料。", () => setEditing(null))
                  }}
                >
                  <div className="fld">
                    <label htmlFor="peName">项目名<span className="req" aria-hidden="true">*</span></label>
                    <input
                      id="peName"
                      type="text"
                      value={editing.name}
                      maxLength={80}
                      required
                      onChange={event => setEditing({ ...editing, name: event.target.value })}
                    />
                  </div>
                  <div className="fld">
                    <label htmlFor="peDesc">项目说明</label>
                    <textarea
                      id="peDesc"
                      value={editing.description}
                      maxLength={2000}
                      rows={4}
                      placeholder="简述项目目标、负责模块或协作边界"
                      onChange={event => setEditing({ ...editing, description: event.target.value })}
                    />
                  </div>
                  <div className="od-cluster" style={{ paddingTop: 4 }}>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !editing.name.trim()}>保存资料</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(null); setNotice(null) }}>取消</button>
                  </div>
                </form>
              ) : (
                <>
                  <dl className="kv">
                    <dt>项目名</dt><dd>{project.name}</dd>
                    <dt>项目说明</dt><dd style={{ color: "var(--fg-2)", lineHeight: 1.65 }}>{project.description || "暂无项目说明，可点击右上角编辑补充。"}</dd>
                    {workspaceName && <><dt>所属</dt><dd>{workspaceName}</dd></>}
                    <dt>仓库</dt><dd className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>{repoDisplay}</dd>
                    <dt>负责人</dt><dd>{nameOf(project.ownerUserId)}</dd>
                    <dt>状态</dt><dd><span className={`status-badge ${archived ? "" : "running"}`}>{archived ? "已归档" : "进行中"}</span></dd>
                  </dl>
                  <div className="stat-row">
                    <div className="stat">
                      <span className="n">{sessionCount ?? 0}</span>
                      <span className="l">我的会话</span>
                    </div>
                    <div className="stat">
                      <span className="n">{taskCount ?? 0}</span>
                      <span className="l">任务</span>
                    </div>
                    <div className="stat">
                      <span className="n">{knowledgeCount ?? 0}</span>
                      <span className="l">项目知识</span>
                    </div>
                  </div>
                </>
              )}
              {message("overview")}
            </section>

            <section className="panel" aria-label="关联仓库">
              <div className="panel-head">
                <h2>关联仓库 · {detail.repositories.length}</h2>
              </div>
              {detail.repositories.length ? (
                <ul className="pnav-list">
                  {detail.repositories.map(item => (
                    <li key={item.repositoryId}>
                      <span className="pnav-list-copy">
                        <strong>{item.name}</strong>
                        <small className="mono">团队仓库 · {item.defaultBranch}</small>
                      </span>
                      {item.status === "archived" && <span className="role-tag">已归档</span>}
                      {manage && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => { void run("repositories", () => host.unlinkRepository(workspaceId, project.projectId, item.repositoryId), `已取消关联 ${item.name}。`) }}
                        >
                          取消关联
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="meta">当前尚未关联团队仓库。</p>
              )}
              {manage && (
                <div className="pnav-form-row">
                  <select aria-label="选择要关联的团队仓库" value={repository} disabled={busy || !linkable.length} onChange={event => setRepository(event.target.value)}>
                    <option value="">{repositories.availability.state === "loading" ? "正在读取团队仓库…" : linkable.length ? "选择团队仓库" : "没有可关联的仓库"}</option>
                    {linkable.map(item => <option key={item.repositoryId} value={item.repositoryId}>{item.name}</option>)}
                  </select>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !repository}
                    onClick={() => { void run("repositories", () => host.linkRepository(workspaceId, project.projectId, repository), "仓库已关联。", () => setRepository("")) }}
                  >
                    关联
                  </button>
                </div>
              )}
              {repositories.availability.state === "failed" && manage && (
                <p className="error" role="alert">
                  {repositories.availability.message}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void repositories.reload() }}>重试</button>
                </p>
              )}
              {message("repositories")}
            </section>
          </div>

          <div className="pnav-info-col">
            <section className="panel" aria-label="项目成员">
              <div className="panel-head">
                <h2>成员 · {active.length} 人</h2>
              </div>
              <div>
                {active.map(member => (
                  <div className="member-row" key={member.userId}>
                    <MemberAvatar initial={nameOf(member.userId).slice(0, 1)} photo={resolveUserPhoto(names.get(member.userId))} self={member.userId === selfUserId} size={30} />
                    <span style={{ display: "flex", flexDirection: "column", gap: 0, minWidth: 0, flex: "1 1 0" }}>
                      <span className="m-name od-truncate">{nameOf(member.userId)}</span>
                      <span className="m-role">{roleOf(member.userId)}</span>
                    </span>
                    {member.userId === project.ownerUserId && <span className="role-tag">管理员</span>}
                    {manage && member.userId !== project.ownerUserId && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => { void run("members", () => host.removeMember(workspaceId, project.projectId, member.userId), `已移出 ${nameOf(member.userId)}。`) }}
                      >
                        移出
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {manage && (
                <div className="pnav-form-row">
                  <select aria-label="选择要添加的团队成员" value={candidate} disabled={busy || !candidates.length} onChange={event => setCandidate(event.target.value)}>
                    <option value="">{candidates.length ? "选择团队成员加入项目" : "团队成员都已加入"}</option>
                    {candidates.map(item => (
                      <option key={item.user.id} value={item.user.id}>
                        {item.user.userName}（{item.user.userNo}{item.user.orgName ? ` · ${item.user.orgName}` : ""}）
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !candidate}
                    onClick={() => {
                      void run(
                        "members",
                        () => host.addMember(workspaceId, project.projectId, { userId: candidate, requestId: crypto.randomUUID() }),
                        `已添加 ${nameOf(candidate)}。`,
                        () => setCandidate(""),
                      )
                    }}
                  >
                    添加
                  </button>
                </div>
              )}
              {message("members")}
              <p className="meta" style={{ lineHeight: 1.7 }}>
                会话同步按 Project 维度生效：只有这里的成员，他们的会话才会出现在顶栏成员条和速览浮层里。
              </p>
            </section>
          </div>
        </div>
      </div>
    </section>
  )
}
