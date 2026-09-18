/** Node 静态 Web server adapter 测试：白名单路由、安全 headers、Host/Origin 校验与 /ui 升级门禁。 */

import { describe, expect, it } from "vitest"
import http from "node:http"
import WebSocket from "ws"

import { createWebServer, type WebServer } from "../../src/web/server"
import { MAX_UI_FRAME_BYTES } from "../../src/presentation-coordinator"
import type { GatewayChannel } from "../../src/presentation-coordinator"

type Harness = {
  server: WebServer
  attachCalls: Array<{ handoffId: string; presentedToken: string; channel: GatewayChannel }>
  activeHandoffs: Set<string>
  validTokens: Set<string>
}

function createHarness(): Harness {
  const attachCalls: Array<{ handoffId: string; presentedToken: string; channel: GatewayChannel }> = []
  const activeHandoffs = new Set<string>()
  const validTokens = new Set<string>()
  const server = createWebServer({
    html: "<!doctype html><title>shell</title>",
    getAssets: async () => ({
      script: "console.log('app')",
      style: "body{}",
      syntaxWorkerScript: "console.log('syntax worker')",
    }),
    isActiveHandoff: handoffId => activeHandoffs.has(handoffId),
    validateUiToken: (_handoffId, token, _origin) => validTokens.has(token),
    attachRenderer: async (handoffId, presentedToken, channel) => {
      attachCalls.push({ handoffId, presentedToken, channel })
      await channel.send({ type: "handoff.state", state: { phase: "opening-web", handoffId } })
    },
  })
  return { server, attachCalls, activeHandoffs, validTokens }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时")
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function sleep(ms: number): Promise<{ timedOut: true }> {
  return new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), ms))
}

describe("node web server", () => {
  it("白名单路由与安全 headers 精确存在；已知 WASM 路由删除后返回 404；未知路由返回 404/405", async () => {
    const { server, activeHandoffs } = createHarness()
    await server.start()
    activeHandoffs.add("handoff-1")
    const origin = server.origin

    const page = await fetch(`${origin}/web/h/handoff-1`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("<title>shell</title>")
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(page.headers.get("content-security-policy")).toContain("connect-src ws://127.0.0.1:*")
    expect(page.headers.get("content-security-policy")).not.toContain("wasm-unsafe-eval")
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin")

    const script = await fetch(`${origin}/web/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get("content-type")).toContain("javascript")
    expect(script.headers.get("cache-control")).toBe("no-store")
    expect(script.headers.get("cross-origin-opener-policy")).toBeNull()

    const style = await fetch(`${origin}/web/app.css`)
    expect(style.status).toBe(200)
    expect(style.headers.get("content-type")).toContain("text/css")

    const syntaxWorker = await fetch(`${origin}/web/syntax-worker.js`)
    expect(syntaxWorker.status).toBe(200)
    expect(syntaxWorker.headers.get("content-type")).toContain("javascript")
    expect(await syntaxWorker.text()).toContain("syntax worker")

    // WASM 路由已全量删除，返回 404
    expect((await fetch(`${origin}/web/syntax/tree-sitter.wasm`)).status).toBe(404)
    expect((await fetch(`${origin}/web/syntax/lang/python.wasm`)).status).toBe(404)

    expect((await fetch(`${origin}/`)).status).toBe(404)
    expect((await fetch(`${origin}/index.html`)).status).toBe(404)
    expect((await fetch(`${origin}/web/syntax/lang/not-in-catalog.wasm`)).status).toBe(404)
    expect((await fetch(`${origin}/web/h/unknown-handoff`)).status).toBe(404)
    expect((await fetch(`${origin}/web/h/handoff-1/../app.js`)).status).toBe(404)
    expect((await fetch(`${origin}/web/h/handoff-1`, { method: "POST" })).status).toBe(405)
    expect((await fetch(`${origin}/web/h/handoff-1/lifecycle`)).status).toBe(404)
    expect((await fetch(`${origin}/web/h/handoff-1/ui`)).status).toBe(405)
    expect((await fetch(`${origin}/web/h/handoff-1/ui`, { method: "POST" })).status).toBe(405)

    activeHandoffs.delete("handoff-1")
    expect((await fetch(`${origin}/web/h/handoff-1`)).status).toBe(404)

    await server.stop()
  })

  it("错误 Host 被拒绝；/ui upgrade 校验 Origin 与 UI token 并投递 handoff.state", async () => {
    const { server, attachCalls, activeHandoffs, validTokens } = createHarness()
    await server.start()
    activeHandoffs.add("handoff-1")
    validTokens.add("token-1")
    const origin = server.origin

    const forgedStatus = await new Promise<number>((resolve, reject) => {
      const parsed = new URL(origin)
      const req = http.request({
        hostname: "127.0.0.1",
        port: parsed.port,
        path: "/web/h/handoff-1",
        method: "GET",
        headers: { host: "evil.example:9999" },
      }, res => {
        resolve(res.statusCode ?? 0)
      })
      req.on("error", reject)
      req.end()
    })
    expect(forgedStatus).toBe(403)

    // 错误 Origin 的升级被拒绝
    let wrongOriginFailed = false
    const wrongWs = new WebSocket(`${origin.replace(/^http/, "ws")}/web/h/handoff-1/ui?ui=token-1`, {
      headers: { origin: "http://evil.example" },
    })
    wrongWs.on("error", () => {
      wrongOriginFailed = true
    })
    await waitFor(() => wrongOriginFailed || wrongWs.readyState === WebSocket.CLOSED)
    expect(wrongOriginFailed || wrongWs.readyState === WebSocket.CLOSED).toBe(true)

    // 错误 / 缺失 token 的升级返回 403 并断开
    let wrongTokenFailed = false
    const wrongTokenWs = new WebSocket(`${origin.replace(/^http/, "ws")}/web/h/handoff-1/ui?ui=wrong`, {
      headers: { origin },
    })
    wrongTokenWs.on("error", () => {
      wrongTokenFailed = true
    })
    await waitFor(() => wrongTokenFailed || wrongTokenWs.readyState === WebSocket.CLOSED)
    expect(wrongTokenFailed || wrongTokenWs.readyState === WebSocket.CLOSED).toBe(true)

    let missingTokenFailed = false
    const missingTokenWs = new WebSocket(`${origin.replace(/^http/, "ws")}/web/h/handoff-1/ui`, {
      headers: { origin },
    })
    missingTokenWs.on("error", () => {
      missingTokenFailed = true
    })
    await waitFor(() => missingTokenFailed || missingTokenWs.readyState === WebSocket.CLOSED)
    expect(missingTokenFailed || missingTokenWs.readyState === WebSocket.CLOSED).toBe(true)

    // 正确 token + Origin → attachRenderer 收到 channel，帧原样投递给 client
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/web/h/handoff-1/ui?ui=token-1`, {
      headers: { origin },
    })
    const messages: unknown[] = []
    socket.on("message", data => {
      messages.push(JSON.parse(String(data)))
    })
    await waitFor(() => attachCalls.length === 1)
    expect(attachCalls[0].handoffId).toBe("handoff-1")
    expect(attachCalls[0].presentedToken).toBe("token-1")
    await waitFor(() => messages.length >= 1)
    expect(messages[0]).toEqual({ type: "handoff.state", state: { phase: "opening-web", handoffId: "handoff-1" } })

    socket.close()
    await waitFor(() => socket.readyState === WebSocket.CLOSED)
    await server.stop()
  })

  it("客户端帧原样投递给 coordinator；二进制被解码；超大帧原样入队由网关处理", async () => {
    const { server, attachCalls, activeHandoffs, validTokens } = createHarness()
    await server.start()
    activeHandoffs.add("handoff-1")
    validTokens.add("token-1")
    const origin = server.origin

    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/web/h/handoff-1/ui?ui=token-1`, {
      headers: { origin },
    })
    await waitFor(() => attachCalls.length === 1)
    await waitFor(() => socket.readyState === WebSocket.OPEN)

    const iterator = attachCalls[0].channel.messages[Symbol.asyncIterator]()
    socket.send(JSON.stringify({ type: "handoff.ready" }))
    const first = await Promise.race([iterator.next(), sleep(1000)])
    expect(first && "value" in first ? first.value : undefined).toBe(JSON.stringify({ type: "handoff.ready" }))

    socket.send(Buffer.from([1, 2, 3]))
    const second = await Promise.race([iterator.next(), sleep(1000)])
    expect(second && "value" in second ? second.value : undefined).toBe("\u0001\u0002\u0003")

    socket.send("x".repeat(MAX_UI_FRAME_BYTES + 1))
    const third = await Promise.race([iterator.next(), sleep(1000)])
    expect(third && "value" in third ? third.value : undefined).toBe("x".repeat(MAX_UI_FRAME_BYTES + 1))

    socket.close()
    await server.stop()
  })

  it("stop() 是幂等的，多次调用不抛错且立即释放端口", async () => {
    const { server } = createHarness()
    await server.start()
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    await server.stop()
    expect(server.origin).toBe("")
    await server.stop() // 第二次调用
  })
})
