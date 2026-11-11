/**
 * 运行时合成（设计 §4.9）：把 ACP 握手/暖会话结果合成
 * `InteractiveRuntime`、`AgentCommand[]` 与浏览器侧自建 `CommandRegistry`。
 *
 * 【这是做什么的？】控制器的 `baseRuntime` / `commandRegistry` 在构造时就
 * 固定，所以网关握手完就要把"这一页能用哪些功能"一次性钉死：
 * `capabilities` 只列真正通过 ACP 支持的能力（`run.cancel`、
 * `threads.read`、`run.approval_mode`、`models.read`、`models.select`）。
 * 模型下拉靠后两项才出现；Skill 和配置入口仍然隐藏。
 *
 * 【命令表】菜单来自 Agent 推送的整张表。本地 TUI 内置命令不混进来，
 * 否则 `/compact` 会走会抛错的本地实现，而不是把斜杠原文交给 ACP。
 * 只有「新建对话」例外：侧栏按钮按 id `thread.new` 执行，这不是 ACP 斜杠命令。
 */

import { Capability, type AgentCommand } from "@za38/protocol"

import { CommandRegistry, builtinCommandDefinitions, type CommandDefinition } from "../../interactive/commands"
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
  commands: ReadonlyArray<{
    name: string
    description: string
    hint: string | null
    /** 扩展里的真实 Skill id。没有时斜杠名本身就是调用 id。 */
    requestedSkillId?: string
    pluginId?: string
  }>
}

const VALID_APPROVAL_MODES = new Set(["plan", "default", "auto-edit", "auto", "yolo"])

type LogFn = (event: { event: string; [key: string]: unknown }) => void

/** `boot` → `InteractiveRuntime`。能力集合按 §4.4 规则钉死。 */
export function createAcpRuntime(boot: AcpBootInfo, options?: { cliVersion?: string }): InteractiveRuntime {
  const capabilities: string[] = [Capability.RUN_CANCEL]
  if (boot.canListSessions && boot.canLoadSession) capabilities.push(Capability.THREADS_READ)
  if (boot.modes) capabilities.push(Capability.RUN_APPROVAL_MODE)
  // 模型下拉和切换分别看 models.read / models.select。目录本身来自 configOptions。
  capabilities.push(Capability.MODELS_READ, Capability.MODELS_SELECT)
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
 * ACP `AvailableCommand` → v3 `AgentCommand`。
 * 整表替换：同名只留第一条，不再丢掉和本地内置命令重名的项。
 * `requested_skill_id` 优先用扩展里的真实 Skill id，否则用斜杠名。
 */
export function synthesizeAgentCommands(
  commands: AcpBootInfo["commands"],
  log: LogFn = () => {},
): AgentCommand[] {
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
    result.push({
      id: command.name,
      name: command.name,
      description: command.description,
      argument_hint: command.hint ?? null,
      requested_skill_id: command.requestedSkillId || command.name,
      plugin_id: command.pluginId || "acp",
    })
  }
  return result
}

const CLIENT_THREAD_NEW = builtinCommandDefinitions.find(definition => definition.id === "thread.new")

/**
 * 只装 Agent 推来的命令。来源记成 plugin，这样斜杠分发会把原文提交给 ACP，
 * 不会落到会报「暂不支持」的本地内置处理函数。
 * 末尾补上本地的新建对话。侧栏按钮按 `thread.new` 查找；整表替换时若丢掉它，
 * 点击会变成「未知命令：/thread.new」。名字被 Agent 占了就换一个菜单名，id 不变。
 */
export function createAcpCommandRegistry(commands: readonly AgentCommand[]): CommandRegistry {
  const agentCommands: CommandDefinition[] = commands.map(command => ({
    id: command.id,
    name: command.name,
    description: command.description,
    source: { type: "plugin", id: command.plugin_id || "acp" },
    presentation: "action",
    ...(command.argument_hint ? { argumentHint: command.argument_hint } : {}),
    requestedSkillId: command.requested_skill_id || command.name,
    requirements: { requiresIdle: true },
    safety: { runtime: "allowed" },
  }))
  return new CommandRegistry([...agentCommands, ...clientThreadNew(agentCommands)])
}

function clientThreadNew(agentCommands: readonly CommandDefinition[]): CommandDefinition[] {
  if (!CLIENT_THREAD_NEW || agentCommands.some(definition => definition.id === "thread.new")) return []
  const taken = new Set(
    agentCommands.flatMap(definition => [definition.name, ...(definition.aliases ?? [])].map(name => name.toLowerCase())),
  )
  const aliases = CLIENT_THREAD_NEW.aliases ?? []
  if (!taken.has(CLIENT_THREAD_NEW.name.toLowerCase()) && aliases.every(alias => !taken.has(alias.toLowerCase()))) {
    return [CLIENT_THREAD_NEW]
  }
  let name = "thread-new"
  let suffix = 2
  while (taken.has(name)) {
    name = `thread-new-${suffix}`
    suffix += 1
  }
  return [{ ...CLIENT_THREAD_NEW, name, aliases: [] }]
}
