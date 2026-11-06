/** guard.ts 的表驱动用例：Host / Origin / Content-Type / 请求体的逐字校验与响应头。 */

import { describe, expect, test } from "bun:test"

import {
  COMMON_HEADERS,
  checkHost,
  checkJsonRequest,
  checkOrigin,
  contentSecurityPolicy,
  htmlHeaders,
  parseBootBody,
  readBoundedText,
} from "../../src/acp-web/bridge/guard"

const PORT = 43_210

describe("checkHost", () => {
  test("接受逐字相等的 127.0.0.1:port", () => {
    expect(checkHost("127.0.0.1:43210", PORT)).toEqual({ ok: true })
  })

  test.each([
    null,
    "",
    "127.0.0.1",
    "127.0.0.1:43211",
    "localhost:43210",
    "[::1]:43210",
    "0.0.0.0:43210",
    "127.0.0.1:43210.evil.test",
    "evil.test:43210",
    " 127.0.0.1:43210",
    "127.0.0.1:43210 ",
    "127.0.0.1:043210",
    "127.0.0.1:43210, evil.test",
  ])("拒绝 %j", host => {
    expect(checkHost(host, PORT)).toEqual({ ok: false, status: 403, reason: "bad-host" })
  })
})

describe("checkOrigin", () => {
  test("只接受 http://127.0.0.1:port（无尾斜杠）", () => {
    expect(checkOrigin("http://127.0.0.1:43210", PORT)).toEqual({ ok: true })
  })

  test.each([
    null,
    "null",
    "http://127.0.0.1:43210/",
    "https://127.0.0.1:43210",
    "http://localhost:43210",
    "http://evil.test",
    "http://127.0.0.1:43210.evil.test",
    "file://",
  ])("拒绝 %j", origin => {
    expect(checkOrigin(origin, PORT)).toEqual({ ok: false, status: 403, reason: "bad-origin" })
  })
})

describe("checkJsonRequest", () => {
  test("application/json 与带 charset 的都通过", () => {
    expect(checkJsonRequest("application/json", "0")).toEqual({ ok: true })
    expect(checkJsonRequest("application/json; charset=utf-8", "100")).toEqual({ ok: true })
    expect(checkJsonRequest("Application/JSON; Charset=UTF-8", "0")).toEqual({ ok: true })
  })

  test.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    null,
  ])("拒绝媒体类型 %j", contentType => {
    expect(checkJsonRequest(contentType, "0")).toEqual({ ok: false, status: 415, reason: "bad-content-type" })
  })

  test("Content-Length 超过上限直接 413，不读请求体", () => {
    expect(checkJsonRequest("application/json", "1025")).toEqual({
      ok: false,
      status: 413,
      reason: "body-too-large",
    })
    expect(checkJsonRequest("application/json", "1024")).toEqual({ ok: true })
  })
})

describe("readBoundedText", () => {
  test("上限内的请求体完整读出", async () => {
    const request = new Request("http://x/", {
      method: "POST",
      body: "a".repeat(1024),
    })
    const result = await readBoundedText(request)
    expect(result).toEqual({ ok: true, text: "a".repeat(1024) })
  })

  test("超限立刻失败且取消读取，不会读完整个流", async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(512).fill(0x61))
      },
    })
    const request = new Request("http://x/", { method: "POST", body: stream })
    const result = await readBoundedText(request)
    expect(result).toEqual({ ok: false, status: 413 })
    // 1025 字节时读取就中止了，不能读满整个无限流。
    expect(pulled).toBeLessThanOrEqual(4)
  })

  test("没有 content-length 的分块流超限同样是 413", async () => {
    const request = new Request("http://x/", {
      method: "POST",
      body: "b".repeat(1025),
      headers: { "content-length": "0" }, // content-length 说谎也不能放宽上限
    })
    const result = await readBoundedText(request)
    expect(result).toEqual({ ok: false, status: 413 })
  })
})

describe("parseBootBody", () => {
  test("{\"code\":\"x\"} 通过", () => {
    expect(parseBootBody('{"code":"x"}')).toEqual({ ok: true, code: "x" })
  })

  test.each([
    "not json",
    "[1,2]",
    "123",
    "{}",
    '{"code":123}',
    '{"code":null}',
    `{"code":"${"x".repeat(129)}"}`,
  ])("拒绝 %j", body => {
    expect(parseBootBody(body)).toEqual({ ok: false, status: 400, reason: "bad-body" })
  })
})

describe("contentSecurityPolicy", () => {
  const csp = contentSecurityPolicy(PORT)

  test("包含严格指令且 connect-src 写确切端口", () => {
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${PORT}`)
    expect(csp).toContain("worker-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  test("端口不是通配符，不含 unsafe-inline / unsafe-eval", () => {
    expect(csp).not.toContain("ws://127.0.0.1:*")
    expect(csp).not.toContain("unsafe-inline")
    expect(csp).not.toContain("unsafe-eval")
  })
})

describe("响应头", () => {
  test("COMMON_HEADERS 与现有 /web 服务一致", () => {
    expect(COMMON_HEADERS).toEqual({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    })
  })

  test("htmlHeaders 带齐安全头与 CSP", () => {
    const headers = htmlHeaders(PORT)
    expect(headers["cache-control"]).toBe("no-store")
    expect(headers["referrer-policy"]).toBe("no-referrer")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin")
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin")
    expect(headers["content-security-policy"]).toBe(contentSecurityPolicy(PORT))
  })
})
