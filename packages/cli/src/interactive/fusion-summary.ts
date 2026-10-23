/** TUI/Web 共用的 Fusion 任务说明；仅展示 Host 已脱敏的状态。 */
import type { FusionTaskStatus, FusionWorkspaceBlocker } from "@za38/protocol"

/** 状态说明和取消错误共用操作顺序；核查成功后才能结束未知任务。 */
export const FUSION_RECOVERY_GUIDANCE = "可直接提问，让 Lead 只读核查；停止凭据缺失不代表已经检测到进程占用。恢复写入前须检查已改文件，并确认相关命令和进程全部停止；要结束任务，单独输入 /fusion cancel --stopped <核查说明>，文件会保留。要继续原任务，可输入 /fusion recover --stopped <核查说明>，看到“核查已记录”后发送继续。"

function workspaceRecoveryGuidance(blocker: FusionWorkspaceBlocker): string {
  if (!blocker.requires_inspection)
    return "冲突操作结束后会自动继续；若想停止当前等待，按 Ctrl+C 或输入 /fusion cancel。"
  if (blocker.operation_id && blocker.requires_inspection)
    return "确认相关命令或文件操作已停止后，在当前对话输入 /fusion resolve --stopped <核查说明>，即可保留文件并释放保护。"
  if (!blocker.task_id || !blocker.thread_id)
    return "占用来源不属于当前项目记录或已不可用，请在原项目检查任务状态；当前对话无法结束这项任务。"
  return blocker.requires_inspection
    ? "先核查停止情况；确认后在当前对话输入 /fusion resolve --stopped <核查说明>，成功后发送继续。"
    : "在当前对话输入 /fusion resolve 可结束占用任务，文件会保留；成功后发送继续。"
}

/** 当前对话无任务时也说明目录写者，不能据此声称发现了运行中的进程。 */
export function fusionWorkspaceSummary(blocker: FusionWorkspaceBlocker): string {
  const owner = blocker.thread_id ? `会话 ${blocker.thread_id}` : blocker.operation_id ? "未确认停止的工具操作" : "来源待核查的任务"
  const action = workspaceRecoveryGuidance(blocker)
  return `本会话没有活动 Fusion 任务；${owner}预留了${blocker.kind === "command" ? "目录命令权限" : (blocker.paths?.join("、") || "文件范围")}。不同文件范围仍可派单，重叠范围会排队，可用后自动继续。这是权限记录，不表示已检测到运行中的进程。${blocker.requires_inspection ? action : ""}`
}

const PHASE_LABELS: Record<string, string> = {
  READY: "等待派单",
  WAITING_RESOURCE: "等待文件权限，可用后自动继续",
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
  lead_control_rejected: "派单或审阅参数连续被拒绝，本轮已暂停",
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
  resource_wait: "文件范围有冲突，正在自动等待",
  resource_wait_paused: "已暂停排队；可只读提问，发送“继续等待”恢复",
  workspace_changed: "其他源码已变化，需要重新检查",
  scope_upgrade: "权限规则已升级，需要对保留的文件重新派单检查",
  workspace_busy: "文件范围被另一任务预留",
  workspace_available: "工作区占用已解除，发送新消息继续原任务",
  owner_unavailable: "占用来源需要人工核查",
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
  const blocker = task.workspace_blocker
  let owner = ""
  if (blocker) {
    const phase = PHASE_LABELS[blocker.phase ?? ""] ?? "需要核查"
    const cause = blocker.reason ? `（${REASON_LABELS[blocker.reason] ?? "需要处理"}）` : ""
    const instructions = task.reason === "resource_wait_paused" ? "排队已暂停；发送“继续等待”可恢复，其他提问保持只读。" : workspaceRecoveryGuidance(blocker)
    owner = `；等待${blocker.kind === "command" ? "命令结束" : `文件 ${blocker.paths?.join("、") || "范围"}`}；相关会话：${blocker.thread_id ?? "其他执行"}，${phase}，第 ${blocker.round} 轮${cause}；${instructions}`
  }
  const waits = task.resource_waits ?? []
  const waiting = waits.length ? `；正在等待${waits[0]?.kind === "command" ? "另一条命令结束" : `文件 ${waits[0]?.paths?.join("、") || "写入权限"}`}，可用后自动继续` : ""
  const recovery = task.phase === "OUTCOME_UNKNOWN" ? `；${FUSION_RECOVERY_GUIDANCE}` : ""
  const round = task.round === 0 ? "尚未派单" : `第 ${task.round} 轮`
  return `Fusion ${String(profile.profile_id)}：${PHASE_LABELS[task.phase] ?? task.phase}；Lead ${modelId(profile.lead)}，Sidekick ${modelId(profile.sidekick)}；${verification}；${round}${reason}${pending}${owner}${waiting}${recovery}`
}

/** 等待资源时给出真实原因，避免把排队显示为模型一直没有响应。 */
export function fusionWaitingLabel(task: FusionTaskStatus | null | undefined): string | null {
  if (!task?.active) return null
  const blocker = task.phase === "WAITING_RESOURCE" ? task.workspace_blocker : ["WORKER_RUNNING", "CHECKING"].includes(task.phase) ? task.resource_waits?.[0] : null
  if (blocker?.requires_inspection) return "等待操作停止状态核查"
  if (blocker) return blocker.kind === "command" ? "等待其他命令结束" : "等待文件写入权限"
  return task.phase === "WAITING_RESOURCE" ? "等待文件写入权限" : null
}
