/** runtime.ts 用例（设计 §6.4）：能力集合、approvalMode 回退、命令合成与自建 registry。 */

import { describe, expect, test } from "bun:test"

import {
  createAcpCommandRegistry,
  createAcpRuntime,
  synthesizeAgentCommands,
  type AcpBootInfo,
} from "../../src/acp-web/client/runtime"

const baseBoot: AcpBootInfo = {
  cwd: "/tmp/ws",
  agentInfo: { name: "agent", title: null, version: "9.9.9" },
  canLoadSession: true,
  canListSessions: true,
  extension: { approval: true, runSummary: true },
  modes: { currentModeId: "auto", availableModes: [{ id: "auto", name: "自动", description: null }] },
  commands: [],
}

describe("createAcpRuntime", () => {
  test("能力集合：list+load 全开 → threads.read；有 modes → run.approval_mode", () => {
    const runtime = createAcpRuntime(baseBoot)
    expect(runtime.capabilities).toEqual(["run.cancel", "threads.read", "run.approval_mode", "models.read", "models.select"])
    expect(runtime.workspace).toBe("/tmp/ws")
    expect(runtime.cliVersion).toBe("9.9.9")
    expect(runtime.modelConfigured).toBe(true)
    expect(runtime.executionMode).toBe("local")
    expect(runtime.approvalMode).toBe("auto")
  })

  test("无 modes / 无 list：能力收窄", () => {
    expect(createAcpRuntime({ ...baseBoot, modes: null }).capabilities).toEqual(["run.cancel", "threads.read", "models.read", "models.select"])
    expect(createAcpRuntime({ ...baseBoot, canListSessions: false }).capabilities).toEqual(["run.cancel", "run.approval_mode", "models.read", "models.select"])
    expect(createAcpRuntime({ ...baseBoot, canLoadSession: false }).capabilities).toEqual(["run.cancel", "run.approval_mode", "models.read", "models.select"])
  })

  test("approvalMode 取 currentModeId；未知值回退默认", () => {
    expect(createAcpRuntime({ ...baseBoot, modes: { currentModeId: "yolo", availableModes: [] } }).approvalMode).toBe("yolo")
    expect(createAcpRuntime({ ...baseBoot, modes: { currentModeId: "weird", availableModes: [] } }).approvalMode).toBe("auto")
    expect(createAcpRuntime({ ...baseBoot, modes: null }).approvalMode).toBe("auto")
  })

  test("不含 skills.read / mcp.* / config.*；模型选择已接入", () => {
    const capabilities = createAcpRuntime(baseBoot).capabilities ?? []
    expect(capabilities).toEqual(expect.arrayContaining(["models.read", "models.select"]))
    for (const capability of capabilities) {
      expect(capability).not.toMatch(/^(skills|mcp|agents|goal|config|context)/)
    }
  })

  test("agentInfo 缺失时 cliVersion 用注入值", () => {
    expect(createAcpRuntime({ ...baseBoot, agentInfo: null }, { cliVersion: "1.2.3" }).cliVersion).toBe("1.2.3")
  })
})

describe("synthesizeAgentCommands（GAP-37）", () => {
  test("字段映射：id=name、requested_skill_id=name、plugin_id=acp、argument_hint 来自 hint", () => {
    const commands = synthesizeAgentCommands([
      { name: "review", description: "代码评审", hint: "<文件>" },
      { name: "mycmd", description: "自有命令", hint: null },
    ])
    expect(commands).toEqual([
      { id: "review", name: "review", description: "代码评审", argument_hint: "<文件>", requested_skill_id: "review", plugin_id: "acp" },
      { id: "mycmd", name: "mycmd", description: "自有命令", argument_hint: null, requested_skill_id: "mycmd", plugin_id: "acp" },
    ])
  })

  test("同名（大小写不敏感）去重保留第一个并记日志", () => {
    const logs: Array<{ event: string; name?: string }> = []
    const commands = synthesizeAgentCommands(
      [{ name: "x", description: "1", hint: null }, { name: "X", description: "2", hint: null }],
      e => logs.push(e),
    )
    expect(commands).toHaveLength(1)
    expect(commands[0]!.description).toBe("1")
    expect(logs).toEqual([{ event: "command.dropped", reason: "duplicate", name: "X" }])
  })

  test("与本地内置同名的命令保留，交给 ACP 执行", () => {
    const commands = synthesizeAgentCommands([
      { name: "compact", description: "压缩", hint: null },
      { name: "resume", description: "恢复", hint: null },
      { name: "mine", description: "ok", hint: null },
    ])
    expect(commands.map(c => c.name)).toEqual(["compact", "resume", "mine"])
  })

  test("有 requestedSkillId 时用真实 Skill id", () => {
    const commands = synthesizeAgentCommands([
      { name: "skill:citrus-check", description: "检查", hint: null, requestedSkillId: "project/citrus-check", pluginId: "acp" },
    ])
    expect(commands[0]).toMatchObject({ requested_skill_id: "project/citrus-check", plugin_id: "acp" })
  })
})

describe("createAcpCommandRegistry", () => {
  test("代理命令可点：没有本地 capability 要求，空闲时才能执行", () => {
    const commands = synthesizeAgentCommands([{ name: "review", description: "代码评审", hint: null }])
    const registry = createAcpCommandRegistry(commands)
    const definition = registry.definitions.find(d => d.name === "review")!
    expect(definition.source).toEqual({ type: "plugin", id: "acp" })
    expect(definition.requirements?.capabilities).toBeUndefined()
    expect(definition.requirements?.requiresIdle).toBe(true)
    expect(definition.requestedSkillId).toBe("review")
    expect(definition.safety?.runtime).toBe("allowed")
  })

  test("空表只留新建对话，不把本地 compact 混进来", () => {
    const registry = createAcpCommandRegistry([])
    expect(registry.definitions.map(definition => definition.id)).toEqual(["thread.new"])
    expect(registry.get("thread.new")).toMatchObject({
      name: "new",
      source: { type: "builtin" },
    })
    expect(registry.resolveName("compact")).toBeUndefined()
  })

  test("Agent 已经占用 new 这个名字时，按钮仍按 thread.new 执行", () => {
    const commands = synthesizeAgentCommands([{ name: "new", description: "别的新", hint: null }])
    const registry = createAcpCommandRegistry(commands)
    expect(registry.get("new")?.source).toEqual({ type: "plugin", id: "acp" })
    expect(registry.get("thread.new")?.id).toBe("thread.new")
    expect(registry.get("thread.new")?.name).not.toBe("new")
  })
})
