/** TUI 表现层与 Adapter 之间共享的语义视图契约；不含 Renderer ref 或按键对象。 */

import type { CommandMenuItem, SkillMenuItem } from "../../interactive/commands"
import type { GoalReviewResponse, InteractiveSnapshot } from "../../interactive/types"
import type { ApprovalDecision, CommandMenuState, DirectoryTrustDecision } from "../application/adapter"

export type {
  ApprovalDecision,
  CommandMenuState,
  DirectoryTrustDecision,
  ThreadPickerItem,
} from "../application/adapter"

/** 首页与 Thread 视图共用的状态和交互入口。 */
export type SharedViewProps = {
  interactive: InteractiveSnapshot
  transientNotice?: { id: string; message: string }
  terminalWidth: number
  terminalHeight: number
  value: string
  onInput: (value: string, cursorOffset?: number) => void
  onInputCursorChange?: (cursorOffset: number) => void
  onSubmit: () => void
  commandMenu: CommandMenuState
  commandOptions: readonly CommandMenuItem[]
  onSelectCommand: (command: CommandMenuItem) => void
  mentionMenu?: import("../application/adapter").MentionMenuState
  mentionSearch?: import("../../presentation-shared/mention-filter-policy").MentionSearchResult
  onSelectMention?: (option: import("../../presentation-shared/mention-filter-policy").MentionOption) => void
  selectedSkill?: SkillMenuItem
  pickerVisible: boolean
  onClearSelectedSkill: () => void
  onApproval: (decision: ApprovalDecision) => void
  onDirectoryTrust: (decision: DirectoryTrustDecision) => void
  onPlan: (decision: import("../../interactive/types").PlanDecision, feedback?: string) => void
  onPlanViewClose: () => void
  onGoal: (response: GoalReviewResponse) => void
  onGoalViewClose: () => void
  onQuestion: (answers: Record<string, string[]>) => void
  onOpenChildTimeline?: (executionId: string) => void
  inputMode?: "chat" | "shell"
}
