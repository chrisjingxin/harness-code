/** Interactive Selector：把领域 snapshot 收敛为可序列化展示视图与 FeatureAvailability。 */

export * from "./types"

import type { InteractiveSnapshot } from "../types"
import { CAPABILITY_GATE, type CodeIndexView, type CommandView, type ConversationView, type FeatureAvailability, type InteractionView, type NavigationView, type RuntimeView, type WorkItemView } from "./types"

/** 由 snapshot 推导全部展示可用性；与 commands.ts 的 availability 计算共享同一输入。 */
export function selectFeatureAvailability(snapshot: InteractiveSnapshot): FeatureAvailability {
  const capabilities = new Set<string>(snapshot.runtime.capabilities ?? [])
  const hasRun = snapshot.activeRun !== null
  const hasInteraction = snapshot.interaction !== null
  const hasPendingOperation = snapshot.activity.kind === "compacting"
  const cancelling = snapshot.activity.kind === "cancelling"
  const isChildTimeline = Boolean(snapshot.childTimelineExecutionId)

  return {
    canSubmit: snapshot.connection.status === "open" && !hasPendingOperation && !isChildTimeline,
    canCancelRun: hasRun && !cancelling,
    canOpenThread: !hasRun && !hasInteraction && !hasPendingOperation,
    canToggleSkill: capabilities.has(CAPABILITY_GATE.toggleSkill) && !hasRun && !hasPendingOperation,
    canManageMcp: capabilities.has(CAPABILITY_GATE.manageMcp) && !hasRun && !hasPendingOperation,
    canChangeModel: capabilities.has(CAPABILITY_GATE.changeModel) && !hasPendingOperation,
    canOpenModelsPanel: capabilities.has(CAPABILITY_GATE.openModelsPanel),
    canOpenSkillsPanel: capabilities.has(CAPABILITY_GATE.openSkillsPanel),
    canOpenMcpPanel: capabilities.has(CAPABILITY_GATE.openMcpPanel),
    canOpenAgentsPanel: capabilities.has(CAPABILITY_GATE.openAgentsPanel),
    hasSkillManage: capabilities.has(CAPABILITY_GATE.toggleSkill),
    hasMcpManage: capabilities.has(CAPABILITY_GATE.manageMcp),
  }
}

const CODE_INDEX_PHASE_LABEL: Record<string, string> = {
  preflight: "预检中",
  preparing: "准备中",
  indexing: "建立中",
  resolving: "解析中",
  validating: "校验中",
  starting_query: "启动查询中",
  removing: "删除中",
}

/** 代码索引状态：只使用 Harness 文案，不透传路径或供应商名称。 */
export function selectCodeIndexView(snapshot: InteractiveSnapshot): CodeIndexView | null {
  const state = snapshot.codeIndex
  if (!state) return null
  if (state.job?.status === "running") {
    const phase = CODE_INDEX_PHASE_LABEL[state.job.phase] ?? "建立中"
    const completed = state.job.completed
    const total = state.job.total
    const count = completed === undefined
      ? ""
      : total === undefined
        ? `\n已处理 ${completed} 项`
        : `\n已处理 ${completed} / ${total} 项`
    return {
      title: "代码索引",
      indexStatus: state.index_status === "incomplete" ? "incomplete" : state.index_status,
      body: `代码索引 · ${phase}${count}`,
    }
  }
  if (state.runtime_status === "unavailable") {
    return {
      title: "代码索引",
      indexStatus: "unavailable",
      body: [
        "代码索引 · 运行时不可用",
        state.error?.message,
        state.error?.recovery,
      ].filter(Boolean).join("\n"),
    }
  }
  if (state.index_status === "absent") {
    return {
      title: "代码索引",
      indexStatus: "absent",
      body: "代码索引 · 未建立",
    }
  }
  if (state.index_status === "incomplete") {
    return {
      title: "代码索引",
      indexStatus: "incomplete",
      body: [
        "代码索引 · 不完整",
        state.error?.message,
        state.error?.recovery,
      ].filter(Boolean).join("\n"),
    }
  }
  return {
    title: "代码索引",
    indexStatus: "ready",
    body: [
      "代码索引 · 已就绪",
      state.stats
        ? `${state.stats.files} 个文件 · ${state.stats.symbols} 个符号 · ${state.stats.relationships} 条关系`
        : undefined,
      `${state.query_status === "ready" ? "查询就绪" : "查询未就绪"} · ${state.watcher_status === "ready" ? "自动同步就绪" : "自动同步未就绪"}`,
      state.watcher_status === "degraded" ? "索引可能已过期；执行 /code-index 手工更新。" : undefined,
    ].filter(Boolean).join("\n"),
  }
}

/** 对话视图：时间线与当前运行状态。 */
export function selectConversationView(snapshot: InteractiveSnapshot): ConversationView {
  return {
    currentThreadId: snapshot.currentThreadId,
    activity: snapshot.activity,
    activeRun: snapshot.activeRun,
    timeline: snapshot.timeline,
    runProgress: snapshot.runProgress,
    lastRun: snapshot.lastRun,
    childTimelineExecutionId: snapshot.childTimelineExecutionId,
    goal: snapshot.goal,
    goalPending: snapshot.goalPending,
    goalEvaluation: snapshot.goalEvaluation,
    goalActivities: snapshot.goalActivities,
  }
}

/** 交互视图：挂起 Interaction 与破坏性确认。 */
export function selectInteractionView(snapshot: InteractiveSnapshot): InteractionView {
  return {
    interaction: snapshot.interaction,
    confirmation: snapshot.confirmation,
  }
}

/** 导航视图：四类 catalog 与打开/变更可用性。 */
export function selectNavigationView(snapshot: InteractiveSnapshot): NavigationView {
  const availability = selectFeatureAvailability(snapshot)
  return {
    catalogs: snapshot.catalogs,
    availability: {
      canOpenThread: availability.canOpenThread,
      canOpenModelsPanel: availability.canOpenModelsPanel,
      canOpenSkillsPanel: availability.canOpenSkillsPanel,
      canOpenMcpPanel: availability.canOpenMcpPanel,
      canOpenAgentsPanel: availability.canOpenAgentsPanel,
      hasSkillManage: availability.hasSkillManage,
      hasMcpManage: availability.hasMcpManage,
    },
  }
}

/** 命令视图：可用命令与提交可用性。 */
export function selectCommandView(snapshot: InteractiveSnapshot): CommandView {
  return {
    commands: snapshot.commands,
    availability: {
      canSubmit: selectFeatureAvailability(snapshot).canSubmit,
    },
  }
}

/** 运行时视图：runtime/connection/selection 与运行控制可用性。 */
export function selectRuntimeView(snapshot: InteractiveSnapshot): RuntimeView {
  const availability = selectFeatureAvailability(snapshot)
  return {
    runtime: snapshot.runtime,
    connection: snapshot.connection,
    selection: snapshot.selection,
    workMode: snapshot.workMode,
    composeState: snapshot.composeState,
    codeIndex: snapshot.codeIndex,
    availability: {
      canCancelRun: availability.canCancelRun,
      canToggleSkill: availability.canToggleSkill,
      canManageMcp: availability.canManageMcp,
      canChangeModel: availability.canChangeModel,
    },
  }
}

/** Work Item 视图：持久投影与模式锁定；renderer 只消费此形状。 */
export function selectWorkItemView(snapshot: InteractiveSnapshot): WorkItemView {
  return {
    workItem: snapshot.workItem,
    threadMode: snapshot.threadMode,
    modeLocked: snapshot.threadMode != null,
  }
}
