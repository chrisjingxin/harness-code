/** 云端普通用户与身份端口；主进程负责会话，UI 只读取不含凭据的业务结果。 */
export interface UserSummary { id: string; username: string; displayName: string }
/** 工作区展示资料；访问权每次由服务端成员关系判断。 */
export interface WorkspaceSummary { id: string; slug: string; name: string }
export interface MemberSummary { user: UserSummary }
export interface CurrentUserResponse { user: UserSummary; workspaces: WorkspaceSummary[] }
export interface DemoUsersResponse { users: UserSummary[] }
export interface WorkspaceListResponse { workspaces: WorkspaceSummary[] }
export interface MembersResponse { workspaceId: string; members: MemberSummary[] }
export interface DemoLoginRequest { username: string }
/** CSRF 数据仅供宿主传输消费，不作为 CollaborationHost 的返回值。 */
export interface CsrfResponse { headerName: "X-CSRF-TOKEN"; token: string }
export interface MetaResponse { productVersion: string; protocolVersion: 1; loginMode: "demo" }
export interface HealthResponse { status: "UP" | "DOWN" }
export type ServerErrorCode = "INVALID_REQUEST" | "AUTHENTICATION_REQUIRED" | "DEMO_LOGIN_REJECTED" | "CSRF_INVALID" | "REQUEST_SOURCE_REJECTED" | "RESOURCE_NOT_FOUND" | "METHOD_NOT_ALLOWED" | "UNSUPPORTED_MEDIA_TYPE" | "ALREADY_AUTHENTICATED" | "PAYLOAD_TOO_LARGE" | "PROTOCOL_VERSION_UNSUPPORTED" | "SERVICE_UNAVAILABLE" | "INTERNAL_ERROR" | "REQUEST_ID_CONFLICT" | "REGISTRATION_CONFLICT" | "DEVICE_AUTHENTICATION_REQUIRED" | "DEVICE_ACTION_REJECTED" | "WORKSPACE_MEMBER_REQUIRED" | "PROJECT_OWNER_REQUIRED" | "DEVICE_FORBIDDEN" | "REPOSITORY_CONFLICT" | "VERSION_CONFLICT" | "PROJECT_ARCHIVED" | "REPOSITORY_ARCHIVED" | "OWNER_CANNOT_LEAVE" | "SEQUENCE_CONFLICT"
/** 安全错误不包含响应头、Cookie、数据库诊断或原生 Error 对象。 */
export interface CollaborationError { code: ServerErrorCode | "NETWORK_UNAVAILABLE" | "TLS_ERROR" | "INVALID_SERVER_RESPONSE"; message: string; requestId: string; retryable: boolean }
export interface ErrorResponse { error: CollaborationError & { code: ServerErrorCode } }
export type CollaborationResult<T> = { ok: true; value: T } | { ok: false; error: CollaborationError }
/** 连接故障保留上次身份提示，不能据此继续发送业务请求。 */
export type IdentityState = { status: "signedOut" } | { status: "loading" } | { status: "signedIn"; user: UserSummary; workspaces: WorkspaceSummary[] } | { status: "connectionError"; lastKnownUser: UserSummary | null; error: CollaborationError }
/** 具名身份接口；监听必须解绑，账号切换先退出再登录，不接受任意网络参数。 */
export interface CollaborationHost {
  getState(): Promise<CollaborationResult<IdentityState>>
  listDemoUsers(): Promise<CollaborationResult<DemoUsersResponse>>
  signIn(username: string): Promise<CollaborationResult<CurrentUserResponse>>
  signOut(): Promise<CollaborationResult<null>>
  listMembers(workspaceId: string): Promise<CollaborationResult<MembersResponse>>
  onStateChanged(listener: (state: IdentityState) => void): () => void
}
/** 仅为后续业务组合的消息头；没有可直接受理的任意 payload 入口。 */
export interface PlatformMessageHeader { protocolVersion: 1; messageId: string; type: string; occurredAt: string }
