/**
 * 最小演示身份区域：订阅安全状态 → 选择普通账号 → 读取真实成员 → 退出后重新选择。
 * 仅消费CollaborationHost；成员随身份状态立即清空，异步回包不得恢复旧视图。
 */
import { useEffect, useRef, useState } from "react"
import type { CollaborationHost, IdentityState, MemberSummary, UserSummary } from "@workbench/contracts"
import "./identity.css"

export function IdentityPanel({ host }: { host: CollaborationHost }) {
  const [state, setState] = useState<IdentityState>({ status: "signedOut" })
  const [users, setUsers] = useState<UserSummary[]>([])
  const [username, setUsername] = useState("")
  const [members, setMembers] = useState<MemberSummary[]>([])
  const [notice, setNotice] = useState("")
  const [fetching, setFetching] = useState(true)
  const [memberRefresh, setMemberRefresh] = useState(0)
  const [action, setAction] = useState<"signIn" | "signOut" | null>(null)
  const revision = useRef(0)
  const actionId = useRef(0)
  const usersRequest = useRef(0)
  const active = useRef(true)

  async function loadUsers() {
    const request = ++usersRequest.current
    setFetching(true)
    try {
      const result = await host.listDemoUsers()
      if (!active.current || request !== usersRequest.current) return
      if (result.ok) {
        setUsers(result.value.users)
        setUsername(old => result.value.users.some(user => user.username === old) ? old : result.value.users[0]?.username ?? "")
      } else { setUsers([]); setNotice(result.error.message) }
    } catch { if (active.current && request === usersRequest.current) { setUsers([]); setNotice("无法读取演示账号，请重试。") } }
    finally { if (active.current && request === usersRequest.current) setFetching(false) }
  }
  useEffect(() => {
    active.current = true
    const apply = (next: IdentityState) => {
      revision.current++; setMembers([]); setNotice(""); setState(next)
    }
    const unsubscribe = host.onStateChanged(apply)
    const initial = revision.current
    void host.getState().then(result => { if (active.current && initial === revision.current && result.ok) apply(result.value) })
    void loadUsers()
    return () => { active.current = false; revision.current++; actionId.current++; usersRequest.current++; unsubscribe() }
  }, [host])
  useEffect(() => {
    if (state.status !== "signedIn" || !state.workspaces[0]) return
    const current = revision.current
    let listening = true
    setMembers([])
    void host.listMembers(state.workspaces[0].id).then(result => {
      if (!listening || !active.current || current !== revision.current) return
      if (result.ok) setMembers(result.value.members)
      else setNotice(result.error.message)
    }).catch(() => { if (listening && active.current && current === revision.current) setNotice("无法读取工作区成员，请重试连接。") })
    return () => { listening = false }
  }, [host, state, memberRefresh])
  async function perform(kind: "signIn" | "signOut") {
    const current = ++actionId.current
    // 点击即清掉旧成员，不等待IPC返回或服务端退出确认。
    revision.current++; usersRequest.current++; setFetching(false)
    setMembers([]); setNotice(""); setAction(kind); setState({ status: "loading" })
    try {
      const result = kind === "signIn" ? await host.signIn(username) : await host.signOut()
      if (active.current && current === actionId.current && !result.ok) setNotice(result.error.message)
    } catch {
      if (active.current && current === actionId.current) setNotice(kind === "signOut" ? "本机已退出，服务端退出未确认" : "身份操作未完成，请重试连接。")
    } finally { if (active.current && current === actionId.current) setAction(null) }
  }
  async function retry() {
    setNotice("")
    try {
      const current = revision.current
      const result = await host.getState()
      if (!active.current) return
      if (result.ok && current === revision.current) { revision.current++; setState(result.value) }
      await loadUsers()
    } catch { if (active.current) setNotice("无法确认服务连接，请重试。") }
  }
  const signedIn = state.status === "signedIn"
  return <section className="identity-panel" aria-labelledby="identity-heading">
    <div className="identity-heading"><h2 id="identity-heading">演示身份</h2><span>普通用户 · 不验证真实人员身份</span></div>
    {state.status === "loading" ? <div className="identity-actions"><p role="status">正在处理身份…</p><button disabled={action === "signOut"} onClick={() => { void perform("signOut") }}>取消并退出本机账号</button></div> :
      state.status === "connectionError" ? <>
        <p role="alert">{state.error.message}</p>
        {state.lastKnownUser && <p>上次身份：{state.lastKnownUser.displayName}（{state.lastKnownUser.username}）。连接确认前暂停业务读取。</p>}
        <div className="identity-actions"><button onClick={() => { void retry() }}>重试连接</button>{state.lastKnownUser && <button onClick={() => { void perform("signOut") }}>退出本机账号</button>}</div>
      </> : signedIn ? <>
        <div className="identity-actions"><p>当前用户：<strong>{state.user.displayName}</strong>（{state.user.username}）</p><button onClick={() => { void perform("signOut") }}>退出 / 切换账号</button></div>
        {state.workspaces.length === 0 ? <p>当前账号未加入工作区</p> : <div><h3>{state.workspaces[0].name}</h3><div className="identity-actions"><p>工作区成员</p><button onClick={() => setMemberRefresh(value => value + 1)}>刷新成员</button></div><ul aria-label="工作区成员">{members.map(member => <li key={member.user.id}>{member.user.displayName}（{member.user.username}）</li>)}</ul>{members.length === 0 && <p role="status">正在读取成员…</p>}</div>}
      </> : <div className="identity-actions">
        <label>演示账号<select aria-label="演示账号" value={username} disabled={fetching || action !== null} onChange={event => setUsername(event.target.value)}>{users.length === 0 && <option value="">{fetching ? "正在读取…" : "暂无可用账号"}</option>}{users.map(user => <option key={user.id} value={user.username}>{user.displayName}（{user.username}）</option>)}</select></label>
        <button className="primary" disabled={!username || fetching || action !== null} onClick={() => { void perform("signIn") }}>演示登录</button>
        <button disabled={fetching} onClick={() => { void retry() }}>刷新账号</button>
      </div>}
    {notice && <p className="error" role="alert">{notice}</p>}
  </section>
}
