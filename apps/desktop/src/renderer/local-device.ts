/** 静默维护当前账号在本机的上传凭据；无需用户手动登记或选择目录。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { DeviceHost, DeviceState, DeviceSummary } from "@workbench/contracts"

export function useLocalDevice(host: DeviceHost, workspaceId: string, userId: string) {
  const [local, setLocal] = useState<{ state: DeviceState | null; message?: string }>({ state: null })
  const [devices, setDevices] = useState<{ rows: readonly DeviceSummary[]; loaded: boolean; message?: string }>({ rows: [], loaded: false })
  const request = useRef(0)
  const ensure = useCallback(async () => {
    const current = ++request.current
    const ensured = await host.registerDevice(workspaceId, "").catch(() => null)
    if (current !== request.current) return
    if (ensured && !ensured.ok) {
      setLocal({ state: null, message: ensured.error.message })
      setDevices({ rows: [], loaded: true, message: ensured.error.message })
      return
    }
    const [stateRes, listRes] = await Promise.all([
      host.getState().catch(() => null),
      host.listDevices(workspaceId).catch(() => null),
    ])
    if (current !== request.current) return
    setLocal(stateRes?.ok ? { state: stateRes.value } : { state: null, message: stateRes?.ok === false ? stateRes.error.message : "无法准备本机对话环境。" })
    if (!listRes?.ok || listRes.value.workspaceId !== workspaceId) {
      setDevices({ rows: [], loaded: true, message: listRes?.ok === false ? listRes.error.message : "无法确认团队会话环境，请重试。" })
    } else {
      setDevices({ rows: listRes.value.devices, loaded: true })
    }
  }, [host, workspaceId])
  useEffect(() => {
    void ensure()
    const unsubscribe = host.onStateChanged(state => { setLocal({ state }) })
    return () => { request.current++; unsubscribe() }
  }, [host, ensure])
  const state = local.state
  const owned = Boolean(state?.deviceId) && devices.rows.some(device => device.deviceId === state?.deviceId && device.ownerUserId === userId && device.revokedAt === null)
  const blockedReason = local.message ?? (!state ? "正在准备本机对话环境…"
    : !devices.loaded ? "正在确认团队会话环境…"
    : devices.message ?? (owned ? undefined : "正在初始化当前用户的会话凭据…"))
  return { device: owned ? state : null, devices: devices.rows, blockedReason, refresh: () => { void ensure() } }
}
