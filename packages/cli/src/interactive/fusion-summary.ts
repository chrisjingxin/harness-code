/** TUI/Web 共用的 Fusion 任务说明；仅展示 Host 已脱敏的状态。 */
import type { FusionTaskStatus } from "@za38/protocol"

const PHASE_LABELS: Record<string, string> = {
  READY: "等待派单",
  WORKER_RUNNING: "Sidekick 执行中",
  CHECKING: "Host 检查中",
  REVIEWING: "Lead 审阅中",
  PAUSED: "已暂停",
  WAITING_USER: "等待处理",
  OUTCOME_UNKNOWN: "结果不明，需要核查",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
}
const REASON_LABELS: Record<string, string> = {
  worker_report_missing: "Sidekick 未提交报告",
  worker_blocked: "Sidekick 遇到阻塞",
  worker_checkpoint_invalid: "Sidekick 历史缺失或未完整结束，请核查后取消任务",
  check_receipt_missing: "检查回执不完整，请核查后返工或取消任务",
  out_of_scope: "改动超出任务范围",
  candidate_changed: "候选文件已变化，需要重新检查",
  rework_limit: "已达到返工上限",
  review_rejected: "Lead 未接受本轮结果",
  effects_unconfirmed: "相关操作是否停止尚未确认",
  run_paused: "运行已暂停",
  inspection_recorded: "已保存人工核查记录",
  direct_answer: "直接问答",
  lead_stopped_without_completion: "Lead 尚未完成派单或审阅",
}
function modelId(profile: unknown): string {
  return typeof profile === "object" &&
    profile !== null &&
    "id" in profile
    ? String(profile.id)
    : "未知"
}

/** 验证通过但仍在审阅的任务，不显示为已经完成审阅。 */
export function fusionSummary(task: FusionTaskStatus): string {
  const profile = task.profile
  const verification =
    task.verification === "verified"
      ? task.phase === "COMPLETED"
        ? "检查及审阅通过"
        : "检查通过，等待审阅"
      : task.verification === "review_only"
        ? task.phase === "COMPLETED"
          ? "仅人工审阅"
          : "未配置检查，等待审阅"
        : "尚未验证"
  const reason = task.reason
    ? `；原因：${REASON_LABELS[task.reason] ?? task.reason}`
    : ""
  const operations = task.pending_operations ?? []
  const kinds: Record<string, string> = {
    execute: "执行命令",
    check: "Host 检查",
    dispatch: "派单",
    write_file: "写文件",
    edit_file: "改文件",
    delete_file: "删除文件",
  }
  const pending = operations.length
    ? `；待核查操作：${operations
        .slice(0, 8)
        .map(
          (operation) =>
            `${kinds[String(operation.kind)] ?? String(operation.kind)}（${String(operation.operation_id)}）`,
        )
        .join(
          "、",
        )}${operations.length > 8 ? `，共 ${operations.length} 项` : ""}`
    : ""
  return `Fusion ${String(profile.profile_id)}：${PHASE_LABELS[task.phase] ?? task.phase}；Lead ${modelId(profile.lead)}，Sidekick ${modelId(profile.sidekick)}；${verification}；第 ${task.round} 轮${reason}${pending}`
}
