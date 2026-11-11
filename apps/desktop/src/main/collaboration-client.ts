/**
 * 主进程网络：具名方法 → wire 校验 → 固定服务 origin → 安全结果。
 * 身份、会话与设备共用同一 Cookie/CSRF 实例；SSE 只走具名解析器，不暴露给 renderer。
 */
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Cookie, CookieJar } from "tough-cookie"
import { Ajv2020 } from "ajv/dist/2020.js"
import formats from "ajv-formats"
import platform from "@workbench/contracts/schema/platform" with { type: "json" }
import conversationSchema from "@workbench/contracts/schema/conversation" with { type: "json" }
import executionSchema from "@workbench/contracts/schema/execution" with { type: "json" }
import deviceSchema from "@workbench/contracts/schema/device" with { type: "json" }
import projectSchema from "@workbench/contracts/schema/project" with { type: "json" }
import type {
  CollaborationError, CollaborationResult, CsrfResponse, CurrentUserResponse, DemoUsersResponse, ErrorResponse,
  MembersResponse, MetaResponse, WorkspaceListResponse, ConversationListResponse, ConversationResponse,
  CreateConversationRequest, CreateConversationResponse, SendInputRequest, InputSavedResponse, ExecutionResponse,
  CancelExecutionRequest, CancelExecutionResponse, HistoryResponse, ConversationEvent,
  DeviceListResponse, DeviceRegistrationRequest, DeviceRegistrationResponse, ProjectListResponse,
  DeviceRevokeRequest, DeviceRevokedResponse, ProjectStopSharingRequest, ProjectSavedResponse, ProjectReadAction, ProjectReadResponse,
} from "@workbench/contracts"

type Transport = typeof fetch
type Session = { jar: CookieJar; csrf: string | null; abort: AbortController }
const messages: Record<CollaborationError["code"], string> = {
  INVALID_REQUEST: "请求参数无效", AUTHENTICATION_REQUIRED: "请先登录", DEMO_LOGIN_REJECTED: "演示账号不存在或已停用",
  CSRF_INVALID: "请求凭据已刷新，请重新执行操作", REQUEST_SOURCE_REJECTED: "请求来源不允许", RESOURCE_NOT_FOUND: "资源不可用",
  METHOD_NOT_ALLOWED: "请求方法不支持", UNSUPPORTED_MEDIA_TYPE: "请求正文必须使用 JSON", ALREADY_AUTHENTICATED: "请先退出当前账号",
  PAYLOAD_TOO_LARGE: "请求体过大", PROTOCOL_VERSION_UNSUPPORTED: "协议版本不支持", SERVICE_UNAVAILABLE: "服务连接暂不可用",
  INTERNAL_ERROR: "服务暂时无法处理请求", NETWORK_UNAVAILABLE: "无法确认服务连接，请重试读取", TLS_ERROR: "服务证书校验失败",
  INVALID_SERVER_RESPONSE: "服务响应不符合契约", REQUEST_ID_CONFLICT: "请求编号已用于其他操作", CURSOR_AHEAD: "事件位置超出已提交范围",
  PROJECT_NOT_SHARED: "项目未共享或已停止共享", TARGET_UNAVAILABLE: "目标设备或执行配置不可用",
  EXECUTION_STATE_CONFLICT: "执行状态已变化，请刷新", REGISTRATION_CONFLICT: "设备标识已被占用",
  DEVICE_AUTHENTICATION_REQUIRED: "设备凭据已失效", DEVICE_ACTION_REJECTED: "当前账号不能管理该设备",
  SHARE_VERSION_CONFLICT: "共享版本已变化，请刷新后重试",
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
  constructor(readonly code: CollaborationError["code"], readonly rebuildProjection = false) { super(code) }
}
interface CallOptions { body?: unknown; inputSchema?: string; query?: Record<string, string>; session?: Session }
interface StreamHandle { close(): void }
type StreamConnection = "connecting" | "connected" | "reconnecting" | "stopped"

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
      !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) throw new Error("服务地址无效")
    this.#origin = origin
    this.#transport = transport
    formats.default(this.#ajv)
    for (const schema of [platform, conversationSchema, executionSchema, deviceSchema, projectSchema]) {
      this.#ajv.addSchema(schema)
      for (const name of Object.keys(schema.$defs)) this.#types.set(name, `${schema.$id}#/$defs/${name}`)
    }
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
      if (method === "POST" && session.csrf) headers["X-CSRF-TOKEN"] = session.csrf
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
      if (response.status === 204 && schema === null) return { ok: true, value: null as T }
      const data = await this.#readJson(response)
      if (!this.#live(session)) throw new ClientProblem("NETWORK_UNAVAILABLE")
      if (!response.ok) {
        if (!this.#validator("ErrorResponse")(data)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
        const error = (data as ErrorResponse).error
        if (error.code === "AUTHENTICATION_REQUIRED" && response.status === 401 && session === this.#session) this.#discardSession()
        if (error.code === "CSRF_INVALID") session.csrf = null
        return { ok: false, error: { ...error, message: messages[error.code] ?? error.message } }
      }
      if ((response.status !== 200 && response.status !== 201) || !schema || !this.#validator(schema)(data)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
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
    const result = await this.#call<CsrfResponse>("/api/v1/auth/csrf", "CsrfResponse", "GET", { session })
    if (result.ok && this.#live(session)) session.csrf = result.value.token
    return result
  }
  async #write<T>(path: string, schema: string | null, options: CallOptions = {}): Promise<CollaborationResult<T>> {
    const session = options.session ?? this.#session
    if (!session.csrf) { const token = await this.#csrf(session); if (!token.ok) return token }
    const result = await this.#call<T>(path, schema, "POST", { ...options, session })
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
    const result = await this.#write<CurrentUserResponse>("/api/v1/auth/demo-login", "CurrentUserResponse", { body: { username }, inputSchema: "DemoLoginRequest", session })
    if (!this.#live(session)) return this.#error("NETWORK_UNAVAILABLE")
    if (result.ok || (!result.ok && ["NETWORK_UNAVAILABLE", "INVALID_SERVER_RESPONSE"].includes(result.error.code))) {
      const token = await this.#csrf(session)
      if (!token.ok) return token
      if (!this.#live(session)) return this.#error("NETWORK_UNAVAILABLE")
      const confirmed = await this.#call<CurrentUserResponse>("/api/v1/auth/me", "CurrentUserResponse", "GET", { session })
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
      const result = await this.#write<null>("/api/v1/auth/logout", null, { session: closing })
      if (!result.ok) return { ok: false, error: { ...result.error, message: "本机已退出，服务端退出未确认", retryable: false } }
      return result
    } finally {
      this.#closing.delete(closing); closing.abort.abort(); closing.csrf = null
      void closing.jar.removeAllCookies()
    }
  }

  listConversations(workspaceId: string, query: Record<string, string> = {}): Promise<CollaborationResult<ConversationListResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/conversations`, "ConversationListResponse", "GET", { query })
  }
  createConversation(workspaceId: string, request: CreateConversationRequest): Promise<CollaborationResult<CreateConversationResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/conversations`, "CreateConversationResponse", { body: request, inputSchema: "CreateConversationRequest" })
  }
  getConversation(workspaceId: string, conversationId: string): Promise<CollaborationResult<ConversationResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/conversations/${conversationId}`, "ConversationResponse")
  }
  sendInput(workspaceId: string, conversationId: string, request: SendInputRequest): Promise<CollaborationResult<InputSavedResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/inputs`, "InputSavedResponse", { body: request, inputSchema: "SendInputRequest" })
  }
  getExecution(workspaceId: string, conversationId: string, executionId: string): Promise<CollaborationResult<ExecutionResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/executions/${executionId}`, "ExecutionResponse")
  }
  cancelExecution(workspaceId: string, conversationId: string, executionId: string, request: CancelExecutionRequest): Promise<CollaborationResult<CancelExecutionResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/executions/${executionId}/cancel`, "CancelExecutionResponse", { body: request, inputSchema: "CancelExecutionRequest" })
  }
  history(workspaceId: string, conversationId: string, query: Record<string, string> = {}): Promise<CollaborationResult<HistoryResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/history`, "HistoryResponse", "GET", { query })
  }

  /** 请求与响应均校验项目 schema，服务从会话确定原设备及项目。 */
  async readProject(workspaceId: string, conversationId: string, action: ProjectReadAction): Promise<CollaborationResult<ProjectReadResponse>> {
    const result = await this.#write<ProjectReadResponse>(`/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/project/read`,
      "ProjectReadResponse", { body: action, inputSchema: "ProjectReadAction" })
    if (!result.ok) return result
    const value = result.value
    if (value.kind !== action.kind || (value.kind === "readPreview" && action.kind === "readPreview" && value.value.path !== action.path)
      || (value.kind === "gitDiff" && action.kind === "gitDiff" && (value.value.path !== action.path || value.value.snapshot !== action.snapshot))) {
      return this.#error("INVALID_SERVER_RESPONSE")
    }
    return result
  }

  /** 网络重连携带已交给调用方的连续位置；调用方负责保留未确认的事件。 */
  subscribeConversation(workspaceId: string, conversationId: string, afterSequence: string,
                        onEvent: (event: ConversationEvent) => void, onProblem: (problem: { code: string; rebuildProjection?: boolean }) => void,
                        onStatus?: (status: StreamConnection) => void): StreamHandle {
    const controller = new AbortController()
    const session = this.#session
    const signal = AbortSignal.any([controller.signal, session.abort.signal])
    const live = () => !signal.aborted && !this.#disposed && session === this.#session
    const emitProblem = (code: string, rebuildProjection = false) => { if (live()) onProblem({ code, ...(rebuildProjection ? { rebuildProjection: true } : {}) }) }
    const emitStatus = (status: StreamConnection) => { if (live()) onStatus?.(status) }
    let cursor = afterSequence
    let retry = 0
    let lastEvent: string | undefined
    let reconnect = false

    const read = async () => {
      const connection = new AbortController()
      const connectionSignal = AbortSignal.any([signal, connection.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const deadline = (ms: number) => {
        clearTimeout(timer)
        timer = setTimeout(() => connection.abort(), ms)
      }
      try {
        const headers: Record<string, string> = {
          Origin: this.#origin, "X-Workbench-Protocol-Version": "1", Accept: "text/event-stream", "X-Request-Id": randomUUID(),
        }
        const cookie = await session.jar.getCookieString(this.#origin, { http: true, sameSiteContext: "strict" })
        if (!live()) return
        if (cookie) headers.Cookie = cookie
        const path = `/api/v1/workspaces/${workspaceId}/conversations/${conversationId}/events`
        const query = reconnect ? "" : `?afterSequence=${cursor}`
        if (reconnect) headers["Last-Event-ID"] = `${conversationId}:${cursor}`
        deadline(10_000)
        const response = await this.#transport(`${this.#origin}${path}${query}`, {
          method: "GET", headers, redirect: "manual", signal: connectionSignal,
        })
        if (!live() || connectionSignal.aborted) { void response.body?.cancel().catch(() => {}); return }
        if (response.status !== 200) {
          if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => {})
            throw new ClientProblem("INVALID_SERVER_RESPONSE")
          }
          const body = await this.#readJson(response)
          if (!live()) return
          if (!this.#validator("ErrorResponse")(body)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
          throw new ClientProblem((body as ErrorResponse).error.code)
        }
        if (!response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") {
          void response.body?.cancel().catch(() => {})
          throw new ClientProblem("INVALID_SERVER_RESPONSE")
        }
        emitStatus("connected")
        reader = response.body.getReader()
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let pending = ""
        let id: string | undefined
        let name: string | undefined
        let data: string[] = []
        let bytes = 0
        let comment = false
        deadline(45_000)
        while (live() && !connectionSignal.aborted) {
          const { done, value } = await reader.read()
          if (!live() || connectionSignal.aborted || done) return
          deadline(45_000)
          try { pending += decoder.decode(value, { stream: true }) }
          catch { throw new ClientProblem("INVALID_SERVER_RESPONSE") }
          let newline = pending.indexOf("\n")
          while (newline >= 0) {
            if (!live() || connectionSignal.aborted) return
            const line = pending.slice(0, newline).replace(/\r$/, "")
            pending = pending.slice(newline + 1)
            newline = pending.indexOf("\n")
            bytes += Buffer.byteLength(line) + 1
            if (bytes > 66_560) throw new ClientProblem("INVALID_SERVER_RESPONSE")
            if (!line) {
              if (name === "stream.problem" && id === undefined) {
                const problem = parse(data.join("\n"))
                if (!this.#validator("ErrorResponse")(problem)) throw new ClientProblem("INVALID_SERVER_RESPONSE")
                throw new ClientProblem((problem as ErrorResponse).error.code)
              }
              if (name === "conversation.event") {
                const content = data.join("\n")
                const event = parse(content) as ConversationEvent
                if (Buffer.byteLength(content) > 65_536 || !this.#validator("ConversationEvent")(event)
                  || event.workspaceId !== workspaceId || event.conversationId !== conversationId
                  || id !== `${conversationId}:${event.sequence}`)
                  throw new ClientProblem("INVALID_SERVER_RESPONSE")
                if (event.sequence === cursor && content === lastEvent) {
                  // 当前连接末尾的相同事件可安全忽略。无法核对的重复必须停止。
                } else {
                  if (event.sequence !== (BigInt(cursor) + 1n).toString()) {
                    // 旧位置的正文无法核对时不能当成相同事件，需要从头重建投影。
                    throw new ClientProblem("INVALID_SERVER_RESPONSE", BigInt(event.sequence) <= BigInt(cursor))
                  }
                  onEvent(event)
                  if (!live()) return
                  cursor = event.sequence
                  lastEvent = content
                }
                retry = 0
              } else if (id !== undefined || name !== undefined || data.length) {
                throw new ClientProblem("INVALID_SERVER_RESPONSE")
              } else if (comment) retry = 0
              id = undefined; name = undefined; data = []; bytes = 0; comment = false
            } else if (line.startsWith(":")) comment = true
            else if (line.startsWith("id:") && id === undefined) id = line.slice(3).replace(/^ /, "")
            else if (line.startsWith("event:") && name === undefined) name = line.slice(6).replace(/^ /, "")
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
            else throw new ClientProblem("INVALID_SERVER_RESPONSE")
          }
          if (bytes + Buffer.byteLength(pending) > 66_560) throw new ClientProblem("INVALID_SERVER_RESPONSE")
        }
      } finally {
        clearTimeout(timer)
        connection.abort()
        if (reader) {
          void reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
    }

    const parse = (value: string): unknown => {
      try { return JSON.parse(value) }
      catch { throw new ClientProblem("INVALID_SERVER_RESPONSE") }
    }
    const run = async () => {
      emitStatus("connecting")
      if (!this.#validator("Id")(workspaceId) || !this.#validator("Id")(conversationId)
        || !/^(0|[1-9][0-9]{0,18})$/.test(cursor) || BigInt(cursor) > 9_223_372_036_854_775_807n) {
        emitStatus("stopped")
        emitProblem("INVALID_REQUEST")
        return
      }
      while (live()) {
        try { await read() }
        catch (failure) {
          if (!live()) return
          const code = failure instanceof ClientProblem ? failure.code : "NETWORK_UNAVAILABLE"
          if (code === "AUTHENTICATION_REQUIRED") {
            // 先清除旧 Cookie，再通知窗口；通知可能同步关闭该订阅。
            this.#discardSession()
            onProblem({ code })
            return
          }
          if (code !== "NETWORK_UNAVAILABLE" && code !== "SERVICE_UNAVAILABLE") emitStatus("stopped")
          emitProblem(code, failure instanceof ClientProblem && failure.rebuildProjection)
          if (code !== "NETWORK_UNAVAILABLE" && code !== "SERVICE_UNAVAILABLE") return
        }
        if (!live()) return
        // 正常流结束也要立刻显示重连，成功握手时再切回已连接。
        emitStatus("reconnecting")
        reconnect = true
        const wait = [1000, 2000, 5000][Math.min(retry++, 2)]
        try { await delay(wait, undefined, { signal }) } catch { return }
      }
    }
    void run()
    return { close: () => { if (live()) { emitStatus("stopped"); controller.abort() } } }
  }

  registerDevice(workspaceId: string, request: DeviceRegistrationRequest): Promise<CollaborationResult<DeviceRegistrationResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/devices`, "DeviceRegistrationResponse", { body: request, inputSchema: "DeviceRegistrationRequest" })
  }
  listDevices(workspaceId: string, query: Record<string, string> = {}): Promise<CollaborationResult<DeviceListResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/devices`, "DeviceListResponse", "GET", { query })
  }
  listProjects(workspaceId: string, deviceId: string, query: Record<string, string> = {}): Promise<CollaborationResult<ProjectListResponse>> {
    return this.#call(`/api/v1/workspaces/${workspaceId}/devices/${deviceId}/projects`, "ProjectListResponse", "GET", { query })
  }
  revokeDevice(workspaceId: string, deviceId: string, request: DeviceRevokeRequest): Promise<CollaborationResult<DeviceRevokedResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/devices/${deviceId}/revoke`, "DeviceRevokedResponse", { body: request, inputSchema: "DeviceRevokeRequest" })
  }
  stopSharing(workspaceId: string, projectId: string, request: ProjectStopSharingRequest): Promise<CollaborationResult<ProjectSavedResponse>> {
    return this.#write(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/stop-sharing`, "ProjectSavedResponse", { body: request, inputSchema: "ProjectStopSharingRequest" })
  }
}
