/** 代码索引 Feature：拉取 Host snapshot 到独立状态，不写 Transcript、不占 pendingOperation。 */

import { Capability, type CodeIndexApplyParams, type CodeIndexSnapshot } from "@za38/protocol"
import type { IntentOutcome } from "../ports"
import { applyCodeIndexSnapshot } from "../state"
import type { FeatureContext } from "./types"

export class CodeIndexFeature {
  /** 接受 Host 推送的完整快照；revision 去重由 state reducer 统一处理。 */
  changed(snapshot: CodeIndexSnapshot, ctx: FeatureContext): void {
    ctx.commit(current => applyCodeIndexSnapshot(current, snapshot))
  }

  /** `/code-index status`：刷新工作区索引状态。 */
  async status(ctx: FeatureContext): Promise<{ snapshot: CodeIndexSnapshot | null; error?: string }> {
    try {
      const snapshot = await ctx.gateway.codeIndexStatus()
      ctx.commit(current => applyCodeIndexSnapshot(current, snapshot))
      return { snapshot }
    } catch (error) {
      const message = codeIndexErrorMessage(error)
      return { snapshot: ctx.getState().codeIndex, error: message }
    }
  }

  async execute(argument: string | undefined, ctx: FeatureContext): Promise<IntentOutcome> {
    if (argument === "status") {
      const result = await this.status(ctx)
      if (result.error) return { status: "rejected", code: "agent-error", message: result.error }
      return { status: "accepted" }
    }
    if (argument && !["rebuild", "cancel", "remove-confirmed"].includes(argument)) {
      return { status: "rejected", code: "invalid-argument", message: "用法：/code-index [status|rebuild|cancel|remove]" }
    }
    if (!ctx.baseRuntime.capabilities?.includes(Capability.CODE_INDEX_MANAGE)) {
      return { status: "rejected", code: "capability-missing", message: "当前连接不能建立代码索引。" }
    }
    // 写操作一律先向 Host 刷新 revision，避免用推送延迟留下的旧 CAS 值。
    const refreshed = await this.status(ctx)
    if (refreshed.error) return { status: "rejected", code: "agent-error", message: refreshed.error }
    const current = refreshed.snapshot
    if (!current) return { status: "rejected", code: "agent-error", message: "无法读取代码索引状态。" }
    let request: CodeIndexApplyParams
    if (argument === "rebuild") {
      request = { action: "rebuild", expected_revision: current.revision }
    } else if (argument === "cancel") {
      if (current.job?.status !== "running") {
        return { status: "rejected", code: "invalid-argument", message: "当前没有可取消的代码索引任务。" }
      }
      request = { action: "cancel", expected_revision: current.revision, job_id: current.job.id }
    } else if (argument === "remove-confirmed") {
      request = { action: "remove", expected_revision: current.revision, confirmed: true }
    } else {
      request = { action: "ensure", expected_revision: current.revision }
    }
    try {
      const snapshot = await ctx.gateway.codeIndexApply(request)
      this.changed(snapshot, ctx)
      return { status: "accepted" }
    } catch (error) {
      return { status: "rejected", code: "agent-error", message: codeIndexErrorMessage(error) }
    }
  }
}

/** 优先使用协议 error.details 中的中性文案，避免把内部错误码直接显示给用户。 */
function codeIndexErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: unknown }).data
    if (data && typeof data === "object") {
      const details = (data as { details?: unknown }).details
      if (details && typeof details === "object") {
        const message = (details as { message?: unknown }).message
        const recovery = (details as { recovery?: unknown }).recovery
        if (typeof message === "string") {
          return typeof recovery === "string" ? `${message}\n${recovery}` : message
        }
      }
    }
  }
  return error instanceof Error ? error.message : String(error)
}
