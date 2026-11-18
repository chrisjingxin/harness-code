/**
 * 【功能定义】每个窗口独有的身份状态与工作区请求门面：
 * 具名动作 → 统一生产网络客户端 → 核对身份代次 → 发布安全视图。
 *
 * 【协作边界】
 * - 窗口关闭或退出立即递增代次并丢弃旧身份回包；这里只存内存态身份，不落盘凭据。
 * - `withWorkspace` 为主进程各 IPC/存储模块提供统一的工作区归属校验与代次隔离；
 *   保留 `applicationWorkspace` 与 `getProjectConversation` 供独立执行桥接 `local-execution-ipc.ts` 调用。
 */
import { randomUUID } from "node:crypto"
import type {
  CollaborationError, CollaborationResult, ConversationDetailResponse, CurrentUserResponse,
  DemoUsersResponse, IdentityState, MembersResponse,
} from "@workbench/contracts"
import { CollaborationClient } from "./collaboration-client.js"

/** IPC 和生命周期边界统一生成可序列化错误，不返回原生异常。 */
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

  /** origin 只来自宿主启动配置；缺失或无效时基础窗口仍可使用。 */
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

  /** 订阅只属于本窗口；取消函数和 dispose 均能解除监听。 */
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
  async signIn(userNo: string): Promise<CollaborationResult<CurrentUserResponse>> {
    if (this.#disposed) return this.#cancelled()
    if (!this.#client) return this.#unavailable()
    if (this.#state.status === "loading" || this.#state.status === "signedIn" || (this.#state.status === "connectionError" && this.#state.lastKnownUser)) return identityError("ALREADY_AUTHENTICATED", "请先退出当前账号。")
    const generation = ++this.#generation
    this.#publish({ status: "loading" })
    const result = await this.#client.signIn(userNo)
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
      // 客户端在首次 await 之前隔离旧 Jar、取消旧请求；远端退出另用旧 Jar 的独立上下文。
      const result = this.#client ? await this.#client.signOut() : this.#unavailable()
      if (!this.#current(generation)) return this.#cancelled()
      this.#publish({ status: "signedOut" })
      return result
    } finally { this.#exiting = false }
  }

  /** 只在身份确认后读取成员；不缓存跨身份结果，旧代回包不交付给 UI。 */
  async listMembers(workspaceId: string): Promise<CollaborationResult<MembersResponse>> {
    if (this.#disposed || this.#state.status !== "signedIn" || !this.#client) return this.#cancelled()
    const generation = this.#generation
    const result = await this.#client.listMembers(workspaceId)
    if (!this.#current(generation)) return this.#cancelled()
    if (!result.ok) this.#failure(result.error)
    return result
  }

  /**
   * 在当前已登录且属于指定工作区的身份代次下执行客户端请求；
   * 退出或切换账号后旧代次迟到的回包直接拦截，认证失效立即收回窗口身份。
   */
  async withWorkspace<T>(
    workspaceId: string,
    fn: (client: CollaborationClient) => Promise<CollaborationResult<T>>,
    options?: { publishConnectionError?: boolean },
  ): Promise<CollaborationResult<T>> {
    if (this.#disposed || this.#state.status !== "signedIn") return this.#cancelled()
    if (!this.#state.workspaces.some(workspace => workspace.id === workspaceId)) return identityError("RESOURCE_NOT_FOUND", "工作区不可用。")
    if (!this.#client) return this.#unavailable()
    const generation = this.#generation
    const result = await fn(this.#client)
    if (!this.#current(generation)) return this.#cancelled()
    const publishConnectionError = options?.publishConnectionError ?? true
    if (!result.ok && (publishConnectionError || result.error.code === "AUTHENTICATION_REQUIRED")) this.#failure(result.error)
    return result
  }

  /** 仅主进程使用。业务错误留在当前表单处理，认证失效仍立即收回窗口身份。 */
  applicationWorkspace<T>(workspaceId: string, request: (client: CollaborationClient) => Promise<CollaborationResult<T>>): Promise<CollaborationResult<T>> {
    return this.withWorkspace(workspaceId, request, { publishConnectionError: false })
  }

  /** 供 `local-execution-ipc.ts` 校验本机发送前的会话归属；通过统一工作区守卫执行。 */
  getProjectConversation(workspaceId: string, projectId: string, conversationId: string): Promise<CollaborationResult<ConversationDetailResponse>> {
    return this.withWorkspace(workspaceId, client => client.getProjectConversation(workspaceId, projectId, conversationId))
  }

  /** 仅主进程内部组合使用；调用方仍要按当前代次核对自己的异步结果。 */
  network(): CollaborationClient | null { return this.#client }

  /** 个人视图存储只读取当前窗口已确认的账号与工作区，并用代次隔离旧请求。 */
  personalIdentity(): { generation: number; accountId: string; workspaces: readonly string[] } | null {
    if (this.#disposed || this.#state.status !== "signedIn") return null
    return { generation: this.#generation, accountId: this.#state.user.id, workspaces: this.#state.workspaces.map(item => item.id) }
  }

  /** 销毁后不再发通知/接受业务；同一窗口重开将创建全新客户端。 */
  dispose(): void {
    this.#disposed = true; this.#generation++; this.#listeners.clear()
    this.#client?.dispose(); this.#state = { status: "signedOut" }
  }
}
