/** 三栏仅管理空间和临时覆盖；业务选择、个人草稿及右侧偏好由宿主持有。 */
import { PanelLeft, PanelRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ReactElement,
  ReactNode,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export type CollaborationContextView = {
  title: string;
  deviceName?: string;
  projectName?: string;
  connection?: string;
  handoff?: string;
};
export type WorkbenchPanelMode = "docked" | "overlay" | "hidden";
/** 右侧插槽将 open/widthPx 投影到 ProjectPersonalView；动作接回同一个宿主状态。 */
export type WorkbenchRightSlot = {
  mode: WorkbenchPanelMode;
  open: boolean;
  widthPx: number;
  setOpen(open: boolean): void;
  setWidth(widthPx: number): void;
};
export type WorkbenchLayoutProps = {
  /** 正式窗口按平台给原生按钮和拖动区留空间。 */
  titleBarClassName?: string;
  context: CollaborationContextView | null;
  navigation: ReactNode;
  center: ReactNode;
  right: (slot: WorkbenchRightSlot) => ReactNode;
  leftOpen: boolean;
  leftWidthPx: number;
  rightOpen: boolean;
  rightWidthPx: number;
  setPanelOpen(side: "left" | "right", open: boolean): void;
  setPanelWidth(side: "left" | "right", widthPx: number): void;
  settingsOpen: boolean;
  settings: ReactNode;
  closeSettings(): void;
};
const LEFT_MIN = 220,
  LEFT_MAX = 400,
  RIGHT_MIN = 330,
  RIGHT_MAX = 760,
  CENTER_MIN = 400;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
/** 面板保持挂载；自动收合只改变显示，不修改宿主的手动开合偏好。 */
export function WorkbenchLayout(props: WorkbenchLayoutProps): ReactElement {
  const root = useRef<HTMLDivElement>(null),
    left = useRef<HTMLElement>(null),
    right = useRef<HTMLDivElement>(null);
  const leftButton = useRef<HTMLButtonElement>(null),
    rightButton = useRef<HTMLButtonElement>(null),
    dialog = useRef<HTMLDivElement>(null);
  const settingsReturn = useRef<HTMLElement | null>(null),
    drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(1400),
    [overlay, setOverlay] = useState<"left" | "right" | null>(null);
  const [overlayRightWidth, setOverlayRightWidth] = useState<number | null>(
    null,
  );
  const leftWidth = clamp(props.leftWidthPx || 280, LEFT_MIN, LEFT_MAX);
  const rightWidth = clamp(props.rightWidthPx || 340, RIGHT_MIN, RIGHT_MAX);
  const leftFits = width >= leftWidth + CENTER_MIN;
  const rightFits =
    width >= (props.leftOpen ? leftWidth : 0) + CENTER_MIN + rightWidth;
  const leftMode: WorkbenchPanelMode =
    leftFits && props.leftOpen
      ? "docked"
      : !leftFits && overlay === "left"
        ? "overlay"
        : "hidden";
  const rightMode: WorkbenchPanelMode =
    rightFits && props.rightOpen
      ? "docked"
      : !rightFits && overlay === "right"
        ? "overlay"
        : "hidden";
  const effectiveRight =
    rightMode === "overlay"
      ? Math.min(overlayRightWidth ?? rightWidth, Math.max(0, width - 32))
      : rightWidth;
  const closeRight = (open: boolean) => {
    if (rightMode === "overlay") {
      if (!open) {
        setOverlay(null);
        rightButton.current?.focus();
      }
    } else props.setPanelOpen("right", open);
  };
  const rightContent = props.right({
    mode: rightMode,
    open: rightMode !== "hidden",
    widthPx: effectiveRight,
    setOpen: closeRight,
    setWidth: (value) =>
      rightMode === "overlay"
        ? setOverlayRightWidth(
            clamp(
              value,
              Math.min(RIGHT_MIN, Math.max(0, width - 32)),
              Math.max(0, width - 32),
            ),
          )
        : props.setPanelWidth("right", clamp(value, RIGHT_MIN, RIGHT_MAX)),
  });
  const hasRight =
    rightContent !== null && rightContent !== undefined && rightContent !== false;
  const visibleRightMode: WorkbenchPanelMode = hasRight ? rightMode : "hidden";
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0]?.contentRect.width ?? element.clientWidth),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const previous = useRef({ leftMode, rightMode: visibleRightMode });
  useLayoutEffect(() => {
    if (
      previous.current.leftMode !== "hidden" &&
      leftMode === "hidden" &&
      left.current?.contains(document.activeElement)
    )
      leftButton.current?.focus();
    if (
      previous.current.rightMode !== "hidden" &&
      visibleRightMode === "hidden" &&
      right.current?.contains(document.activeElement)
    )
      rightButton.current?.focus();
    previous.current = { leftMode, rightMode: visibleRightMode };
  }, [leftMode, visibleRightMode]);
  useEffect(() => {
    if (
      (overlay === "left" && leftFits) ||
      (overlay === "right" && (rightFits || !hasRight))
    )
      setOverlay(null);
  }, [overlay, leftFits, rightFits, hasRight]);
  useEffect(() => {
    if (!props.settingsOpen) return;
    settingsReturn.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current
      ?.querySelector<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
    return () => {
      settingsReturn.current?.focus();
    };
  }, [props.settingsOpen]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (drag.current)
        props.setPanelWidth(
          "left",
          clamp(
            drag.current.width + event.clientX - drag.current.x,
            LEFT_MIN,
            LEFT_MAX,
          ),
        );
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [props.setPanelWidth]);
  const toggle = (side: "left" | "right") => {
    if (side === "right" && !hasRight) return;
    const fits = side === "left" ? leftFits : rightFits;
    if (!fits) {
      if (side === "right") setOverlayRightWidth(null);
      setOverlay((previous) => (previous === side ? null : side));
    } else
      props.setPanelOpen(
        side,
        !(side === "left" ? props.leftOpen : props.rightOpen),
      );
  };
  const keyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      if (props.settingsOpen) {
        event.preventDefault();
        props.closeSettings();
      } else if (overlay) {
        event.preventDefault();
        const side = overlay;
        setOverlay(null);
        (side === "left" ? leftButton : rightButton).current?.focus();
      }
    }
    if (event.key === "Tab" && props.settingsOpen && dialog.current) {
      const items = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!items.length) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (
        !event.shiftKey &&
        document.activeElement === items[items.length - 1]
      ) {
        event.preventDefault();
        items[0]?.focus();
      }
    }
  };
  return (
    <div className="collaboration-layout" ref={root} onKeyDown={keyDown}>
      <header className={props.titleBarClassName ? `collaboration-header ${props.titleBarClassName}` : "collaboration-header"}>
        <button
          ref={leftButton}
          onClick={() => toggle("left")}
          aria-label="切换导航"
          aria-expanded={leftMode !== "hidden"}
        >
          <PanelLeft size={18} />
        </button>
        <div className="collaboration-header-context">
          <strong>{props.context?.title ?? "请选择会话"}</strong>
          {props.context && (
            <span>
              {[
                props.context.deviceName,
                props.context.projectName,
                props.context.connection,
                props.context.handoff,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
        <button
          ref={rightButton}
          onClick={() => toggle("right")}
          disabled={!hasRight}
          tabIndex={hasRight ? undefined : -1}
          aria-hidden={!hasRight || undefined}
          style={hasRight ? undefined : { visibility: "hidden" }}
          aria-label="切换项目面板"
          aria-expanded={visibleRightMode !== "hidden"}
        >
          <PanelRight size={18} />
        </button>
      </header>
      <div className="collaboration-body">
        <aside
          ref={left}
          className="collaboration-left"
          data-mode={leftMode}
          style={{
            width:
              leftMode === "hidden"
                ? 0
                : Math.min(leftWidth, Math.max(0, width - 32)),
          }}
          aria-hidden={leftMode === "hidden" || undefined}
          inert={leftMode === "hidden"}
        >
          {props.navigation}
          {leftMode === "docked" && (
            <div
              className="collaboration-left-resize"
              role="separator"
              aria-label="调整导航宽度"
              aria-orientation="vertical"
              onPointerDown={(event: ReactPointerEvent) => {
                event.preventDefault();
                drag.current = { x: event.clientX, width: leftWidth };
              }}
            />
          )}
        </aside>
        <main className="collaboration-center">{props.center}</main>
        <div
          ref={right}
          className="collaboration-right"
          data-mode={visibleRightMode}
          style={{ width: visibleRightMode === "hidden" ? 0 : effectiveRight }}
          aria-hidden={visibleRightMode === "hidden" || undefined}
          inert={visibleRightMode === "hidden"}
        >
          {rightContent}
        </div>
      </div>
      {props.settingsOpen && (
        <div className="collaboration-modal-backdrop">
          <div
            ref={dialog}
            className="collaboration-modal"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
            tabIndex={-1}
          >
            <button
              className="collaboration-modal-close"
              onClick={props.closeSettings}
              aria-label="关闭设置"
            >
              <X size={18} />
            </button>
            {props.settings}
          </div>
        </div>
      )}
    </div>
  );
}
