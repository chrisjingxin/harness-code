/** 公共品牌与角色图形；不携带消息、账号或导航状态。 */
import { Command, MessageCircle, Sparkles } from "lucide-react"
import type { ReactElement } from "react"

/** 沿用旧工作台的 Command 品牌图形，颜色由容器继承。 */
export function BrandMark(): ReactElement {
  return <Command className="wb-brand-mark" size={20} strokeWidth={2.5} aria-hidden="true" focusable="false" />
}

/** 用户与 Agent 头像是装饰图形；可读的角色名称由调用方提供。 */
export function RoleAvatar({ kind }: { kind: "assistant" | "user" }): ReactElement {
  const Icon = kind === "assistant" ? Sparkles : MessageCircle
  return <span className="wb-role-avatar" aria-hidden="true"><Icon size={16} strokeWidth={1.8} focusable="false" /></span>
}
