/** 设置页的本机设备状态：本机登记 + 当前团队的设备列表，用于判断本机是否属于当前账号与团队。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { DeviceHost, DeviceState, DeviceSummary } from "@workbench/contracts"

export function useLocalDevice(host: DeviceHost, workspaceId: string, userId: string) {
  const [local, setLocal] = useState<{ state: DeviceState | null; message?: string }>({ state: null })
  const [devices, setDevices] = useState<{ rows: readonly DeviceSummary[]; loaded: boolean; message?: string }>({ rows: [], loaded: false })
  const request = useRef(0)
  const loadDevices = useCallback(async () => {
    const current = ++request.current
    const result = await host.listDevices(workspaceId).catch(() => null)
    if (current !== request.current) return
    if (!result?.ok || result.value.workspaceId !== workspaceId) setDevices({ rows: [], loaded: true, message: result?.ok === false ? result.error.message : "无法确认本机设备，请重试。" })
    else setDevices({ rows: result.value.devices, loaded: true })
  }, [host, workspaceId])
  useEffect(() => {
    void loadDevices()
    let initial = true
    const unsubscribe = host.onStateChanged(state => { initial = false; setLocal({ state }) })
    void host.getState().then(result => {
      if (initial) setLocal(result.ok ? { state: result.value } : { state: null, message: result.error.message })
    }).catch(() => { if (initial) setLocal({ state: null, message: "无法确认本机设备状态。" }) })
    return () => { initial = false; request.current++; unsubscribe() }
  }, [host, loadDevices])
  const state = local.state
  const owned = !state?.deviceId || devices.rows.some(device => device.deviceId === state.deviceId && device.ownerUserId === userId)
  const blockedReason = local.message ?? (!state ? "正在确认本机设备状态。"
    : !devices.loaded ? "正在确认本机设备所属团队。"
    : devices.message ?? (owned ? undefined : "当前团队未确认本机设备登记。"))
  return { device: owned ? state : null, devices: devices.rows, blockedReason, refresh: () => { void loadDevices() } }
}
