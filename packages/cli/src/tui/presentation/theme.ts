/** Harness Code 终端主题：Mode 金/紫、Semantic 色。 */

/** Logo 仍用品牌蓝；Mode 身份只走 modeAccent，不得用 primary 冒充当前 Mode。 */
export const tuiTheme = {
  modeBuild: "#EAB308",
  modeCompose: "#A9A5D4",
  modeShell: "#56B6C2",
  thinking: "#7EB6C9",
  background: "#0B0C0E",
  surface: "#15171A",
  surfaceElevated: "#1B1D21",
  overlay: "#1B1D21",
  panel: "#15171A",
  toolSurface: "#15171A",
  menu: "#1B1D21",
  element: "#15171A",
  border: "#2A2D33",
  borderActive: "#EAB308",
  text: "#E8E9EC",
  muted: "#A0A4AE",
  subtle: "#676C76",
  primary: "#3b82f6",
  primarySoft: "#1d4ed8",
  pickerActive: "#EAB308",
  star: "#3f3f46",
  trail: "#60a5fa",
  success: "#7FA37A",
  warning: "#C88758",
  danger: "#C56F6F",
  diffAdd: "#6F9A72",
  diffRemove: "#B96A6A",
  diffAddedBackground: "#155815",
  diffRemovedBackground: "#581515",
  syntaxComment: "#858b99",
  syntaxKeyword: "#8da7ff",
  syntaxFunction: "#79c6ff",
  syntaxVariable: "#f08ba9",
  syntaxString: "#9bce93",
  syntaxNumber: "#e6bb72",
  syntaxType: "#c4a7f2",
  syntaxOperator: "#7bd4d0",
  syntaxPunctuation: "#b8becb",
} as const

/** 当前 Run / 输入栏身份色；Build 与 Compose 等权。 */
export function modeAccent(mode: "build" | "compose"): string {
  return mode === "compose" ? tuiTheme.modeCompose : tuiTheme.modeBuild
}

/** 用户消息竖条颜色只看该条 Mode；缺字段按 Build，不读当前会话。 */
export function userMessageAccent(workMode: "build" | "compose" | undefined): string {
  return modeAccent(workMode ?? "build")
}
