/**
 * 【功能定义】工作台 `workbench://` 深链接白名单解析与单实例唤醒挂起槽：
 * 1. `parseWorkbenchDeepLink`：严格限定协议（`workbench:`）、host（`open`）、长度上限（512B）、零控制字符与白名单路由，
 *    首期仅放行 `workbench://open/inbox` 与严格小写 UUID 参数的 `workbench://open/task?workspaceId=...&projectId=...&taskId=...`；
 * 2. `DeepLinkBroker`：协调冷启动参数、macOS `open-url` 与 Windows/Linux `second-instance`，
 *    未登录时将合法目标暂存挂起槽、登出或认证失效立即清空防止跨账号泄漏，渲染层就绪并已登录后投递只读跳转。
 *
 * 【协作边界】零 Electron 顶层依赖，供 `index.ts`、`window.ts`、`desktop-ipc.ts` 与 `desktop/tests/deep-link.test.ts` 共用。
 */
import type { WorkbenchDeepLinkEvent, WorkbenchDeepLinkTarget } from "../shared/index.js"

export const WORKBENCH_PROTOCOL = "workbench"
export const MAX_DEEP_LINK_BYTES = 512

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/
const REQUIRED_TASK_QUERY_KEYS = ["workspaceId", "projectId", "taskId"] as const

export type ParseDeepLinkResult =
  | { readonly ok: true; readonly target: WorkbenchDeepLinkTarget }
  | { readonly ok: false; readonly reason: string; readonly message: "无效的跳转链接。" }

const invalidLink = (reason: string): ParseDeepLinkResult => ({
  ok: false,
  reason,
  message: "无效的跳转链接。",
})

/** 严格按白名单校验 `workbench://` 深链接，任何越界/未知路径/多余参数均拒绝。 */
export function parseWorkbenchDeepLink(rawUrl: unknown): ParseDeepLinkResult {
  if (typeof rawUrl !== "string") return invalidLink("not_string")
  if (CONTROL_CHAR_PATTERN.test(rawUrl)) return invalidLink("control_chars")
  const trimmed = rawUrl.trim()
  if (!trimmed) return invalidLink("empty")
  if (new TextEncoder().encode(trimmed).length > MAX_DEEP_LINK_BYTES) return invalidLink("too_long")

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return invalidLink("malformed_url")
  }

  if (parsed.protocol !== `${WORKBENCH_PROTOCOL}:`) return invalidLink("unexpected_protocol")
  if (parsed.hostname !== "open" || parsed.host !== "open") return invalidLink("unexpected_host")
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
    return invalidLink("disallowed_authority_parts")
  }
  if (parsed.hash !== "") return invalidLink("disallowed_hash")

  if (parsed.pathname === "/inbox") {
    if (parsed.search !== "") return invalidLink("unexpected_query_for_inbox")
    return { ok: true, target: { kind: "inbox" } }
  }

  if (parsed.pathname === "/task") {
    const entries = [...parsed.searchParams.entries()]
    if (entries.length !== REQUIRED_TASK_QUERY_KEYS.length) return invalidLink("invalid_task_query_count")
    const values = new Map<string, string>()
    for (const [key, value] of entries) {
      if (!(REQUIRED_TASK_QUERY_KEYS as readonly string[]).includes(key)) return invalidLink("unknown_task_query_key")
      if (values.has(key)) return invalidLink("duplicate_task_query_key")
      if (!UUID_PATTERN.test(value)) return invalidLink("invalid_uuid_param")
      values.set(key, value)
    }
    const workspaceId = values.get("workspaceId")
    const projectId = values.get("projectId")
    const taskId = values.get("taskId")
    if (!workspaceId || !projectId || !taskId) return invalidLink("missing_task_query_key")
    return {
      ok: true,
      target: { kind: "task", workspaceId, projectId, taskId },
    }
  }

  return invalidLink("unknown_route")
}

/** 从进程启动或二次唤醒 `argv` 中提取唯一以 `workbench:` 开头的深链接参数。 */
export function extractWorkbenchDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && /^workbench:/i.test(arg.trim())) {
      return arg.trim()
    }
  }
  return null
}

/**
 * 管理未登录挂起与窗口聚焦投递的深链接协调器。
 * - 合法目标在未登录/页面未就绪时挂起在内存中，等 `signedIn && rendererReady` 后只投递一次；
 * - 登出或身份切换立即丢弃既有挂起目标，严禁跨账号消费；
 * - 畸形链接即使未登录也可立即向欢迎页提示“无效的跳转链接”，不暴露任何敏感路由细节。
 */
export class DeepLinkBroker {
  #pending: WorkbenchDeepLinkEvent | null = null
  #signedIn = false
  #rendererReady = false
  #deliver: ((event: WorkbenchDeepLinkEvent) => boolean) | null = null

  constructor(private readonly onWarning: (message: string) => void = message => console.warn(message)) {}

  #canDeliver(event: WorkbenchDeepLinkEvent): boolean {
    if (!this.#rendererReady || !this.#deliver) return false
    return !event.ok || this.#signedIn
  }

  #flushPending(): void {
    const current = this.#pending
    if (!current || !this.#canDeliver(current)) return
    if (this.#deliver!(current)) {
      this.#pending = null
    }
  }

  receiveRawUrl(rawUrl: string): void {
    const parsed = parseWorkbenchDeepLink(rawUrl)
    if (!parsed.ok) {
      this.onWarning(`[deep-link] 已拦截非法跳转链接 (${parsed.reason})`)
    }
    const event: WorkbenchDeepLinkEvent = parsed.ok
      ? { ok: true, target: parsed.target }
      : { ok: false, message: parsed.message }
    if (this.#canDeliver(event) && this.#deliver!(event)) {
      return
    }
    this.#pending = event
  }

  attachDeliver(deliver: (event: WorkbenchDeepLinkEvent) => boolean): void {
    this.#deliver = deliver
  }

  detachDeliver(): void {
    this.#deliver = null
    this.#rendererReady = false
  }

  markRendererNotReady(): void {
    this.#rendererReady = false
  }

  setSignedIn(signedIn: boolean): void {
    if (signedIn === this.#signedIn) return
    this.#signedIn = signedIn
    if (!signedIn) {
      // 登出或账号切换时立即清空未消费目标，防止原账号的待跳转链接被下一账号消费。
      this.#pending = null
      return
    }
    this.#flushPending()
  }

  consumePending(): WorkbenchDeepLinkEvent | null {
    this.#rendererReady = true
    const current = this.#pending
    if (!current) return null
    if (current.ok && !this.#signedIn) return null
    this.#pending = null
    return current
  }

  /** 仅供测试观察挂起槽是否处于预期状态。 */
  peekPending(): WorkbenchDeepLinkEvent | null {
    return this.#pending
  }
}
