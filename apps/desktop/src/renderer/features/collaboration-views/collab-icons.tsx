/**
 * 协作视图内联 SVG 图标集：遵守 apps/desktop 依赖边界（不直接引入 lucide-react）。
 */
import type { ReactElement } from "react"

type Props = { readonly size?: number; readonly className?: string }

function svg(size: number, children: ReactElement | readonly ReactElement[], className?: string): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function SearchIcon({ size = 15 }: Props): ReactElement {
  return svg(size, [<circle key="1" cx="11" cy="11" r="7" />, <path key="2" d="M16.5 16.5 21 21" />])
}

export function CloseIcon({ size = 15 }: Props): ReactElement {
  return svg(size, <path d="M6 6l12 12M18 6 6 18" />)
}

export function ChevronDownIcon({ size = 13 }: Props): ReactElement {
  return svg(size, <path d="m6 9 6 6 6-6" />)
}

export function PlusIcon({ size = 14 }: Props): ReactElement {
  return svg(size, <path d="M12 5v14M5 12h14" />)
}

export function CheckIcon({ size = 14 }: Props): ReactElement {
  return svg(size, <path d="M5 13l4 4L19 7" />)
}

export function LockIcon({ size = 13 }: Props): ReactElement {
  return svg(size, [<rect key="1" x="5" y="10" width="14" height="10" rx="2" />, <path key="2" d="M8 10V7a4 4 0 0 1 8 0v3" />])
}

export function ClockIcon({ size = 14 }: Props): ReactElement {
  return svg(size, [<circle key="1" cx="12" cy="12" r="8" />, <path key="2" d="M12 8v4l3 2" />])
}

export function DotIcon({ size = 14 }: Props): ReactElement {
  return svg(size, <circle cx="12" cy="12" r="4" />)
}

export function SendArrowIcon({ size = 14 }: Props): ReactElement {
  return svg(size, <path d="M5 12h13M12 6l6 6-6 6" />)
}

export function AtSignIcon({ size = 14 }: Props): ReactElement {
  return svg(size, [<circle key="1" cx="12" cy="12" r="4" />, <path key="2" d="M16 8v5a2.5 2.5 0 0 0 5 0v-1a9 9 0 1 0-3.6 7.2" />])
}

export function BookOpenIcon({ size = 14 }: Props): ReactElement {
  return svg(size, [<path key="1" d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z" />, <path key="2" d="M17 7h2v13H8" />])
}

export function FileIcon({ size = 14 }: Props): ReactElement {
  return svg(size, [<path key="1" d="M7 3h7l5 5v13H7z" />, <path key="2" d="M14 3v5h5" />])
}

export function TaskIcon({ size = 14 }: Props): ReactElement {
  return svg(size, [<path key="1" d="M4 7h11M4 12h11M4 17h7" />, <path key="2" d="m16 15 2.5 2.5L23 13" />])
}

export function ArrowLeftIcon({ size = 15 }: Props): ReactElement {
  return svg(size, <path d="M19 12H5M11 6l-6 6 6 6" />)
}
