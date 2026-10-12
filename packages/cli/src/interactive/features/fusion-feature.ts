/** 双模型组合的共享入口；TUI 和 Web 使用相同状态、恢复和取消契约。 */
import { Capability, type FusionTaskStatus } from "@za38/protocol"
import type { FeatureContext } from "./types"
import type { IntentOutcome } from "../ports"
import { appendNotice } from "../state"

import { fusionSummary } from "../fusion-summary"

export class FusionFeature {
  /** 重连或切换 Thread 后刷新，活动任务自动带回原组合。 */
  async refresh(
    threadId: string,
    ctx: FeatureContext,
    notice = false,
  ): Promise<void> {
    if (!ctx.baseRuntime.capabilities?.includes(Capability.FUSION_READ)) return
    const { task } = await ctx.gateway.inspectFusion(threadId)
    if (ctx.getState().currentThreadId !== threadId) return
    ctx.commit((current) => ({
      ...current,
      fusionTask: task,
      fusionProfileId: task?.active
        ? String(task.profile.profile_id)
        : current.fusionProfileId,
    }))
    if (notice)
      ctx.commit((current) =>
        appendNotice(
          current,
          task ? fusionSummary(task) : "当前没有 Fusion 任务。",
        ),
      )
  }

  /** /fusion、status、off、cancel、recover --stopped <核查说明> 或组合 ID。 */
  async execute(
    argument: string | undefined,
    ctx: FeatureContext,
  ): Promise<IntentOutcome> {
    const value = argument?.trim() ?? ""
    try {
      const threadId = ctx.getState().currentThreadId
      if (threadId) await this.refresh(threadId, ctx)
      if (!value || value === "status") {
        const task = ctx.getState().fusionTask
        if (task)
          ctx.commit((current) => appendNotice(current, fusionSummary(task)))
        else {
          const profiles = await ctx.gateway.listFusionProfiles()
          ctx.commit((current) =>
            appendNotice(
              current,
              `Fusion 组合：${Object.keys(profiles).join("、") || "未配置"}。用 /fusion <组合ID> 启用。`,
            ),
          )
        }
        return { status: "accepted" }
      }
      if (!ctx.baseRuntime.capabilities?.includes(Capability.FUSION_MANAGE))
        return {
          status: "rejected",
          code: "capability-missing",
          message: "当前连接不支持 Fusion 管理。",
        }
      const current = ctx.getState()
      const task = current.fusionTask
      if (value === "cancel") {
        if (!task?.active)
          return {
            status: "rejected",
            code: "invalid-argument",
            message: "当前没有活动 Fusion 任务。",
          }
        const result = await ctx.gateway.cancelFusion({
          task_id: task.task_id,
          expected_version: task.version,
        })
        ctx.commit((state) =>
          appendNotice(
            { ...state, fusionTask: result, fusionProfileId: null },
            fusionSummary(result),
          ),
        )
        return { status: "accepted" }
      }
      if (value.startsWith("recover")) {
        const match = /^recover\s+--stopped\s+([\s\S]+)$/.exec(value)
        if (!match || !task || task.phase !== "OUTCOME_UNKNOWN")
          return {
            status: "rejected",
            code: "invalid-argument",
            message:
              "先检查文件和所有相关命令，确认停止后使用 /fusion recover --stopped <核查说明>。",
          }
        const result = await ctx.gateway.recoverFusion({
          task_id: task.task_id,
          expected_version: task.version,
          inspection_note: match[1]!.trim(),
          effects_stopped: true,
        })
        ctx.commit((state) =>
          appendNotice(
            { ...state, fusionTask: result },
            "核查已记录，任务暂停。发送新消息可继续原任务。",
          ),
        )
        return { status: "accepted" }
      }
      if (task?.active)
        return {
          status: "rejected",
          code: "busy",
          message: "先继续或取消活动 Fusion 任务，才能退出或切换组合。",
        }
      if (current.activeRun)
        return {
          status: "rejected",
          code: "busy",
          message: "运行中不能切换 Fusion 组合。",
        }
      if (value === "off") {
        ctx.commit((state) =>
          appendNotice(
            { ...state, fusionProfileId: null, fusionTask: null },
            "已退出 Fusion。",
          ),
        )
        return { status: "accepted" }
      }
      if (
        current.workMode !== "build" ||
        current.goal?.status === "active" ||
        current.goal?.status === "blocked"
      )
        return {
          status: "rejected",
          code: "invalid-argument",
          message: "Fusion 需要 Build 模式，且不能与活动 Goal 混用。",
        }
      const profiles = await ctx.gateway.listFusionProfiles()
      if (!profiles[value])
        return {
          status: "rejected",
          code: "invalid-argument",
          message: "组合不存在，请先在可信配置中配置 Fusion。",
        }
      ctx.commit((state) =>
        appendNotice(
          { ...state, fusionProfileId: value, fusionTask: null },
          `已选择 Fusion ${value}：Lead ${profiles[value]!.lead_profile_id}，Sidekick ${profiles[value]!.sidekick_profile_id}。发送需求开始。`,
        ),
      )
      return { status: "accepted" }
    } catch (error) {
      return {
        status: "rejected",
        code: "agent-error",
        message: error instanceof Error ? error.message : "Fusion 操作失败。",
      }
    }
  }
}
