/**
 * 会话右键上下文菜单与重命名弹窗（仿照 Codex 桌面菜单交互与视觉）：
 * 1. `SessionContextMenu`：通过 Portal 渲染悬浮上下文菜单，自动贴边防溢出，支持蓝色高亮态、分组分割线与键盘上下导航；
 * 2. `RenameSessionDialog`：通过 Portal 渲染居中重命名弹窗，打开自动聚焦全选、回车提交、Esc 取消并展示保存校验错误。
 */
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

export type SessionContextMenuItem = {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly separatorBefore?: boolean;
  readonly danger?: boolean;
  readonly onSelect: () => void;
};

export type SessionContextMenuProps = {
  readonly x: number;
  readonly y: number;
  readonly ariaLabel?: string;
  readonly items: readonly SessionContextMenuItem[];
  readonly onClose: () => void;
};

const MENU_MARGIN = 8;

/** Codex 风格悬浮右键菜单（Portal 到 body 避免被侧栏滚动容器裁剪）。 */
export function SessionContextMenu({
  x,
  y,
  ariaLabel = "会话操作",
  items,
  onClose,
}: SessionContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN);
    const maxTop = Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN);
    setPos({
      left: Math.min(Math.max(MENU_MARGIN, x), maxLeft),
      top: Math.min(Math.max(MENU_MARGIN, y), maxTop),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const el = menuRef.current;
    const firstEnabled = el?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    firstEnabled?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (buttons.length === 0) return;
        event.preventDefault();
        const activeIdx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        let nextIdx = 0;
        if (event.key === "ArrowDown") {
          nextIdx = activeIdx >= 0 ? (activeIdx + 1) % buttons.length : 0;
        } else if (event.key === "ArrowUp") {
          nextIdx = activeIdx >= 0 ? (activeIdx - 1 + buttons.length) % buttons.length : buttons.length - 1;
        } else if (event.key === "End") {
          nextIdx = buttons.length - 1;
        }
        buttons[nextIdx]?.focus();
      }
    };
    const dismiss = () => onClose();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [onClose]);

  const menu = (
    <div
      ref={menuRef}
      className="pnav-ctx-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      onContextMenu={(event) => { event.preventDefault(); }}
    >
      {items.map((item) => (
        <div key={item.id} className="pnav-ctx-entry">
          {item.separatorBefore && <div className="pnav-ctx-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`pnav-ctx-item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            {item.icon && <span className="pnav-ctx-icon" aria-hidden="true">{item.icon}</span>}
            <span className="pnav-ctx-label">{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );

  return typeof document !== "undefined" ? createPortal(menu, document.body) : menu;
}

export type RenameSessionDialogProps = {
  readonly initialTitle: string;
  readonly onClose: () => void;
  readonly onSubmit: (title: string) => Promise<string | null>;
};

/** 居中会话重命名模态弹窗（回车保存、Esc 取消、保存中禁用关闭）。 */
export function RenameSessionDialog({
  initialTitle,
  onClose,
  onSubmit,
}: RenameSessionDialogProps): ReactElement {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(timer);
      returnTo?.focus();
    };
  }, []);

  async function save() {
    if (saving) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError("请输入 1～80 个字符的会话名称。");
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setError("");
    const failure = await onSubmit(trimmed).catch(() => "会话名称保存失败，请重试。");
    setSaving(false);
    if (failure) {
      setError(failure);
      inputRef.current?.focus();
    } else {
      onClose();
    }
  }

  const dialog = (
    <div
      className="pnav-rename-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && !saving) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        className="pnav-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pnavRenameTitle"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="pnav-rename-head">
          <h2 id="pnavRenameTitle">重命名会话</h2>
          <button
            type="button"
            className="pnav-icon-button"
            aria-label="关闭"
            disabled={saving}
            onClick={onClose}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="pnav-rename-body">
          <label htmlFor="pnavRenameInput">会话名称</label>
          <input
            id="pnavRenameInput"
            ref={inputRef}
            type="text"
            maxLength={80}
            value={title}
            readOnly={saving}
            aria-invalid={Boolean(error)}
            placeholder="输入新的会话名称"
            onChange={(event) => {
              setTitle(event.target.value);
              if (error) setError("");
            }}
          />
          {error && <p className="pnav-rename-error" role="alert">{error}</p>}
        </div>

        <div className="pnav-rename-foot">
          <button
            type="button"
            className="wb-button wb-button-secondary"
            disabled={saving}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="wb-button wb-button-primary"
            disabled={saving}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
