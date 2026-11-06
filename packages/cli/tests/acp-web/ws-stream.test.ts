/** createWebSocketStream 用例：假 WsLike 驱动 readable/writable 全部规则。 */

import { describe, expect, test } from "bun:test"

import { MAX_FRAME_BYTES } from "../../src/acp-web/bridge/framing"
import { createWebSocketStream, type WsLike } from "../../src/acp-web/client/ws-stream"

function fakeWs(): WsLike & {
  sent: string[]
  listeners: Map<string, Array<(event: unknown) => void>>
  closeCalls: Array<{ code?: number; reason?: string }>
  emit(type: string, event: unknown): void
} {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    closeCalls: [] as Array<{ code?: number; reason?: string }>,
    listeners,
    send(data: string) { ws.sent.push(data) },
    close(code?: number, reason?: string) { ws.closeCalls.push({ code, reason }); ws.readyState = 3 },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
  return ws
}

const message = (data: unknown) => ({ data })
const closeEvent = (code = 1000, reason = "", wasClean = true) => ({ code, reason, wasClean })

describe("createWebSocketStream", () => {
  test("回环：writable.write → socket.send；message → readable 读出", async () => {
    const ws = fakeWs()
    const { stream } = createWebSocketStream(ws)
    const writer = stream.writable.getWriter()
    await writer.write({ jsonrpc: "2.0", id: 1, method: "x" } as never)
    expect(ws.sent).toEqual(['{"jsonrpc":"2.0","id":1,"method":"x"}'])

    ws.emit("message", message('{"jsonrpc":"2.0","id":1,"result":{}}'))
    const reader = stream.readable.getReader()
    expect(await reader.read()).toEqual({ done: false, value: { jsonrpc: "2.0", id: 1, result: {} } })
  })

  test("非字符串帧 → 1003 binary-frame，readable 报错，closed.localReason 记录", async () => {
    const ws = fakeWs()
    const { stream, closed } = createWebSocketStream(ws)
    ws.emit("message", message(new Uint8Array([1, 2, 3])))
    expect(ws.closeCalls[0]).toEqual({ code: 1003, reason: "binary-frame" })
    ws.emit("close", closeEvent(1003, "binary-frame"))
    const info = await closed
    expect(info.localReason).toBe("binary-frame")
    await expect(stream.readable.getReader().read()).rejects.toThrow("binary-frame")
  })

  test("超长文本帧 → 1009 frame-too-large", async () => {
    const ws = fakeWs()
    createWebSocketStream(ws)
    ws.emit("message", message(`{${"a".repeat(MAX_FRAME_BYTES)}}`))
    expect(ws.closeCalls[0].code).toBe(1009)
  })

  test("length ≤ 上限但 UTF-8 字节数超限的多字节帧 → 1009", async () => {
    const ws = fakeWs()
    // 上限 100：'你'(3 字节) × 40 = 120 字节 > 100，但 length = 40+2 ≤ 100。
    createWebSocketStream(ws, { maxFrameBytes: 100 })
    ws.emit("message", message(`{"${"你".repeat(40)}"}`))
    expect(ws.closeCalls[0]).toEqual({ code: 1009, reason: "frame-too-large" })
  })

  test("坏 JSON → 1007 invalid-json；数组/标量 → 1008 not-a-jsonrpc-object", async () => {
    const bad = fakeWs()
    createWebSocketStream(bad)
    bad.emit("message", message("not json"))
    expect(bad.closeCalls[0]).toEqual({ code: 1007, reason: "invalid-json" })

    const arr = fakeWs()
    createWebSocketStream(arr)
    arr.emit("message", message("[1]"))
    expect(arr.closeCalls[0]).toEqual({ code: 1008, reason: "not-a-jsonrpc-object" })

    const scalar = fakeWs()
    createWebSocketStream(scalar)
    scalar.emit("message", message("42"))
    expect(scalar.closeCalls[0].code).toBe(1008)
  })

  test("_harnessCode/bridge/exit 帧：不入队，记入 closed.bridgeExit，readable 报错", async () => {
    const ws = fakeWs()
    const { stream, closed } = createWebSocketStream(ws)
    ws.emit("message", message(JSON.stringify({
      jsonrpc: "2.0",
      method: "_harnessCode/bridge/exit",
      params: { code: 3, signal: null, stderrTail: "boom" },
    })))
    ws.emit("message", message('{"jsonrpc":"2.0","id":1,"result":{}}'))
    const reader = stream.readable.getReader()
    const { value } = await reader.read() as { value: { id: number } }
    expect(value.id).toBe(1) // 桥通知没有入队
    ws.emit("close", closeEvent(1011, "agent-exited", false))
    const info = await closed
    expect(info.bridgeExit).toEqual({ code: 3, signal: null, stderrTail: "boom" })
    expect(info.code).toBe(1011)
    await expect(reader.read()).rejects.toThrow("agent-exited")
  })

  test("正常 close：closed 带 code/reason/wasClean，readable 正常结束", async () => {
    const ws = fakeWs()
    const { stream, closed } = createWebSocketStream(ws)
    const reader = stream.readable.getReader()
    const pending = reader.read()
    ws.emit("close", closeEvent(1000, "bye"))
    const info = await closed
    expect(info).toMatchObject({ code: 1000, reason: "bye", wasClean: true, bridgeExit: null })
    expect(await pending).toMatchObject({ done: true })
  })

  test("writable.write：连接非 OPEN 抛错；超限帧抛错且不发送", async () => {
    const ws = fakeWs()
    const { stream } = createWebSocketStream(ws)
    ws.readyState = 3
    const writer = stream.writable.getWriter()
    await expect(writer.write({ a: 1 } as never)).rejects.toThrow()

    // WritableStream 出错后即失效，超限用例另起一个流。
    const ws2 = fakeWs()
    const writer2 = createWebSocketStream(ws2).stream.writable.getWriter()
    const big = { data: "a".repeat(MAX_FRAME_BYTES) }
    await expect(writer2.write(big as never)).rejects.toThrow("frame-too-large")
    expect(ws2.sent).toEqual([])
  })

  test("背压：bufferedAmount 高于水位时 write 等待 sleep，回落后放行", async () => {
    const ws = fakeWs()
    let sleeps = 0
    const { stream } = createWebSocketStream(ws, {
      highWaterBytes: 10,
      sleep: async () => { sleeps += 1; ws.bufferedAmount = 0 },
    })
    ws.bufferedAmount = 100
    const writer = stream.writable.getWriter()
    await writer.write({ a: 1 } as never)
    expect(sleeps).toBe(1)
    expect(ws.sent).toHaveLength(1)
  })

  test("readable.cancel 与 writable.close 都以 1000 关闭 socket", async () => {
    const ws = fakeWs()
    const { stream } = createWebSocketStream(ws)
    await stream.readable.cancel()
    expect(ws.closeCalls[0]).toEqual({ code: 1000, reason: "reader-cancelled" })

    const ws2 = fakeWs()
    const s2 = createWebSocketStream(ws2)
    await s2.stream.writable.close()
    expect(ws2.closeCalls[0]).toEqual({ code: 1000, reason: "client-closed" })
    s2.close(1001, "custom")
    expect(ws2.closeCalls[1]).toEqual({ code: 1001, reason: "custom" })
  })
})
