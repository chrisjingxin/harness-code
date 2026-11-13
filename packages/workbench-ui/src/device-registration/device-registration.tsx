/** 最小设备登记：真实所有者显式选目录/登记/托管；不写导航或完整工作台。 */
import { useEffect, useState } from "react"
import type { CollaborationHost, DeviceHost, DeviceState, DeviceSummary, IdentityState } from "@workbench/contracts"
import "./device-registration.css"

type StandaloneProps = { host: DeviceHost; collaboration: CollaborationHost }
type DeviceFormProps = {
  host: DeviceHost
  workspaceId: string | null
  device: DeviceState | null
  devices?: readonly DeviceSummary[]
  blockedReason?: string
  onChanged?(): void
}

/** 正式窗口提供统一身份下的本机状态；基础页仍可独立订阅原宿主。 */
export function DeviceRegistrationPanel(props: StandaloneProps | DeviceFormProps) {
  if ("collaboration" in props) return <StandaloneDeviceRegistrationPanel {...props} />
  return <DeviceForm key={props.workspaceId} {...props} />
}

function StandaloneDeviceRegistrationPanel({ host, collaboration }: StandaloneProps) {
  const [identity, setIdentity] = useState<IdentityState | null>(null)
  const [device, setDevice] = useState<DeviceState | null>(null)
  const [devices, setDevices] = useState<DeviceSummary[]>([])

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

  return <DeviceForm key={workspaceId} host={host} workspaceId={workspaceId} device={device} devices={devices} />
}

function DeviceForm({ host, workspaceId, device, devices = [], blockedReason, onChanged }: DeviceFormProps) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const blocked = busy || !!blockedReason

  async function run(action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true); setMessage("")
    try {
      const result = await action()
      if (result.ok) onChanged?.()
      else if (result.error) setMessage(result.error.message)
    } catch { setMessage("操作未完成，请重试。") }
    finally { setBusy(false) }
  }

  if (!workspaceId) return <section className="device-panel" aria-label="本机设备"><h2>本机设备</h2><p className="hint">登录并加入工作区后可登记本机。</p></section>

  return <section className="device-panel" aria-label="本机设备">
    <h2>本机设备</h2>
    <p className="hint">只有明确登记并共享的项目才会被其他成员看到；路径与秘密留在本机。</p>
    <div className="device-row">
      <input aria-label="项目名称" placeholder="项目名称（可选）" value={name} maxLength={80} onChange={event => setName(event.target.value)} />
      <button className="primary wb-button wb-button-primary" disabled={blocked} onClick={() => { void run(() => host.registerDevice(workspaceId, name)) }}>选择目录并登记</button>
    </div>
    <p className="device-state" data-testid="device-state">
      状态：{blockedReason ? "未确认" : device?.status === "running" ? "运行中" : device?.status === "registered" ? "已登记" : device?.status === "stopped" ? "已停止" : device?.status === "unavailable" ? "不可用" : "未登记"}
      {device?.projectId ? device.shareEnabled ? " · 已共享" : " · 未共享" : ""}
      {device?.connection === "ready" ? " · 服务已就绪" : device?.connection === "reconciling" ? " · 正在恢复连接" : ""}
    </p>
    <div className="device-actions">
      <button disabled={blocked || !device?.projectId || device.shareEnabled} onClick={() => { void run(() => host.shareProject()) }}>共享项目</button>
      <button disabled={blocked || !device?.shareEnabled || device.status === "running"} onClick={() => { void run(() => host.startRunner()) }}>启动本机执行器</button>
      <button disabled={blocked || device?.status !== "running"} onClick={() => { void run(() => host.stopRunner()) }}>停止</button>
    </div>
    {blockedReason && <div className="device-actions"><p role="status">{blockedReason}</p>
      {onChanged && <button onClick={onChanged}>重新确认</button>}
    </div>}
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
