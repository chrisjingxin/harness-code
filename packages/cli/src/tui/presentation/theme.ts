/** Harness Code Ink 主题：品牌、Mode、文本、选择与 Semantic 单一 token。 */
export const tuiTheme = {
  brand: "#3B82F6",
  modeBuild: "#EAB308",
  modeCompose: "#A9A5D4",
  border: "#2A2D33",
  borderActive: "#EAB308",
  selection: "#EAB308",
  muted: "#6B7280",
  textDim: "#888888",
  textMuted: "#5F6673",
  cardBorder: "#333740",
  chipBg: "#1F232B",
  roleUser: "#FFCB6B",
  success: "#7FA37A",
  warning: "#C88758",
  danger: "#C56F6F",
  diffAdd: "#6F9A72",
  diffRemove: "#B96A6A",
} as const

/** 当前 Run / 输入栏身份色；Build 与 Compose 等权。 */
export function modeAccent(mode: "build" | "compose"): string {
  return mode === "compose" ? tuiTheme.modeCompose : tuiTheme.modeBuild
}

/** 用户消息竖条颜色只看该条 Mode；缺字段按 Build，不读当前会话。 */
export function userMessageAccent(workMode: "build" | "compose" | undefined): string {
  return modeAccent(workMode ?? "build")
}
