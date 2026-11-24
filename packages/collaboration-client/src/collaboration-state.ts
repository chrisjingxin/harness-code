/**
 * 【功能定义】身份状态与工作区请求门面：
 * 具名动作 → 统一网络客户端 → 核对身份代次 → 发布安全视图。
 *
 * 【协作边界】
 * - 零 Electron 依赖；退出登录、认证失效或实例销毁时立即递增代次，丢弃旧代次迟到的网络回包。
 * - `withWorkspace` 为各上层宿主或 CLI 提供统一的工作区成员归属校验与代次隔离。
 */
import { randomUUID } from "node:crypto"
import type {
  CollaborationError, CollaborationResult, ConversationDetailResponse, CurrentUserResponse,
  DemoUsersResponse, IdentityState, MembersResponse, WorkspaceSummary,
} from "./types/index.js"
import { CollaborationClient } from "./collaboration-client.js"

/** 边界统一生成可序列化业务错误，不向外泄露原生异常对象。 */
export function identityError(code: CollaborationError["code"], message: string): { ok: false; error: CollaborationError } {
  return { ok: false, error: { code, message, requestId: randomUUID(), retryable: code === "NETWORK_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE" } }
}

export class CollaborationState {
  #client: CollaborationClient | null = null
  #state: IdentityState = { status: "signedOut" }
  #lastKnownWorkspaces: WorkspaceSummary[] = []
  #refresh: Promise<CollaborationResult<CurrentUserResponse>> | null = null
  #workspaceRevisions = new Map<string, number>()
  #generation = 0
  #disposed = false
  #exiting = false
  #listeners = new Set<(state: IdentityState) => void>()

  /** origin 只来自宿主启动配置；缺失或无效时保持脱机安全态，基础壳层仍可使用。 */
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
    const previous = this.#state.status === "signedIn" ? this.#state.workspaces : this.#lastKnownWorkspaces
    const next = state.status === "signedIn" ? state.workspaces : []
    for (const id of new Set([...previous.map(w => w.id), ...next.map(w => w.id)])) {
      const a = previous.find(w => w.id === id), b = next.find(w => w.id === id)
      if (a?.accessVersion !== b?.accessVersion || a?.role !== b?.role || a?.memberVersion !== b?.memberVersion) this.#workspaceRevisions.set(id, (this.#workspaceRevisions.get(id) ?? 0) + 1)
    }
    this.#state = state
    if (state.status === "signedIn") {
      this.#lastKnownWorkspaces = structuredClone(state.workspaces)
    } else if (state.status === "signedOut") {
      this.#lastKnownWorkspaces = []
    }
    for (const listener of this.#listeners) listener(structuredClone(state))
  }
  #failure(error: CollaborationError) {
    if (error.code === "AUTHENTICATION_REQUIRED") { this.#generation++; this.#publish({ status: "signedOut" }); return }
    if (["NETWORK_UNAVAILABLE", "TLS_ERROR", "INVALID_SERVER_RESPONSE", "SERVICE_UNAVAILABLE", "INTERNAL_ERROR"].includes(error.code)) {
      const user = this.#state.status === "signedIn" ? this.#state.user : this.#state.status === "connectionError" ? this.#state.lastKnownUser : null
      if (!user) this.#lastKnownWorkspaces = []
      this.#publish({ status: "connectionError", lastKnownUser: user, error })
    }
  }

  /** 订阅属于当前门面实例；返回函数与 dispose 均能解除监听。 */
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

  /** 实际请求身份接口；合并并发刷新，账号代次与团队修订分别隔离。 */
  refreshIdentity(): Promise<CollaborationResult<CurrentUserResponse>> {
    if (this.#refresh) return this.#refresh
    if (this.#disposed || !this.#client || this.#state.status === "signedOut" || this.#state.status === "loading") return Promise.resolve(this.#cancelled())
    const generation = this.#generation
    const pending = this.#client.getCurrentUser().then(result => {
      if (!this.#current(generation)) return this.#cancelled()
      if (result.ok) this.#publish({ status: "signedIn", ...result.value })
      else this.#failure(result.error)
      return result
    }).finally(() => { if (this.#refresh === pending) this.#refresh = null })
    this.#refresh = pending
    return pending
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
    this.#lastKnownWorkspaces = []
    this.#publish({ status: "loading" })
    try {
      // 客户端在首次 await 之前隔离旧 Jar、取消旧请求；远端退出另用旧 Jar 的独立上下文。
      const result = this.#client ? await this.#client.signOut() : this.#unavailable()
      if (!this.#current(generation)) return this.#cancelled()
      this.#publish({ status: "signedOut" })
      return result
    } finally { this.#exiting = false }
  }

  /** 只在身份确认后读取成员；不缓存跨身份结果，旧代回包不交付给消费端。 */
  async listMembers(workspaceId: string): Promise<CollaborationResult<MembersResponse>> {
    if (this.#disposed || this.#state.status !== "signedIn" || !this.#client) return this.#cancelled()
    const generation = this.#generation
    const revision = this.#workspaceRevisions.get(workspaceId) ?? 0
    const result = await this.#client.listMembers(workspaceId)
    if (!this.#current(generation)) return this.#cancelled()
    if (revision !== (this.#workspaceRevisions.get(workspaceId) ?? 0)) return identityError("VERSION_CONFLICT", "团队权限已变化，请重新读取。")
    if (!result.ok) this.#failure(result.error)
    return result
  }

  /**
   * 在当前已登录且属于指定工作区的身份代次下执行客户端请求；
   * 退出或切换账号后旧代次迟到的回包直接拦截，认证失效立即收回当前身份。
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
    const revision = this.#workspaceRevisions.get(workspaceId) ?? 0
    const result = await fn(this.#client)
    if (!this.#current(generation)) return this.#cancelled()
    if (revision !== (this.#workspaceRevisions.get(workspaceId) ?? 0)) return identityError("VERSION_CONFLICT", "团队权限已变化，请重新读取。")
    if (!result.ok && ["WORKSPACE_MEMBER_REQUIRED", "WORKSPACE_ADMIN_REQUIRED"].includes(result.error.code)) await this.refreshIdentity()
    const publishConnectionError = options?.publishConnectionError ?? true
    if (!result.ok && (publishConnectionError || result.error.code === "AUTHENTICATION_REQUIRED")) this.#failure(result.error)
    return result
  }

  /**
   * 在当前已登录账号的身份代次下执行跨工作区账号级请求（如收件箱聚合、跨团队通知流与通知偏好）；
   * 退出或切换账号后旧代次迟到的回包直接拦截，认证失效立即收回当前身份。
   */
  async withAccount<T>(
    fn: (client: CollaborationClient) => Promise<CollaborationResult<T>>,
    options?: { publishConnectionError?: boolean },
  ): Promise<CollaborationResult<T>> {
    if (this.#disposed || this.#state.status !== "signedIn") return this.#cancelled()
    if (!this.#client) return this.#unavailable()
    const generation = this.#generation
    const result = await fn(this.#client)
    if (!this.#current(generation)) return this.#cancelled()
    if (!result.ok && ["WORKSPACE_MEMBER_REQUIRED", "WORKSPACE_ADMIN_REQUIRED"].includes(result.error.code)) {
      await this.refreshIdentity()
    }
    const publishConnectionError = options?.publishConnectionError ?? true
    if (!result.ok && (publishConnectionError || result.error.code === "AUTHENTICATION_REQUIRED")) this.#failure(result.error)
    return result
  }

  /** 业务错误留在当前调用处理，认证失效仍立即收回身份。 */
  applicationWorkspace<T>(workspaceId: string, request: (client: CollaborationClient) => Promise<CollaborationResult<T>>): Promise<CollaborationResult<T>> {
    return this.withWorkspace(workspaceId, request, { publishConnectionError: false })
  }

  /** 校验本机发送或加载前的项目会话归属；通过统一工作区守卫执行。 */
  getProjectConversation(workspaceId: string, projectId: string, conversationId: string): Promise<CollaborationResult<ConversationDetailResponse>> {
    return this.withWorkspace(workspaceId, client => client.getProjectConversation(workspaceId, projectId, conversationId))
  }

  /** 会话创建者停止继续向团队同步该会话；通过统一工作区守卫执行。 */
  stopProjectConversationSharing(workspaceId: string, projectId: string, conversationId: string): Promise<CollaborationResult<ConversationDetailResponse>> {
    return this.withWorkspace(workspaceId, client => client.stopProjectConversationSharing(workspaceId, projectId, conversationId))
  }

  /** 仅宿主或 SDK 内部组合使用；调用方仍要按当前代次核对异步结果。 */
  network(): CollaborationClient | null { return this.#client }

  /** 提取当前已确认的账号、工作区与身份代次快照；在断网续用态（connectionError + lastKnownUser）下保留只读/本机离线身份。 */
  personalIdentity(): { generation: number; accountId: string; workspaces: readonly string[]; offline: boolean } | null {
    if (this.#disposed) return null
    if (this.#state.status === "signedIn") {
      return {
        generation: this.#generation,
        accountId: this.#state.user.id,
        workspaces: this.#state.workspaces.map(item => item.id),
        offline: false,
      }
    }
    if (this.#state.status === "connectionError" && this.#state.lastKnownUser) {
      return {
        generation: this.#generation,
        accountId: this.#state.lastKnownUser.id,
        workspaces: this.#lastKnownWorkspaces.map(item => item.id),
        offline: true,
      }
    }
    return null
  }

  /** 销毁后不再发通知/接受业务；重开需创建全新实例。 */
  dispose(): void {
    this.#disposed = true; this.#generation++; this.#listeners.clear()
    this.#lastKnownWorkspaces = []
    this.#client?.dispose(); this.#state = { status: "signedOut" }
  }
}
