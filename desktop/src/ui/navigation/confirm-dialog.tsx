/**
 * 通用确认弹窗（对齐 `RenameSessionDialog` 的 Portal/聚焦/Esc/提交中禁用/错误展示交互）：
 * 供个人会话归档、删除等需二次确认的操作复用，支持红色危险主按钮与「必须勾选确认」复选框。
 */
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

export type ConfirmDialogProps = {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly requireAckLabel?: string;
  readonly onClose: () => void;
  readonly onSubmit: () => Promise<string | null>;
};

/** 居中确认模态弹窗（回车/按钮提交、Esc 取消、提交中禁用关闭，错误在弹窗内展示）。 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  requireAckLabel,
  onClose,
  onSubmit,
}: ConfirmDialogProps): ReactElement {
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.requestAnimationFrame(() => {
      confirmRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(timer);
      returnTo?.focus();
    };
  }, []);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const failure = await onSubmit().catch(() => "操作失败，请重试。");
    setBusy(false);
    if (failure) {
      setError(failure);
      confirmRef.current?.focus();
    } else {
      onClose();
    }
  }

  const dialog = (
    <div
      className="pnav-rename-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && !busy) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        className="pnav-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pnavConfirmTitle"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="pnav-rename-head">
          <h2 id="pnavConfirmTitle">{title}</h2>
          <button
            type="button"
            className="pnav-icon-button"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="pnav-rename-body">
          <div className="pnav-confirm-text">{body}</div>
          {requireAckLabel && (
            <label className="pnav-confirm-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={busy}
                onChange={(event) => {
                  setAcknowledged(event.target.checked);
                  if (error) setError("");
                }}
              />
              <span>{requireAckLabel}</span>
            </label>
          )}
          {error && <p className="pnav-rename-error" role="alert">{error}</p>}
        </div>

        <div className="pnav-rename-foot">
          <button
            type="button"
            className="wb-button wb-button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            ref={confirmRef}
            className={danger ? "wb-button wb-button-danger" : "wb-button wb-button-primary"}
            disabled={busy || (Boolean(requireAckLabel) && !acknowledged)}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
