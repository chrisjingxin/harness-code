/**
 * 主进程网络：具名方法 → wire 校验 → 固定服务 origin → 安全结果。
 * 身份、会话与设备共用同一 Cookie/CSRF 实例；SSE 只走具名解析器，不暴露给 renderer。
 */
import { randomUUID } from "node:crypto"
import { Cookie, CookieJar } from "tough-cookie"
import { Ajv2020 } from "ajv/dist/2020.js"
import formats from "ajv-formats"
import platform from "@workbench/contracts/schema/platform" with { type: "json" }
import conversationSchema from "@workbench/contracts/schema/conversation" with { type: "json" }
import executionSchema from "@workbench/contracts/schema/execution" with { type: "json" }
import deviceSchema from "@workbench/contracts/schema/device" with { type: "json" }
import projectSchema from "@workbench/contracts/schema/project" with { type: "json" }
import organizationSchema from "@workbench/contracts/schema/organization" with { type: "json" }
import type {
  BeeResponseEntity, CollaborationError, CollaborationResult, CsrfResponse, CurrentUserResponse, DemoUsersResponse, ErrorEnvelope,
  MembersResponse, MetaResponse, WorkspaceListResponse,
  DeviceListResponse, DeviceRegistrationRequest, DeviceRegistrationResponse, DeviceRevokeRequest, DeviceRevokedResponse,
  ConversationDetailResponse, ConversationHistoryResponse, ConversationListResponse, ConversationRegisterRequest, ConversationStatus,
  ProjectCreateRequest, ProjectDetailResponse, ProjectListResponse, ProjectMemberAddRequest, ProjectMemberChangeResponse,
  ProjectPatchRequest, ProjectResponse, RepositoryListResponse,
} from "@workbench/contracts"

type Transport = typeof fetch
type WriteMethod = "POST" | "PATCH" | "PUT" | "DELETE"
type Session = { jar: CookieJar; csrf: string | null; abort: AbortController }
const messages: Record<CollaborationError["code"], string> = {
  INVALID_REQUEST: "请求参数无效", AUTHENTICATION_REQUIRED: "请先登录", DEMO_LOGIN_REJECTED: "演示账号不存在或已停用",
  CSRF_INVALID: "请求凭据已刷新，请重新执行操作", REQUEST_SOURCE_REJECTED: "请求来源不允许", RESOURCE_NOT_FOUND: "资源不可用",
  METHOD_NOT_ALLOWED: "请求方法不支持", UNSUPPORTED_MEDIA_TYPE: "请求正文必须使用 JSON", ALREADY_AUTHENTICATED: "请先退出当前账号",
  PAYLOAD_TOO_LARGE: "请求体过大", PROTOCOL_VERSION_UNSUPPORTED: "协议版本不支持", SERVICE_UNAVAILABLE: "服务连接暂不可用",
  INTERNAL_ERROR: "服务暂时无法处理请求", NETWORK_UNAVAILABLE: "无法确认服务连接，请重试读取", TLS_ERROR: "服务证书校验失败",
  INVALID_SERVER_RESPONSE: "服务响应不符合契约", REQUEST_ID_CONFLICT: "请求编号已用于其他操作",
  REGISTRATION_CONFLICT: "设备标识已被占用",
  DEVICE_AUTHENTICATION_REQUIRED: "设备凭据已失效", DEVICE_ACTION_REJECTED: "当前账号不能管理该设备",
  CURSOR_AHEAD: "事件位置超出已提交范围", PROJECT_NOT_SHARED: "项目未共享或已停止共享",
  TARGET_UNAVAILABLE: "目标设备或执行配置不可用", EXECUTION_STATE_CONFLICT: "执行状态已变化，请刷新",
  SHARE_VERSION_CONFLICT: "共享版本已变化，请刷新后重试",
  WORKSPACE_MEMBER_REQUIRED: "请先加入该团队", PROJECT_OWNER_REQUIRED: "仅项目负责人可执行该操作",
  DEVICE_FORBIDDEN: "设备无权执行该操作", REPOSITORY_CONFLICT: "仓库地址已被登记",
  VERSION_CONFLICT: "数据已被他人修改，请刷新后重试", PROJECT_ARCHIVED: "项目已归档",
  REPOSITORY_ARCHIVED: "仓库已归档", OWNER_CANNOT_LEAVE: "项目负责人不能移出自己",
  SEQUENCE_CONFLICT: "消息序号与服务端水位不一致，请按 expectedSequence 续传",
  PROJECT_READ_UNAVAILABLE: "设备尚未接入项目读取", PROJECT_READ_BUSY: "项目读取繁忙，请稍后重试",
  PROJECT_READ_TIMEOUT: "项目读取超时，请重试", PROJECT_SOURCE_UNKNOWN: "项目来源尚未确认",
  PROJECT_REPOSITORY_DENIED: "当前账号没有仓库读取权限", PROJECT_IDENTITY_UNBOUND: "当前账号尚未绑定 Git 身份",
  PROJECT_AUTH_UNAVAILABLE: "仓库权限暂时无法核验", PROJECT_ROOT_CHANGED: "原设备项目目录已变化",
  PROJECT_BUSY: "原设备项目繁忙", PROJECT_PATH_INVALID: "项目路径无效",
  PROJECT_FILE_NOT_FOUND: "项目文件不存在", PROJECT_FILE_DENIED: "原设备没有文件读取权限",
  PROJECT_FILE_UNSUPPORTED: "项目文件暂不支持预览", PROJECT_FILE_CHANGED: "项目文件已变化，请刷新",
  PROJECT_CURSOR_EXPIRED: "目录已变化，请重新加载", PROJECT_LIMIT_EXCEEDED: "项目内容超出读取限制",
  PROJECT_GIT_UNAVAILABLE: "Git 状态暂不可用", PROJECT_GIT_ROOT_REQUIRED: "请登记完整仓库根目录",
  PROJECT_GIT_STALE: "Git 状态已变化，请刷新", PROJECT_READ_FAILED: "项目读取失败",
}
class ClientProblem extends Error {
  constructor(readonly code: CollaborationError["code"]) { super(code) }
}
interface CallOptions { body?: unknown; inputSchema?: string; query?: Record<string, string>; session?: Session }

/** 宿主内部客户端；transport 仅用于同一真实链路的冒烟控制，不通过 renderer 暴露。 */
export class CollaborationClient {
  readonly #origin: string
  readonly #transport: Transport
  readonly #ajv = new Ajv2020({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false })
  readonly #types = new Map<string, string>()
  #session: Session = this.#emptySession()
  #closing = new Set<Session>()
  #disposed = false

  constructor(origin: string, transport: Transport = fetch) {
    let url: URL
    try { url = new URL(origin) } catch { throw new Error("服务地址无效") }
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || url.protocol === "http:")) throw new Error("服务地址无效")
    this.#origin = origin
    this.#transport = transport
    formats.default(this.#ajv)
    // 类型统一按"Schema 名#类型名"定位；只在所有 Schema 中唯一的类型名才允许省略前缀，重名类型必须写全。
    const schemas = { platform, conversation: conversationSchema, execution: executionSchema, device: deviceSchema, project: projectSchema, organization: organizationSchema }
    const bare = new Map<string, string | null>()
    for (const [key, schema] of Object.entries(schemas)) {
      this.#ajv.addSchema(schema)
      for (const name of Object.keys(schema.$defs)) {
        const target = `${schema.$id}#/$defs/${name}`
        this.#types.set(`${key}#${name}`, target)
        bare.set(name, bare.has(name) ? null : target)
      }
    }
    for (const [name, target] of bare) if (target) this.#types.set(name, target)
  }
  #emptySession(): Session { return { jar: new CookieJar(undefined, { prefixSecurity: "strict" }), csrf: null, abort: new AbortController() } }
  #discardSession() {
    this.#session.abort.abort()
    this.#session = this.#emptySession()
  }
  #live(session: Session) { return !this.#disposed && (session === this.#session || this.#closing.has(session)) }
  /** 窗口关闭只释放本机身份；取消在途读取/退出，绝不修改未来设备凭据。 */
  dispose(): void {
    this.#disposed = true
    for (const session of [this.#session, ...this.#closing]) {
      session.abort.abort(); session.csrf = null
      void session.jar.removeAllCookies()
    }
    this.#closing.clear()
  }
  #validator(name: string) {
    const target = this.#types.get(name)
    const validate = target ? this.#ajv.getSchema(target) : undefined
    if (!validate) throw new ClientProblem("INVALID_SERVER_RESPONSE")
    return validate
  }
  #error(code: CollaborationError["code"], requestId = randomUUID()): { ok: false; error: CollaborationError } {
    return { ok: false, error: { code, message: messages[code], requestId, retryable: code === "NETWORK_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE" } }
  }
  async #readJson(response: Response): Promise<unknown> {
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) throw new ClientProblem("INVALID_SERVER_RESPONSE")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1_048_576) { await reader.cancel(); throw new ClientProblem("INVALID_SERVER_RESPONSE") }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
    catch { throw new ClientProblem("INVALID_SERVER_RESPONSE") }
  }
  async #call<T>(path: string, schema: string | null, method = "GET", options: CallOptions = {}): Promise<CollaborationResult<T>> {
    const requestId = randomUUID()
    const session = options.session ?? this.#session
    try {
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (options.body !== undefined && options.inputSchema && !this.#validator(options.inputSchema)(options.body)) return this.#error("INVALID_REQUEST", requestId)
      const body = options.body === undefined ? undefined : JSON.stringify(options.body)
      if (body && Buffer.byteLength(body) > 1_048_576) return this.#error("PAYLOAD_TOO_LARGE", requestId)
      const query = options.query ? "?" + new URLSearchParams(options.query).toString() : ""
      const headers: Record<string, string> = { Origin: this.#origin, "X-Workbench-Protocol-Version": "1", "X-Request-Id": requestId }
      const cookie = await session.jar.getCookieString(this.#origin, { http: true, sameSiteContext: "strict" })
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (cookie) headers.Cookie = cookie
      if (method !== "GET" && session.csrf) headers["X-CSRF-TOKEN"] = session.csrf
      if (body) headers["Content-Type"] = "application/json"
      const response = await this.#transport(`${this.#origin}${path}${query}`, { method, headers, body, redirect: "manual", signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(10000)]) })
      if (!this.#live(session)) { void response.body?.cancel().catch(() => {}); throw new ClientProblem("NETWORK_UNAVAILABLE") }
      if (response.status >= 300 && response.status < 400) throw new ClientProblem("INVALID_SERVER_RESPONSE")
      for (const header of response.headers.getSetCookie()) {
        const parsed = Cookie.parse(header)
        if (!parsed || parsed.key !== "WBSESSION" || parsed.domain || parsed.path !== "/") throw new ClientProblem("INVALID_SERVER_RESPONSE")
        const deleting = parsed.value === "" && (parsed.maxAge === 0 || (parsed.expires instanceof Date && parsed.expires.getTime() <= Date.now()))
        if (!deleting && (!parsed.httpOnly || parsed.sameSite !== "strict" || (this.#origin.startsWith("https:") && !parsed.secure))) throw new ClientProblem("INVALID_SERVER_RESPONSE")
        if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
        await session.jar.setCookie(parsed, this.#origin, { http: true })
        if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      }
      // 无正文的成功响应只对声明无返回值的写操作有效。
      if (response.status === 204) {
        void response.body?.cancel().catch(() => {})
        if (schema !== null || method === "GET") throw new ClientProblem("INVALID_SERVER_RESPONSE")
        return { ok: true, value: null as T }
      }
      const data = await this.#readJson(response)
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (!response.ok) {
        if (!this.#validator("ErrorEnvelope")(data)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
        const envelope = data as ErrorEnvelope
        const error = envelope.body
        if (error.code === "AUTHENTICATION_REQUIRED" && response.status === 401 && session === this.#session) this.#discardSession()
        if (error.code === "CSRF_INVALID") session.csrf = null
        return { ok: false, error: { ...error, message: messages[error.code] ?? envelope.errorMsg } }
      }
      if ((response.status !== 200 && response.status !== 201) || !this.#validator("BeeResponseEntity")(data)
        || (data as BeeResponseEntity<unknown>).returnCode !== "SUC0000") throw new ClientProblem("INVALID_SERVER_RESPONSE")
      const value = (data as BeeResponseEntity<unknown>).body
      if (schema === null) return { ok: true, value: null as T }
      if (!this.#validator(schema)(value)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
      return { ok: true, value: value as T }
    } catch (e) {
      if (e instanceof ClientProblem) return this.#error(e.code, requestId)
      let cause: unknown = e
      for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
        const value = cause as { code?: unknown; cause?: unknown }
        if (typeof value.code === "string" && /CERT|TLS|SELF_SIGNED|ISSUER/.test(value.code)) return this.#error("TLS_ERROR", requestId)
        cause = value.cause
      }
      return this.#error("NETWORK_UNAVAILABLE", requestId)
    }
  }
  async #csrf(session: Session) {
    const result = await this.#call<CsrfResponse>("/api/v1/auth/csrf", "CsrfResponse", "GET", { session })
    if (result.ok && this.#live(session)) session.csrf = result.value.token
    return result
  }
  async #write<T>(path: string, schema: string | null, options: CallOptions = {}, method: WriteMethod = "POST"): Promise<CollaborationResult<T>> {
    const session = options.session ?? this.#session
    if (!session.csrf) { const token = await this.#csrf(session); if (!token.ok) return token }
    const result = await this.#call<T>(path, schema, method, { ...options, session })
    if (!result.ok && result.error.code === "CSRF_INVALID" && this.#live(session)) await this.#csrf(session)
    return result
  }

  getMeta(): Promise<CollaborationResult<MetaResponse>> { return this.#call("/api/v1/meta", "MetaResponse") }
  listDemoUsers(): Promise<CollaborationResult<DemoUsersResponse>> { return this.#call("/api/v1/auth/demo-users", "DemoUsersResponse") }
  getCurrentUser(): Promise<CollaborationResult<CurrentUserResponse>> { return this.#call("/api/v1/auth/me", "CurrentUserResponse") }
  listWorkspaces(): Promise<CollaborationResult<WorkspaceListResponse>> { return this.#call("/api/v1/workspaces", "WorkspaceListResponse") }
  listMembers(workspaceId: string): Promise<CollaborationResult<MembersResponse>> {
    if (!this.#validator("Id")(workspaceId)) return Promise.resolve(this.#error("INVALID_REQUEST"))
    return this.#call(`/api/v1/workspaces/${workspaceId}/members`, "MembersResponse")
  }
  /** 登录响应丢失后只查询同一 Jar 的 /me，绝不盲目再次 POST 登录。 */
  async signIn(userNo: string): Promise<CollaborationResult<CurrentUserResponse>> {
    if (!this.#validator("DemoLoginRequest")({ userNo })) return this.#error("INVALID_REQUEST")
    const session = this.#session
    const result = await this.#write<CurrentUserResponse>("/api/v1/auth/demo-login", "CurrentUserResponse", { body: { userNo }, inputSchema: "DemoLoginRequest", session })
    if (!this.#live(session)) return this.#error("NETWORK_UNAVAILABLE")
    if (result.ok || (!result.ok && ["NETWORK_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(result.error.code))) {
      const token = await this.#csrf(session)
      if (!token.ok) return token
      if (!this.#live(session)) return this.#error("NETWORK_UNAVAILABLE")
      const confirmed = await this.#call<CurrentUserResponse>("/api/v1/auth/me", "CurrentUserResponse", "GET", { session })
      if (!this.#live(session) && (confirmed.ok || confirmed.error.code !== "AUTHENTICATION_REQUIRED")) return this.#error("NETWORK_UNAVAILABLE")
      if (confirmed.ok) return confirmed.value.user.userNo === userNo ? confirmed : this.#error("INVALID_SERVER_RESPONSE")
      return result.ok ? confirmed : result
    }
    return result
  }
  /** 先隔离本机身份再尝试远端退出；退出专用上下文只使用旧Jar，不可能清除新会话。 */
  async signOut(): Promise<CollaborationResult<null>> {
    if (this.#disposed) return this.#error("NETWORK_UNAVAILABLE")
    const old = this.#session
    const closing: Session = { jar: old.jar, csrf: old.csrf, abort: new AbortController() }
    this.#closing.add(closing)
    this.#discardSession()
    try {
      const result = await this.#write<null>("/api/v1/auth/logout", null, { session: closing })
      if (!result.ok) return { ok: false, error: { ...result.error, message: "本机已退出，服务端退出未确认", retryable: false } }
      return result
    } finally {
      this.#closing.delete(closing); closing.abort.abort(); closing.csrf = null
      void closing.jar.removeAllCookies()
    }
  }

  /** 项目级会话只读与登记接口：统一消费 HC-211 服务端路由并按 organization Schema 校验报文。 */
  listProjectConversations(workspaceId: string, projectId: string, query: { ownerId?: string; status?: ConversationStatus } = {}): Promise<CollaborationResult<ConversationListResponse>> {
    if (!this.#validator("Id")(workspaceId) || !this.#validator("Id")(projectId)) return Promise.resolve(this.#error("INVALID_REQUEST"))
    const params: Record<string, string> = {}
    if (query.ownerId !== undefined) {
      if (!this.#validator("platform#UserId")(query.ownerId)) return Promise.resolve(this.#error("INVALID_REQUEST"))
      params.ownerId = query.ownerId
    }
    if (query.status !== undefined) {
      if (!this.#validator("organization#ConversationStatus")(query.status)) return Promise.resolve(this.#error("INVALID_REQUEST"))
      params.status = query.status
    }
    return this.#call(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/conversations`,
      "organization#ConversationListResponse",
      "GET",
      Object.keys(params).length ? { query: params } : {},
    )
  }
  registerProjectConversation(workspaceId: string, projectId: string, request: ConversationRegisterRequest): Promise<CollaborationResult<ConversationDetailResponse>> {
    if (!this.#validator("Id")(workspaceId) || !this.#validator("Id")(projectId)) return Promise.resolve(this.#error("INVALID_REQUEST"))
    return this.#write(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/conversations`,
      "organization#ConversationDetailResponse",
      { body: request, inputSchema: "organization#ConversationRegisterRequest" },
    )
  }
  getProjectConversation(workspaceId: string, projectId: string, conversationId: string): Promise<CollaborationResult<ConversationDetailResponse>> {
    if (!this.#validator("Id")(workspaceId) || !this.#validator("Id")(projectId) || !this.#validator("Id")(conversationId)) {
      return Promise.resolve(this.#error("INVALID_REQUEST"))
    }
    return this.#call(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/conversations/${conversationId}`,
      "organization#ConversationDetailResponse",
    )
  }
  readProjectConversationHistory(workspaceId: string, projectId: string, conversationId: string, afterSequence: number, limit = 200): Promise<CollaborationResult<ConversationHistoryResponse>> {
    if (!this.#validator("Id")(workspaceId) || !this.#validator("Id")(projectId) || !this.#validator("Id")(conversationId)
      || !Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      return Promise.resolve(this.#error("INVALID_REQUEST"))
    }
    return this.#call(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/conversations/${conversationId}/history`,
      "organization#ConversationHistoryResponse",
      "GET",
      { query: { afterSequence: String(afterSequence), limit: String(limit) } },
    )
  }

  registerDevice(workspaceId: string, request: DeviceRegistrationRequest): Promise<CollaborationResult<DeviceRegistrationResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/devices`, "DeviceRegistrationResponse", { body: request, inputSchema: "DeviceRegistrationRequest" })
  }
  listDevices(workspaceId: string, query: Record<string, string> = {}): Promise<CollaborationResult<DeviceListResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/devices`, "DeviceListResponse", "GET", { query })
  }
  revokeDevice(workspaceId: string, deviceId: string, request: DeviceRevokeRequest): Promise<CollaborationResult<DeviceRevokedResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/devices/${deviceId}/revoke`, "DeviceRevokedResponse", { body: request, inputSchema: "DeviceRevokeRequest" })
  }

  /** 组织层：项目、成员与仓库目录。路径参数由 IPC 先校验为 UUID，请求体按组织层 Schema 校验。 */
  listProjects(workspaceId: string): Promise<CollaborationResult<ProjectListResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/projects`, "organization#ProjectListResponse")
  }
  createProject(workspaceId: string, request: ProjectCreateRequest): Promise<CollaborationResult<ProjectResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects`, "organization#ProjectResponse", { body: request, inputSchema: "organization#ProjectCreateRequest" })
  }
  getProject(workspaceId: string, projectId: string): Promise<CollaborationResult<ProjectDetailResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/projects/${projectId}`, "organization#ProjectDetailResponse")
  }
  updateProject(workspaceId: string, projectId: string, request: ProjectPatchRequest): Promise<CollaborationResult<ProjectResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects/${projectId}`, "organization#ProjectResponse", { body: request, inputSchema: "organization#ProjectPatchRequest" }, "PATCH")
  }
  addProjectMember(workspaceId: string, projectId: string, request: ProjectMemberAddRequest): Promise<CollaborationResult<ProjectMemberChangeResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/members`, "organization#ProjectMemberChangeResponse", { body: request, inputSchema: "organization#ProjectMemberAddRequest" })
  }
  removeProjectMember(workspaceId: string, projectId: string, userId: string): Promise<CollaborationResult<ProjectMemberChangeResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/members/${userId}`, "organization#ProjectMemberChangeResponse", {}, "DELETE")
  }
  listRepositories(workspaceId: string): Promise<CollaborationResult<RepositoryListResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/repositories`, "organization#RepositoryListResponse")
  }
  linkRepository(workspaceId: string, projectId: string, repositoryId: string): Promise<CollaborationResult<null>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/repositories/${repositoryId}`, null, {}, "PUT")
  }
  unlinkRepository(workspaceId: string, projectId: string, repositoryId: string): Promise<CollaborationResult<null>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/repositories/${repositoryId}`, null, {}, "DELETE")
  }
}
