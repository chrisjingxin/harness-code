/** 双模型组合的共享入口；TUI 和 Web 使用相同状态、恢复和取消契约。 */
import { Capability, type FusionTaskStatus, type FusionWorkspaceBlocker } from "@za38/protocol"
import type { FeatureContext } from "./types"
import type { IntentOutcome } from "../ports"
import { appendNotice } from "../state"

import { FUSION_RECOVERY_GUIDANCE, fusionSummary, fusionWorkspaceSummary } from "../fusion-summary"

export class FusionFeature {
  private workspace: { threadId: string; blocker: FusionWorkspaceBlocker | null } | undefined

  /** 目录占用独立于当前任务，缓存必须和发起查询的会话一起使用。 */
  private blocker(threadId: string | null, task: FusionTaskStatus | null): FusionWorkspaceBlocker | null {
    return task?.workspace_blocker ?? task?.resource_waits?.[0] ?? (this.workspace?.threadId === threadId ? this.workspace.blocker : null)
  }
  /** 重连或切换 Thread 后刷新，活动任务自动带回原组合。 */
  async refresh(
    threadId: string,
    ctx: FeatureContext,
    notice = false,
  ): Promise<void> {
    if (!ctx.baseRuntime.capabilities?.includes(Capability.FUSION_READ)) return
    const requestedTask = ctx.getState().fusionTask
    const { task, workspace_blocker } = await ctx.gateway.inspectFusion(threadId)
    if (ctx.getState().currentThreadId !== threadId) return
    const latest = ctx.getState().fusionTask
    // 查询等待期间可能已收到更高版本的进度，或同一对话已启动了新任务。
    if (latest && task && latest.task_id === task.task_id && latest.version > task.version) return
    if (latest !== requestedTask && latest?.task_id !== task?.task_id) return
    this.workspace = { threadId, blocker: workspace_blocker }
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
          task ? fusionSummary({ ...task, workspace_blocker: this.blocker(threadId, task) }) : workspace_blocker ? fusionWorkspaceSummary(workspace_blocker) : "当前没有 Fusion 任务。",
        ),
      )
  }

  /** 当前会话完成选择、查询、取消、核查和占用处理；TUI/Web 共用。 */
  async execute(
    argument: string | undefined,
    ctx: FeatureContext,
  ): Promise<IntentOutcome> {
    const value = argument?.trim() ?? ""
    try {
      const threadId = ctx.getState().currentThreadId
      if (threadId) await this.refresh(threadId, ctx)
      if (ctx.getState().currentThreadId !== threadId)
        return { status: "rejected", code: "busy", message: "会话已切换，请在当前会话重新执行命令。" }
      if (!value || value === "status") {
        const task = ctx.getState().fusionTask
        if (task)
          ctx.commit((current) => appendNotice(current, fusionSummary({ ...task, workspace_blocker: this.blocker(threadId, task) })))
        else {
          const blocker = this.blocker(threadId, task)
          if (blocker) {
            ctx.commit(current => appendNotice(current, fusionWorkspaceSummary(blocker)))
            return { status: "accepted" }
          }
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
      if (/^(cancel|resolve)(?:\s|$)/.test(value)) {
        const match = /^(cancel|resolve)(?:\s+--stopped\s+([\s\S]+))?$/.exec(value)
        if (!match || (match[2] !== undefined && (!match[2].trim() || match[2].length > 4000)))
          return { status: "rejected", code: "invalid-argument", message: "确认相关操作停止后填写 --stopped <核查说明>，说明须为 1–4000 字。" }
        const resolving = match[1] === "resolve"
        let target = task
        if (resolving) {
          const blocker = this.blocker(threadId, task)
          if (!blocker && task?.reason === "workspace_available") {
            ctx.commit(state => appendNotice(state, "占用已自动解除，发送“继续”恢复当前任务。"))
            return { status: "accepted" }
          }
          if (!blocker?.task_id && blocker?.operation_id && blocker.sequence) {
            if (!match[2]?.trim())
              return { status: "rejected", code: "invalid-argument", message: "这是普通工具留下的未知操作。请确认相关命令已停止，再输入 /fusion resolve --stopped <核查说明>。" }
            await ctx.gateway.releaseFusionOperation({ operation_id: blocker.operation_id, expected_sequence: blocker.sequence, stopped_inspection_note: match[2].trim() })
            if (ctx.getState().currentThreadId === threadId) {
              if (threadId) await this.refresh(threadId, ctx)
              if (ctx.getState().currentThreadId === threadId)
                ctx.commit(state => appendNotice(state, "已记录停止核查并释放工具权限，文件已保留。原排队任务会自动继续；主动暂停过的任务请发送“继续等待”。"))
            }
            return { status: "accepted" }
          }
          if (!blocker?.task_id || !blocker.thread_id)
            return { status: "rejected", code: "invalid-argument", message: "当前没有可在此处理的占用任务；用 /fusion status 查看状态。" }
          const result = await ctx.gateway.inspectFusion(blocker.thread_id)
          if (threadId) await this.refresh(threadId, ctx)
          if (ctx.getState().currentThreadId === threadId && ctx.getState().fusionTask?.reason === "workspace_available") {
            ctx.commit(state => appendNotice(state, "占用已自动解除，发送“继续”恢复当前任务。"))
            return { status: "accepted" }
          }
          // 查询可能跨过切换会话或占用者变化；绝不改为取消新的任务。
          const latest = ctx.getState()
          if (latest.currentThreadId !== threadId || latest.fusionTask?.task_id !== task?.task_id
            || this.blocker(threadId, latest.fusionTask)?.task_id !== blocker.task_id
            || result.task?.task_id !== blocker.task_id)
            return { status: "rejected", code: "busy", message: "占用状态已变化，请重新输入 /fusion resolve 查询。" }
          target = result.task
        }
        if (!target?.active)
          return { status: "rejected", code: "invalid-argument", message: resolving ? "占用任务已结束，刷新 /fusion status 后继续。" : "当前没有活动 Fusion 任务。" }
        const result = await ctx.gateway.cancelFusion({
          task_id: target.task_id,
          expected_version: target.version,
          ...(match[2] === undefined ? {} : { stopped_inspection_note: match[2].trim() }),
        })
        const latest = ctx.getState()
        if (latest.currentThreadId !== threadId || latest.fusionTask?.task_id !== task?.task_id
          || (!resolving && latest.fusionTask && latest.fusionTask.version > result.version)) return { status: "accepted" }
        if (resolving) {
          if (threadId) await this.refresh(threadId, ctx)
          if (ctx.getState().currentThreadId === threadId)
            ctx.commit(state => appendNotice(state, "占用任务已结束，文件已保留。发送“继续”恢复当前任务。"))
        } else {
          ctx.commit(state => appendNotice({ ...state, fusionTask: result, fusionProfileId: null }, fusionSummary(result)))
        }
        return { status: "accepted" }
      }
      if (value.startsWith("recover")) {
        const match = /^recover\s+--stopped\s+([\s\S]+)$/.exec(value)
        if (!match || !task || !["OUTCOME_UNKNOWN", "WORKER_RUNNING", "CHECKING"].includes(task.phase))
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
        const latest = ctx.getState()
        if (latest.currentThreadId !== threadId || latest.fusionTask?.task_id !== task.task_id
          || latest.fusionTask.version > result.version) return { status: "accepted" }
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
      const message = error instanceof Error ? error.message : "Fusion 操作失败。"
      return {
        status: "rejected",
        code: "agent-error",
        message: /^(cancel|resolve)(?:\s|$)/.test(value) && message === "FUSION_OUTCOME_UNKNOWN"
          ? value.startsWith("resolve")
            ? "占用任务仍有结果不明的操作。先检查文件，并确认相关命令和进程已停止，再在当前对话输入 /fusion resolve --stopped <核查说明>，即可保留文件并结束占用任务。"
            : `暂时无法取消：任务结果仍待核查（FUSION_OUTCOME_UNKNOWN）。${FUSION_RECOVERY_GUIDANCE}`
          : message,
      }
    }
  }
}
