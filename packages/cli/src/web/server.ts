/** Node 静态 server adapter：白名单路由、精细 Host/Origin 校验与 UI token 升级门禁。 */

import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer } from "ws"
import type { RawData } from "ws"

import { AsyncQueue } from "../ipc/transport"
import type { GatewayChannel } from "../presentation-coordinator"
import type { WebAssets } from "./bundle"

export type WebServerOptions = {
  html: string
  getAssets: () => Promise<WebAssets>
  isActiveHandoff: (handoffId: string) => boolean
  /** 升级请求携带的 UI token 校验；通过后该连接获得渲染资格。 */
  validateUiToken: (handoffId: string, token: string, origin: string) => boolean
  /** 把已完成升级的渲染 channel 交给 Coordinator；生命周期与业务帧由上层处理。 */
  attachRenderer: (handoffId: string, presentedToken: string, channel: GatewayChannel) => Promise<void>
}

export type WebServer = {
  readonly origin: string
  pathFor(handoffId: string): string
  start(): Promise<void>
  stop(): Promise<void>
}

const COMMON_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
}

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src ws://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** 创建只服务当前 handoff 的本机静态 server；start 前不绑定端口。 */
export function createWebServer(options: WebServerOptions): WebServer {
  let httpServer: http.Server | undefined
  let wss: WebSocketServer | undefined
  let port = 0
  let assets: WebAssets = {
    script: "",
    style: "",
    syntaxWorkerScript: "",
  }
  const openSockets = new Set<Duplex>()
  const openWebSockets = new Set<WebSocket>()

  const origin = () => (port > 0 ? `http://127.0.0.1:${port}` : "")

  function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!httpServer || port === 0) {
      res.writeHead(404, COMMON_HEADERS)
      res.end("Not Found")
      return
    }

    const host = req.headers.host
    if (host !== `127.0.0.1:${port}`) {
      res.writeHead(403, COMMON_HEADERS)
      res.end("Forbidden")
      return
    }

    const url = new URL(req.url ?? "/", origin())
    const path = url.pathname

    if (path === "/web/app.js") {
      if (req.method !== "GET") {
        res.writeHead(405, COMMON_HEADERS)
        res.end("Method Not Allowed")
        return
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", ...COMMON_HEADERS })
      res.end(assets.script)
      return
    }

    if (path === "/web/app.css") {
      if (req.method !== "GET") {
        res.writeHead(405, COMMON_HEADERS)
        res.end("Method Not Allowed")
        return
      }
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", ...COMMON_HEADERS })
      res.end(assets.style)
      return
    }

    if (path === "/web/syntax-worker.js") {
      if (req.method !== "GET") {
        res.writeHead(405, COMMON_HEADERS)
        res.end("Method Not Allowed")
        return
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", ...COMMON_HEADERS })
      res.end(assets.syntaxWorkerScript || "")
      return
    }

    const match = matchHandoffPath(path)
    if (!match || !options.isActiveHandoff(match.handoffId)) {
      res.writeHead(404, COMMON_HEADERS)
      res.end("Not Found")
      return
    }

    if (match.kind === "page") {
      if (req.method !== "GET") {
        res.writeHead(405, COMMON_HEADERS)
        res.end("Method Not Allowed")
        return
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cross-origin-opener-policy": "same-origin",
        "content-security-policy": HTML_CSP,
        ...COMMON_HEADERS,
      })
      res.end(options.html)
      return
    }

    // /ui 路由是 WebSocket 专用路由，普通 HTTP 请求一律返回 405
    res.writeHead(405, COMMON_HEADERS)
    res.end("Method Not Allowed")
  }

  function handleHttpUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    function rejectUpgrade(statusCode: number, statusText: string): void {
      socket.end(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }

    if (!httpServer || port === 0 || !wss) {
      rejectUpgrade(500, "Server Not Ready")
      return
    }

    const host = req.headers.host
    if (host !== `127.0.0.1:${port}`) {
      rejectUpgrade(403, "Forbidden")
      return
    }

    if (req.headers.origin !== origin()) {
      rejectUpgrade(403, "Forbidden")
      return
    }

    const url = new URL(req.url ?? "/", origin())
    const match = matchHandoffPath(url.pathname)
    if (!match || match.kind !== "ui" || !options.isActiveHandoff(match.handoffId)) {
      rejectUpgrade(404, "Not Found")
      return
    }

    // UI token 从升级 URL 的查询参数读取（fragment 无法送达服务端）；bootstrap token
    // 绑定 handoffId、Origin 与 TTL，接管后使用每次成功连接都轮换的单次重连 token。
    // 本 server 只服务 127.0.0.1、无访问日志——禁止为该 server
    // 开启访问日志或接入代理，否则 token 会以明文出现在日志中。
    const token = url.searchParams.get("ui")
    if (!token || !options.validateUiToken(match.handoffId, token, origin())) {
      rejectUpgrade(403, "Forbidden")
      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      openWebSockets.add(ws)
      const queue = new AsyncQueue<unknown>()

      const channel: GatewayChannel = {
        messages: queue,
        send: async message => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message))
          }
        },
        close: async (code, reason) => {
          try {
            ws.close(code, reason)
          } catch {
            // 已断开时忽略。
          }
          queue.end()
        },
        isOpen: () => ws.readyState === WebSocket.OPEN,
      }

      ws.on("message", (raw: RawData) => {
        const text = typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString("utf8")
              : new TextDecoder().decode(raw)
        queue.push(text)
      })

      ws.on("close", () => {
        queue.end()
        openWebSockets.delete(ws)
      })

      ws.on("error", () => {
        queue.end()
        openWebSockets.delete(ws)
      })

      void options.attachRenderer(match.handoffId, token, channel)
    })
  }

  return {
    get origin() {
      return origin()
    },
    pathFor: handoffId => `/web/h/${handoffId}`,
    start: async () => {
      if (httpServer) return
      assets = await options.getAssets()

      wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: 16 * 1024 * 1024,
      })

      httpServer = http.createServer(handleHttpRequest)
      httpServer.on("upgrade", handleHttpUpgrade)
      httpServer.on("connection", socket => {
        openSockets.add(socket)
        socket.on("close", () => openSockets.delete(socket))
      })

      await new Promise<void>((resolve, reject) => {
        httpServer!.listen(0, "127.0.0.1", () => {
          const address = httpServer?.address()
          if (address && typeof address === "object") {
            port = address.port
            resolve()
          } else {
            reject(new Error("Failed to obtain loopback port"))
          }
        })
        httpServer!.once("error", reject)
      })
    },
    stop: async () => {
      if (!httpServer) return
      const currentServer = httpServer
      const currentWss = wss
      httpServer = undefined
      wss = undefined
      port = 0

      for (const ws of openWebSockets) {
        try {
          ws.terminate()
        } catch {
          // 忽略
        }
      }
      openWebSockets.clear()

      for (const socket of openSockets) {
        try {
          socket.destroy()
        } catch {
          // 忽略
        }
      }
      openSockets.clear()

      try {
        currentWss?.close()
      } catch {
        // 忽略
      }

      await new Promise<void>(resolve => {
        currentServer.close(() => resolve())
      })
    },
  }
}

/** 只解析两条精确路径；不做任何文件系统读取。 */
function matchHandoffPath(
  path: string,
): { handoffId: string; kind: "page" | "ui" } | undefined {
  const page = path.match(/^\/web\/h\/([^/]+)$/)
  if (page) {
    const handoffId = decodePathSegment(page[1])
    if (handoffId !== undefined) return { handoffId, kind: "page" }
  }
  const ui = path.match(/^\/web\/h\/([^/]+)\/ui$/)
  if (ui) {
    const handoffId = decodePathSegment(ui[1])
    if (handoffId !== undefined) return { handoffId, kind: "ui" }
  }
  return undefined
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
