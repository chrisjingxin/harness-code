/**
 * `boot.ts`：ACP 入口的引导链路——读凭据、换 wsToken、建 WebSocket。
 *
 * 流程（设计 §5.3）：
 * 1. `location.hash` 的 `#c=<bootCode>` 优先（新开的 `harness web`）；否则
 *    读 `sessionStorage`（刷新场景）。读到 fragment 后先 `replaceState`
 *    清地址栏再发任何网络请求。
 * 2. `POST /acp/boot`：200 → `{cwd, wsToken}`；403 → 清存储 + invalid-code
 *    （不重试）；429 → locked（不重试）；5xx/网络错 → 计入重试。
 * 3. `ws://<host>/acp/ws?t=<wsToken>` 等 open；升级失败（409 busy 与 403
 *    在浏览器里都只表现为未 open 的 close/error）按 busy 有界重试：
 *    20 次 × 450ms ≈ 9s，覆盖桥回收上一个子进程的最坏 8s；每轮回第 2
 *    步换新 wsToken（一次性，60s TTL）。
 */

const STORAGE_KEY = "harness-acp-boot"
const WS_RETRY_LIMIT = 20
const WS_RETRY_DELAY_MS = 450

export class BootError extends Error {
  constructor(
    readonly code: "missing-code" | "invalid-code" | "locked" | "unavailable",
    message: string,
  ) {
    super(message)
    this.name = "BootError"
  }
}

export type BootDeps = {
  location: Pick<Location, "hash" | "host" | "pathname">
  history: Pick<History, "replaceState">
  /** sessionStorage；不可用时为 null（仍可首次连接，只是不支持刷新）。 */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  createSocket: (url: string) => WebSocket
  sleep: (ms: number) => Promise<void>
}

export type AcpTransport = { socket: WebSocket; cwd: string }

const defaultDeps = (): BootDeps => ({
  location: window.location,
  history: window.history,
  storage: typeof sessionStorage === "undefined" ? null : sessionStorage,
  // fetch 必须包一层箭头函数：存成未绑定的引用后 this 丢失，
  // 浏览器里会以 Illegal invocation 抛 TypeError（E2E 实测发现）。
  fetch: (input, init) => fetch(input, init),
  createSocket: url => new WebSocket(url),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
})

export async function bootAcpTransport(deps: BootDeps = defaultDeps()): Promise<AcpTransport> {
  // ① 读凭据：fragment 优先 → sessionStorage 兜底。fragment 进存储后立即
  // 清地址栏，bootCode 不进 Referer/历史。
  let code: string | null = null
  const fragment = deps.location.hash.match(/^#c=(.+)$/)
  if (fragment) {
    code = fragment[1]!
    deps.storage?.setItem(STORAGE_KEY, code)
    deps.history.replaceState(null, "", deps.location.pathname)
  } else {
    code = deps.storage?.getItem(STORAGE_KEY) ?? null
  }
  if (!code) throw new BootError("missing-code", "missing boot code")

  // ②③ bootCode → wsToken → WebSocket；升级失败按 busy 有界重试，
  // 每轮回第 2 步换一张新的 wsToken（一次性、60s TTL）。
  for (let attempt = 0; attempt < WS_RETRY_LIMIT; attempt += 1) {
    let response: Response
    try {
      response = await deps.fetch("/acp/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
    } catch {
      await deps.sleep(WS_RETRY_DELAY_MS)
      continue // 网络错误：计入重试
    }
    if (response.status === 403) {
      deps.storage?.removeItem(STORAGE_KEY)
      throw new BootError("invalid-code", "boot code rejected")
    }
    if (response.status === 429) throw new BootError("locked", "bridge temporarily locked")
    if (!response.ok) {
      await deps.sleep(WS_RETRY_DELAY_MS)
      continue // 5xx 等：计入重试
    }
    const payload = await response.json() as { cwd: string; wsToken: string }
    const socket = deps.createSocket(`ws://${deps.location.host}/acp/ws?t=${encodeURIComponent(payload.wsToken)}`)
    const opened = await new Promise<boolean>(resolve => {
      socket.addEventListener("open", () => resolve(true), { once: true })
      socket.addEventListener("close", () => resolve(false), { once: true })
      socket.addEventListener("error", () => resolve(false), { once: true })
    })
    if (opened) return { socket, cwd: payload.cwd }
    await deps.sleep(WS_RETRY_DELAY_MS)
  }
  throw new BootError("unavailable", "bridge unavailable after retries")
}
