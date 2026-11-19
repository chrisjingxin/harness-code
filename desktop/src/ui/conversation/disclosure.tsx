/**
 * 通用折叠容器：组体始终挂载，用 grid-template-rows 0fr↔1fr 过渡高度，
 * 收起时内容设为 inert 并对读屏隐藏，供工具详情、工具组和思考过程复用。
 */
import type { ReactElement, ReactNode } from "react"

export function Disclosure({
  open,
  className,
  children,
}: {
  open: boolean
  className?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className={`wb-disclosure${className ? ` ${className}` : ""}`} data-open={open || undefined}>
      <div className="wb-disclosure-inner" inert={!open} aria-hidden={!open}>{children}</div>
    </div>
  )
}
