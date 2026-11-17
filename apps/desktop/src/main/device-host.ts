/** 原生设备入口。按人静默维护本机上传凭据，无需手动登记或选择目录。 */
import { app, type BrowserWindow } from "electron"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  CollaborationResult, DeviceState, DeviceListResponse, DeviceRevokedResponse, ProjectSavedResponse,
  DeviceProjectPublishRequest, DeviceSyncRequest, IdentityState, LocalDeviceRegistration,
} from "@workbench/contracts"
import type { LocalExecutionScope, LocalExecutionUploadNotice } from "../local-execution-host.js"
import { identityError } from "./collaboration-state.js"
import type { CollaborationClient } from "./collaboration-client.js"
import { ConversationUploads, type FinalizedTurn } from "./conversation-uploads.js"
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
  readonly #uploads: ConversationUploads
  readonly #listeners = new Set<(state: DeviceState) => void>()
  readonly #disposeListeners: (() => void)[]
  #device: SavedDevice | null = null
  #generation = 0
  #identityKey: string | null = null
  #busy = false
  #ensuring = new Map<string, Promise<CollaborationResult<SavedDevice>>>()

  constructor(client: CollaborationClient, supervisor: RunnerSupervisor, window: () => BrowserWindow | null, identity: IdentitySource,
    onUpload: (notice: LocalExecutionUploadNotice) => void) {
    this.#client = client
    this.#supervisor = supervisor
    this.#window = window
    this.#identity = identity
    this.#origin = process.env.WORKBENCH_SERVICE_ORIGIN!
    this.#root = join(app.getPath("userData"), "runner", createHash("sha256").update(this.#origin).digest("hex"))
    this.#uploads = new ConversationUploads(join(this.#root, "conversation-uploads"), {
      watermark: (scope, signal) => this.#conversationWatermark(scope, signal),
      upload: (scope, request, signal) => this.#sendConversationBatch(scope, request, signal),
    }, onUpload)
    this.#disposeListeners = [supervisor.onStateChanged(() => this.#publish()), identity.onStateChanged(state => {
      this.#generation++
      this.#identityKey = state.status === "signedIn" ? state.user.id : null
      const uploadOwner = this.#identityKey ?? (state.status === "connectionError" ? state.lastKnownUser?.id : null)
      this.#uploads.useAccount(uploadOwner ?? null)
      this.#publish()
    })]
  }

  dispose(): void {
    this.#generation++
    this.#identityKey = null
    this.#uploads.useAccount(null)
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

  /** 仅主进程调用。受理过的本机轮在终态落盘，再由同一设备凭据异步上传。 */
  enqueueConversationTurn(scope: LocalExecutionScope, turn: FinalizedTurn): Promise<void> {
    return this.#uploads.enqueue(scope, turn)
  }

  /** 退出窗口前只等文件落盘，未确认的设备请求留给同一账号下次登录续传。 */
  pauseConversationUploads(): Promise<void> {
    this.#uploads.useAccount(null)
    return this.#uploads.flush()
  }

  async #conversationWatermark(scope: LocalExecutionScope, signal: AbortSignal): Promise<CollaborationResult<number>> {
    const detail = await this.#client.getProjectConversation(scope.workspaceId, scope.projectId, scope.conversationId, signal)
    if (!detail.ok) return detail
    const { conversation } = detail.value
    if (signal.aborted || conversation.conversationId !== scope.conversationId || conversation.projectId !== scope.projectId
      || conversation.ownerUserId !== scope.accountId) return denied()
    return { ok: true, value: conversation.syncedSequence }
  }

  async #sendConversationBatch(scope: LocalExecutionScope, request: DeviceSyncRequest, signal: AbortSignal) {
    const device = await this.#loadForAccount(scope.accountId)
    if (signal.aborted || !device?.registered || device.origin !== this.#origin || device.ownerUserId !== scope.accountId) return denied()
    return this.#client.syncDeviceConversation(scope.conversationId, device, request, signal)
  }
  async revokeDevice(workspaceId: string, deviceId: string, requestId: string): Promise<CollaborationResult<DeviceRevokedResponse>> {
    const result = await this.#client.revokeDevice(workspaceId, deviceId, { requestId })
    if (result.ok && this.#device?.deviceId === deviceId) await this.#supervisor.stop()
    return result
  }

  /** 为当前登录人在当前团队静默准备本机上传凭据；若尚未登记或已失效则自动登记，不弹窗打扰用户。 */
  ensureLocalDevice(workspaceId: string): Promise<CollaborationResult<SavedDevice>> {
    const key = `${this.#generation}:${this.#identityKey ?? ""}:${workspaceId}`
    const pending = this.#ensuring.get(key)
    if (pending) return pending
    const task = this.#ensureLocalDeviceImpl(workspaceId).finally(() => {
      if (this.#ensuring.get(key) === task) this.#ensuring.delete(key)
    })
    this.#ensuring.set(key, task)
    return task
  }

  async #ensureLocalDeviceImpl(workspaceId: string): Promise<CollaborationResult<SavedDevice>> {
    const owner = await this.#owner(workspaceId)
    if (!owner) return denied()
    const listed = await this.#client.listDevices(workspaceId, { limit: "50" })
    if (!this.#current(owner)) return denied()
    if (!listed.ok) return listed

    let device = await this.#loadForAccount(owner.userId)
    if (!this.#current(owner)) return denied()
    const activeOnServer = device?.registered
      && listed.value.devices.some(item => item.deviceId === device!.deviceId && item.ownerUserId === owner.userId && item.revokedAt === null)
    if (activeOnServer && device) {
      this.#device = device
      this.#publish()
      return { ok: true, value: device }
    }

    if (!device || device.registered || device.workspaceId !== workspaceId) {
      device = {
        deviceId: randomUUID(),
        installationId: randomUUID(),
        ledgerId: randomUUID(),
        registrationId: randomUUID(),
        origin: this.#origin,
        ownerUserId: owner.userId,
        registered: false,
        secret: randomBytes(32).toString("base64url"),
        workspaceId,
        projectId: randomUUID(),
        projectRoot: app.getPath("userData"),
        projectName: "workbench",
        shareEnabled: false,
        shareVersion: "0",
        pendingPublishId: null,
      }
      await this.#saveForAccount(device)
    }
    if (!this.#current(owner)) return denied()

    const result = await this.#client.registerDevice(workspaceId, {
      registrationId: device.registrationId,
      deviceId: device.deviceId,
      installationId: device.installationId,
      ledgerId: device.ledgerId,
      name: process.platform === "darwin" ? "macOS 本机" : process.platform === "win32" ? "Windows 本机" : "Linux 本机",
      secret: device.secret,
    })
    if (!this.#current(owner)) return denied()
    if (!result.ok) {
      if (result.error.code === "REGISTRATION_CONFLICT") {
        await this.#clearAccountFile(owner.userId)
      }
      return result
    }
    if (result.value.device.ownerUserId !== device.ownerUserId || result.value.device.deviceId !== device.deviceId
      || result.value.registrationId !== device.registrationId) {
      return failure("INVALID_SERVER_RESPONSE", "登记结果与本机凭据不一致。")
    }
    const saved: SavedDevice = { ...device, registered: true }
    await this.#saveForAccount(saved)
    this.#device = saved
    this.#publish()
    return { ok: true, value: saved }
  }

  /** 兼容既有 IPC 入口：静默确认或登记本机上传凭据，不再弹窗要求选择项目目录。 */
  async registerDevice(workspaceId: string, _name: string): Promise<CollaborationResult<DeviceState>> {
    const ensured = await this.ensureLocalDevice(workspaceId)
    if (!ensured.ok) return ensured
    return { ok: true, value: this.#view() }
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

  #accountFile(accountId: string): string | null {
    return /^[0-9a-f]{32}$/.test(accountId) ? join(this.#root, "local-devices", `${accountId}.json`) : null
  }

  async #clearAccountFile(accountId: string): Promise<void> {
    const file = this.#accountFile(accountId)
    if (file) await rm(file, { force: true }).catch(() => {})
  }

  async #loadForAccount(accountId: string): Promise<SavedDevice | null> {
    const file = this.#accountFile(accountId)
    if (file) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as SavedDevice
        if (parsed && parsed.origin === this.#origin && parsed.ownerUserId === accountId && typeof parsed.deviceId === "string") {
          return parsed
        }
      } catch { /* 无记录或解析失败时尝试回退旧账本 */ }
    }
    try {
      const legacy = await this.#supervisor.deviceStore(this.#root, this.#origin)
      if (legacy && legacy.origin === this.#origin && legacy.ownerUserId === accountId) {
        if (legacy.registered) await this.#saveForAccount(legacy)
        return legacy
      }
    } catch { /* Runner 不可用时忽略旧账本 */ }
    return null
  }

  async #saveForAccount(device: SavedDevice): Promise<void> {
    const file = this.#accountFile(device.ownerUserId)
    if (!file) return
    await mkdir(join(this.#root, "local-devices"), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify(device), { mode: 0o600 })
    if (this.#identityKey === device.ownerUserId) this.#device = device
  }

  async #load(): Promise<SavedDevice | null> {
    if (!this.#identityKey) {
      this.#device = null
      return null
    }
    this.#device = await this.#loadForAccount(this.#identityKey)
    return this.#device
  }

  async #save(device: SavedDevice): Promise<void> {
    await this.#saveForAccount(device)
  }
}

function failure(code: Parameters<typeof identityError>[0], message: string) { return identityError(code, message) }
function denied() { return failure("AUTHENTICATION_REQUIRED", "请用当前设备所有者账号操作。") }
