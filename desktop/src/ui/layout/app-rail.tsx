/**
 * 56px 固定全局图标栏（第一层一级业务导航）：
 * 仅展示已实现的业务入口（工作台 / Inbox / Project 看板 / 团队知识 + 全局搜索 / 管理与设置 / 头像），
 * 顶部保留 macOS 红绿灯与拖拽安全区，底部头像弹出轻量 UserPopover。
 */
import {
  IconBook2,
  IconHome,
  IconInbox,
  IconLayoutKanban,
  IconSearch,
  IconSettings,
} from "@tabler/icons-react";
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import { safeAvatarUrl } from "../common/avatar.js";
import { BrandMark } from "../common/brand.js";
import { UserPopover, type UserPopoverThemeMode } from "./user-popover.js";

export type WorkbenchNavId = "chat" | "inbox" | "board" | "knowledge" | "admin";

export type AppRailProps = {
  readonly activeNav: WorkbenchNavId;
  readonly onSelectNav: (nav: WorkbenchNavId) => void;
  readonly inboxCount?: number;
  readonly localAttentionCount?: number;
  readonly hasChatUpdates?: boolean;
  readonly accountName: string;
  readonly accountPhoto?: string | null;
  readonly accountRole?: string | null;
  readonly online: boolean;
  readonly hasTeam: boolean;
  readonly themeMode: UserPopoverThemeMode;
  readonly onSetThemeMode: (mode: UserPopoverThemeMode) => void;
  readonly onOpenCommandPalette: () => void;
  readonly onSignOut?: () => void;
};

export function AppRail({
  activeNav,
  onSelectNav,
  inboxCount = 0,
  localAttentionCount = 0,
  hasChatUpdates = false,
  accountName,
  accountPhoto,
  accountRole,
  online,
  hasTeam,
  themeMode,
  onSetThemeMode,
  onOpenCommandPalette,
  onSignOut,
}: AppRailProps): ReactElement {
  const [popOpen, setPopOpen] = useState(false);
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const avatarBtnRef = useRef<HTMLButtonElement>(null);

  const candidate = safeAvatarUrl(accountPhoto);
  const avatarSrc = candidate && brokenUrl !== candidate ? candidate : null;
  const initial = (accountName || "?").slice(0, 1);

  const navItems: ReadonlyArray<{
    id: Exclude<WorkbenchNavId, "admin">;
    label: string;
    Icon: typeof IconHome;
    badge?: number;
    dot?: "accent" | "warn";
  }> = [
    {
      id: "chat",
      label: "工作台（个人 & 团队会话）",
      Icon: IconHome,
      ...(hasChatUpdates && activeNav !== "chat" ? { dot: "accent" as const } : {}),
    },
    {
      id: "inbox",
      label: "Inbox · 全局待办收件箱",
      Icon: IconInbox,
      ...(inboxCount > 0
        ? { badge: inboxCount }
        : localAttentionCount > 0 && activeNav !== "inbox"
          ? { dot: "warn" as const }
          : {}),
    },
    {
      id: "board",
      label: "项目看板与任务",
      Icon: IconLayoutKanban,
    },
    {
      id: "knowledge",
      label: "团队知识库",
      Icon: IconBook2,
    },
  ];

  const handleSelectNav = (nav: WorkbenchNavId) => {
    setPopOpen(false);
    onSelectNav(nav);
  };

  return (
    <aside className="lf-rail" aria-label="全局业务导航">
      <div className="lf-rail-macos-spacer" aria-hidden="true" />
      <div className="lf-brand-mark" title="Harness Code 协作工作台">
        <BrandMark />
      </div>

      <nav className="rail-nav" aria-label="主导航">
        {navItems.map(({ id, label, Icon, badge, dot }) => {
          const active = activeNav === id;
          return (
            <button
              key={id}
              type="button"
              className={`rail-btn${active ? " is-active" : ""}`}
              title={label}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              onClick={() => handleSelectNav(id)}
            >
              <Icon size={18} aria-hidden="true" />
              {badge !== undefined && badge > 0 ? (
                <span className="rail-badge" aria-label={`${badge} 项待处理`}>
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : dot ? (
                <span
                  className={`rail-dot${dot === "warn" ? " is-warn" : ""}`}
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="rail-spacer" />
      <div className="rail-sep" role="separator" />

      <button
        type="button"
        className="rail-btn"
        title="全局命令面板 (⌘K)"
        aria-label="全局命令面板"
        onClick={() => {
          setPopOpen(false);
          onOpenCommandPalette();
        }}
      >
        <IconSearch size={17} aria-hidden="true" />
      </button>

      <button
        type="button"
        className={`rail-btn${activeNav === "admin" ? " is-active" : ""}`}
        title="管理与设置"
        aria-label="管理与设置"
        aria-current={activeNav === "admin" ? "page" : undefined}
        onClick={() => handleSelectNav("admin")}
      >
        <IconSettings size={18} aria-hidden="true" />
      </button>

      <button
        ref={avatarBtnRef}
        type="button"
        className="rail-avatar-btn"
        title={`${accountName} · 外观与账号`}
        aria-label="个人账号与外观设置"
        aria-haspopup="dialog"
        aria-expanded={popOpen}
        onClick={() => setPopOpen(prev => !prev)}
      >
        {avatarSrc ? (
          <img
            className="av"
            src={avatarSrc}
            alt={accountName}
            style={{ ["--av" as string]: "30px" }}
            onError={() => setBrokenUrl(candidate)}
          />
        ) : (
          <span className="av-fallback" data-self="true" style={{ ["--av" as string]: "30px" }}>
            {initial}
          </span>
        )}
        <span
          className={`av-role-dot${!online || !hasTeam ? " solo" : ""}`}
          aria-hidden="true"
        />
      </button>

      <UserPopover
        open={popOpen}
        anchorEl={avatarBtnRef.current}
        accountName={accountName}
        accountPhoto={accountPhoto}
        accountRole={accountRole}
        online={online}
        hasTeam={hasTeam}
        themeMode={themeMode}
        onSetThemeMode={onSetThemeMode}
        onOpenAdmin={() => handleSelectNav("admin")}
        onSignOut={onSignOut}
        onClose={() => setPopOpen(false)}
      />
    </aside>
  );
}
