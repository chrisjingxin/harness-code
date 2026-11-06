/**
 * ACP Web 桥的两段式凭据：bootCode 与一次性 wsToken。
 *
 * 【这是做什么的？】
 * `harness web` 启动时在终端打印一个一次性打开的地址 `http://127.0.0.1:P/#c=<bootCode>`。
 * 浏览器拿 bootCode 换 wsToken（60 秒有效、只能用一次），再用 wsToken 升级 WebSocket。
 * 两段设计的目的：bootCode 可以多次换 token（刷新页面仍可重连），而 WebSocket 凭据
 * 一次性，泄漏在日志/历史里的 ws:// URL 无法重放。
 *
 * 【安全规则】
 * - 凭据只存 SHA-256 摘要；比较时对出示值取同样的 32 字节摘要后 `timingSafeEqual`，
 *   wsToken 的比对扫描全部在途项且不提前返回（避免"第几项匹配"成为时序预言机）。
 * - 连续 5 次错误出示锁 30 秒；锁定期内不做任何比较（连正确码也是 locked），
 *   防止锁定期被当成"密码对不对"的预言机。
 * - bootCode 滑动过期：最近一次成功兑换或 `touch()` 后 10 分钟有效；过期不可复活。
 * - 任何字段都不出现在日志、错误信息或 HTTP 响应里（`bootCode` 只用于拼地址）。
 *
 * 【上下游】
 * 上游：`bridge.ts` 的路由（`POST /acp/boot` 调 `redeemBootCode`，`/acp/ws` 调
 * `inspectWsToken` 与 `spendWsToken`）与连接生命周期（收发帧时 `touch`）。
 * 下游：`node:crypto` 的 `randomBytes` / `createHash` / `timingSafeEqual`；
 * 测试注入 `now` 与 `randomBytes`，并通过包名空间调用 `timingSafeEqual` 以便探针计数。
 */

import * as nodeCrypto from "node:crypto"

export type SessionTokensOptions = {
  /** 时钟；测试注入以推进滑动窗口与 TTL。 */
  now?: () => number
  /** 随机源；测试注入确定性序列。 */
  randomBytes?: (size: number) => Uint8Array
  /** bootCode 滑动窗口：最近一次成功使用 / touch 之后 10 分钟。 */
  bootTtlMs?: number
  /** wsToken 有效期。 */
  wsTtlMs?: number
  /** 连续错误次数达到该值即锁定。 */
  maxFailures?: number
  /** 锁定时长。 */
  lockMs?: number
  /** 未消耗的 wsToken 上限，防止刷新风暴撑大内存。 */
  maxOutstandingWsTokens?: number
}

export type RedeemResult =
  | { ok: true; wsToken: string }
  | { ok: false; reason: "invalid" | "expired" | "locked"; retryAfterMs?: number }

export type WsTokenVerdict = "valid" | "invalid" | "expired"

export interface SessionTokens {
  /** 只用于拼打开浏览器的 URL；禁止进日志、错误信息、HTTP 响应。 */
  readonly bootCode: string
  /** bootCode 换一次性 wsToken。 */
  redeemBootCode(presented: unknown): RedeemResult
  /** 只检视不消耗：桥用它先查名额再决定是否烧掉 token。 */
  inspectWsToken(presented: unknown): WsTokenVerdict
  /** 消耗（删除）；重复调用无副作用。 */
  spendWsToken(presented: string): void
  /** 有活动连接时顺延 bootCode 滑动窗口；已过期的不会被复活。 */
  touch(): void
}

/** 32 字节随机的 base64url 恰为 43 字符；格式预检在取摘要之前（长度不是秘密）。 */
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/

function sha256(value: string): Uint8Array {
  return nodeCrypto.createHash("sha256").update(value, "utf8").digest()
}

export function createSessionTokens(options: SessionTokensOptions = {}): SessionTokens {
  const now = options.now ?? Date.now
  const randomBytes = options.randomBytes ?? ((size: number) => nodeCrypto.randomBytes(size))
  const bootTtlMs = options.bootTtlMs ?? 600_000
  const wsTtlMs = options.wsTtlMs ?? 60_000
  const maxFailures = options.maxFailures ?? 5
  const lockMs = options.lockMs ?? 30_000
  const maxOutstanding = options.maxOutstandingWsTokens ?? 16

  const bootCode = Buffer.from(randomBytes(32)).toString("base64url")
  const bootDigest = sha256(bootCode)
  // 滑动窗口锚点：创建、每次成功兑换、每次 touch 都会刷新。
  let lastUsedAt = now()
  let failures = 0
  let lockedUntil = 0
  const outstanding: Array<{ digest: Uint8Array; issuedAt: number }> = []

  const expired = (at: number): boolean => at - lastUsedAt > bootTtlMs

  return {
    bootCode,

    redeemBootCode(presented: unknown): RedeemResult {
      const at = now()
      // 锁定期不做任何比较：避免"锁定期内对不对"被当成密码预言机。
      if (at < lockedUntil) {
        return { ok: false, reason: "locked", retryAfterMs: lockedUntil - at }
      }
      // 过期不计入错误：陈旧页面不等于密码猜测。
      if (expired(at)) return { ok: false, reason: "expired" }
      if (
        typeof presented !== "string"
        || !CREDENTIAL_PATTERN.test(presented)
        || !nodeCrypto.timingSafeEqual(sha256(presented), bootDigest)
      ) {
        failures += 1
        if (failures >= maxFailures) {
          lockedUntil = at + lockMs
          failures = 0
        }
        return { ok: false, reason: "invalid" }
      }
      failures = 0
      lastUsedAt = at
      const wsToken = Buffer.from(randomBytes(32)).toString("base64url")
      outstanding.push({ digest: sha256(wsToken), issuedAt: at })
      // 在途超限丢最旧的：被丢的那个 inspect 时得到 invalid。
      if (outstanding.length > maxOutstanding) outstanding.shift()
      return { ok: true, wsToken }
    },

    inspectWsToken(presented: unknown): WsTokenVerdict {
      if (typeof presented !== "string" || !CREDENTIAL_PATTERN.test(presented)) return "invalid"
      const presentedDigest = sha256(presented)
      const at = now()
      let matched: { digest: Uint8Array; issuedAt: number } | undefined
      // 扫描全部在途项并累积结果，不因命中提前返回（时序预言机防护）。
      for (const item of outstanding) {
        if (nodeCrypto.timingSafeEqual(presentedDigest, item.digest)) matched = item
      }
      if (!matched) return "invalid"
      if (at - matched.issuedAt > wsTtlMs) {
        // 顺手清掉这条过期项：过期 token 与不存在等价，不应再占在途额度。
        const index = outstanding.indexOf(matched)
        if (index >= 0) outstanding.splice(index, 1)
        return "expired"
      }
      return "valid"
    },

    spendWsToken(presented: string): void {
      if (!CREDENTIAL_PATTERN.test(presented)) return
      const presentedDigest = sha256(presented)
      for (let index = 0; index < outstanding.length; index += 1) {
        if (nodeCrypto.timingSafeEqual(presentedDigest, outstanding[index]!.digest)) {
          outstanding.splice(index, 1)
          return
        }
      }
    },

    touch(): void {
      const at = now()
      if (!expired(at)) lastUsedAt = at
    },
  }
}
