/**
 * ACP Web 桥：`harness web` 的核心，浏览器与 `harness acp` 子进程之间的本机转发层。
 *
 * 【这是做什么的？】
 * 监听 127.0.0.1 随机端口，提供四个路由：`GET /`（入口页）、`GET /assets/*`
 * （静态资源）、`POST /acp/boot`（bootCode 换一次性 wsToken）、`GET /acp/ws`
 * （升级 WebSocket）。一个 WebSocket 对应一个 `harness acp` 子进程，帧在两个
 * 方向原样转发（一帧一条 JSON-RPC 对象、一条 JSON 一行）。
 *
 * 【安全模型（为什么每条都不可省）】
 * 桥会启动能执行代码的子进程，任何校验不过一律拒绝（fail closed）：
 * - Host 逐字匹配防 DNS 重绑定；Origin 逐字匹配防跨站请求与跨站 WebSocket；
 * - 凭据检查永远排在 Host/Origin 之后：跨站请求碰不到错误计数器，无法锁死用户；
 * - bootCode 滑动过期、wsToken 一次性 60 秒、比较恒定时间（见 session-token.ts）；
 * - 同时只允许一个 WebSocket（含回收中的连接），第二个升级 409 且不烧 token。
 *
 * 【连接生命周期】
 * ```text
 * GET /acp/ws                     open(ws)                         close(ws)
 *   Host✓ Origin✓ t✓               plan = agentPlan()                 │
 *   inspect(wsToken)               child = spawn(plan)                ▼
 *   名额空闲 → spend → upgrade ──▶  stdin/stdout/stderr 接管       beginReap:
 *        │                            │                            stdin.end() → EOF
 *        │                            ▼                            t+exitGraceMs → SIGTERM
 *        │                        message(ws, data)                t+termGraceMs → SIGKILL
 *        │                          门禁 → stdin.write            child exit → 名额释放
 *        │                        stdout → 按行 ws.send
 *        │
 *        └── 子进程先死（崩溃）：发 _harnessCode/bridge/exit 通知 → 1011 → 同上回收
 * ```
 *
 * 【上下游】
 * 上游：`web-command.ts`（`harness web` 命令创建并 stop 它）。
 * 下游：`guard.ts`（门禁纯函数）、`session-token.ts`（凭据）、`framing.ts`
 * （帧门禁与行切分）、`assets.ts`（资源提供者）、`../ext.ts`（桥通知方法名）、
 * `acp-command.ts`（AcpSpawnPlan 类型）、node:child_process（spawn，可注入）。
 *
 * 【日志纪律】诊断事件只有枚举值与安全字段；token、帧内容、请求头值、URL、
 * stderr 全文一律不进事件。stderr 尾部只留脱敏后的 200 字符。
 */

import { spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"

import { BRIDGE_EXIT_METHOD } from "../ext"
import type { AcpSpawnPlan } from "../../acp-command"
import {
  ASSET_KEY_PATTERN,
  assertValidAssets,
  placeholderAssets,
  type AcpWebAssetProvider,
  type AcpWebAssets,
} from "./assets"
import {
  COMMON_HEADERS,
  MAX_BOOT_BODY_BYTES,
  checkHost,
  checkJsonRequest,
  checkOrigin,
  htmlHeaders,
  parseBootBody,
  readBoundedText,
} from "./guard"
import {
  LineSplitter,
  MAX_FRAME_BYTES,
  TailBuffer,
  checkInboundFrame,
  redactTail,
} from "./framing"
import { createSessionTokens, type SessionTokens } from "./session-token"

export type { AcpSpawnPlan }

export type BridgeLimits = {
  /** 关 stdin 后等子进程自行退出的宽限。 */
  exitGraceMs: number
  /** SIGTERM 之后再等的宽限。 */
  termGraceMs: number
  /** stop() 的总上限，之后对残余强杀。 */
  stopDeadlineMs: number
  /** 子进程不读 stdin 时，待写字节超过即终止连接。 */
  stdinPendingBytes: number
  /** 崩溃通知里带的 stderr 末尾长度。 */
  stderrTailChars: number
  /** 活动连接顺延 bootCode 滑动窗口的最小间隔。 */
  touchIntervalMs: number
  /** Bun ws 出站背压上限；超过即由 Bun 关闭连接。 */
  backpressureLimit: number
}

const DEFAULT_LIMITS: BridgeLimits = {
  exitGraceMs: 5_000,
  termGraceMs: 3_000,
  stopDeadlineMs: 12_000,
  stdinPendingBytes: 32 * 1024 * 1024,
  stderrTailChars: 200,
  touchIntervalMs: 10_000,
  backpressureLimit: 16 * 1024 * 1024,
}

/** 结构化诊断事件；任何字段都不含 token、帧内容、请求头值、URL。 */
export type BridgeEvent =
  | { event: "server.started"; port: number }
  | { event: "guard.rejected"; route: "page" | "asset" | "boot" | "ws"; reason: string }
  | { event: "boot.redeemed" }
  | { event: "boot.rejected"; reason: "invalid" | "expired" | "locked" }
  | { event: "ws.rejected"; reason: "invalid-token" | "expired-token" | "busy" }
  | { event: "ws.opened" }
  | { event: "ws.closed"; code: number; reason: string }
  | { event: "frame.rejected"; direction: "in" | "out"; reason: string }
  | { event: "agent.spawned"; pid: number | undefined }
  | { event: "agent.exited"; code: number | null; signal: string | null; expected: boolean; stderrTail: string }
  | { event: "agent.escalated"; step: "SIGTERM" | "SIGKILL" }
  | { event: "stop.begin" }
  | { event: "stop.end"; forced: number }

export type AcpWebBridgeOptions = {
  /** 已 realpath 的工作区绝对路径；POST /acp/boot 原样返回给页面。 */
  cwd: string
  /** 每个 WebSocket 调用一次，返回该连接专属的子进程计划。 */
  agentPlan: () => AcpSpawnPlan
  /** 资源提供者；S3-A 默认占位页，S3-C 换成浏览器 bundle。 */
  assets?: AcpWebAssetProvider
  /** 默认 0（随机空闲端口）。 */
  port?: number
  spawn?: typeof spawn
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  limits?: Partial<BridgeLimits>
  /** 结构化诊断回调；缺省丢弃。 */
  log?: (event: BridgeEvent) => void
}

export interface AcpWebBridge {
  start(): Promise<{ port: number; origin: string }>
  /** `http://127.0.0.1:<port>/#c=<bootCode>`；start 之前调用抛错。 */
  bootUrl(): string
  /** 正常关闭：停止接新连接 → 对所有连接 close(1001) 并回收 → 释放端口。幂等。 */
  stop(options?: { force?: boolean }): Promise<void>
  /** 已接受但尚未被回收完毕的连接数（含正在回收的）。 */
  readonly connectionCount: number
}

type Conn = {
  id: number
  ws: import("bun").ServerWebSocket<WsData>
  child: ChildProcessWithoutNullStreams
  splitter: LineSplitter
  stderrTail: TailBuffer
  phase: "open" | "closing" | "reaped"
  stdoutPaused: boolean
  /** Bun 的 child.stdin.writableLength 恒为 0：待写 stdin 字节必须自己记账（见 write 回调）。 */
  stdinPending: number
  spawnError: Error | null
  /** `exit` 事件先到的退出码与信号；真正的回收在 `close`（stdio 读尽）时做。 */
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  timers: { term?: ReturnType<typeof setTimeout>; kill?: ReturnType<typeof setTimeout>; drain?: ReturnType<typeof setTimeout> }
  resolveReaped: () => void
  reaped: Promise<void>
}

type WsData = { conn?: Conn }

export function createAcpWebBridge(options: AcpWebBridgeOptions): AcpWebBridge {
  const limits: BridgeLimits = { ...DEFAULT_LIMITS, ...options.limits }
  const log = options.log ?? (() => undefined)
  const spawnFn = options.spawn ?? spawn
  const now = options.now ?? Date.now
  const tokens: SessionTokens = createSessionTokens({ now: options.now, randomBytes: options.randomBytes })
  let assets: AcpWebAssets | undefined
  let server: ReturnType<typeof Bun.serve<WsData>> | undefined
  /** Bun 把 server.port 标成可选；我们只绑 TCP，start 成功后它一定是数。 */
  let boundPort = 0
  let active: { conn?: Conn } | null = null
  const all = new Set<Conn>()
  let lastTouchAt = Number.NEGATIVE_INFINITY
  let stopPromise: Promise<void> | null = null

  /** 活动连接顺延 bootCode 滑动窗口；节流到 touchIntervalMs 一次。 */
  const touch = (): void => {
    const at = now()
    if (at - lastTouchAt < limits.touchIntervalMs) return
    lastTouchAt = at
    tokens.touch()
  }

  const jsonError = (status: number, error: string, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json", ...COMMON_HEADERS, ...headers },
    })

  const methodNotAllowed = (allow: string): Response =>
    new Response(JSON.stringify({ error: "method-not-allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow, ...COMMON_HEADERS },
    })

  const guardReject = (route: "page" | "asset" | "boot" | "ws", reason: string, status: number, headers?: Record<string, string>): Response => {
    log({ event: "guard.rejected", route, reason })
    return jsonError(status, reason, headers)
  }

  async function handleBoot(request: Request, port: number): Promise<Response> {
    const originCheck = checkOrigin(request.headers.get("origin"), port)
    if (!originCheck.ok) return guardReject("boot", "bad-origin", 403)
    const jsonCheck = checkJsonRequest(
      request.headers.get("content-type"),
      request.headers.get("content-length"),
      MAX_BOOT_BODY_BYTES,
    )
    if (!jsonCheck.ok) {
      return guardReject("boot", jsonCheck.reason, jsonCheck.status)
    }
    const body = await readBoundedText(request, MAX_BOOT_BODY_BYTES)
    if (!body.ok) return guardReject("boot", "body-too-large", 413)
    const parsed = parseBootBody(body.text)
    if (!parsed.ok) return guardReject("boot", "bad-body", 400)
    const result = tokens.redeemBootCode(parsed.code)
    if (!result.ok) {
      log({ event: "boot.rejected", reason: result.reason })
      if (result.reason === "locked") {
        return jsonError(429, "locked", {
          "retry-after": String(Math.ceil((result.retryAfterMs ?? 0) / 1_000)),
        })
      }
      return jsonError(403, `${result.reason}-code`)
    }
    log({ event: "boot.redeemed" })
    return new Response(JSON.stringify({ cwd: options.cwd, wsToken: result.wsToken }), {
      headers: { "content-type": "application/json", ...COMMON_HEADERS },
    })
  }

  function handleWsUpgrade(request: Request, url: URL, port: number): Response | undefined {
    const originCheck = checkOrigin(request.headers.get("origin"), port)
    if (!originCheck.ok) return guardReject("ws", "bad-origin", 403)
    // 该路由只为升级存在：非升级请求连凭据检查都不值得做。
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonError(400, "not-an-upgrade")
    }
    const presented = url.searchParams.get("t")
    if (!presented || presented.length > 128) {
      log({ event: "ws.rejected", reason: "invalid-token" })
      return jsonError(403, "invalid-token")
    }
    const verdict = tokens.inspectWsToken(presented)
    if (verdict !== "valid") {
      log({ event: "ws.rejected", reason: `${verdict}-token` })
      return jsonError(403, `${verdict}-token`)
    }
    // 名额被占（含回收中的连接）：409 且不烧 token，客户端可稍后重试。
    if (active) {
      log({ event: "ws.rejected", reason: "busy" })
      return jsonError(409, "busy")
    }
    tokens.spendWsToken(presented)
    // 先占名额再升级：open 回调可能在 upgrade() 内同步触发（实测如此），
    // 它通过 ws.data（同一对象）拿到名额，并发升级永远只有一个能进来。
    const slot: WsData = {}
    active = slot
    if (!server || !server.upgrade(request, { data: slot })) {
      if (active === slot) active = null
      return jsonError(500, "upgrade-failed")
    }
    touch()
    return undefined
  }

  async function handleFetch(request: Request): Promise<Response | undefined> {
    const port = boundPort
    // 第一步永远是 Host 校验：跨站/重绑定请求连路由都不该看到。
    const hostCheck = checkHost(request.headers.get("host"), port)
    if (!hostCheck.ok) {
      const path = new URL(request.url).pathname
      const route = path === "/" ? "page" : path.startsWith("/assets/") ? "asset" : path.startsWith("/acp/boot") ? "boot" : path.startsWith("/acp/ws") ? "ws" : "page"
      return guardReject(route, "bad-host", 403)
    }
    const url = new URL(request.url)
    const path = url.pathname
    if (path === "/") {
      if (request.method !== "GET") return methodNotAllowed("GET")
      return new Response(assets!.html, { headers: htmlHeaders(port) })
    }
    if (path.startsWith("/assets/")) {
      if (request.method !== "GET") return methodNotAllowed("GET")
      const key = path.slice("/assets/".length)
      // 先过白名单再用 hasOwn 查表：`files["constructor"]` 这类原型键会
      // 命中 Object.prototype 成员而不是 404。
      const file = ASSET_KEY_PATTERN.test(key) && Object.hasOwn(assets!.files, key)
        ? assets!.files[key]
        : undefined
      if (!file) return jsonError(404, "not-found")
      return new Response(file.body, {
        headers: { "content-type": file.contentType, ...COMMON_HEADERS },
      })
    }
    if (path === "/acp/boot") {
      if (request.method !== "POST") return methodNotAllowed("POST")
      return handleBoot(request, port)
    }
    if (path === "/acp/ws") {
      if (request.method !== "GET") return methodNotAllowed("GET")
      return handleWsUpgrade(request, url, port)
    }
    return jsonError(404, "not-found")
  }

  /** 浏览器关闭或桥主动断开后：EOF → 宽限 → SIGTERM → SIGKILL，保证不留子进程。 */
  function beginReap(conn: Conn, force = false): void {
    if (conn.phase === "reaped") return
    // 幂等：doStop 循环与 ws close 回调都会走到这里，EOF/计时器只挂一份；
    // 第二份会把第一份计时器的引用冲掉，悬空计时器白钉事件循环 exitGraceMs 秒。
    if (conn.phase === "open") {
      conn.phase = "closing"
      // stdin 写端关闭给子进程 EOF：harness acp 读到 EOF 会取消 Run、按拒绝收敛审批并退出。
      try {
        conn.child.stdin.end()
      } catch {
        // stdin 可能已随子进程死亡而关闭。
      }
      // stdout 在回收窗口内没有读者：不销毁的话，像 `yes` 这种不读 stdin 的子进程
      // 会趁宽限期往 Bun 的读缓冲里灌满 GB 级数据（实测留存 ~1.2 GB）。stderr 保留：
      // 崩溃通知要用它的尾部，且子进程一般不在退出时狂写 stderr。
      try {
        conn.child.stdout.destroy()
      } catch {
        // 已结束。
      }
    }
    if (force) {
      log({ event: "agent.escalated", step: "SIGKILL" })
      try {
        conn.child.kill("SIGKILL")
      } catch {
        // 子进程可能已死；exit/close 事件负责最终回收。
      }
      return
    }
    // EOF/stdout.destroy 可能同步触发 exit：onChildExit 已把 phase 置 reaped；
    // 已有 term 计时器时不重复挂。
    if ((conn.phase as Conn["phase"]) === "reaped" || conn.timers.term) return
    conn.timers.term = setTimeout(() => {
      if (conn.phase === "reaped") return
      log({ event: "agent.escalated", step: "SIGTERM" })
      try {
        conn.child.kill("SIGTERM")
      } catch {
        // 同上。
      }
      conn.timers.kill = setTimeout(() => {
        if (conn.phase === "reaped") return
        log({ event: "agent.escalated", step: "SIGKILL" })
        try {
          conn.child.kill("SIGKILL")
        } catch {
          // 同上。
        }
      }, limits.termGraceMs)
    }, limits.exitGraceMs)
  }

  /** 桥主动结束连接的唯一出口：先发通知再 close，然后进入回收。幂等。 */
  function terminate(conn: Conn, closeCode: number, reason: string, exitInfo?: { code: number | null; signal: string | null; stderrTail: string }): void {
    if (conn.phase !== "open") return
    if (exitInfo && conn.ws.readyState === 1) {
      try {
        conn.ws.send(JSON.stringify({
          jsonrpc: "2.0",
          method: BRIDGE_EXIT_METHOD,
          params: exitInfo,
        }))
      } catch {
        // 发送失败不影响关闭路径。
      }
    }
    try {
      conn.ws.close(closeCode, reason)
    } catch {
      // 已关闭的连接 close 可能抛错；回收照样进行。
    }
    beginReap(conn)
  }

  function onChildExit(conn: Conn, code: number | null, signal: NodeJS.Signals | null): void {
    if (conn.phase === "reaped") return
    // closing（回收中）算预期退出；open 阶段死掉的是崩溃。
    const expected = conn.phase === "closing"
    const stderrTail = conn.spawnError
      ? `spawn failed: ${(conn.spawnError as NodeJS.ErrnoException).code ?? conn.spawnError.message}`
      : redactTail(conn.stderrTail.tail(), limits.stderrTailChars)
    const residual = conn.splitter.end()
    if (residual > 0) {
      log({ event: "frame.rejected", direction: "out", reason: "partial-frame" })
    }
    if (!expected) {
      // 意外退出：先发桥通知帧告诉浏览器 Agent 已死，再以 1011 关闭。
      // close reason 最长 123 字节装不下诊断，所以只放短码（设计 Q3）。
      terminate(conn, 1011, "agent-exited", { code, signal, stderrTail })
    }
    conn.phase = "reaped"
    if (conn.timers.term) clearTimeout(conn.timers.term)
    if (conn.timers.kill) clearTimeout(conn.timers.kill)
    if (conn.timers.drain) clearTimeout(conn.timers.drain)
    all.delete(conn)
    if (active?.conn === conn) active = null
    log({ event: "agent.exited", code, signal, expected, stderrTail })
    conn.resolveReaped()
  }

  function attachConnection(ws: import("bun").ServerWebSocket<WsData>): void {
    const plan = options.agentPlan()
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnFn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams
    } catch {
      // spawn 同步抛错（参数级别错误）：没有子进程可收，直接通知 + 1011 并还名额。
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            method: BRIDGE_EXIT_METHOD,
            params: { code: null, signal: null, stderrTail: "spawn failed: spawn threw" },
          }))
        } catch {
          // 发送失败不影响关闭。
        }
      }
      try {
        ws.close(1011, "agent-exited")
      } catch {
        // 已断开时忽略。
      }
      active = null
      return
    }
    let resolveReaped!: () => void
    const conn: Conn = {
      id: 0,
      ws,
      child,
      splitter: new LineSplitter(),
      stderrTail: new TailBuffer(limits.stderrTailChars * 4),
      phase: "open",
      stdoutPaused: false,
      stdinPending: 0,
      spawnError: null,
      exitCode: null,
      exitSignal: null,
      timers: {},
      resolveReaped: () => resolveReaped(),
      reaped: new Promise<void>(resolve => { resolveReaped = resolve }),
    }
    // 名额对象就是 ws.data 本身：升级时占位的 slot 与这个连接天然绑定。
    ws.data.conn = conn
    all.add(conn)
    // 子进程先死时管道已断，后续的 stdin.write/flush 回调会触发 EPIPE 的
    // 'error' 事件；真正的工作由 exit/close 完成，这里吞掉即可。
    child.stdin.on("error", () => undefined)
    // stderr 必须始终消费：不读会写满管道把子进程堵死。
    child.stderr.on("data", (chunk: Uint8Array) => conn.stderrTail.push(chunk))
    child.stdout.on("data", (chunk: Uint8Array) => {
      for (const item of conn.splitter.push(chunk)) {
        if (conn.phase !== "open") return
        if (item.kind === "error") {
          log({ event: "frame.rejected", direction: "out", reason: item.reason })
          terminate(conn, item.closeCode, item.reason)
          return
        }
        const sent = conn.ws.send(item.text)
        if (sent === -1) {
          // 出站背压：暂停 stdout，drain 回调再恢复（见 websocket.drain）。
          conn.stdoutPaused = true
          conn.child.stdout.pause()
        } else if (sent === 0 || sent === -2) {
          // 帧被丢弃：协议流已经不完整，继续转发只会让界面静默异常。
          terminate(conn, 1011, "send-failed")
          return
        }
      }
      touch()
    })
    const onDone = (code: number | null, signal: NodeJS.Signals | null) => onChildExit(conn, code, signal)
    child.on("exit", (code, signal) => {
      conn.exitCode = code
      conn.exitSignal = signal
      if (conn.phase === "open") {
        // 未预期退出：最后的帧可能还在管道里，通知与 1011 要等 close（stdio
        // 全部读完）再发，保证顺序是"最后的帧 → bridge/exit → 1011"。但留一个
        // 排尽兜底：孙子进程握着管道时 close 可能永不到达。
        conn.timers.drain = setTimeout(() => {
          if (conn.phase === "reaped") return
          onDone(conn.exitCode, conn.exitSignal)
        }, limits.exitGraceMs)
      } else {
        // 回收中的预期退出：照常回收——孙进程可能握着管道让 close 永不
        // 到达（`sh -c 'echo x; sleep 60'` 形态），不能等它。
        onDone(code, signal)
      }
    })
    child.on("error", error => {
      // spawn 失败（ENOENT 等）：stderrTail 换成 spawn 描述；close 可能不来，
      // 这里直接回收（幂等，靠 phase 去重）。
      conn.spawnError = error
      onDone(conn.exitCode ?? child.exitCode, conn.exitSignal ?? child.signalCode)
    })
    child.on("close", () => {
      // stdio 读尽：此时最后的帧已经通过 stdout 'data' 转发出去了。
      onDone(conn.exitCode ?? child.exitCode, conn.exitSignal ?? child.signalCode)
    })
    log({ event: "agent.spawned", pid: child.pid })
    log({ event: "ws.opened" })
    touch()
  }

  async function doStop(force: boolean): Promise<void> {
    log({ event: "stop.begin" })
    server!.stop() // 不带 true：不再接新连接，已有连接保留。
    const conns = [...all]
    for (const conn of conns) {
      try {
        conn.ws.close(1001, "server-shutdown")
      } catch {
        // 已关闭的连接 close 可能抛错。
      }
      beginReap(conn, force)
    }
    let forced = 0
    if (!force) {
      // race 的超时分支输不输都要清掉：悬空的 setTimeout 会把事件循环
      // 多钉住 stopDeadlineMs 秒，进程因此退不出。
      let deadline: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(conns.map(conn => conn.reaped)),
        new Promise<void>(resolve => { deadline = setTimeout(resolve, limits.stopDeadlineMs) }),
      ])
      if (deadline) clearTimeout(deadline)
    }
    forced = forceKillAll()
    if (forced > 0) await Promise.allSettled(conns.map(conn => conn.reaped))
    server!.stop(true) // 释放端口。
    // Bun 的 Server 在 stop(true) 之后仍挂住事件循环直到被 GC；unref 让
    // `harness web` 的进程在桥关闭后能自然退出。
    server!.unref()
    log({ event: "stop.end", forced })
  }

  /** 对尚未回收完的连接一律 SIGKILL；返回补杀的数量。 */
  function forceKillAll(): number {
    let forced = 0
    for (const conn of all) {
      if (conn.phase === "reaped") continue
      forced += 1
      try {
        conn.child.kill("SIGKILL")
      } catch {
        // 已死。
      }
    }
    return forced
  }

  return {
    async start() {
      if (server) throw new Error("bridge already started")
      assets = assertValidAssets(await (options.assets ?? placeholderAssets)())
      server = Bun.serve<WsData>({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        fetch: request => handleFetch(request),
        websocket: {
          // 第一道防线：超限时 Bun 以 1006 关闭；framing 仍是权威检查（F10）。
          maxPayloadLength: MAX_FRAME_BYTES,
          backpressureLimit: limits.backpressureLimit,
          closeOnBackpressureLimit: true,
          open(ws) {
            attachConnection(ws)
          },
          message(ws, data) {
            const conn = ws.data.conn
            if (!conn || conn.phase !== "open") return
            const frame = checkInboundFrame(data)
            if (!frame.ok) {
              log({ event: "frame.rejected", direction: "in", reason: frame.reason })
              terminate(conn, frame.closeCode, frame.reason)
              return
            }
            // Bun 的 stdin.writableLength 恒为 0：自己记账待写字节，write 回调在
            // 内核接受后减掉。子进程不读 stdin 时计数只增不减。
            const line = `${frame.line}\n`
            const bytes = Buffer.byteLength(line, "utf8")
            conn.stdinPending += bytes
            try {
              conn.child.stdin.write(line, () => {
                conn.stdinPending -= bytes
              })
            } catch {
              conn.stdinPending -= bytes
              terminate(conn, 1011, "stdin-failed")
              return
            }
            // 入站背压：浏览器灌帧而子进程不读 stdin 时，待写字节超限就断开，
            // 避免无界缓冲拖垮桥进程。
            if (conn.stdinPending > limits.stdinPendingBytes) {
              terminate(conn, 1008, "stdin-backpressure")
              return
            }
            touch()
          },
          drain(ws) {
            const conn = ws.data.conn
            if (conn?.stdoutPaused) {
              conn.stdoutPaused = false
              conn.child.stdout.resume()
            }
          },
          close(ws, code, reason) {
            const conn = ws.data.conn
            if (!conn) {
              // 升级成功但 open 还没跑就断开：直接还名额。
              if (active && !active.conn) active = null
              return
            }
            log({ event: "ws.closed", code, reason })
            touch()
            beginReap(conn)
          },
        },
      })
      boundPort = server.port ?? 0
      log({ event: "server.started", port: boundPort })
      return { port: boundPort, origin: `http://127.0.0.1:${boundPort}` }
    },

    bootUrl() {
      if (!server) throw new Error("bridge not started")
      return `http://127.0.0.1:${boundPort}/#c=${tokens.bootCode}`
    },

    async stop(stopOptions?: { force?: boolean }) {
      if (!server) return
      if (stopPromise) {
        // 第二次 Ctrl+C：优雅回收已在进行，立即升级成强杀残余。
        if (stopOptions?.force) forceKillAll()
        return stopPromise
      }
      stopPromise = doStop(stopOptions?.force === true)
      return stopPromise
    },

    get connectionCount() {
      return all.size
    },
  }
}
