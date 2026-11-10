/**
 * 运行时合成（设计 §4.9）：把 ACP 握手/暖会话结果合成
 * `InteractiveRuntime`、`AgentCommand[]` 与浏览器侧自建 `CommandRegistry`。
 *
 * 【这是做什么的？】控制器的 `baseRuntime` / `commandRegistry` 在构造时就
 * 固定，所以网关握手完就要把"这一页能用哪些功能"一次性钉死：
 * `capabilities` 只列真正通过 ACP 支持的能力（`run.cancel`、
 * `threads.read`、`run.approval_mode`），Skill/模型/配置等入口因此隐藏。
 *
 * 【Q4：自建 CommandRegistry】`createCommandRegistry` 给插件命令挂
 * `skills.read` 要求，但 ACP 没有 Skill 目录（GAP-13）。本文件在
 * `createAcpCommandRegistry` 里复用内置命令与重名规则，但把插件命令的
 * `skills.read` 要求剥掉（`requiresIdle` 保留）——命令可点，Skill
 * 面板入口依然隐藏。
 */

import { Capability, type AgentCommand } from "@za38/protocol"

import {
  CommandRegistry,
  builtinCommandDefinitions,
  createCommandRegistry,
} from "../../interactive/commands"
import { DEFAULT_APPROVAL_MODE, type InteractiveRuntime } from "../../interactive/runtime"

/** `AcpAgentGateway.connect` 的握手结果（类型放这里避免与网关文件成环）。 */
export type AcpBootInfo = {
  cwd: string
  agentInfo: { name: string; title: string | null; version: string } | null
  /** agentCapabilities.loadSession === true */
  canLoadSession: boolean
  /** agentCapabilities.sessionCapabilities?.list 存在 */
  canListSessions: boolean
  /** sessionCapabilities.resume 已声明：openThread 对已登记会话可用 session/resume。 */
  /** sessionCapabilities.close 已声明。 */
  /** agentCapabilities._meta.harnessCode.capabilities 两个开关 */
  extension: { approval: boolean; runSummary: boolean }
  modes: {
    currentModeId: string
    availableModes: ReadonlyArray<{ id: string; name: string; description: string | null }>
  } | null
  commands: ReadonlyArray<{ name: string; description: string; hint: string | null }>
}

const VALID_APPROVAL_MODES = new Set(["plan", "default", "auto-edit", "auto", "yolo"])

type LogFn = (event: { event: string; [key: string]: unknown }) => void

/** `boot` → `InteractiveRuntime`。能力集合按 §4.4 规则钉死。 */
export function createAcpRuntime(boot: AcpBootInfo, options?: { cliVersion?: string }): InteractiveRuntime {
  const capabilities: string[] = [Capability.RUN_CANCEL]
  if (boot.canListSessions && boot.canLoadSession) capabilities.push(Capability.THREADS_READ)
  if (boot.modes) capabilities.push(Capability.RUN_APPROVAL_MODE)
  const currentMode = boot.modes?.currentModeId
  const agentCommands = synthesizeAgentCommands(boot.commands)
  return {
    workspace: boot.cwd,
    cliVersion: boot.agentInfo?.version ?? options?.cliVersion ?? "0.0.0",
    modelConfigured: true, // 真正的模型配置错误在第一次 prompt 以 run.failed 出现
    executionMode: "local",
    approvalMode: VALID_APPROVAL_MODES.has(currentMode ?? "")
      ? currentMode as InteractiveRuntime["approvalMode"]
      : DEFAULT_APPROVAL_MODE,
    capabilities,
    agentCommands,
    commandRegistry: createAcpCommandRegistry(agentCommands),
  }
}

/**
 * ACP `AvailableCommand` → v3 `AgentCommand`（GAP-37 合成值）。
 * - `id = name`（按 casefold 去重，重复项保留第一个）；
 * - `requested_skill_id = name`（不能是空串，F1）；
 * - 与内置命令（含别名）重名的项**直接丢弃**（不走 `acp.<name>` 别名——
 *   否则发出去的 `/acp.xxx` Python 找不到，见 §4.9）。
 */
export function synthesizeAgentCommands(
  commands: AcpBootInfo["commands"],
  log: LogFn = () => {},
): AgentCommand[] {
  const builtinNames = new Set(
    builtinCommandDefinitions
      .flatMap(definition => [definition.name, ...(definition.aliases ?? [])])
      .map(name => name.trim().toLowerCase()),
  )
  const seen = new Set<string>()
  const result: AgentCommand[] = []
  for (const command of commands) {
    const key = command.name.trim().toLowerCase()
    if (!key) {
      log({ event: "command.dropped", reason: "empty-name" })
      continue
    }
    if (seen.has(key)) {
      log({ event: "command.dropped", reason: "duplicate", name: command.name })
      continue
    }
    seen.add(key)
    if (builtinNames.has(key)) {
      log({ event: "command.dropped", reason: "builtin-collision", name: command.name })
      continue
    }
    result.push({
      id: command.name,
      name: command.name,
      description: command.description,
      argument_hint: command.hint ?? null,
      requested_skill_id: command.name,
      plugin_id: "acp",
    })
  }
  return result
}

/**
 * 自建 CommandRegistry（Q4）：复用 `createCommandRegistry` 的内置命令与
 * 重名规则，只把插件命令的 `skills.read` 要求剥掉（`requiresIdle` 保留），
 * 内置命令的 requirements 不动。
 */
export function createAcpCommandRegistry(commands: readonly AgentCommand[]): CommandRegistry {
  const base = createCommandRegistry(commands)
  return new CommandRegistry(base.definitions.map(definition =>
    definition.source.type === "plugin"
      ? { ...definition, requirements: { ...definition.requirements, capabilities: undefined } }
      : definition))
}
