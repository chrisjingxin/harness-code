/**
 * 每个窗口独有的身份状态：具名动作 → 同一生产网络客户端 → 核对代次 → 发布安全视图。
 * 窗口关闭/退出立即取消旧身份；这里只存一份身份状态，不存设备身份或磁盘缓存。
 */
import { randomUUID } from "node:crypto"
import type { CollaborationError, CollaborationResult, CurrentUserResponse, DemoUsersResponse, IdentityState, MembersResponse } from "@workbench/contracts"
import { CollaborationClient } from "./collaboration-client.js"

/** IPC和生命周期边界统一生成可序列化错误，不返回原生异常。 */
export function identityError(code: CollaborationError["code"], message: string): { ok: false; error: CollaborationError } {
  return { ok: false, error: { code, message, requestId: randomUUID(), retryable: code === "NETWORK_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE" } }
}

export class CollaborationState {
  #client: CollaborationClient | null = null
  #state: IdentityState = { status: "signedOut" }
  #generation = 0
  #disposed = false
  #exiting = false
  #listeners = new Set<(state: IdentityState) => void>()

  /** origin只来自宿主启动配置；缺失或无效时基础窗口仍可使用。 */
  constructor(origin?: string, transport?: typeof fetch) {
    try {
      if (!origin) throw new Error("未配置")
      this.#client = new CollaborationClient(origin, transport)
    } catch {
      this.#state = { status: "connectionError", lastKnownUser: null, error: identityError("NETWORK_UNAVAILABLE", "协作服务地址未配置或无效，请配置后重启。").error }
    }
  }
  #current(generation: number) { return !this.#disposed && generation === this.#generation }
  #cancelled() { return identityError("AUTHENTICATION_REQUIRED", "身份操作已结束，请确认当前账号。") }
  #unavailable() { return identityError("NETWORK_UNAVAILABLE", "协作服务不可用，请检查连接后重试。") }
  #publish(state: IdentityState) {
    this.#state = state
    for (const listener of this.#listeners) listener(structuredClone(state))
  }
  #failure(error: CollaborationError) {
    if (error.code === "AUTHENTICATION_REQUIRED") { this.#generation++; this.#publish({ status: "signedOut" }); return }
    if (["NETWORK_UNAVAILABLE", "TLS_ERROR", "INVALID_SERVER_RESPONSE", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"].includes(error.code)) {
      const user = this.#state.status === "signedIn" ? this.#state.user : this.#state.status === "connectionError" ? this.#state.lastKnownUser : null
      this.#publish({ status: "connectionError", lastKnownUser: user, error })
    }
  }
  /** 订阅只属于本窗口；取消函数和dispose均能解除监听。 */
  onStateChanged(listener: (state: IdentityState) => void): () => void {
    if (this.#disposed) return () => {}
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  /** 读取安全状态；连接恢复时重新向服务确认上次身份，不直接恢复旧工作区。 */
  async getState(): Promise<CollaborationResult<IdentityState>> {
    if (this.#disposed) return this.#cancelled()
    // 断连后的“上次身份”不能直接恢复为已登录，必须由服务器重新确认。
    if (this.#client && this.#state.status === "connectionError" && this.#state.lastKnownUser) {
      const generation = this.#generation
      const result = await this.#client.getCurrentUser()
      if (!this.#current(generation)) return this.#cancelled()
      if (result.ok) this.#publish({ status: "signedIn", ...result.value })
      else this.#failure(result.error)
    }
    return { ok: true, value: structuredClone(this.#state) }
  }
  /** 匿名演示列表也来自服务；读取失败不生成本地账号。 */
  async listDemoUsers(): Promise<CollaborationResult<DemoUsersResponse>> {
    if (this.#disposed) return this.#cancelled()
    if (!this.#client) return this.#unavailable()
    const generation = this.#generation
    const result = await this.#client.listDemoUsers()
    if (!this.#current(generation)) return this.#cancelled()
    if (!result.ok) this.#failure(result.error)
    else if (this.#state.status === "connectionError" && !this.#state.lastKnownUser) this.#publish({ status: "signedOut" })
    return result
  }
  /** 完整登录确认属于同一代操作；已有身份或正在退出时禁止覆盖登录。 */
  async signIn(username: string): Promise<CollaborationResult<CurrentUserResponse>> {
    if (this.#disposed) return this.#cancelled()
    if (!this.#client) return this.#unavailable()
    if (this.#state.status === "loading" || this.#state.status === "signedIn" || (this.#state.status === "connectionError" && this.#state.lastKnownUser)) return identityError("ALREADY_AUTHENTICATED", "请先退出当前账号。")
    const generation = ++this.#generation
    this.#publish({ status: "loading" })
    const result = await this.#client.signIn(username)
    if (!this.#current(generation)) return this.#cancelled()
    if (result.ok) this.#publish({ status: "signedIn", ...result.value })
    else { this.#publish({ status: "signedOut" }); this.#failure(result.error) }
    return result
  }
  /** 开始即停止旧业务；远端失败仍回到本机已退出，并返回未确认的事实。 */
  async signOut(): Promise<CollaborationResult<null>> {
    if (this.#disposed) return this.#cancelled()
    if (this.#exiting) return identityError("INVALID_REQUEST", "正在退出，请稍候。")
    const generation = ++this.#generation
    this.#exiting = true
    this.#publish({ status: "loading" })
    try {
      // 客户端在首次await之前隔离旧Jar、取消旧请求；远端退出另用旧Jar的独立上下文。
      const result = this.#client ? await this.#client.signOut() : this.#unavailable()
      if (!this.#current(generation)) return this.#cancelled()
      this.#publish({ status: "signedOut" })
      return result
    } finally { this.#exiting = false }
  }
  /** 只在身份确认后读取成员；不缓存跨身份结果，旧代回包不交付给UI。 */
  async listMembers(workspaceId: string): Promise<CollaborationResult<MembersResponse>> {
    if (this.#disposed || this.#state.status !== "signedIn" || !this.#client) return this.#cancelled()
    const generation = this.#generation
    const result = await this.#client.listMembers(workspaceId)
    if (!this.#current(generation)) return this.#cancelled()
    if (!result.ok) this.#failure(result.error)
    return result
  }
  /** 仅主进程内部组合使用；调用方仍要按当前代次核对自己的异步结果。 */
  network(): CollaborationClient | null { return this.#client }

  /** 销毁后不再发通知/接受业务；同一窗口重开将创建全新客户端。 */
  dispose(): void {
    this.#disposed = true; this.#generation++; this.#listeners.clear()
    this.#client?.dispose(); this.#state = { status: "signedOut" }
  }
}
