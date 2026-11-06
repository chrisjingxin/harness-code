/** session-token.ts 用例：两段式凭据的滑动过期、一次性、错误锁定与恒定时间比较。 */

import { describe, expect, spyOn, test } from "bun:test"
import * as crypto from "node:crypto"

import { createSessionTokens } from "../../src/acp-web/bridge/session-token"

/** 每次调用返回不同字节的确定性随机数，保证 bootCode 与 wsToken 两两不同。 */
function sequentialRandom(): (size: number) => Uint8Array {
  let counter = 0
  return (size: number) => {
    const bytes = new Uint8Array(size)
    bytes.fill(counter)
    counter += 1
    return bytes
  }
}

/** 注入可控时钟与定长随机数的凭据实例。 */
function makeTokens() {
  let at = 1_000_000
  const tokens = createSessionTokens({ now: () => at, randomBytes: sequentialRandom() })
  return { tokens, advance: (ms: number) => { at += ms } }
}

describe("凭据格式", () => {
  test("bootCode 是 43 字符 base64url；wsToken 同型且与 bootCode 不同", () => {
    const { tokens } = makeTokens()
    expect(tokens.bootCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const result = tokens.redeemBootCode(tokens.bootCode)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.wsToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.wsToken).not.toBe(tokens.bootCode)
  })
})

describe("兑换 bootCode", () => {
  test("可重复兑换，每次签发新的 wsToken", () => {
    const { tokens } = makeTokens()
    const first = tokens.redeemBootCode(tokens.bootCode)
    const second = tokens.redeemBootCode(tokens.bootCode)
    const third = tokens.redeemBootCode(tokens.bootCode)
    expect(first.ok && second.ok && third.ok).toBe(true)
    if (!(first.ok && second.ok && third.ok)) return
    expect(new Set([first.wsToken, second.wsToken, third.wsToken]).size).toBe(3)
  })

  test.each([
    "wrong",
    "",
    "a".repeat(42),
    "a".repeat(44),
    "a".repeat(43), // 格式对但摘要不同
    "+".repeat(43), // 非法字符集
    " ".repeat(43),
    undefined,
    null,
    123,
    {},
  ])("错误出示 %j → invalid", presented => {
    const { tokens } = makeTokens()
    expect(tokens.redeemBootCode(presented)).toEqual({ ok: false, reason: "invalid" })
  })
})

describe("连续错误锁定", () => {
  test("4 次错误仍可兑换；成功兑换清零错误计数", () => {
    const { tokens } = makeTokens()
    for (let i = 0; i < 4; i += 1) expect(tokens.redeemBootCode("x".repeat(43)).ok).toBe(false)
    expect(tokens.redeemBootCode(tokens.bootCode).ok).toBe(true)
    // 成功兑换清零了计数：再错 4 次仍不锁。
    for (let i = 0; i < 4; i += 1) expect(tokens.redeemBootCode("x".repeat(43)).ok).toBe(false)
    expect(tokens.redeemBootCode(tokens.bootCode).ok).toBe(true)
  })

  test("第 5 次错误后锁定：正确码也是 locked，30 秒后恢复", () => {
    const { tokens, advance } = makeTokens()
    for (let i = 0; i < 5; i += 1) expect(tokens.redeemBootCode("x".repeat(43)).ok).toBe(false)
    const locked = tokens.redeemBootCode(tokens.bootCode)
    expect(locked.ok).toBe(false)
    if (locked.ok) return
    expect(locked.reason).toBe("locked")
    expect(locked.retryAfterMs).toBeGreaterThan(0)
    expect(locked.retryAfterMs).toBeLessThanOrEqual(30_000)
    // 锁定期内继续错误出示，仍是 locked 而不是 invalid（锁定不是失败计数）。
    expect(tokens.redeemBootCode("x".repeat(43))).toEqual(
      expect.objectContaining({ ok: false, reason: "locked" }),
    )
    advance(30_001)
    expect(tokens.redeemBootCode(tokens.bootCode).ok).toBe(true)
  })

  test("过期的出示不计入错误：反复 expired 也不会被锁", () => {
    const { tokens, advance } = makeTokens()
    advance(600_001)
    for (let i = 0; i < 10; i += 1) {
      expect(tokens.redeemBootCode(tokens.bootCode)).toEqual({ ok: false, reason: "expired" })
    }
  })
})

describe("bootCode 滑动过期", () => {
  test("最近一次成功或 touch 后 10 分钟内可兑换，之后 expired", () => {
    const { tokens, advance } = makeTokens()
    advance(9 * 60_000)
    expect(tokens.redeemBootCode(tokens.bootCode).ok).toBe(true)
    advance(9 * 60_000) // 距上次成功 9 分钟，窗口顺延
    expect(tokens.redeemBootCode(tokens.bootCode).ok).toBe(true)
    advance(10 * 60_000 + 1)
    expect(tokens.redeemBootCode(tokens.bootCode)).toEqual({ ok: false, reason: "expired" })
  })

  test("touch() 顺延窗口；已过期的 bootCode 不会被 touch 复活", () => {
    const { tokens, advance } = makeTokens()
    advance(9 * 60_000)
    tokens.touch()
    advance(9 * 60_000)
    expect(tokens.redeemBootCode(tokens.bootCode).ok).toBe(true)

    const { tokens: expired, advance: advanceExpired } = makeTokens()
    advanceExpired(10 * 60_000 + 1)
    expired.touch()
    expect(expired.redeemBootCode(expired.bootCode)).toEqual({ ok: false, reason: "expired" })
  })
})

describe("wsToken", () => {
  test("inspect 不消耗；spend 之后 inspect → invalid，重放也是 invalid", () => {
    const { tokens } = makeTokens()
    const result = tokens.redeemBootCode(tokens.bootCode)
    if (!result.ok) throw new Error("redeem failed")
    expect(tokens.inspectWsToken(result.wsToken)).toBe("valid")
    expect(tokens.inspectWsToken(result.wsToken)).toBe("valid")
    tokens.spendWsToken(result.wsToken)
    expect(tokens.inspectWsToken(result.wsToken)).toBe("invalid")
    tokens.spendWsToken(result.wsToken) // 重复消耗无副作用
    expect(tokens.inspectWsToken(result.wsToken)).toBe("invalid")
  })

  test("60 秒内 valid，过期后 expired", () => {
    const { tokens, advance } = makeTokens()
    const first = tokens.redeemBootCode(tokens.bootCode)
    if (!first.ok) throw new Error("redeem failed")
    advance(59_900)
    expect(tokens.inspectWsToken(first.wsToken)).toBe("valid")
    const second = tokens.redeemBootCode(tokens.bootCode)
    if (!second.ok) throw new Error("redeem failed")
    advance(60_101)
    expect(tokens.inspectWsToken(first.wsToken)).toBe("expired")
    expect(tokens.inspectWsToken(second.wsToken)).toBe("expired")
    // 过期项已被清理：再检视得到 invalid 而不是 expired。
    expect(tokens.inspectWsToken(first.wsToken)).toBe("invalid")
  })

  test("在途 wsToken 超过 16 个时丢弃最旧的", () => {
    const { tokens } = makeTokens()
    const issued: string[] = []
    for (let i = 0; i < 17; i += 1) {
      const result = tokens.redeemBootCode(tokens.bootCode)
      if (!result.ok) throw new Error("redeem failed")
      issued.push(result.wsToken)
    }
    expect(tokens.inspectWsToken(issued[0]!)).toBe("invalid")
    for (const token of issued.slice(1)) {
      expect(tokens.inspectWsToken(token)).toBe("valid")
    }
  })

  test("非字符串与格式不对的出示 → invalid，且不消耗任何凭据", () => {
    const { tokens } = makeTokens()
    expect(tokens.inspectWsToken(undefined)).toBe("invalid")
    expect(tokens.inspectWsToken(42)).toBe("invalid")
    expect(tokens.inspectWsToken("short")).toBe("invalid")
    expect(tokens.inspectWsToken(tokens.bootCode)).toBe("invalid") // bootCode 不是 wsToken
  })
})

describe("恒定时间比较", () => {
  test("inspectWsToken 对全部在途项做摘要比较，不提前返回", () => {
    const { tokens } = makeTokens()
    for (let i = 0; i < 3; i += 1) tokens.redeemBootCode(tokens.bootCode)

    const spy = spyOn(crypto, "timingSafeEqual")
    try {
      tokens.inspectWsToken("a".repeat(43))
      expect(spy.mock.calls.length).toBe(3) // 3 个在途项，即使都不匹配也扫完
      spy.mockClear()
      const result = tokens.redeemBootCode("b".repeat(43))
      expect(result.ok).toBe(false)
      expect(spy.mock.calls.length).toBe(1) // bootCode 只有一个摘要比对
      spy.mockClear()
      tokens.redeemBootCode("not-base64url!")
      expect(spy.mock.calls.length).toBe(0) // 格式预检在取摘要之前
    } finally {
      spy.mockRestore()
    }
  })

  test("每次比较的都是 32 字节 SHA-256 摘要", () => {
    const { tokens } = makeTokens()
    const spy = spyOn(crypto, "timingSafeEqual")
    try {
      tokens.redeemBootCode(tokens.bootCode)
      expect(spy.mock.calls.length).toBe(1)
      const [a, b] = spy.mock.calls[0]! as [Uint8Array, Uint8Array]
      expect(a.byteLength).toBe(32)
      expect(b.byteLength).toBe(32)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("不泄漏凭据", () => {
  test("所有返回值序列化后不含 bootCode 或 wsToken 之外的秘密", () => {
    const { tokens, advance } = makeTokens()
    const outputs: unknown[] = []
    outputs.push(tokens.redeemBootCode("x".repeat(43)))
    for (let i = 0; i < 5; i += 1) outputs.push(tokens.redeemBootCode("x".repeat(43)))
    outputs.push(tokens.redeemBootCode(tokens.bootCode)) // locked
    advance(60_000)
    outputs.push(tokens.redeemBootCode(tokens.bootCode))
    advance(600_001)
    outputs.push(tokens.redeemBootCode(tokens.bootCode)) // expired
    outputs.push(tokens.inspectWsToken("a".repeat(43)))
    const serialized = JSON.stringify(outputs)
    expect(serialized).not.toContain(tokens.bootCode)
  })
})
