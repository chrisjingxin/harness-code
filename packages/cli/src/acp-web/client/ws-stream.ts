/**
 * 浏览器 WebSocket → ACP SDK `Stream` 的适配层。
 *
 * 浏览器一侧的帧门禁与背压：
 * - 入站只做形状检查（桥已保证一帧一条、无换行、≤ 8 MiB 字节）；
 *   桥自己的 `_harnessCode/bridge/exit` 崩溃通知不交给 SDK，记入
 *   `closed` 的 `bridgeExit` 字段供网关辨认。
 * - 出站 `write` 前检查 readyState 与字节上限（超限抛错且不发送），
 *   `bufferedAmount` 高水位以上轮询 sleep，避免浏览器狂写撑爆缓冲区。
 * - `closed` 恒 resolve（不 reject）：网关一定能走到 onClose 分支。
 *
 * 【上下游】上游：SDK 的 ClientSideConnection 持有 Stream；下游：boot.ts
 * 创建的浏览器 WebSocket。本文件只允许浏览器运行时 API（不依赖 node 模块与 Bun 全局对象）。
 */

import { MAX_FRAME_BYTES } from "@za38/protocol"
import type { Stream } from "@agentclientprotocol/sdk"

import { BRIDGE_EXIT_METHOD } from "../ext"

export type WsLike = {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message" | "close" | "error" | "open", listener: (event: unknown) => void): void
}

export type BridgeExitInfo = { code: number | null; signal: string | null; stderrTail: string }

export type WsCloseInfo = {
  code: number
  reason: string
  wasClean: boolean
  bridgeExit: BridgeExitInfo | null
  /** 我们主动关闭时记下的原因（如 binary-frame）；浏览器 close 事件没有这层语义。 */
  localReason: string | null
}

export type WsStreamOptions = {
  /** 默认 MAX_FRAME_BYTES（8 MiB，按 UTF-8 字节算）。 */
  maxFrameBytes?: number
  /** 默认 1 MiB：socket.bufferedAmount 超过则 write 等待回落。 */
  highWaterBytes?: number
  /** 默认 4096：readable 队列深度超过此数判定入站溢出。 */
  maxPendingInbound?: number
  /** 测试注入；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
}

export function createWebSocketStream(
  socket: WsLike,
  options: WsStreamOptions = {},
): {
  stream: Stream
  closed: Promise<WsCloseInfo>
  close(code?: number, reason?: string): void
} {
  const max = options.maxFrameBytes ?? MAX_FRAME_BYTES
  const highWater = options.highWaterBytes ?? 1_048_576
  const maxPending = options.maxPendingInbound ?? 4096
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))

  let bridgeExit: BridgeExitInfo | null = null
  let localReason: string | null = null
  let resolveClosed!: (info: WsCloseInfo) => void
  const closed = new Promise<WsCloseInfo>(resolve => { resolveClosed = resolve })

  const fail = (controller: ReadableStreamDefaultController<unknown>, code: number, reason: string): void => {
    localReason = reason // 先记原因再关：close 事件里用它生成 closed.localReason
    try {
      socket.close(code, reason)
    } catch {
      // 已断开。
    }
    try {
      controller.error(new Error(reason))
    } catch {
      // controller 可能已关闭。
    }
  }

  const readable = new ReadableStream({
    start(controller) {
      socket.addEventListener("message", event => {
        const data = (event as { data: unknown }).data
        if (typeof data !== "string") return fail(controller, 1003, "binary-frame")
        // UTF-8 字节数可达 length 的 3 倍：length > max 直接超限；
        // length*3 ≤ max 时字节数必然不超，只有中间区间才需要精确编码。
        if (data.length > max) return fail(controller, 1009, "frame-too-large")
        if (data.length * 3 > max && new TextEncoder().encode(data).byteLength > max) {
          return fail(controller, 1009, "frame-too-large")
        }
        let value: unknown
        try {
          value = JSON.parse(data)
        } catch {
          return fail(controller, 1007, "invalid-json")
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return fail(controller, 1008, "not-a-jsonrpc-object")
        }
        const method = (value as { method?: unknown }).method
        if (method === BRIDGE_EXIT_METHOD) {
          // 桥通知不给 SDK：参数是桥发的纯 JSON，只认三字段形态。
          const params = (value as { params?: Partial<BridgeExitInfo> }).params
          bridgeExit = {
            code: typeof params?.code === "number" ? params.code : null,
            signal: typeof params?.signal === "string" ? params.signal : null,
            stderrTail: typeof params?.stderrTail === "string" ? params.stderrTail : "",
          }
          return
        }
        if ((controller.desiredSize ?? 1) < -maxPending) {
          return fail(controller, 1008, "inbound-overflow")
        }
        controller.enqueue(value)
      })
      socket.addEventListener("error", () => {
        // 只记录：浏览器随后总会发 close，统一在那里收尾。
      })
      socket.addEventListener("close", event => {
        const e = event as { code: number; reason: string; wasClean: boolean }
        resolveClosed({ code: e.code, reason: e.reason, wasClean: e.wasClean, bridgeExit, localReason })
        try {
          // 收到 bridgeExit 时 readable 报错结束，让 SDK 侧的失败路径能区分
          // "Agent 崩溃"与"正常关闭"。
          if (bridgeExit) controller.error(new Error("agent-exited"))
          else controller.close()
        } catch {
          // controller 可能已被失败路径关闭。
        }
      })
    },
    cancel() {
      try {
        socket.close(1000, "reader-cancelled")
      } catch {
        // 已断开。
      }
    },
  })

  const writable = new WritableStream({
    async write(message) {
      if (socket.readyState !== 1) throw new Error("WebSocket 未连接")
      const text = JSON.stringify(message)
      if (new TextEncoder().encode(text).byteLength > max) throw new Error("frame-too-large")
      socket.send(text)
      // 出站背压：浏览器写比 ws 通道发得快时，待发送缓冲会膨胀。
      while (socket.bufferedAmount > highWater && socket.readyState === 1) {
        await sleep(8)
      }
    },
    close() {
      try {
        socket.close(1000, "client-closed")
      } catch {
        // 已断开。
      }
    },
    abort() {
      try {
        socket.close(1000, "client-aborted")
      } catch {
        // 已断开。
      }
    },
  })

  return {
    stream: { readable, writable } as Stream,
    closed,
    close: (code = 1000, reason = "client-closed") => {
      try {
        socket.close(code, reason)
      } catch {
        // 已断开。
      }
    },
  }
}
