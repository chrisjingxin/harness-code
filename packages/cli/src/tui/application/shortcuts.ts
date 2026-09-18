/** 全局快捷键解析器：同一按键只交给最高优先级 owner。 */

type KeyLike = {
  name: string
  ctrl: boolean
  shift?: boolean
}

/** 当前占据动态区的全宽临时视图；无视图时不设值。 */
export type TemporaryViewKind = "status" | "btw" | "inspect" | "workspace" | "tool-inspector"

export type ShortcutContext = {
  commandDialogVisible?: boolean
  skillPickerVisible?: boolean
  skillOptionCount?: number
  threadPickerVisible?: boolean
  threadOptionCount?: number
  modelPickerVisible?: boolean
  modelOptionCount?: number
  agentPickerVisible?: boolean
  agentOptionCount?: number
  undoPickerVisible?: boolean
  undoOptionCount?: number
  undoDialogVisible?: boolean
  commandMenuVisible: boolean
  commandOptionCount: number
  mentionMenuVisible?: boolean
  mentionOptionCount?: number
  mentionBrowsePath?: string
  mentionQuery?: string
  mentionSelectedKind?: "directory" | "file" | "symlink"
  activeRun: boolean
  hasDraft: boolean
  inputMode?: "chat" | "shell"
  childTimelineActive?: boolean
  interactionActive?: boolean
  temporaryViewKind?: TemporaryViewKind
}

export type ShortcutAction =
  | "none"
  | "exit-shell-mode"
  | "confirm-command-dialog"
  | "cancel-command-dialog"
  | "close-temporary-view"
  | "copy-btw-answer"
  | "open-workspace"
  | "open-tool-inspector"
  | "leave-child-timeline"
  | "close-undo-dialog"
  | "undo-mode-prev"
  | "undo-mode-next"
  | "undo-mode-1"
  | "undo-mode-2"
  | "undo-mode-3"
  | "confirm-undo"
  | "close-undo-picker"
  | "undo-previous"
  | "undo-next"
  | "undo-select"
  | "undo-block"
  | "close-command-menu"
  | "command-previous"
  | "command-next"
  | "command-select"
  | "command-complete"
  | "command-block"
  | "close-mention-menu"
  | "mention-previous"
  | "mention-next"
  | "mention-page-previous"
  | "mention-page-next"
  | "mention-enter"
  | "mention-parent"
  | "mention-select"
  | "mention-block"
  | "close-skill-picker"
  | "skill-previous"
  | "skill-next"
  | "skill-select"
  | "skill-block"
  | "close-thread-picker"
  | "thread-previous"
  | "thread-next"
  | "thread-select"
  | "thread-block"
  | "close-model-picker"
  | "model-previous"
  | "model-next"
  | "model-select"
  | "model-block"
  | "close-agent-picker"
  | "agent-previous"
  | "agent-next"
  | "agent-select"
  | "agent-block"
  | "command-open"
  | "clear-draft"
  | "cancel-run"
  | "hint-interrupt"
  | "exit"
  | "clear-selected-skill"
  | "cycle-approval-mode"
  | "cycle-work-mode"

const NAVIGATION_KEYS = new Set(["return", "kpenter", "escape", "tab", "up", "down", "left", "right", "pageup", "pagedown"])

/** Ctrl+C：清草稿 → 取消 Run → 退出。 */
function resolveCtrlC(context: ShortcutContext): ShortcutAction {
  if (context.hasDraft) return "clear-draft"
  if (context.activeRun) return "cancel-run"
  return "exit"
}

/** 快捷键按 Interaction → 确认框 → 临时视图 → 选择器/菜单 → 全局 的唯一 owner 解析。 */
export function resolveShortcut(key: KeyLike, context: ShortcutContext): ShortcutAction {
  if (context.interactionActive) {
    if (key.ctrl && key.name === "c") return resolveCtrlC(context)
    if (NAVIGATION_KEYS.has(key.name)) return "none"
  }
  if (context.commandDialogVisible) {
    if (key.name === "escape") return "cancel-command-dialog"
    if (key.name === "return" || key.name === "kpenter") return "confirm-command-dialog"
    return "none"
  }
  if (context.undoDialogVisible) {
    if (key.name === "escape") return "close-undo-dialog"
    if (key.name === "return" || key.name === "kpenter") return "confirm-undo"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "undo-mode-prev"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "undo-mode-next"
    if (key.name === "1" && !key.ctrl) return "undo-mode-1"
    if (key.name === "2" && !key.ctrl) return "undo-mode-2"
    if (key.name === "3" && !key.ctrl) return "undo-mode-3"
    return "none"
  }
  if (context.temporaryViewKind) {
    if (context.temporaryViewKind === "btw" && key.name === "c" && !key.ctrl) return "copy-btw-answer"
    if (key.ctrl && key.name === "c") return resolveCtrlC(context)
    const closesOnEnter = context.temporaryViewKind === "status"
      || context.temporaryViewKind === "btw"
      || context.temporaryViewKind === "inspect"
    if (key.name === "escape") return "close-temporary-view"
    if (closesOnEnter && (key.name === "return" || key.name === "kpenter" || key.name === "q")) return "close-temporary-view"
    if (context.temporaryViewKind === "inspect" && key.name === "q") return "close-temporary-view"
    return "none"
  }
  if (context.undoPickerVisible) {
    if (key.name === "escape") return "close-undo-picker"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "undo-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "undo-next"
    if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      return (context.undoOptionCount ?? 0) > 0 ? "undo-select" : "undo-block"
    }
  }
  if (context.threadPickerVisible) {
    if (key.name === "escape") return "close-thread-picker"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "thread-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "thread-next"
    if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      return (context.threadOptionCount ?? 0) > 0 ? "thread-select" : "thread-block"
    }
  }
  if (context.modelPickerVisible) {
    if (key.name === "escape") return "close-model-picker"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "model-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "model-next"
    if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      return (context.modelOptionCount ?? 0) > 0 ? "model-select" : "model-block"
    }
  }
  if (context.agentPickerVisible) {
    if (key.name === "escape") return "close-agent-picker"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "agent-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "agent-next"
    if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      return (context.agentOptionCount ?? 0) > 0 ? "agent-select" : "agent-block"
    }
  }
  if (context.skillPickerVisible) {
    if (key.name === "escape") return "close-skill-picker"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "skill-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "skill-next"
    if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      return (context.skillOptionCount ?? 0) > 0 ? "skill-select" : "skill-block"
    }
  }
  if (context.commandMenuVisible) {
    if (key.name === "escape") return "close-command-menu"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "command-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "command-next"
    if (key.name === "tab") {
      return context.commandOptionCount > 0 ? "command-complete" : "command-block"
    }
    if (key.name === "return" || key.name === "kpenter") {
      return context.commandOptionCount > 0 ? "command-select" : "command-block"
    }
  }
  if (context.mentionMenuVisible) {
    if (key.name === "escape") return "close-mention-menu"
    if (key.name === "up" || (key.ctrl && key.name === "p")) return "mention-previous"
    if (key.name === "down" || (key.ctrl && key.name === "n")) return "mention-next"
    if (key.name === "pageup") return "mention-page-previous"
    if (key.name === "pagedown") return "mention-page-next"
    if (key.name === "right" && !context.mentionQuery && context.mentionSelectedKind === "directory") return "mention-enter"
    if (key.name === "left" && !context.mentionQuery && context.mentionBrowsePath) return "mention-parent"
    if (key.name === "return" || key.name === "kpenter" || key.name === "tab") {
      return (context.mentionOptionCount ?? 0) > 0 ? "mention-select" : "mention-block"
    }
  }

  if (key.ctrl && key.name === "p") return "command-open"
  if (key.ctrl && key.name === "c") return resolveCtrlC(context)
  if ((key.name === "escape" || key.name === "backspace" || key.name === "delete") && context.childTimelineActive) {
    return "leave-child-timeline"
  }
  if (key.name === "escape" && context.inputMode === "shell") return "exit-shell-mode"
  if (key.name === "escape" && context.activeRun) return "hint-interrupt"
  if (key.name === "escape" && !context.hasDraft) return "clear-selected-skill"
  if (key.ctrl && key.name === "b") return "open-workspace"
  if (key.ctrl && key.name === "o") return "open-tool-inspector"
  // Shift+Tab 循环切换审批模式；浮层打开时让位，避免选择器焦点下误切换。
  if (key.shift && key.name === "tab") return "cycle-approval-mode"
  // 空闲且无浮层时 Tab 切换 Work Mode（Build/Compose）；输入草稿时保留
  // 给 textarea 默认行为，运行中由 busy 门禁拒绝并给出稳定提示。
  if (key.name === "tab" && !key.shift && !context.activeRun && !context.hasDraft) {
    return "cycle-work-mode"
  }
  if (key.ctrl && key.name === "d" && !context.activeRun && !context.hasDraft) return "exit"
  return "none"
}
