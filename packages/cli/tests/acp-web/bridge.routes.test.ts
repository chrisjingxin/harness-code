/** 桥的 HTTP 路由与凭据门禁用例（假子进程 echo，只测 HTTP 面）。 */

import { afterEach, describe, expect, test } from "bun:test"

import { fakeChild } from "./support/fake-children"
import { startBridge, type BridgeHarness } from "./support/bridge-harness"

let harness: BridgeHarness | undefined

afterEach(async () => {
  await harness?.stop()
  harness = undefined
})

async function up(overrides: Parameters<typeof startBridge>[1] = {}) {
  harness = await startBridge(fakeChild("echo"), overrides)
  return harness
}

describe("GET / 与静态资源", () => {
  test("GET / 返回 200、占位页与安全响应头", async () => {
    const h = await up()
    const response = await fetch(`${h.origin}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    const csp = response.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${h.port}`)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    const body = await response.text()
    expect(body).toContain("acp-placeholder")
    expect(body).not.toContain(h.bootCode)
  })

  test.each(["/assets/x", "/assets/../x", "/web/app.js", "/acp/app.js", "/acp/", "/acp"])
  ("%s → 404", async path => {
    const h = await up()
    expect((await fetch(`${h.origin}${path}`)).status).toBe(404)
  })

  test.each(["/assets/constructor", "/assets/__proto__", "/assets/toString"])
  ("%s 原型键不命中 Object.prototype → 404 not-found", async path => {
    const h = await up()
    const response = await fetch(`${h.origin}${path}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "not-found" })
  })

  test("/assets/%2e%2e 编码穿越：Bun 规范化后落到 /，返回占位页而非资源", async () => {
    // Bun 的 URL 解析（fetch 客户端与 Bun.serve 都一样）先把 %2e%2e 归并成 /，
    // 请求到达桥时就是 GET /，编码穿越根本碰不到 /assets/* 命名空间。
    const h = await up()
    const response = await fetch(`${h.origin}/assets/%2e%2e`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("acp-placeholder")
    // 编码后的嵌套路径同样被归并成 /x → 未知路径 404。
    expect((await fetch(`${h.origin}/assets/%2e%2e/x`)).status).toBe(404)
  })

  test("已知路径的错误方法 → 405 且带 allow", async () => {
    const h = await up()
    const post = await fetch(`${h.origin}/`, { method: "POST" })
    expect(post.status).toBe(405)
    expect(post.headers.get("allow")).toBe("GET")
    const get = await fetch(`${h.origin}/acp/boot`)
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    const del = await fetch(`${h.origin}/assets/x`, { method: "DELETE" })
    expect(del.status).toBe(405)
    const options = await fetch(`${h.origin}/acp/boot`, { method: "OPTIONS" })
    expect(options.status).toBe(405)
    expect(options.headers.get("allow")).toBe("POST")
  })
})

describe("DNS 重绑定：伪造 Host 全部 403 且不碰凭据逻辑", () => {
  test.each(["/", "/assets/x", "/acp/boot", "/acp/ws"])("%s", async path => {
    const h = await up()
    const response = await fetch(`${h.origin}${path}`, {
      headers: { host: "evil.test:80" },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "bad-host" })
    // 只允许 guard.rejected 与 server.started：伪造 Host 不得触发任何凭据逻辑。
    const unexpected = h.events.filter(event =>
      !event.event.startsWith("guard.") && event.event !== "server.started")
    expect(unexpected).toEqual([])
  })
})

describe("POST /acp/boot", () => {
  test("跨站请求一律 403 bad-origin，且不计入错误锁定", async () => {
    const h = await up()
    const evil = await fetch(`${h.origin}/acp/boot`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.test" },
      body: JSON.stringify({ code: h.bootCode }),
    })
    expect(evil.status).toBe(403)
    expect(await evil.json()).toEqual({ error: "bad-origin" })
    const missing = await fetch(`${h.origin}/acp/boot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: h.bootCode }),
    })
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual({ error: "bad-origin" })
    // 连续 10 次错 Origin 之后，正确 Origin + 正确码仍成功：Origin 失败不进凭据计数。
    for (let i = 0; i < 10; i += 1) {
      await fetch(`${h.origin}/acp/boot`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.test" },
        body: JSON.stringify({ code: "wrong" }),
      })
    }
    const ok = await h.redeem()
    expect(ok.status).toBe(200)
  })

  test("请求体门禁：非 JSON 415、超限 413、坏体 400", async () => {
    const h = await up()
    const post = (body: BodyInit, headers: Record<string, string> = {}) =>
      fetch(`${h.origin}/acp/boot`, {
        method: "POST",
        headers: { origin: h.origin, ...headers },
        body,
      })
    expect((await post("x", { "content-type": "text/plain" })).status).toBe(415)
    expect((await post("a".repeat(1025), { "content-type": "application/json" })).status).toBe(413)
    expect((await post("not json", { "content-type": "application/json" })).status).toBe(400)
    expect((await post("{}", { "content-type": "application/json" })).status).toBe(400)
  })

  test("正确码 → 200 {cwd, wsToken}；错码 → 403 invalid-code", async () => {
    const h = await up({ cwd: "/tmp/acp-bridge-cwd" })
    const bad = await h.redeem("x".repeat(43))
    expect(bad.status).toBe(403)
    expect(bad.body).toEqual({ error: "invalid-code" })
    const ok = await h.redeem()
    expect(ok.status).toBe(200)
    expect(ok.body.cwd).toBe("/tmp/acp-bridge-cwd")
    expect(ok.body.wsToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("兑换响应带 cache-control: no-store", async () => {
    const h = await up()
    const response = await fetch(`${h.origin}/acp/boot`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.origin },
      body: JSON.stringify({ code: h.bootCode }),
    })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("连续 5 次错码 → 429 + retry-after；30 秒后恢复", async () => {
    let at = 1_000_000
    const h = await up({ now: () => at })
    for (let i = 0; i < 5; i += 1) {
      expect((await h.redeem("x".repeat(43))).status).toBe(403)
    }
    const locked = await h.redeem()
    expect(locked.status).toBe(429)
    expect(locked.body).toEqual({ error: "locked" })
    expect(locked.retryAfter).toBeTruthy()
    at += 30_001
    expect((await h.redeem()).status).toBe(200)
  })

  test("滑动窗口：10 分钟未用 → 403 expired-code；成功兑换顺延", async () => {
    let at = 1_000_000
    const h = await up({ now: () => at })
    at += 9 * 60_000
    expect((await h.redeem()).status).toBe(200)
    at += 9 * 60_000
    expect((await h.redeem()).status).toBe(200)
    at += 10 * 60_000 + 1
    const expired = await h.redeem()
    expect(expired.status).toBe(403)
    expect(expired.body).toEqual({ error: "expired-code" })
  })
})

describe("GET /acp/ws 门禁", () => {
  const upgradeHeaders = (origin: string, extra: Record<string, string> = {}) => ({
    upgrade: "websocket",
    origin,
    ...extra,
  })

  test.each(["", "a".repeat(129), "short-token", "x".repeat(43)])(
    "t=%j → 403", async token => {
      const h = await up()
      const suffix = token === "" ? "" : `?t=${token}`
      const response = await fetch(`${h.origin}/acp/ws${suffix}`, {
        headers: upgradeHeaders(h.origin),
      })
      expect(response.status).toBe(403)
      const body = await response.json() as { error: string }
      expect(body.error).toMatch(/-token$/)
    },
  )

  test("非升级请求 → 400", async () => {
    const h = await up()
    const response = await fetch(`${h.origin}/acp/ws`, { headers: { origin: h.origin } })
    expect(response.status).toBe(400)
  })

  test("缺 Origin / 错 Origin → 403 bad-origin", async () => {
    const h = await up()
    const missing = await fetch(`${h.origin}/acp/ws`, { headers: { upgrade: "websocket" } })
    expect(missing.status).toBe(403)
    const evil = await fetch(`${h.origin}/acp/ws`, { headers: upgradeHeaders("http://evil.test") })
    expect(evil.status).toBe(403)
    expect(await evil.json()).toEqual({ error: "bad-origin" })
  })

  test("有效 token + 错 Host → 403 且 token 未被消耗", async () => {
    const h = await up()
    const redeemed = await h.redeem()
    const token = redeemed.body.wsToken!
    const rejected = await fetch(`${h.origin}/acp/ws?t=${token}`, {
      headers: upgradeHeaders(h.origin, { host: "evil.test:80" }),
    })
    expect(rejected.status).toBe(403)
    // 同一 token 做正常升级仍可用：403 没有烧掉它。
    const socket = h.openWs(token)
    await socket.opened
    socket.ws.close()
    await h.waitForDrained()
  })
})

describe("日志不含秘密", () => {
  test("诊断事件全文不含 bootCode、wsToken 与头值", async () => {
    const h = await up()
    await fetch(`${h.origin}/`, { headers: { host: "evil.test:80" } })
    const redeemed = await h.redeem()
    const bad = await h.redeem("x".repeat(43))
    expect(bad.status).toBe(403)
    const serialized = JSON.stringify(h.events)
    expect(serialized).not.toContain(h.bootCode)
    expect(serialized).not.toContain(redeemed.body.wsToken!)
    expect(serialized).not.toContain("evil.test")
  })
})

describe("绑定", () => {
  test("只监听 127.0.0.1，IPv6 连不上", async () => {
    const h = await up()
    expect(h.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await expect(fetch(`http://[::1]:${h.port}/`, { signal: AbortSignal.timeout(1_000) }))
      .rejects.toThrow()
  })
})
