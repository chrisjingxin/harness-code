/** 桥的连接生命周期用例：转发、回收、崩溃、名额、背压与 stop。 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { connect as netConnect, type Socket } from "node:net"

import { MAX_FRAME_BYTES } from "../../src/acp-web/bridge/framing"
import { fakeChild } from "./support/fake-children"
import { startBridge, type BridgeHarness } from "./support/bridge-harness"

let harness: BridgeHarness | undefined

afterEach(async () => {
  await harness?.stop()
  harness = undefined
})

async function up(
  plan: Parameters<typeof startBridge>[0] = fakeChild("echo"),
  overrides: Parameters<typeof startBridge>[1] = {},
) {
  harness = await startBridge(plan, overrides)
  return harness
}

async function tokenOf(h: BridgeHarness): Promise<string> {
  const redeemed = await h.redeem()
  expect(redeemed.status).toBe(200)
  return redeemed.body.wsToken!
}

/** 期望失败的升级（403/409）：fetch 拿到桥的 HTTP 错误响应。 */
const upgradeStatus = (h: BridgeHarness, token: string, extraHeaders: Record<string, string> = {}) =>
  fetch(`${h.origin}/acp/ws?t=${token}`, {
    headers: { upgrade: "websocket", origin: h.origin, ...extraHeaders },
  })

describe("基本转发", () => {
  test("回显往返：一帧一条，200 帧顺序保持", async () => {
    const h = await up()
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    socket.ws.send('{"jsonrpc":"2.0","id":1,"method":"x"}')
    expect(await socket.nextMessage()).toBe('{"jsonrpc":"2.0","id":1,"method":"x"}')
    const sent: string[] = []
    for (let i = 0; i < 200; i += 1) {
      const frame = `{"jsonrpc":"2.0","id":${i},"method":"x"}`
      sent.push(frame)
      socket.ws.send(frame)
    }
    for (const expected of sent) {
      expect(await socket.nextMessage()).toBe(expected)
    }
    socket.ws.close()
    await h.waitForDrained()
  })

  test("一个 WebSocket 一个子进程：agentPlan 每连接调用一次", async () => {
    let calls = 0
    const h = await up(() => {
      calls += 1
      return fakeChild("echo")
    })
    const first = h.openWs(await tokenOf(h))
    await first.opened
    await h.waitForEvent(event => event.event === "agent.spawned")
    expect(calls).toBe(1)
    first.ws.close()
    await h.waitForDrained()
    const second = h.openWs(await tokenOf(h))
    await second.opened
    await h.waitForEvent(event => event.event === "agent.spawned")
    expect(calls).toBe(2)
    second.ws.close()
    await h.waitForDrained()
  })
})

describe("非法入站帧", () => {
  test.each([
    { name: "二进制帧", send: (ws: WebSocket) => ws.send(new Uint8Array([1, 2, 3])), codes: [1003] },
    { name: "数组帧", send: (ws: WebSocket) => ws.send("[1]"), codes: [1008] },
    { name: "含换行帧", send: (ws: WebSocket) => ws.send('{"a":1}\n'), codes: [1008] },
    {
      name: "超 8 MiB 帧",
      send: (ws: WebSocket) => ws.send(`{${"a".repeat(MAX_FRAME_BYTES)}}`),
      codes: [1006, 1009], // Bun 的 maxPayloadLength(1006) 或桥的门禁(1009) 均可
    },
  ])("$name → 关闭且子进程被回收", async ({ send, codes }) => {
    const h = await up()
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    send(socket.ws)
    const closed = await socket.closed
    expect(codes).toContain(closed.code)
    const exited = await h.waitForEvent(event => event.event === "agent.exited")
    expect(exited.event === "agent.exited" && exited.expected).toBe(true)
    await h.waitForDrained()
  })
})

describe("浏览器关闭与子进程回收", () => {
  test("关闭 WebSocket → stdin EOF → cat 在宽限内退出，无信号升级", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "acp-pid-")), "pid")
    const h = await up(fakeChild("pidfile", { pidFile }))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const spawned = await h.waitForEvent(event => event.event === "agent.spawned")
    socket.ws.close()
    const exited = await h.waitForEvent(event => event.event === "agent.exited", 2_000)
    expect(exited.event === "agent.exited" && exited.expected).toBe(true)
    expect(h.events.filter(event => event.event === "agent.escalated")).toEqual([])
    expect(spawned.event === "agent.spawned" && spawned.pid).toBeTruthy()
    await h.waitForDrained()
    expect(h.bridge.connectionCount).toBe(0)
  })

  test("忽略 EOF 的子进程 → SIGTERM → SIGKILL 依次升级", async () => {
    const h = await up(fakeChild("ignore-term"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const spawned = await h.waitForEvent(event => event.event === "agent.spawned")
    const pid = spawned.event === "agent.spawned" ? spawned.pid! : 0
    const startedAt = Date.now()
    socket.ws.close()
    await h.waitForEvent(event => event.event === "agent.escalated" && event.step === "SIGTERM")
    await h.waitForEvent(event => event.event === "agent.escalated" && event.step === "SIGKILL")
    await h.waitForDrained()
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeLessThan(400 + 400 + 1_000)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("连接关闭后名额在回收完成前一直占着", async () => {
    const h = await up(fakeChild("ignore-term"))
    const first = h.openWs(await tokenOf(h))
    await first.opened
    const secondToken = await tokenOf(h)
    first.ws.close()
    // ignore-term 回收要走完 SIGTERM→SIGKILL 窗口：这段时间升级仍是 409。
    const busy = await upgradeStatus(h, secondToken)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toEqual({ error: "busy" })
    await h.waitForDrained()
    // 回收完毕后同一 token（409 没烧掉它）可以升级。
    const second = h.openWs(secondToken)
    await second.opened
    second.ws.close()
    await h.waitForDrained()
  })
})

describe("子进程崩溃与异常", () => {
  test("崩溃：先收 _harnessCode/bridge/exit 帧，再以 1011 关闭", async () => {
    const h = await up(fakeChild("crash"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const frame = JSON.parse(await socket.nextMessage()) as {
      method: string
      params: { code: number | null; signal: string | null; stderrTail: string }
    }
    expect(frame.method).toBe("_harnessCode/bridge/exit")
    expect(frame.params.code).toBe(3)
    expect(frame.params.signal).toBeNull()
    expect(frame.params.stderrTail).toContain("boom")
    const closed = await socket.closed
    expect(closed.code).toBe(1011)
    expect(closed.reason).toBe("agent-exited")
    const exited = await h.waitForEvent(event => event.event === "agent.exited")
    expect(exited.event === "agent.exited" && exited.expected).toBe(false)
    await h.waitForDrained()
  })

  test("崩溃：子进程最后写的帧先于 bridge/exit 与 1011 到达", async () => {
    const h = await up(fakeChild("crash-with-frame"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    expect(await socket.nextMessage()).toBe('{"jsonrpc":"2.0","id":9,"method":"last"}')
    const notice = JSON.parse(await socket.nextMessage()) as { method: string; params: { code: number | null } }
    expect(notice.method).toBe("_harnessCode/bridge/exit")
    expect(notice.params.code).toBe(3)
    expect((await socket.closed).code).toBe(1011)
    await h.waitForDrained()
  })

  test("崩溃通知脱敏：stderr 里的秘密形态串变成 [redacted]", async () => {
    const h = await up(fakeChild("leak-token"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const frame = JSON.parse(await socket.nextMessage()) as { params: { stderrTail: string } }
    expect(frame.params.stderrTail).toContain("[redacted]")
    expect(frame.params.stderrTail).not.toContain("aBc9_-Xy7")
    await socket.closed
    await h.waitForDrained()
  })

  test("启动失败：可执行文件不存在 → 通知 + 1011", async () => {
    const h = await up({
      executable: "/nonexistent/acp-agent",
      args: [],
      cwd: "/tmp",
      env: {},
    })
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const frame = JSON.parse(await socket.nextMessage()) as { params: { stderrTail: string } }
    expect(frame.params.stderrTail).toContain("spawn failed")
    const closed = await socket.closed
    expect(closed.code).toBe(1011)
    await h.waitForDrained()
  })

  test("stdout 污染：非帧行不转发，连接以 1011 关闭", async () => {
    const h = await up(fakeChild("pollute"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const closed = await socket.closed
    expect(closed.code).toBe(1011)
    expect(socket.messages.join("")).not.toContain("not json")
    await h.waitForDrained()
  })

  test("stderr 始终被消费：写 2 MiB stderr 后回显仍正常", async () => {
    const h = await up(fakeChild("stderr-flood"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const frame = '{"jsonrpc":"2.0","id":9,"method":"x"}'
    socket.ws.send(frame)
    expect(await socket.nextMessage()).toBe(frame)
    socket.ws.close()
    await h.waitForDrained()
  })
})

describe("第二个连接与 token 语义", () => {
  test("名额被占时升级 409 不烧 token；无效 token 仍先 403", async () => {
    const h = await up()
    const first = h.openWs(await tokenOf(h))
    await first.opened
    const secondToken = await tokenOf(h) // boot 兑换不受名额限制
    const busy = await upgradeStatus(h, secondToken)
    expect(busy.status).toBe(409)
    const invalidWhileBusy = await upgradeStatus(h, "x".repeat(43))
    expect(invalidWhileBusy.status).toBe(403) // 先检视凭据再看名额
    first.ws.close()
    await h.waitForDrained()
    const second = h.openWs(secondToken) // 409 没烧掉 token
    await second.opened
    second.ws.close()
    await h.waitForDrained()
  })

  test("wsToken 一次性：重放 403；注入时钟 60 秒后 403 expired", async () => {
    let at = 1_000_000
    const h = await up(fakeChild("echo"), { now: () => at })
    const token = await tokenOf(h)
    const socket = h.openWs(token)
    await socket.opened
    socket.ws.close()
    await h.waitForDrained()
    const replay = await upgradeStatus(h, token)
    expect(replay.status).toBe(403)
    expect(await replay.json()).toEqual({ error: "invalid-token" })

    const second = await tokenOf(h)
    at += 60_001
    const expired = await upgradeStatus(h, second)
    expect(expired.status).toBe(403)
    expect(await expired.json()).toEqual({ error: "expired-token" })
  })

  test("并发升级竞态：恰好一个 101，另一个 409，只 spawn 一个子进程", async () => {
    const h = await up()
    const [t1, t2] = [await tokenOf(h), await tokenOf(h)]
    const first = h.openWs(t1)
    const second = h.openWs(t2)
    const [r1, r2] = await Promise.allSettled([first.opened, second.opened])
    const opened = [r1, r2].filter(r => r.status === "fulfilled").length
    expect(opened).toBe(1)
    await h.waitForEvent(event => event.event === "ws.rejected" && event.reason === "busy")
    expect(h.events.filter(event => event.event === "agent.spawned")).toHaveLength(1)
    for (const socket of [first, second]) socket.ws.close()
    await h.waitForDrained()
  })
})

describe("stop()", () => {
  test("正常停止：连接收到 server-shutdown 关闭，子进程回收，端口释放，幂等", async () => {
    const h = await up()
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    await h.bridge.stop()
    const closed = await socket.closed
    // Bun 把 1001（保留码）改写成 1000；语义由 reason 承载（describeClose 认它）。
    expect(closed.code).toBe(1000)
    expect(closed.reason).toBe("server-shutdown")
    await h.waitForDrained()
    // Bun 的 fetch 会复用 keep-alive 连接：端口是否真的释放要用新 TCP 连接验证。
    await expect(new Promise<void>((resolve, reject) => {
      const sock = netConnect({ host: "127.0.0.1", port: h.port })
      sock.once("connect", () => { sock.destroy(); resolve() })
      sock.once("error", reject)
    })).rejects.toThrow()
    // 重复 stop 无副作用。
    await h.bridge.stop()
    harness = undefined // afterEach 不再重复 stop
  })

  test("stop({force:true})：ignore-term 立即 SIGKILL", async () => {
    const h = await up(fakeChild("ignore-term"))
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    const spawned = await h.waitForEvent(event => event.event === "agent.spawned")
    const pid = spawned.event === "agent.spawned" ? spawned.pid! : 0
    const startedAt = Date.now()
    await h.bridge.stop({ force: true })
    expect(Date.now() - startedAt).toBeLessThan(400) // 不等 exitGrace
    await h.waitForDrained()
    expect(() => process.kill(pid, 0)).toThrow()
    harness = undefined
  })
})

describe("背压", () => {
  test("慢客户端：不读数据的连接在 backpressureLimit 处被关闭，子进程回收", async () => {
    const h = await up(fakeChild("flood"), { limits: { backpressureLimit: 1024 * 1024, exitGraceMs: 400, termGraceMs: 400 } })
    const heapBefore = process.memoryUsage().heapUsed
    const token = await tokenOf(h)
    // node:net socket 不挂 data 监听就一直 paused：内核缓冲填满 → 服务端背压。
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const sock = netConnect({ host: "127.0.0.1", port: h.port })
      sock.once("connect", () => resolveSocket(sock))
      sock.once("error", rejectSocket)
    })
    const key = Buffer.from("0123456789abcdef").toString("base64")
    socket.write(
      `GET /acp/ws?t=${token} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${h.port}\r\n` +
      `Origin: ${h.origin}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n",
    )
    await h.waitForEvent(event => event.event === "ws.opened")
    // 连接被背压关闭，子进程走完回收。
    // 连接被背压关闭，子进程走完回收。队列上限 1 MiB 由 Bun 的
    // closeOnBackpressureLimit 兜底；flood 的吞吐量只造成 GC 抖动，
    // 留存内存用 heapUsed 衡量（RSS 不会因 GC 收缩，不可作为断言对象）。
    await h.waitForEvent(event => event.event === "ws.closed", 10_000)
    await h.waitForDrained(10_000)
    socket.destroy()
    Bun.gc(true) // flood 的吞吐只造成临时分配；GC 后的 heapUsed 才是真实留存
    // 真实泄漏（回收期 stdout 不销毁）会让留存到 GB 级；阈值放宽到 128 MiB
    // 只挡病态，不容忍 GC/碎片噪声。
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore
    expect(heapGrowth).toBeLessThan(128 * 1024 * 1024)
  })

  test("stdin 背压：子进程不读 stdin，待写字节超限 → 1008 关闭并回收", async () => {
    const h = await up(fakeChild("sleep"), { limits: { stdinPendingBytes: 1024 * 1024, exitGraceMs: 400, termGraceMs: 400 } })
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    // 1.5 MiB 的单帧：sleep 不读 stdin，write 排队立刻超 1 MiB 上限。
    socket.ws.send(`{"data":"${"a".repeat(1536 * 1024)}"}`)
    socket.ws.send(`{"data":"${"b".repeat(1024)}"}`)
    const closed = await socket.closed
    expect(closed.code).toBe(1008)
    await h.waitForDrained()
  })
})

describe("bootCode 滑动窗口", () => {
  test("活动连接期间 touch 顺延；关闭后 10 分钟过期", async () => {
    let at = 1_000_000
    const h = await up(fakeChild("echo"), { now: () => at })
    const socket = h.openWs(await tokenOf(h))
    await socket.opened
    // 在窗口内分两次推进：touch 只顺延"未过期"的锚点，过期后不能复活，
    // 所以必须在 10 分钟内各发一帧，模拟真实长连接里的持续活动。
    for (const step of [1, 2]) {
      at += 9 * 60_000
      socket.ws.send(`{"jsonrpc":"2.0","id":${step},"method":"x"}`)
      expect(await socket.nextMessage()).toBe(`{"jsonrpc":"2.0","id":${step},"method":"x"}`)
    }
    // 距创建已 18 分钟，但帧活动让窗口一直顺延：兑换仍然成功。
    expect((await h.redeem()).status).toBe(200)
    socket.ws.close()
    await h.waitForDrained()
    at += 10 * 60_000 + 1
    const expired = await h.redeem()
    expect(expired.status).toBe(403)
    expect(expired.body.error).toBe("expired-code")
  })
})

describe("日志不含秘密", () => {
  test("生命周期事件全文不含凭据与请求头值", async () => {
    const h = await up()
    const token = await tokenOf(h)
    const socket = h.openWs(token)
    await socket.opened
    socket.ws.send('{"jsonrpc":"2.0","id":1,"method":"x"}')
    await socket.nextMessage()
    socket.ws.close()
    await h.waitForDrained()
    const serialized = JSON.stringify(h.events)
    expect(serialized).not.toContain(h.bootCode)
    expect(serialized).not.toContain(token)
  })
})
