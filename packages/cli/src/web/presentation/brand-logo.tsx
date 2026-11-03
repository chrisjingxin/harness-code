/** 设计稿品牌标志：Command 线形图标，色彩由 theme.css 的品牌变量提供。 */
/** @jsxImportSource react */
import { Command } from "lucide-react"

/** 与已确认工作台设计稿使用同一 Command 图形。 */
export function HarnessBrandLogo() {
  return <Command className="harness-brand-logo" size={20} strokeWidth={2.5} aria-hidden="true" focusable="false" />
}
