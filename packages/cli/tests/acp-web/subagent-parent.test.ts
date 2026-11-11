/** 子代理卡 parent 归属（2.11/2.12）：meta 解析 + 事件带 execution/agent 归属。 */

import { describe, expect, test } from "bun:test"

import { parseParentMeta } from "../../src/acp-web/ext"
import { RunTranslator, type AcpSessionUpdate } from "../../src/acp-web/client/translate"

const now = () => 1000
const opts = { runId: "r1", threadId: "t1", startedAtMs: 900, now }

const parentMeta = { harnessCode: { parent: { toolCallId: "r1:pc0", executionId: "exec-c1", agentId: "builder" } } }

function toolCall(meta: unknown): AcpSessionUpdate {
  return { sessionUpdate: "tool_call", toolCallId: "r1:exec-c1:cc0", title: "builder: execute", status: "completed", _meta: meta } as AcpSessionUpdate
}

describe("parseParentMeta：fail-soft 解析", () => {
  test("完整形状 → 字段齐全", () => {
    expect(parseParentMeta(parentMeta)).toEqual({ toolCallId: "r1:pc0", executionId: "exec-c1", agentId: "builder" })
  })
  test("缺 harnessCode/缺 parent/缺字段 → undefined", () => {
    expect(parseParentMeta(undefined)).toBeUndefined()
    expect(parseParentMeta({ harnessCode: {} })).toBeUndefined()
    expect(parseParentMeta({ harnessCode: { parent: { toolCallId: "x" } } })).toBeUndefined()
    expect(parseParentMeta({ harnessCode: { parent: "bad" } })).toBeUndefined()
  })
  test("agentId 非字符串则省略该键", () => {
    const m = { harnessCode: { parent: { toolCallId: "p", executionId: "e", agentId: 1 } } }
    expect(parseParentMeta(m)).toEqual({ toolCallId: "p", executionId: "e" })
  })
})

describe("子代理卡事件带归属", () => {
  test("带 parent → started/completed 事件顶层有 execution_id/agent_id", () => {
    const tr = new RunTranslator(opts)
    const events = tr.update(toolCall(parentMeta))
    const scoped = events.filter(e => e.execution_id === "exec-c1" && e.agent_id === "builder")
    expect(scoped.length).toBe(events.length)
    expect(scoped.length).toBeGreaterThan(0)
  })
  test("无 parent → 事件不带归属字段（普通卡）", () => {
    const tr = new RunTranslator(opts)
    const events = tr.update(toolCall(undefined))
    expect(events.every(e => e.execution_id === undefined && e.agent_id === undefined)).toBe(true)
  })
  test("agentId 缺失 → 只带 execution_id", () => {
    const tr = new RunTranslator(opts)
    const events = tr.update(toolCall({ harnessCode: { parent: { toolCallId: "p", executionId: "exec-c9" } } }))
    expect(events.every(e => e.execution_id === "exec-c9" && e.agent_id === undefined)).toBe(true)
  })
})
