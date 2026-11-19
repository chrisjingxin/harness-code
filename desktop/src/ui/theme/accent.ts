/**
 * 强调色公共出口：设置页、预览与主题 CSS 共用同一份色板，避免多处写死色值漂移。
 * swatch 只用于界面色块展示，实际着色统一由 theme/accent.css 的 [data-accent] 令牌决定。
 */
export const ACCENT_OPTIONS = [
  { id: "violet", label: "紫罗兰", swatch: { light: "#5b63d3", dark: "#8c93f8" } },
  { id: "indigo", label: "靛蓝", swatch: { light: "#2b59e8", dark: "#82a0ff" } },
  { id: "teal", label: "青碧", swatch: { light: "#09695a", dark: "#46c7ae" } },
  { id: "ink", label: "墨黑", swatch: { light: "#171717", dark: "#ededf0" } },
] as const

export type AccentId = (typeof ACCENT_OPTIONS)[number]["id"]

/** 未设置或存储值非法时回落的默认强调色。 */
export const DEFAULT_ACCENT: AccentId = "violet"

/** 校验持久化或宿主传入的值是否仍是受支持的强调色，防止旧值泄漏进 data-accent。 */
export function isAccentId(value: unknown): value is AccentId {
  return ACCENT_OPTIONS.some(option => option.id === value)
}
