/** Command Feature：管理命令注册表查询、/ 解析、availability 能力计算及 semantic operation 执行。 */

import type { AgentCommand } from "@za38/protocol"
import { dispatchSlashCommand, type CommandDispatchContext, type CommandResult } from "../command-dispatcher"
import {
  builtinCommandCapabilities,
  commandRegistry,
  createCommandRegistry,
  findCommandMenuItems,
  resolveSlashCommand,
  unknownCommandNotice,
  type CommandContext,
  type CommandMenuItem,
  type CommandRegistry,
  type SkillMenuItem,
} from "../commands"
import type { IntentOutcome } from "../ports"
import { appendNotice, type ComposeProjection } from "../state"
import { runtimeStatusSummary, type InteractiveApprovalMode } from "../runtime"
import type { FeatureContext } from "./types"

export class CommandFeature {
  /** 当前命令表。ACP 目录更新时整表换掉，TUI 构造后不再改。 */
  private registry: CommandRegistry

  constructor(
    agentCommands: readonly AgentCommand[] = [],
    registry?: CommandRegistry,
  ) {
    this.registry = registry ?? createCommandRegistry(agentCommands)
  }

  /** 暴露当前命令表，供 Controller 的手输路径复用。 */
  get commandRegistry(): CommandRegistry {
    return this.registry
  }

  /** ACP 后来推来的整张命令表换掉菜单。调用方负责随后发布快照。 */
  replaceRegistry(registry: CommandRegistry): void {
    this.registry = registry
  }

  commandDispatchContext(
    ctx: FeatureContext,
    hasPendingInteraction: boolean,
    approvalMode?: InteractiveApprovalMode,
    pendingPlanInteraction = false,
  ): CommandDispatchContext {
    return {
      commandContext: {
        capabilities: new Set(ctx.baseRuntime.capabilities ?? builtinCommandCapabilities),
        hasThread: Boolean(ctx.getState().currentThreadId),
        activeRun: Boolean(ctx.getState().activeRun),
        pendingOperation: Boolean(ctx.getState().pendingOperation),
        hasPendingInteraction,
        workMode: ctx.getState().workMode,
        hasActiveWorkItem: hasActiveComposeSession(ctx.getState().composeState),
        isReverted: Boolean(ctx.getState().isReverted),
      },
      threadId: ctx.getState().currentThreadId,
      runtimeStatus: runtimeStatusSummary(ctx.baseRuntime),
      idGenerator: ctx.idGenerator,
      approvalMode,
      pendingPlanInteraction,
    }
  }

  buildCommandItems(
    skillItems: readonly SkillMenuItem[],
    ctx: FeatureContext,
    hasPendingInteraction: boolean,
  ): readonly CommandMenuItem[] {
    return findCommandMenuItems(
      "/",
      skillItems,
      this.commandDispatchContext(ctx, hasPendingInteraction).commandContext,
      this.registry,
    )
  }

  /** 按稳定 command ID 交给 Dispatcher；未知 ID 只输出本地提示。 */
  async executeSlashCommand(
    command: { id: string; name: string; argument?: string },
    ctx: FeatureContext,
    options: {
      hasPendingInteraction: boolean
      applyResult: (result: CommandResult) => Promise<IntentOutcome>
      approvalMode?: InteractiveApprovalMode
      pendingPlanInteraction?: boolean
    },
  ): Promise<IntentOutcome> {
    const definition = this.registry.get(command.id)
    if (!definition) {
      ctx.commit(current => appendNotice(current, `未知命令：/${command.name}。输入 /help 查看可用命令。`))
      return { status: "accepted" }
    }
    const result = dispatchSlashCommand(
      { id: command.id, name: definition.name, argument: command.argument },
      this.commandDispatchContext(ctx, options.hasPendingInteraction, options.approvalMode, options.pendingPlanInteraction),
      this.registry,
    )
    return options.applyResult(result)
  }

  /** 解析输入为 command/unknown/escaped；unknown 由调用方转本地提示。 */
  resolveInputSlashCommand(rawValue: string): ReturnType<typeof resolveSlashCommand> {
    return resolveSlashCommand(rawValue, this.registry)
  }

  unknownNotice(resolution: Extract<ReturnType<typeof resolveSlashCommand>, { kind: "unknown" }>): string {
    return unknownCommandNotice(resolution)
  }
}

function hasActiveComposeSession(progress: ComposeProjection | null | undefined): boolean {
  return Boolean(progress && progress.status !== "completed" && progress.status !== "abandoned")
}
