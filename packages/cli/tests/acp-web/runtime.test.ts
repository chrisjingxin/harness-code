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

  test("与内置命令（含别名）重名的项丢弃并记日志", () => {
    const logs: Array<{ event: string; reason?: string }> = []
    const commands = synthesizeAgentCommands(
      [{ name: "compact", description: "撞名", hint: null }, { name: "resume", description: "撞别名", hint: null }, { name: "mine", description: "ok", hint: null }],
      e => logs.push(e),
    )
    expect(commands.map(c => c.name)).toEqual(["mine"])
    expect(logs.map(l => l.reason)).toEqual(["builtin-collision", "builtin-collision"])
  })
})

describe("createAcpCommandRegistry（Q4）", () => {
  test("插件命令在不含 skills.read 的 capabilities 下 available；requiresIdle 保留", () => {
    const commands = synthesizeAgentCommands([{ name: "review", description: "代码评审", hint: null }])
    const registry = createAcpCommandRegistry(commands)
    const definition = registry.definitions.find(d => d.name === "review")!
    expect(definition.source.type).toBe("plugin")
    // availability 需要 context —— 直接看 requirements.capabilities 被剥掉。
    expect(definition.requirements?.capabilities).toBeUndefined()
    expect(definition.requirements?.requiresIdle).toBe(true)
  })

  test("内置命令的 requirements 不被改动", () => {
    const registry = createAcpCommandRegistry([])
    const compact = registry.definitions.find(d => d.name === "compact")!
    expect(compact.requirements?.capabilities).toEqual(["context.manage"])
  })
})
