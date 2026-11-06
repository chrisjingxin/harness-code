/**
 * 桥集成测试夹具：起一个真实 Bun.serve 的桥（随机端口），提供兑换、升级与事件等待助手。
 *
 * 所有用例共用的小限制（exitGraceMs/termGraceMs 400ms）让回收断言足够快；
 * `events` 收集结构化诊断事件，断言"日志不含秘密"的用例直接对它做全文搜索。
 */

import type { AcpSpawnPlan } from "../../../src/acp-command"
import {
  createAcpWebBridge,
  type AcpWebBridge,
  type AcpWebBridgeOptions,
  type BridgeEvent,
} from "../../../src/acp-web/bridge/bridge"

export type RedeemResult = { status: number; body: { cwd?: string; wsToken?: string; error?: string }; retryAfter: string | null }

export type HarnessSocket = {
  ws: WebSocket
  opened: Promise<void>
  closed: Promise<{ code: number; reason: string; wasClean: boolean }>
  /** 已收到的文本帧（按到达顺序）。 */
  messages: string[]
  /** 取下一帧；没有则等待。 */
  nextMessage(): Promise<string>
}

export type BridgeHarness = {
  bridge: AcpWebBridge
  origin: string
  wsOrigin: string
  port: number
  events: BridgeEvent[]
  bootCode: string
  /** 走真实 POST /acp/boot；默认用正确 bootCode、正确 Origin 与 JSON Content-Type。 */
  redeem(code?: string): Promise<RedeemResult>
  /** 用 Bun 的 WebSocket 客户端升级；Origin 默认正确。 */
  openWs(token: string, options?: { origin?: string }): HarnessSocket
  wsUrl(token: string): string
  /** 轮询 events 直到匹配或超时；超时输出里不含凭据，只有事件名。 */
  waitForEvent(match: (event: BridgeEvent) => boolean, timeoutMs?: number): Promise<BridgeEvent>
  /** 等桥侧连接数归零。 */
  waitForDrained(timeoutMs?: number): Promise<void>
  stop(): Promise<void>
}

export async function startBridge(
  plan: AcpSpawnPlan | (() => AcpSpawnPlan),
  overrides: Partial<AcpWebBridgeOptions> = {},
): Promise<BridgeHarness> {
  const events: BridgeEvent[] = []
  const bridge = createAcpWebBridge({
    cwd: process.cwd(),
    agentPlan: typeof plan === "function" ? plan : () => plan,
    port: 0,
    limits: { exitGraceMs: 400, termGraceMs: 400 },
    log: event => events.push(event),
    ...overrides,
  })
  const { port, origin } = await bridge.start()
  const bootUrl = bridge.bootUrl()
  const bootCode = new URL(bootUrl).hash.slice(3) // "#c=" 前缀
  const wsOrigin = origin.replace(/^http/, "ws")

  const harness: BridgeHarness = {
    bridge,
    origin,
    wsOrigin,
    port,
    events,
    bootCode,
    async redeem(code = bootCode) {
      const response = await fetch(`${origin}/acp/boot`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ code }),
      })
      return {
        status: response.status,
        body: await response.json(),
        retryAfter: response.headers.get("retry-after"),
      }
    },
    openWs(token, options = {}) {
      const socket = new WebSocket(harness.wsUrl(token), {
        headers: { origin: options.origin ?? origin },
      } as never)
      return wrapSocket(socket)
    },
    wsUrl(token) {
      return `${wsOrigin}/acp/ws?t=${encodeURIComponent(token)}`
    },
    async waitForEvent(match, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = events.find(match)
        if (found) return found
        if (Date.now() > deadline) {
          throw new Error(`等待桥事件超时；已见事件: ${events.map(event => event.event).join(",")}`)
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
    async waitForDrained(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      while (bridge.connectionCount > 0) {
        if (Date.now() > deadline) throw new Error(`等待连接回收超时；剩余 ${bridge.connectionCount}`)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
    async stop() {
      await bridge.stop({ force: true }).catch(() => undefined)
    },
  }
  return harness
}

function wrapSocket(socket: WebSocket): HarnessSocket {
  const messages: string[] = []
  const waiters: Array<(text: string) => void> = []
  let rejectOpened: ((error: Error) => void) | undefined
  const opened = new Promise<void>((resolve, reject) => {
    rejectOpened = reject
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("WebSocket 升级失败")), { once: true })
  })
  const closed = new Promise<{ code: number; reason: string; wasClean: boolean }>(resolve => {
    socket.addEventListener("close", event => {
      rejectOpened?.(new Error("WebSocket 升级失败"))
      resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean })
    }, { once: true })
  })
  socket.addEventListener("message", event => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data)
    const waiter = waiters.shift()
    if (waiter) waiter(text)
    else messages.push(text)
  })
  return {
    ws: socket,
    opened,
    closed,
    messages,
    nextMessage() {
      const queued = messages.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<string>(resolve => waiters.push(resolve))
    },
  }
}
