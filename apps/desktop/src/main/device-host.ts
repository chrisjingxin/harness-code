/** 原生设备入口。窗口身份用于当前所有者授权，Runner 和账本按固定服务独立存活。 */
import { dialog, app, type BrowserWindow } from "electron"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { basename, join } from "node:path"
import type {
  CollaborationResult, DeviceState, DeviceListResponse, ProjectListResponse, DeviceRevokedResponse, ProjectSavedResponse,
  DeviceProjectPublishRequest, IdentityState, LocalDeviceRegistration,
} from "@workbench/contracts"
import { identityError } from "./collaboration-state.js"
import type { CollaborationClient } from "./collaboration-client.js"
import type { RunnerSupervisor } from "./runner-supervisor.js"

type SavedDevice = LocalDeviceRegistration

interface IdentitySource {
  getState(): Promise<CollaborationResult<IdentityState>>
  onStateChanged(listener: (state: IdentityState) => void): () => void
}

const LOCAL_AGENT_ID = "00000000-0000-4000-8000-000000000001"
const LOCAL_AGENT_NAME = "本机 Agent（未接入）"

export class DeviceHost {
  readonly #client: CollaborationClient
  readonly #supervisor: RunnerSupervisor
  readonly #window: () => BrowserWindow | null
  readonly #identity: IdentitySource
  readonly #origin: string
  readonly #root: string
  readonly #listeners = new Set<(state: DeviceState) => void>()
  readonly #disposeListeners: (() => void)[]
  #device: SavedDevice | null = null
  #generation = 0
  #identityKey: string | null = null
  #busy = false

  constructor(client: CollaborationClient, supervisor: RunnerSupervisor, window: () => BrowserWindow | null, identity: IdentitySource) {
    this.#client = client
    this.#supervisor = supervisor
    this.#window = window
    this.#identity = identity
    this.#origin = process.env.WORKBENCH_SERVICE_ORIGIN!
    this.#root = join(app.getPath("userData"), "runner", createHash("sha256").update(this.#origin).digest("hex"))
    this.#disposeListeners = [supervisor.onStateChanged(() => this.#publish()), identity.onStateChanged(state => {
      this.#generation++
      this.#identityKey = state.status === "signedIn" ? state.user.id : null
      this.#publish()
    })]
  }

  dispose(): void {
    this.#generation++
    this.#identityKey = null
    this.#listeners.clear()
    for (const dispose of this.#disposeListeners) dispose()
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #view(): DeviceState {
    const device = this.#device
    if (!device?.registered || device.ownerUserId !== this.#identityKey) return { status: "idle", deviceId: null, projectId: null, connection: "offline" }
    const child = this.#supervisor.state()
    const status = child === "failed" ? "unavailable" : this.#supervisor.hasChild() ? "running" : "registered"
    return { status, deviceId: device.deviceId, projectId: device.projectId,
      shareEnabled: device.shareEnabled, connection: child === "ready" || child === "reconciling" ? child : "offline",
      ...(child === "failed" ? { message: "本机执行器未确认可用。" } : {}) }
  }

  #publish() {
    for (const listener of this.#listeners) listener(this.#view())
  }

  async getState(): Promise<CollaborationResult<DeviceState>> {
    const result = await this.#identity.getState()
    this.#identityKey = result.ok && result.value.status === "signedIn" ? result.value.user.id : null
    await this.#load()
    return { ok: true, value: this.#view() }
  }

  listDevices(workspaceId: string): Promise<CollaborationResult<DeviceListResponse>> { return this.#client.listDevices(workspaceId, { limit: "50" }) }
  listProjects(workspaceId: string, deviceId: string): Promise<CollaborationResult<ProjectListResponse>> { return this.#client.listProjects(workspaceId, deviceId, { limit: "50" }) }
  async revokeDevice(workspaceId: string, deviceId: string, requestId: string): Promise<CollaborationResult<DeviceRevokedResponse>> {
    const result = await this.#client.revokeDevice(workspaceId, deviceId, { requestId })
    if (result.ok && this.#device?.deviceId === deviceId) await this.#supervisor.stop()
    return result
  }

  async stopSharing(workspaceId: string, projectId: string, requestId: string, expectedShareVersion: string): Promise<CollaborationResult<ProjectSavedResponse>> {
    const result = await this.#client.stopSharing(workspaceId, projectId, { requestId, expectedShareVersion })
    if (result.ok && this.#device?.projectId === projectId) {
      await this.#save({ ...this.#device, shareEnabled: false, shareVersion: result.value.project.shareVersion })
      this.#publish()
    }
    return result
  }

  /** 本机显式选择目录。响应丢失时用原登记 ID 与秘密重试，不能自动换设备或根目录。 */
  async registerDevice(workspaceId: string, name: string): Promise<CollaborationResult<DeviceState>> {
    if (this.#busy) return failure("INVALID_REQUEST", "已有设备操作正在进行。")
    this.#busy = true
    try {
      const owner = await this.#owner(workspaceId)
      if (!owner) return denied()
      const existing = await this.#load()
      if (existing && (existing.ownerUserId !== owner.userId || existing.workspaceId !== workspaceId)) return denied()
      if (existing?.registered) return { ok: true, value: this.#view() }
      let device = existing
      if (!device) {
        const window = this.#window()
        if (!window) return denied()
        const picked = await dialog.showOpenDialog(window, { title: "选择本机项目", properties: ["openDirectory"] })
        if (picked.canceled || picked.filePaths.length !== 1) return failure("INVALID_REQUEST", "已取消选择目录。")
        const projectRoot = await realpath(picked.filePaths[0]!)
        const projectName = name.trim() || basename(projectRoot)
        if (!projectName || Array.from(projectName).length > 80 || !(await lstat(projectRoot)).isDirectory()) return failure("INVALID_REQUEST", "项目目录或名称无效。")
        if (!this.#current(owner)) return denied()
        device = { deviceId: randomUUID(), installationId: randomUUID(), ledgerId: randomUUID(), registrationId: randomUUID(), origin: this.#origin,
          ownerUserId: owner.userId, registered: false, secret: randomBytes(32).toString("base64url"), workspaceId,
          projectId: randomUUID(), projectRoot, projectName, shareEnabled: false, shareVersion: "0", pendingPublishId: null }
        await this.#save(device)
      }
      if (!this.#current(owner)) return denied()
      const result = await this.#client.registerDevice(workspaceId, {
        registrationId: device.registrationId, deviceId: device.deviceId, installationId: device.installationId,
        ledgerId: device.ledgerId, name: process.platform === "darwin" ? "macOS 本机" : "Windows 本机", secret: device.secret,
      })
      if (!this.#current(owner)) return denied()
      if (!result.ok) return result
      if (result.value.device.ownerUserId !== device.ownerUserId || result.value.device.deviceId !== device.deviceId
        || result.value.registrationId !== device.registrationId) return failure("INVALID_SERVER_RESPONSE", "登记结果与本机设备不一致。")
      await this.#save({ ...device, registered: true })
      this.#publish()
      return { ok: true, value: this.#view() }
    } finally { this.#busy = false }
  }

  /** 用固定设备凭据发布无路径元数据。只有真实云端确认后才允许启动已共享项目。 */
  async shareProject(): Promise<CollaborationResult<DeviceState>> {
    if (this.#busy) return failure("INVALID_REQUEST", "已有设备操作正在进行。")
    this.#busy = true
    try {
      let device = await this.#load()
      if (!device?.registered) return failure("INVALID_REQUEST", "请先登记本机设备。")
      const owner = await this.#owner(device.workspaceId, device.ownerUserId)
      if (!owner) return denied()
      if (device.shareEnabled) return { ok: true, value: this.#view() }
      if (device.pendingPublishId === null) {
        device = { ...device, pendingPublishId: randomUUID() }
        await this.#save(device)
      }
      if (!this.#current(owner)) return denied()
      const request: DeviceProjectPublishRequest = { requestId: device.pendingPublishId!, projectId: device.projectId,
        name: device.projectName, shareEnabled: true, expectedShareVersion: device.shareVersion,
        agentConfigs: [{ agentConfigId: LOCAL_AGENT_ID, name: LOCAL_AGENT_NAME, available: false }] }
      let response: Response
      try {
        response = await fetch(`${this.#origin}/api/v1/device/projects`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${device.deviceId}.${device.secret}`, Origin: this.#origin,
            "X-Workbench-Protocol-Version": "1", "Content-Type": "application/json" }, body: JSON.stringify(request) })
      } catch { return failure("NETWORK_UNAVAILABLE", "项目共享未确认，请用原请求重试。") }
      if (!this.#current(owner)) return denied()
      if (!response.ok) return failure("INVALID_REQUEST", "服务未确认共享项目。")
      const saved = await response.json() as ProjectSavedResponse
      if (saved.requestId !== request.requestId || saved.project?.deviceId !== device.deviceId || saved.project.workspaceId !== device.workspaceId
        || saved.project.projectId !== device.projectId || saved.project.shareEnabled !== true || !/^[1-9][0-9]{0,18}$/.test(saved.project.shareVersion)) {
        return failure("INVALID_SERVER_RESPONSE", "项目共享结果与本机登记不一致。")
      }
      if (!this.#current(owner)) return denied()
      await this.#save({ ...device, shareEnabled: true, shareVersion: saved.project.shareVersion, pendingPublishId: null })
      this.#publish()
      return { ok: true, value: this.#view() }
    } finally { this.#busy = false }
  }

  async startRunner(): Promise<CollaborationResult<DeviceState>> {
    const device = await this.#load()
    if (!device?.registered || !device.shareEnabled) return failure("INVALID_REQUEST", "请先明确共享项目。")
    const owner = await this.#owner(device.workspaceId, device.ownerUserId)
    if (!owner || !this.#current(owner)) return denied()
    this.#supervisor.start({ server: this.#origin, secret: device.secret, dataDir: this.#root,
      projectRoot: device.projectRoot, projectId: device.projectId, projectName: device.projectName,
      agentConfigId: LOCAL_AGENT_ID, deviceId: device.deviceId, workspaceId: device.workspaceId,
      ledgerId: device.ledgerId, shareEnabled: device.shareEnabled, shareVersion: device.shareVersion })
    return { ok: true, value: this.#view() }
  }

  async stopRunner(): Promise<CollaborationResult<DeviceState>> {
    const device = await this.#load()
    if (!device?.registered || !await this.#owner(device.workspaceId, device.ownerUserId)) return denied()
    const stopped = await this.#supervisor.stop()
    return stopped ? { ok: true, value: this.#view() } : failure("INTERNAL_ERROR", "执行器退出未确认。")
  }

  async #owner(workspaceId: string, expected?: string) {
    const state = await this.#identity.getState()
    if (!state.ok || state.value.status !== "signedIn" || !state.value.workspaces.some(item => item.id === workspaceId)
      || (expected !== undefined && state.value.user.id !== expected)) return null
    this.#identityKey = state.value.user.id
    const owner = { userId: state.value.user.id, generation: this.#generation }
    // 本机敏感动作也核对当前服务身份，不能用窗口曾经登录过作为永久授权。
    const current = await this.#client.getCurrentUser()
    if (!current.ok || current.value.user.id !== owner.userId || !current.value.workspaces.some(item => item.id === workspaceId) || !this.#current(owner)) return null
    return owner
  }

  #current(owner: { generation: number; userId: string }): boolean {
    return this.#generation === owner.generation && this.#identityKey === owner.userId && this.#window() !== null
  }

  async #load(): Promise<SavedDevice | null> {
    this.#device = await this.#supervisor.deviceStore(this.#root, this.#origin)
    return this.#device
  }

  async #save(device: SavedDevice): Promise<void> {
    this.#device = await this.#supervisor.deviceStore(this.#root, this.#origin, device)
  }
}

function failure(code: Parameters<typeof identityError>[0], message: string) { return identityError(code, message) }
function denied() { return failure("AUTHENTICATION_REQUIRED", "请用当前设备所有者账号操作。") }
