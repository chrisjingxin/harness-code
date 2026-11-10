/**
 * `UNSUPPORTED_METHODS` 漂移与行为锁定（设计 §6.5）：
 * ① 与 `AgentGateway` 接口的 39 个方法去掉 12 个已实现后完全相同——
 *    接口新增方法而没归类时本测试失败；
 * ② 每个方法调用返回被拒绝的 Promise，`code = ACP_NOT_SUPPORTED`、
 *    `message` 含表里登记的 GAP 编号；
 * ③ 是拒绝的 Promise 而不是同步抛出：真实构造控制器不炸，
 *    `catalogs.skills` 落为 error；
 * ④ `runtime.capabilities` 不含 skills.* / models.* / mcp.* /
 *    agents.* / goal.* / config.* / context.manage。
 */

import { describe, expect, test } from "bun:test"

import { AcpAgentGateway, UNSUPPORTED_METHODS } from "../../src/acp-web/client/acp-agent-gateway"
import { createInteractiveController } from "../../src/interactive/controller"
import { AgentGatewayError } from "../../src/interactive/ports/agent-gateway"
import { FakeAgent, pairedStreams } from "./support/fake-agent"

/** `AgentGateway` 接口的全部方法名（写在测试里，新增方法漏归类会红）。 */
const ALL_METHODS = [
  "onProtocolError", "onThreadSummary", "onCodeIndexChanged", "onClose", "onApprovalModeChanged",
  "setInteractionHandler", "abandonInteraction",
  "startRun", "cancel", "setApprovalMode",
  "compactContext", "configDetails", "previewConfig", "commitConfig",
  "listThreads", "openThread", "setThreadTitle",
  "inspectGoal", "requestGoal", "mutateGoal",
  "listTurns", "undo", "redo",
  "mcpStatus", "mcpAdd", "mcpRemove",
  "codeIndexStatus", "codeIndexApply",
  "listModels", "listSkills", "setSkillEnabled",
  "listAgents", "listTeams", "inspectTeam", "generateTeam", "runTeam", "cancelTeam",
  "abandonCompose", "sideQuestion",
] as const

const IMPLEMENTED = new Set([
  "onProtocolError", "onThreadSummary", "onCodeIndexChanged", "onClose", "onApprovalModeChanged",
  "setInteractionHandler", "abandonInteraction",
  "startRun", "cancel", "setApprovalMode", "listThreads", "openThread",
])

async function gateway(): Promise<AcpAgentGateway> {
  const { client, agent } = pairedStreams()
  new FakeAgent().attach(agent)
  return (await AcpAgentGateway.connect({ stream: client, cwd: "/tmp/ws", now: () => 1, commandsTimeoutMs: 10 })).gateway
}

describe("UNSUPPORTED_METHODS", () => {
  test("与 AgentGateway 接口 39 个方法去掉 12 个已实现后完全相同", () => {
    const expected = ALL_METHODS.filter(m => !IMPLEMENTED.has(m)).sort()
    expect(Object.keys(UNSUPPORTED_METHODS).sort()).toEqual(expected)
    expect(ALL_METHODS).toHaveLength(39)
    expect(Object.keys(UNSUPPORTED_METHODS)).toHaveLength(27)
  })

  test.each(Object.keys(UNSUPPORTED_METHODS))("%s → 拒绝的 Promise，code=ACP_NOT_SUPPORTED，含 GAP 编号", async method => {
    const g = await gateway()
    const entry = UNSUPPORTED_METHODS[method]!
    // 必须是 Promise 拒绝而非同步抛出：用 then/catch 探形状。
    const call = () => (g as unknown as Record<string, () => Promise<never>>)[method]!()
    let threwSync: unknown = null
    let promise: Promise<never> | null = null
    try {
      promise = call()
    } catch (error) {
      threwSync = error
    }
    expect(threwSync).toBeNull()
    expect(promise).not.toBeNull()
    const error = await promise!.catch((e: unknown) => e) as AgentGatewayError
    expect(error).toBeInstanceOf(AgentGatewayError)
    expect(error.code).toBe("ACP_NOT_SUPPORTED")
    expect(error.message).toContain(entry.gap)
  })

  test("同步不抛：真实构造控制器不炸，catalogs.skills 落为 error", async () => {
    const g = await gateway()
    const controller = createInteractiveController({
      gateway: g,
      baseRuntime: g.runtime,
      resolveMentions: async (_r, t) => ({ resolved: [], inlinedCount: 0, referenceCount: 0, totalBytes: 0, contextBlock: "", prompt: t }),
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    const snapshot = controller.getSnapshot() as { catalogs?: { skills?: { status?: string; message?: string } } }
    expect(snapshot.catalogs?.skills?.status).toBe("error")
    expect(snapshot.catalogs?.skills?.message).toContain("GAP-13")
    await controller.close()
  })

  test("runtime.capabilities 不含 skills.* / models.* / mcp.* / agents.* / goal.* / config.* / context.manage", async () => {
    const g = await gateway()
    for (const capability of g.runtime.capabilities ?? []) {
      expect(capability).not.toMatch(/^(skills|models|mcp|agents|goal|config|context)\./)
    }
  })
})
