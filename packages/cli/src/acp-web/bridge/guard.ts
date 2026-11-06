/**
 * ACP Web 桥的请求门禁：把 HTTP 校验收敛成纯函数，方便表驱动测试。
 *
 * 【这是做什么的？】
 * 桥是本机服务，浏览器里的任意网页都可能连到 127.0.0.1。本模块把两类防线做成纯函数：
 * ① Host / Origin 逐字相等，挡住 DNS 重绑定（把恶意域名解析到 127.0.0.1）与跨站请求；
 * ② JSON 请求体的大小与形状校验，挡住超大请求体耗尽内存。
 * 校验失败一律拒绝，不降级放行（fail closed）。
 *
 * 【上下游】
 * 上游：`bridge.ts` 的 fetch 入口（每个请求第一步先过 checkHost，再到具体路由的门禁）。
 * 下游：不依赖任何运行时 API，只操作字符串与 Request，全部可单测。
 *
 * 【为什么 Host 用头的原始字符串】
 * Bun 的 `request.url` 主机部分直接取自 Host 头，两者等价；用头的原始字符串做逐字
 * 相等比较，可以精确拒绝 `127.0.0.1:043210`、带空格、多值与尾随域名等变体，不需要
 * 关心 URL 规范化（端口补零、大小写、尾点）会不会偷偷放行。
 */

/** POST /acp/boot 请求体的字节上限。 */
export const MAX_BOOT_BODY_BYTES = 1_024

export type GuardReason = "bad-host" | "bad-origin" | "bad-content-type" | "body-too-large" | "bad-body"

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 413 | 415; reason: GuardReason }

/**
 * Host 头必须逐字等于 `127.0.0.1:<port>`。
 *
 * 缺失、`localhost`、IPv6、带后缀域名、多值、带空格、端口补零一律拒绝：
 * 浏览器对 `http://evil.test/` 的请求可以携带任意 Host，但 evil.test 解析到
 * 127.0.0.1 时 Host 是 `evil.test:<port>`，逐字比较把它挡住（DNS 重绑定）。
 */
export function checkHost(hostHeader: string | null, port: number): GuardResult {
  if (hostHeader === `127.0.0.1:${port}`) return { ok: true }
  return { ok: false, status: 403, reason: "bad-host" }
}

/**
 * Origin 必须逐字等于 `http://127.0.0.1:<port>`（无尾斜杠）。
 *
 * 缺失也拒绝：浏览器对 POST 与 WebSocket 握手都会带 Origin，不带的是非浏览器
 * 客户端，拒绝不会影响正常页面；放行则会让跨站表单把请求送到桥。
 */
export function checkOrigin(originHeader: string | null, port: number): GuardResult {
  if (originHeader === `http://127.0.0.1:${port}`) return { ok: true }
  return { ok: false, status: 403, reason: "bad-origin" }
}

/**
 * 校验 JSON 请求的 Content-Type 与 Content-Length。
 *
 * 媒体类型必须是 application/json（参数部分如 `; charset=utf-8` 允许）：
 * 跨站"简单请求"只能发 text/plain / form-urlencoded，这条门禁把跨站写请求挡在
 * 凭据检查之前。Content-Length 超过上限直接 413；缺失或说谎时由
 * `readBoundedText` 的边读边计数兜底。
 */
export function checkJsonRequest(
  contentType: string | null,
  contentLength: string | null,
  maxBytes: number = MAX_BOOT_BODY_BYTES,
): GuardResult {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, reason: "bad-content-type" }
  }
  if (contentLength !== null) {
    const length = Number(contentLength)
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, status: 413, reason: "body-too-large" }
    }
  }
  return { ok: true }
}

/**
 * 限长读取请求体：边读边计数，超过上限立刻取消读取并返回 413。
 *
 * Content-Length 缺失或说谎时同样成立——这是唯一权威的字节数校验。
 * 超限后取消流：桥不会读完整个超大请求体，内存占用有上界。
 */
export async function readBoundedText(
  request: Request,
  maxBytes: number = MAX_BOOT_BODY_BYTES,
): Promise<{ ok: true; text: string } | { ok: false; status: 413 }> {
  const body = request.body
  if (!body) return { ok: true, text: "" }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, status: 413 }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, text: new TextDecoder().decode(merged) }
}

/**
 * 解析 `POST /acp/boot` 的 JSON 请求体，要求 `{code: string}` 且 code 不超过
 * 128 个字符。形状不符返回 400 `bad-body`；凭据对错不归这里管。
 */
export function parseBootBody(
  text: string,
): { ok: true; code: string } | { ok: false; status: 400; reason: "bad-body" } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, reason: "bad-body" }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, status: 400, reason: "bad-body" }
  }
  const code = (value as { code?: unknown }).code
  if (typeof code !== "string" || code.length > 128) {
    return { ok: false, status: 400, reason: "bad-body" }
  }
  return { ok: true, code }
}

/** 所有响应共用的安全头；与 `web/server.ts` 的 COMMON_HEADERS 同值。 */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
}

/**
 * ACP 入口页的 CSP。比现有 /web 页面更严一点：
 * `connect-src` 写确切端口而不是 `ws://127.0.0.1:*`——只有这座桥能被连；
 * `worker-src` 与 `img-src` 是为语法高亮 Worker 与 Markdown 里的 data: 图片预留。
 */
export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port}`,
    "worker-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/** HTML 响应的头 = 内容类型 + COMMON_HEADERS + COOP + CSP（端口已知后才能构造）。 */
export function htmlHeaders(port: number): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    ...COMMON_HEADERS,
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy": contentSecurityPolicy(port),
  }
}
