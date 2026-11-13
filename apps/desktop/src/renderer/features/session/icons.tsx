/**
 * 会话页面轻量矢量图标集：避免在 apps/desktop 额外引入第三方图标运行依赖，严格遵守依赖边界。
 */
import type { ReactElement } from "react"

type IconProps = { readonly size?: number }

function svg(size: number, children: ReactElement | readonly ReactElement[]): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function FolderIcon({ size = 14 }: IconProps): ReactElement {
  return svg(size, <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />)
}

export function LaptopIcon({ size = 12 }: IconProps): ReactElement {
  return svg(size, [
    <rect key="1" x="4" y="5" width="16" height="11" rx="2" />,
    <path key="2" d="M2 19h20" />,
  ])
}

export function LockIcon({ size = 12 }: IconProps): ReactElement {
  return svg(size, [
    <rect key="1" x="5" y="11" width="14" height="9" rx="2" />,
    <path key="2" d="M8 11V7a4 4 0 1 1 8 0v4" />,
  ])
}

export function RefreshIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M21 12a9 9 0 0 0-15.5-6.3L3 8" />,
    <path key="2" d="M3 3v5h5" />,
    <path key="3" d="M3 12a9 9 0 0 0 15.5 6.3L21 16" />,
    <path key="4" d="M16 16h5v5" />,
  ])
}

export function CheckDoubleIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M18 6 7 17l-5-5" />,
    <path key="2" d="m22 10-7.5 7.5L13 16" />,
  ])
}

export function ClockIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <circle key="1" cx="12" cy="12" r="9" />,
    <path key="2" d="M12 7v5l3 2" />,
  ])
}

export function MessageIcon({ size = 15 }: IconProps): ReactElement {
  return svg(size, <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />)
}

export function GitBranchIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <line key="1" x1="6" y1="3" x2="6" y2="15" />,
    <circle key="2" cx="18" cy="6" r="3" />,
    <circle key="3" cx="6" cy="18" r="3" />,
    <path key="4" d="M18 9a9 9 0 0 1-9 9" />,
  ])
}

export function PlusIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M12 5v14" />,
    <path key="2" d="M5 12h14" />,
  ])
}

export function LinkIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />,
    <path key="2" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />,
  ])
}

export function ShieldCheckIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
    <path key="2" d="m9 12 2 2 4-4" />,
  ])
}

export function ArrowRightIcon({ size = 14 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M5 12h14" />,
    <path key="2" d="m12 5 7 7-7 7" />,
  ])
}

export function ChevronDownIcon({ size = 12 }: IconProps): ReactElement {
  return svg(size, <path d="m6 9 6 6 6-6" />)
}

export function UsersIcon({ size = 12 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />,
    <circle key="2" cx="9" cy="7" r="4" />,
    <path key="3" d="M22 21v-2a4 4 0 0 0-3-3.87" />,
    <path key="4" d="M16 3.13a4 4 0 0 1 0 7.75" />,
  ])
}

export function AlertIcon({ size = 13 }: IconProps): ReactElement {
  return svg(size, [
    <path key="1" d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />,
    <path key="2" d="M12 9v4" />,
    <path key="3" d="M12 17h.01" />,
  ])
}
