/**
 * 跨语言常量漂移检查：读 `packages/agent/harness_agent/host/acp/ext.py` 源码，
 * 断言 EXT_KEY / EXT_VERSION / CAP_APPROVAL / CAP_RUN_SUMMARY / CAP_SESSION_SUMMARY 与
 * `src/acp-web/ext.ts` 同值。Python 侧是源头，这个测试防止两侧静默漂移。
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  BRIDGE_EXIT_METHOD,
  CAP_APPROVAL,
  CAP_RUN_SUMMARY,
  CAP_SESSION_SUMMARY,
  CAP_GOAL,
  CAP_SUBAGENT,
  CLIENT_EXTENSION_DECLARATION,
  EXT_KEY,
  EXT_METHOD_PREFIX,
  EXT_VERSION,
  parseSessionSummaryMeta,
} from "../../src/acp-web/ext"

const EXT_PY = readFileSync(
  join(import.meta.dir, "../../../agent/harness_agent/host/acp/ext.py"),
  "utf8",
)

/** 从 ext.py 源码抠出 `NAME: Final = 值` 常量，防止拿错名字。 */
function pythonConstant(name: string): string {
  const match = EXT_PY.match(new RegExp(`^${name}:\\s*Final\\s*=\\s*(.+)$`, "m"))
  if (!match) throw new Error(`ext.py 里找不到 ${name} 常量`)
  return match[1]!.trim()
}

describe("ACP 扩展常量与 Python ext.py 同值", () => {
  test("EXT_KEY / EXT_VERSION / 能力名 与 Python 源同值", () => {
    expect(EXT_KEY).toBe(JSON.parse(pythonConstant("EXT_KEY").replace(/'/g, '"')))
    expect(EXT_VERSION).toBe(Number(pythonConstant("EXT_VERSION")))
    expect(CAP_APPROVAL).toBe(JSON.parse(pythonConstant("CAP_APPROVAL").replace(/'/g, '"')))
    expect(CAP_RUN_SUMMARY).toBe(JSON.parse(pythonConstant("CAP_RUN_SUMMARY").replace(/'/g, '"')))
    expect(CAP_SESSION_SUMMARY).toBe(JSON.parse(pythonConstant("CAP_SESSION_SUMMARY").replace(/'/g, '"')))
  })

  test("方法前缀与桥通知方法名从 EXT_KEY 派生", () => {
    expect(EXT_METHOD_PREFIX).toBe(`_${EXT_KEY}/`)
    expect(BRIDGE_EXIT_METHOD).toBe(`_${EXT_KEY}/bridge/exit`)
    // Python 侧是同构 f-string：f"_{EXT_KEY}/"，断言它确实引用同名常量。
    expect(pythonConstant("EXT_METHOD_PREFIX")).toBe('f"_{EXT_KEY}/"')
  })

  test("客户端扩展声明：版本与能力顺序与 Python _CAPABILITY_ORDER 一致", () => {
    expect(CLIENT_EXTENSION_DECLARATION.version).toBe(EXT_VERSION)
    expect([...CLIENT_EXTENSION_DECLARATION.capabilities]).toEqual([CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY, CAP_SUBAGENT, CAP_GOAL])
    expect(CAP_GOAL).toBe(JSON.parse(pythonConstant("CAP_GOAL").replace(/'/g, '"')))
    expect(EXT_PY).toContain("_CAPABILITY_ORDER: Final[tuple[str, ...]] = (CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY, CAP_SUBAGENT, CAP_GOAL)")
    expect(EXT_PY).toContain("KNOWN_CAPABILITIES: Final = frozenset({CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY, CAP_SUBAGENT, CAP_GOAL})")
  })
})

describe("parseSessionSummaryMeta", () => {
  const valid = {
    createdAt: "2026-11-09T08:00:00.123Z",
    messageCount: 2,
    firstMessage: "首条",
    latestMessage: "末条",
  }
  const wrap = (summary: unknown) => ({ harnessCode: { summary } })

  test("合法形状原样返回", () => {
    expect(parseSessionSummaryMeta(wrap(valid))).toEqual(valid)
  })

  test.each([
    ["非对象 meta", null],
    ["meta 无 harnessCode", {}],
    ["summary 缺失", { harnessCode: {} }],
    ["缺 createdAt", wrap({ messageCount: 1, firstMessage: "a", latestMessage: "b" })],
    ["messageCount 非整数", wrap({ ...valid, messageCount: "2" })],
    ["messageCount 小数", wrap({ ...valid, messageCount: 2.5 })],
    ["firstMessage 非字符串", wrap({ ...valid, firstMessage: 1 })],
    ["latestMessage 缺失", wrap({ createdAt: valid.createdAt, messageCount: 0, firstMessage: "a" })],
  ])("%s → undefined", (_name, meta) => {
    expect(parseSessionSummaryMeta(meta)).toBeUndefined()
  })
})
