/**
 * `bootAcpTransport` 凭据读取、token 兑换与 WebSocket 重试（注入 fake
 * fetch/createSocket/storage/history，不碰真实网络）。
 */

import { describe, expect, test } from "bun:test"

import { bootAcpTransport, BootError, type BootDeps } from "../../src/acp-web/client/boot"

type FakeSocket = {
  addEventListener: (type: string, fn: () => void, opts?: { once?: boolean }) => void
  /** 测试侧触发：'open' | 'close' | 'error' */
  fire(type: "open" | "close" | "error"): void
  url: string
}

function makeDeps(over: {
  hash?: string
  stored?: string | null
  responses?: Array<{ status: number; body?: unknown }>
  socket?: "open" | "close-first"
} = {}) {
  const calls: string[] = []
  const sockets: FakeSocket[] = []
  let responseIdx = 0
  const storage = {
    map: new Map<string, string>(),
    getItem(k: string) { return this.map.get(k) ?? null },
    setItem(k: string, v: string) { calls.push("storage.set"); this.map.set(k, v) },
    removeItem(k: string) { this.map.delete(k) },
  }
  if (over.stored !== undefined) {
    if (over.stored !== null) storage.map.set("harness-acp-boot", over.stored)
  }
  let socketCount = 0
  const deps: BootDeps = {
    location: { hash: over.hash ?? "", host: "127.0.0.1:8080", pathname: "/" },
    history: { replaceState: () => { calls.push("replaceState") } },
    storage,
    fetch: (async (_url: unknown, init?: { body?: string }) => {
      calls.push("fetch")
      const spec = over.responses?.[responseIdx] ?? over.responses?.at(-1) ?? { status: 200, body: { cwd: "/tmp/ws", wsToken: `tok-${responseIdx}` } }
      responseIdx += 1
      return { status: spec.status, ok: spec.status >= 200 && spec.status < 300, json: async () => spec.body } as Response
    }) as unknown as typeof fetch,
    createSocket: (url: string) => {
      socketCount += 1
      const listeners = new Map<string, Array<() => void>>()
      const socket: FakeSocket = {
        url,
        addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
        fire: type => { for (const fn of listeners.get(type) ?? []) fn() },
      }
      sockets.push(socket)
      // 自动行为：open → 立即 open；close-first → 第一个 close 之后第二个 open。
      queueMicrotask(() => {
        if (over.socket === "close-first" && socketCount === 1) socket.fire("close")
        else socket.fire("open")
      })
      return socket as unknown as WebSocket
    },
    sleep: () => Promise.resolve(),
  }
  return { deps, calls, sockets, storage }
}

describe("bootAcpTransport", () => {
  test("片段 #c=x → 写 storage、replaceState 先于任何 fetch", async () => {
    const { deps, calls, storage } = makeDeps({ hash: "#c=frag-code" })
    await bootAcpTransport(deps)
    expect(storage.map.get("harness-acp-boot")).toBe("frag-code")
    expect(calls.indexOf("replaceState")).toBeLessThan(calls.indexOf("fetch"))
    expect(calls.indexOf("storage.set")).toBeLessThan(calls.indexOf("fetch"))
  })

  test("storage 有、片段无 → 用 storage 里的 code", async () => {
    const { deps, calls } = makeDeps({ stored: "saved-code" })
    const t = await bootAcpTransport(deps)
    expect(t.cwd).toBe("/tmp/ws")
    expect(calls).not.toContain("replaceState")
  })

  test("片段与 storage 都有且不同 → 片段优先", async () => {
    const { deps, storage } = makeDeps({ hash: "#c=fresh", stored: "stale" })
    await bootAcpTransport(deps)
    expect(storage.map.get("harness-acp-boot")).toBe("fresh")
  })

  test("两处都没有 → missing-code", async () => {
    const { deps } = makeDeps({ stored: null })
    await expect(bootAcpTransport(deps)).rejects.toMatchObject({ code: "missing-code" })
  })

  test("403 → invalid-code 且清掉 storage，不重试", async () => {
    const { deps, storage } = makeDeps({ stored: "x", responses: [{ status: 403 }] })
    await expect(bootAcpTransport(deps)).rejects.toMatchObject({ code: "invalid-code" })
    expect(storage.map.has("harness-acp-boot")).toBe(false)
  })

  test("429 → locked，不重试", async () => {
    const { deps } = makeDeps({ stored: "x", responses: [{ status: 429 }] })
    await expect(bootAcpTransport(deps)).rejects.toMatchObject({ code: "locked" })
  })

  test("ws 未 open 时回第 2 步换新 token 重试，成功后返回 socket 与 cwd", async () => {
    const { deps, sockets } = makeDeps({ stored: "x", socket: "close-first" })
    const t = await bootAcpTransport(deps)
    expect(t.cwd).toBe("/tmp/ws")
    expect(sockets.length).toBe(2)
    // 第二次用的是新 wsToken（tok-1 ≠ tok-0）
    expect(sockets[0]!.url).toContain("t=tok-0")
    expect(sockets[1]!.url).toContain("t=tok-1")
  })

  test("20 次重试用尽 → unavailable", async () => {
    let fetches = 0
    const { deps } = makeDeps({ stored: "x" })
    deps.fetch = (async () => { fetches += 1; return { status: 503, ok: false } as Response }) as unknown as typeof fetch
    await expect(bootAcpTransport(deps)).rejects.toMatchObject({ code: "unavailable" })
    expect(fetches).toBe(20)
  })
})
