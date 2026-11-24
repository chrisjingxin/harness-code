/**
 * 左下角个人头像 Popover：
 * 承接账号状态展示、浅/深色主题快速切换、直达管理与设置台以及退出登录，
 * 避免高频外观操作每次都切离当前会话。
 */
import { IconCheck, IconDeviceDesktop, IconLogout, IconMoon, IconSettings, IconSun } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { safeAvatarUrl } from "../common/avatar.js";

export type UserPopoverThemeMode = "system" | "light" | "dark";

export type UserPopoverProps = {
  readonly open: boolean;
  readonly anchorEl: HTMLElement | null;
  readonly accountName: string;
  readonly accountPhoto?: string | null;
  readonly accountRole?: string | null;
  readonly online: boolean;
  readonly hasTeam: boolean;
  readonly themeMode: UserPopoverThemeMode;
  readonly onSetThemeMode: (mode: UserPopoverThemeMode) => void;
  readonly onOpenAdmin: () => void;
  readonly onSignOut?: () => void;
  readonly onClose: () => void;
};

export function UserPopover({
  open,
  anchorEl,
  accountName,
  accountPhoto,
  accountRole,
  online,
  hasTeam,
  themeMode,
  onSetThemeMode,
  onOpenAdmin,
  onSignOut,
  onClose,
}: UserPopoverProps): ReactElement | null {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 66, bottom: 12 });
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const syncPos = () => {
      const rect = anchorEl.getBoundingClientRect();
      setPos({
        left: Math.round(rect.right + 10),
        bottom: Math.round(Math.max(12, window.innerHeight - rect.bottom)),
      });
    };
    syncPos();
    window.addEventListener("resize", syncPos);
    return () => window.removeEventListener("resize", syncPos);
  }, [open, anchorEl]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popRef.current?.contains(target) || anchorEl?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        anchorEl?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchorEl, onClose]);

  if (!open) return null;

  const candidate = safeAvatarUrl(accountPhoto);
  const src = candidate && brokenUrl !== candidate ? candidate : null;
  const initial = (accountName || "?").slice(0, 1);
  const statusText = !online
    ? "离线快照 · 个人会话可用"
    : !hasTeam
      ? "未加入团队 · 仅本机"
      : accountRole || "已连接协作服务";

  const themes: ReadonlyArray<{ id: UserPopoverThemeMode; label: string; Icon: typeof IconSun }> = [
    { id: "system", label: "系统", Icon: IconDeviceDesktop },
    { id: "light", label: "浅色", Icon: IconSun },
    { id: "dark", label: "深色", Icon: IconMoon },
  ];

  return (
    <div
      ref={popRef}
      className="user-popover"
      role="dialog"
      aria-label="账号与外观设置"
      style={{ left: pos.left, bottom: pos.bottom }}
    >
      <div className="user-pop-head">
        <span className="lf-av-wrap">
          {src ? (
            <img
              className="av"
              src={src}
              alt={accountName}
              style={{ ["--av" as string]: "34px" }}
              onError={() => setBrokenUrl(candidate)}
            />
          ) : (
            <span className="av-fallback" data-self="true" style={{ ["--av" as string]: "34px" }}>
              {initial}
            </span>
          )}
        </span>
        <div className="user-pop-identity">
          <strong>{accountName}</strong>
          <span className="meta">{statusText}</span>
        </div>
      </div>

      <div className="user-pop-section">
        <span className="meta">外观主题</span>
        <div className="seg user-pop-theme-seg" role="radiogroup" aria-label="外观主题">
          {themes.map(({ id, label, Icon }) => {
            const active = themeMode === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                className={active ? "is-active" : undefined}
                onClick={() => onSetThemeMode(id)}
              >
                <Icon size={12} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="user-pop-section user-pop-actions">
        <button
          type="button"
          className="user-pop-item"
          onClick={() => {
            onClose();
            onOpenAdmin();
          }}
        >
          <IconSettings size={15} aria-hidden="true" />
          <span>管理与设置</span>
          <IconCheck size={13} className="user-pop-arrow" style={{ opacity: 0 }} aria-hidden="true" />
        </button>
        {onSignOut && (
          <button
            type="button"
            className="user-pop-item is-danger"
            onClick={() => {
              onClose();
              onSignOut();
            }}
          >
            <IconLogout size={15} aria-hidden="true" />
            <span>退出登录</span>
          </button>
        )}
      </div>
    </div>
  );
}
