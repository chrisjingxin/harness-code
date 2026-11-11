/** 最小设备登记：真实所有者显式选目录/登记/托管；不写导航或完整工作台。 */
import { useEffect, useState } from "react"
import type { CollaborationHost, DeviceHost, DeviceState, DeviceSummary, IdentityState } from "@workbench/contracts"

export function DeviceRegistrationPanel({ host, collaboration }: { host: DeviceHost; collaboration: CollaborationHost }) {
  const [identity, setIdentity] = useState<IdentityState | null>(null)
  const [device, setDevice] = useState<DeviceState | null>(null)
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    let active = true
    const applyIdentity = (next: IdentityState) => { if (active) setIdentity(next) }
    const applyDevice = (next: DeviceState) => { if (active) setDevice(next) }
    const offIdentity = collaboration.onStateChanged(applyIdentity)
    const offDevice = host.onStateChanged(applyDevice)
    collaboration.getState().then(result => { if (active && result.ok) setIdentity(result.value) }).catch(() => {})
    host.getState().then(result => { if (active && result.ok) setDevice(result.value) }).catch(() => {})
    return () => { active = false; offIdentity(); offDevice() }
  }, [host, collaboration])

  const workspaceId = identity?.status === "signedIn" ? identity.workspaces[0]?.id ?? null : null
  useEffect(() => {
    if (!workspaceId) { setDevices([]); return }
    let active = true
    host.listDevices(workspaceId).then(result => { if (active && result.ok) setDevices(result.value.devices) }).catch(() => {})
    return () => { active = false }
  }, [host, workspaceId, device?.status])

  async function run(action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true); setMessage("")
    try {
      const result = await action()
      if (!result.ok && result.error) setMessage(result.error.message)
    } catch { setMessage("操作未完成，请重试。") }
    finally { setBusy(false) }
  }

  async function stopSharing() {
    if (!workspaceId || !device?.deviceId || !device.projectId) return { ok: false }
    const projects = await host.listProjects(workspaceId, device.deviceId)
    if (!projects.ok) return projects
    const project = projects.value.projects.find(item => item.projectId === device.projectId)
    if (!project) return { ok: false, error: { message: "服务尚未确认此项目，请刷新后重试。" } }
    return host.stopSharing(workspaceId, project.projectId, crypto.randomUUID(), project.shareVersion)
  }

  if (!workspaceId) return <section className="device-panel" aria-label="本机设备"><h2>本机设备</h2><p className="hint">登录并加入工作区后可登记本机。</p></section>

  return <section className="device-panel" aria-label="本机设备">
    <h2>本机设备</h2>
    <p className="hint">只有明确登记并共享的项目才会被其他成员看到；路径与秘密留在本机。</p>
    <div className="device-row">
      <input aria-label="项目名称" placeholder="项目名称（可选）" value={name} maxLength={80} onChange={event => setName(event.target.value)} />
      <button className="primary" disabled={busy} onClick={() => { void run(() => host.registerDevice(workspaceId, name)) }}>选择目录并登记</button>
    </div>
    <p className="device-state" data-testid="device-state">
      状态：{device?.status === "running" ? "运行中" : device?.status === "registered" ? "已登记" : device?.status === "stopped" ? "已停止" : "未登记"}
      {device?.projectId ? device.shareEnabled ? " · 已共享" : " · 未共享" : ""}
      {device?.connection === "ready" ? " · 服务已就绪" : device?.connection === "reconciling" ? " · 正在恢复连接" : ""}
    </p>
    <div className="device-actions">
      <button disabled={busy || !device?.projectId || device.shareEnabled} onClick={() => { void run(() => host.shareProject()) }}>共享项目</button>
      <button disabled={busy || !device?.shareEnabled} onClick={() => { void run(stopSharing) }}>撤回共享</button>
      <button disabled={busy || !device?.shareEnabled || device.status === "running"} onClick={() => { void run(() => host.startRunner()) }}>启动本机执行器</button>
      <button disabled={busy || device?.status !== "running"} onClick={() => { void run(() => host.stopRunner()) }}>停止</button>
    </div>
    {device?.message && <p className="error" role="alert">{device.message}</p>}
    {message && <p className="error" role="alert">{message}</p>}
    {devices.length > 0 && <ul className="device-list">
      {devices.map(item => <li key={item.deviceId}>
        <strong>{item.name}</strong>
        <span>{item.connectionState === "ready" ? "在线" : item.connectionState === "reconciling" ? "恢复中" : "离线"}</span>
        {item.revokedAt && <span>已撤销</span>}
      </li>)}
    </ul>}
  </section>
}
