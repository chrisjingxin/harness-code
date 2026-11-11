/** 当前已选工作区的设备首页与本机状态。切换作用域时由正式入口卸载此订阅。 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { CollaborationError, DeviceHost, DeviceState, DeviceSummary, ProjectSummary } from "@workbench/contracts"
import type { NavigationAvailability } from "@workbench/ui"

type Page<Row> = {
  rows: readonly Row[]
  availability: NavigationAvailability
  partial?: boolean
}

function listError(error: CollaborationError): NavigationAvailability {
  if (error.code === "AUTHENTICATION_REQUIRED" || error.code === "RESOURCE_NOT_FOUND" || error.code === "REQUEST_SOURCE_REJECTED") {
    return { state: "denied", message: "当前账号无法读取此范围。" }
  }
  return { state: "offline", message: error.message }
}

/** 每个设备单独跟踪在途读取；较早的返回不会覆盖刷新结果。 */
export function useWorkspaceDevices(host: DeviceHost, workspaceId: string | null, expanded: readonly string[]) {
  const [devices, setDevices] = useState<Page<DeviceSummary>>({ rows: [], availability: { state: "loading" } })
  const [projects, setProjects] = useState<Partial<Record<string, Page<ProjectSummary>>>>({})
  const [local, setLocal] = useState<{ state: DeviceState | null; message?: string }>({ state: null })
  const active = useRef(false)
  const deviceRequest = useRef(0)
  const projectRequest = useRef(0)
  const projectRequests = useRef(new Map<string, number>())

  const loadDevices = useCallback(async () => {
    if (!workspaceId || !active.current) return
    const request = ++deviceRequest.current
    setDevices(previous => ({ ...previous, availability: { state: "loading" } }))
    try {
      const result = await host.listDevices(workspaceId)
      if (request !== deviceRequest.current) return
      if (!result.ok) {
        projectRequests.current.clear()
        setProjects({})
        setDevices({ rows: [], availability: listError(result.error) })
      } else if (result.value.workspaceId !== workspaceId || result.value.devices.some(device => device.workspaceId !== workspaceId)) {
        projectRequests.current.clear()
        setProjects({})
        setDevices({ rows: [], availability: { state: "offline", message: "设备列表与当前工作区不一致。" } })
      } else {
        setDevices({ rows: result.value.devices, availability: { state: "ready" }, partial: result.value.nextPage !== null })
      }
    } catch {
      if (request === deviceRequest.current) {
        projectRequests.current.clear()
        setProjects({})
        setDevices({ rows: [], availability: { state: "offline", message: "无法读取设备，请重试。" } })
      }
    }
  }, [host, workspaceId])

  const loadProjects = useCallback(async (deviceId: string) => {
    if (!workspaceId || !active.current) return
    const request = ++projectRequest.current
    projectRequests.current.set(deviceId, request)
    const apply = (page: Page<ProjectSummary>) => {
      if (request === projectRequests.current.get(deviceId)) setProjects(previous => ({ ...previous, [deviceId]: page }))
    }
    apply({ rows: [], availability: { state: "loading" } })
    try {
      const result = await host.listProjects(workspaceId, deviceId)
      if (!result.ok) apply({ rows: [], availability: listError(result.error) })
      else if (result.value.workspaceId !== workspaceId || result.value.deviceId !== deviceId
        || result.value.projects.some(project => project.workspaceId !== workspaceId || project.deviceId !== deviceId)) {
        apply({ rows: [], availability: { state: "offline", message: "项目列表与当前设备不一致。" } })
      } else apply({ rows: result.value.projects, availability: { state: "ready" }, partial: result.value.nextPage !== null })
    } catch {
      apply({ rows: [], availability: { state: "offline", message: "无法读取项目，请重试。" } })
    }
  }, [host, workspaceId])

  useEffect(() => {
    active.current = true
    void loadDevices()
    return () => {
      // 设备动作可能在离开工作区后完成，其回调不能再发旧范围的读取。
      active.current = false
      deviceRequest.current++
      projectRequests.current.clear()
    }
  }, [loadDevices])

  useEffect(() => {
    for (const device of devices.rows) {
      if (expanded.includes(device.deviceId) && !projectRequests.current.has(device.deviceId)) void loadProjects(device.deviceId)
    }
  }, [devices.rows, expanded, loadProjects])

  useEffect(() => {
    const deviceId = local.state?.deviceId
    // 本机设备可能排在首页之后，项目列表接口会按当前账号和工作区核对该设备。
    if (deviceId && devices.partial && !devices.rows.some(device => device.deviceId === deviceId)
      && !projectRequests.current.has(deviceId)) void loadProjects(deviceId)
  }, [devices.rows, devices.partial, local.state?.deviceId, loadProjects])

  useEffect(() => {
    if (!workspaceId) return
    let initial = true
    const unsubscribe = host.onStateChanged(state => {
      initial = false
      setLocal({ state })
    })
    void host.getState().then(result => {
      if (!initial) return
      setLocal(result.ok ? { state: result.value } : { state: null, message: result.error.message })
    }).catch(() => {
      if (initial) setLocal({ state: null, message: "无法确认本机设备状态。" })
    })
    return () => { initial = false; unsubscribe() }
  }, [host, workspaceId])

  function refresh() {
    void loadDevices()
    for (const device of devices.rows) {
      if (projectRequests.current.has(device.deviceId)) void loadProjects(device.deviceId)
    }
    const deviceId = local.state?.deviceId
    if (deviceId && !devices.rows.some(device => device.deviceId === deviceId)) void loadProjects(deviceId)
  }

  return { devices, projects, local, loadDevices, loadProjects, refresh }
}
