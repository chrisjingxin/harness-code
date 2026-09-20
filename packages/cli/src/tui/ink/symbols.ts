/**
 * TUI 专用排版符号与 CJK 宽字符防护。
 * 追加零宽度变体选择符 15 (\uFE0E)，强制终端将歧义宽度（Ambiguous Width）符号渲染为 1 列窄字符，杜绝排版错位与断行。
 */
const _VS15 = "\uFE0E"

export const ICON = {
  DIAMOND: `◆${_VS15}`,
  BULLET: `●${_VS15}`,
  STAR: `★${_VS15}`,
  CHECK: `✓${_VS15}`,
  CROSS: `✗${_VS15}`,
  THEREFORE: `∴${_VS15}`,
  BECAUSE: `∵${_VS15}`,
  SPINNER: `◐${_VS15}`,
  EDIT: "✎",
  READ: "📖",
  SEARCH: "🔍",
  SHELL: "❯",
  SPARKLE: "✨",
  BRANCH: "⎇",
  TREE_BRANCH: "├─",
  TREE_LAST: "└─",
  TREE_LINE: "│",
} as const
