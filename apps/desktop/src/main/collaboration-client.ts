/**
 * 主进程身份网络：具名方法 → wire 校验 → 固定服务 origin → 安全结果。
 * Cookie/CSRF 只存在于实例私有内存；UI/IPC 后续只消费业务 DTO，不获得网络或凭据入口。
 */
import { randomUUID } from "node:crypto"
import { Cookie, CookieJar } from "tough-cookie"
import { Ajv2020 } from "ajv/dist/2020.js"
import formats from "ajv-formats"
import platform from "@workbench/contracts/schema" with { type: "json" }
import type { CollaborationError, CollaborationResult, CsrfResponse, CurrentUserResponse, DemoUsersResponse, ErrorResponse, MembersResponse, MetaResponse, WorkspaceListResponse } from "@workbench/contracts"

type Transport = typeof fetch
type Session = { jar: CookieJar; csrf: string | null; abort: AbortController }
const messages: Record<CollaborationError["code"], string> = {
  INVALID_REQUEST: "请求参数无效", AUTHENTICATION_REQUIRED: "请先登录", DEMO_LOGIN_REJECTED: "演示账号不存在或已停用",
  CSRF_INVALID: "请求凭据已刷新，请重新执行操作", REQUEST_SOURCE_REJECTED: "请求来源不允许", RESOURCE_NOT_FOUND: "资源不可用",
  METHOD_NOT_ALLOWED: "请求方法不支持", UNSUPPORTED_MEDIA_TYPE: "请求正文必须使用 JSON", ALREADY_AUTHENTICATED: "请先退出当前账号",
  PAYLOAD_TOO_LARGE: "请求体过大", PROTOCOL_VERSION_UNSUPPORTED: "协议版本不支持", SERVICE_UNAVAILABLE: "服务连接暂不可用",
  INTERNAL_ERROR: "服务暂时无法处理请求", NETWORK_UNAVAILABLE: "无法确认服务连接，请重试读取", TLS_ERROR: "服务证书校验失败",
  INVALID_SERVER_RESPONSE: "服务响应不符合契约",
}
class ClientProblem extends Error {
  constructor(readonly code: CollaborationError["code"]) { super(code) }
}

/** 宿主内部客户端；transport 仅用于同一真实链路的冒烟控制，不通过 renderer 暴露。 */
export class CollaborationClient {
  readonly #origin: string
  readonly #transport: Transport
  readonly #ajv = new Ajv2020({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false })
  #session: Session = this.#emptySession()
  #closing = new Set<Session>()
  #disposed = false

  constructor(origin: string, transport: Transport = fetch) {
    let url: URL
    try { url = new URL(origin) } catch { throw new Error("服务地址无效") }
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) throw new Error("服务地址无效")
    this.#origin = origin
    this.#transport = transport
    // 此依赖发布为 CJS；NodeNext 按声明的 default 属性接入同一个格式插件。
    formats.default(this.#ajv)
    this.#ajv.addSchema(platform)
    for (const name of Object.keys(platform.$defs)) this.#validator(name)
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
    const validate = this.#ajv.getSchema(`${platform.$id}#/$defs/${name}`)
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
        if (size > 65536) { await reader.cancel(); throw new ClientProblem("INVALID_SERVER_RESPONSE") }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
    catch { throw new ClientProblem("INVALID_SERVER_RESPONSE") }
  }
  /** 只有内部固定路由能调用；每次异步结果先核对所属会话，旧响应不能写入新 Jar。 */
  async #call<T>(path: string, schema: string | null, method = "GET", input?: { username: string }, session = this.#session): Promise<CollaborationResult<T>> {
    const requestId = randomUUID()
    try {
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (input && !this.#validator("DemoLoginRequest")(input)) return this.#error("INVALID_REQUEST", requestId)
      const body = input ? JSON.stringify(input) : undefined
      if (body && Buffer.byteLength(body) > 16384) return this.#error("PAYLOAD_TOO_LARGE", requestId)
      const headers: Record<string, string> = { Origin: this.#origin, "X-Workbench-Protocol-Version": "1", "X-Request-Id": requestId }
      const cookie = await session.jar.getCookieString(this.#origin, { http: true, sameSiteContext: "strict" })
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (cookie) headers.Cookie = cookie
      if (method === "POST" && session.csrf) headers["X-CSRF-TOKEN"] = session.csrf
      if (body) headers["Content-Type"] = "application/json"
      const response = await this.#transport(`${this.#origin}${path}`, { method, headers, body, redirect: "manual", signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(10000)]) })
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
      if (response.status === 204 && schema === null) return { ok: true, value: null as T }
      const data = await this.#readJson(response)
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (!response.ok) {
        if (!this.#validator("ErrorResponse")(data)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
        const error = (data as ErrorResponse).error
        if (error.code === "AUTHENTICATION_REQUIRED" && response.status === 401 && session === this.#session) this.#discardSession()
        // 显式错误CSRF只刷新，不自动重放原写操作；失败不等于获得重试授权。
        if (error.code === "CSRF_INVALID") session.csrf = null
        return { ok: false, error: { ...error, message: messages[error.code] } }
      }
      if (response.status !== 200 || !schema || !this.#validator(schema)(data)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
      return { ok: true, value: data as T }
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
    const result = await this.#call<CsrfResponse>("/api/v1/auth/csrf", "CsrfResponse", "GET", undefined, session)
    if (result.ok && this.#live(session)) session.csrf = result.value.token
    return result
  }
  async #write<T>(path: string, schema: string | null, input?: { username: string }, session = this.#session): Promise<CollaborationResult<T>> {
    if (!session.csrf) { const token = await this.#csrf(session); if (!token.ok) return token }
    const result = await this.#call<T>(path, schema, "POST", input, session)
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
  async signIn(username: string): Promise<CollaborationResult<CurrentUserResponse>> {
    if (!this.#validator("DemoLoginRequest")({ username })) return this.#error("INVALID_REQUEST")
    const session = this.#session
    const result = await this.#write<CurrentUserResponse>("/api/v1/auth/demo-login", "CurrentUserResponse", { username }, session)
    if (!this.#live(session)) return this.#error("NETWORK_UNAVAILABLE")
    if (result.ok || (!result.ok && ["NETWORK_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(result.error.code))) {
      const token = await this.#csrf(session)
      if (!token.ok) return token
      if (!this.#live(session)) return this.#error("NETWORK_UNAVAILABLE")
      const confirmed = await this.#call<CurrentUserResponse>("/api/v1/auth/me", "CurrentUserResponse", "GET", undefined, session)
      if (!this.#live(session) && (confirmed.ok || confirmed.error.code !== "AUTHENTICATION_REQUIRED")) return this.#error("NETWORK_UNAVAILABLE")
      if (confirmed.ok) return confirmed.value.user.username === username ? confirmed : this.#error("INVALID_SERVER_RESPONSE")
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
      const result = await this.#write<null>("/api/v1/auth/logout", null, undefined, closing)
      if (!result.ok) return { ok: false, error: { ...result.error, message: "本机已退出，服务端退出未确认", retryable: false } }
      return result
    } finally {
      this.#closing.delete(closing); closing.abort.abort(); closing.csrf = null
      void closing.jar.removeAllCookies()
    }
  }
}
