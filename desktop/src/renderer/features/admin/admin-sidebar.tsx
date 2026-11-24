/**
 * 304px 管理模式次级侧栏（HC-255 停点 2）：
 * 承接「管理与设置」一级入口的分组切换与返回工作台操作，与工作台会话树共用统一次级侧栏容器。
 */
import {
  IconArrowLeft,
  IconBrain,
  IconCpu,
  IconInbox,
  IconSun,
  IconUser,
  IconUsers,
} from "@tabler/icons-react"
import type { ReactElement } from "react"
import { ADMIN_NAV_GROUPS, type AdminSectionId } from "./admin-model.js"

const SECTION_ICONS: Readonly<Record<AdminSectionId, typeof IconSun>> = {
  appearance: IconSun,
  agents: IconCpu,
  notifications: IconInbox,
  memory: IconBrain,
  account: IconUser,
  team: IconUsers,
}

export type AdminSidebarProps = {
  readonly activeSection: AdminSectionId
  readonly onSelectSection: (section: AdminSectionId) => void
  readonly onBackToWorkbench: () => void
  readonly memoryNeedsSessionHint?: boolean
}

export function AdminSidebar({
  activeSection,
  onSelectSection,
  onBackToWorkbench,
  memoryNeedsSessionHint = false,
}: AdminSidebarProps): ReactElement {
  return (
    <nav className="project-navigation" data-dual="true" aria-label="管理与设置导航">
      <div className="sb-head">
        <span className="sb-head-title">管理与设置</span>
        <button
          type="button"
          className="wb-button wb-button-soft wb-button-xs"
          onClick={onBackToWorkbench}
        >
          <IconArrowLeft size={12} aria-hidden="true" />
          <span>返回工作台</span>
        </button>
      </div>

      <div className="sb-scroll">
        {ADMIN_NAV_GROUPS.map(group => (
          <div key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map(item => {
              const active = activeSection === item.id
              const Icon = SECTION_ICONS[item.id]
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item${active ? " is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelectSection(item.id)}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span className="nav-label">{item.label}</span>
                  {item.id === "memory" && memoryNeedsSessionHint && (
                    <span className="hui-badge" data-tone="muted" data-size="xs">需会话</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </nav>
  )
}
