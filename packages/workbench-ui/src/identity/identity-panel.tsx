/** 演示身份面板复用宿主登录状态，成员查询只读取当前已选工作区。 */
import { useEffect, useId, useState } from "react"
import type { CollaborationHost, MemberSummary, UserSummary } from "@workbench/contracts"
import { useCollaborationIdentity } from "./use-collaboration-identity.js"
import "./identity.css"

type IdentityControls = ReturnType<typeof useCollaborationIdentity>
type IdentityPanelProps = {
  host: CollaborationHost
  identity?: IdentityControls
  workspaceId?: string | null
}

/** 装配方可传入共享的身份控制器，独立使用时面板自行订阅原宿主。 */
export function IdentityPanel({ host, identity, workspaceId }: IdentityPanelProps) {
  return identity
    ? <IdentityForm host={host} identity={identity} workspaceId={workspaceId} />
    : <StandaloneIdentityPanel host={host} workspaceId={workspaceId} />
}

function StandaloneIdentityPanel({ host, workspaceId }: IdentityPanelProps) {
  const identity = useCollaborationIdentity(host)
  return <IdentityForm host={host} identity={identity} workspaceId={workspaceId} />
}

function userDetail(user: UserSummary) {
  return user.orgName ? `${user.userNo} · ${user.orgName}` : user.userNo
}

function IdentityForm({ host, identity, workspaceId }: IdentityPanelProps & { identity: IdentityControls }) {
  const { state, action, notice, refresh, signIn, signOut } = identity
  const headingId = useId()
  const [users, setUsers] = useState<UserSummary[]>([])
  const [userNo, setUserNo] = useState("")
  const [fetching, setFetching] = useState(false)
  const [userNotice, setUserNotice] = useState("")
  const [reload, setReload] = useState(0)
  const signedOut = state.status === "signedOut"
  const retryAnonymous = state.status === "connectionError" && !state.lastKnownUser

  useEffect(() => {
    if (!signedOut && !(retryAnonymous && reload)) {
      setFetching(false)
      return
    }
    let active = true
    setFetching(true)
    setUserNotice("")
    void host.listDemoUsers().then(result => {
      if (!active) return
      if (result.ok) {
        setUsers(result.value.users)
        setUserNo(old => result.value.users.some(user => user.userNo === old) ? old : result.value.users[0]?.userNo ?? "")
      } else {
        setUsers([])
        setUserNotice(result.error.message)
      }
    }).catch(() => {
      if (active) { setUsers([]); setUserNotice("无法读取演示账号，请重试。") }
    }).finally(() => { if (active) setFetching(false) })
    return () => { active = false }
  }, [host, signedOut, retryAnonymous, reload])

  const workspace = state.status === "signedIn"
    ? workspaceId === undefined ? state.workspaces[0] : state.workspaces.find(item => item.id === workspaceId)
    : undefined

  return <section className="identity-panel" aria-labelledby={headingId}>
    <div className="identity-heading"><h2 id={headingId}>演示身份</h2><span>普通用户 · 不验证真实人员身份</span></div>
    {state.status === "loading" ? <div className="identity-actions">
      <p role="status">正在处理身份…</p>
      {action && <button className="wb-button wb-button-secondary" disabled={action === "signOut"} onClick={() => { void signOut() }}>取消并退出本机账号</button>}
      {!action && notice && <button className="wb-button wb-button-secondary" onClick={() => { void refresh() }}>重试连接</button>}
    </div> : state.status === "connectionError" ? <>
      <p className="error" role="alert">{state.error.message}</p>
      {state.lastKnownUser && <p>上次身份：{state.lastKnownUser.userName}（{userDetail(state.lastKnownUser)}）。连接确认前暂停业务读取。</p>}
      <div className="identity-actions">
        <button className="wb-button wb-button-secondary" disabled={fetching && retryAnonymous} onClick={() => {
          if (retryAnonymous) setReload(value => value + 1)
          else void refresh()
        }}>重试连接</button>
        {state.lastKnownUser && <button className="wb-button wb-button-secondary" onClick={() => { void signOut() }}>退出本机账号</button>}
      </div>
    </> : state.status === "signedIn" ? <>
      <div className="identity-actions"><p>当前用户：<strong>{state.user.userName}</strong>（{userDetail(state.user)}）</p><button className="wb-button wb-button-secondary" onClick={() => { void signOut() }}>退出 / 切换账号</button></div>
      {workspace
        ? <Members key={JSON.stringify([state.user.id, workspace.id])} host={host} workspace={workspace} />
        : <p>{state.workspaces.length ? "请先选择工作区。" : "当前账号未加入工作区"}</p>}
    </> : <div className="identity-actions">
      <label>演示账号<select aria-label="演示账号" value={userNo} disabled={fetching || action !== null} onChange={event => setUserNo(event.target.value)}>
        {users.length === 0 && <option value="">{fetching ? "正在读取…" : "暂无可用账号"}</option>}
        {users.map(user => <option key={user.id} value={user.userNo}>{user.userName}（{userDetail(user)}）</option>)}
      </select></label>
      <button className="primary wb-button wb-button-primary" disabled={!userNo || fetching || action !== null} onClick={() => { void signIn(userNo) }}>演示登录</button>
      <button className="wb-button wb-button-secondary" disabled={fetching} onClick={() => setReload(value => value + 1)}>刷新账号</button>
    </div>}
    {(notice || (signedOut && userNotice)) && <p className="error" role="alert">{notice || userNotice}</p>}
  </section>
}

function Members({ host, workspace }: { host: CollaborationHost; workspace: { id: string; name: string } }) {
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  const [notice, setNotice] = useState("")
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setMembers(null)
    setNotice("")
    void host.listMembers(workspace.id).then(result => {
      if (!active) return
      if (result.ok) setMembers(result.value.members)
      else setNotice(result.error.message)
    }).catch(() => { if (active) setNotice("无法读取工作区成员，请重试连接。") })
    return () => { active = false }
  }, [host, workspace.id, reload])

  return <div>
    <h3>{workspace.name}</h3>
    <div className="identity-actions"><p>工作区成员</p><button className="wb-button wb-button-secondary" onClick={() => setReload(value => value + 1)}>刷新成员</button></div>
    {notice ? <p className="error" role="alert">{notice}</p> : members === null ? <p role="status">正在读取成员…</p> : members.length
      ? <ul aria-label="工作区成员">{members.map(member => <li key={member.user.id}>{member.user.userName}（{userDetail(member.user)}）</li>)}</ul>
      : <p>当前工作区暂无成员。</p>}
  </div>
}
