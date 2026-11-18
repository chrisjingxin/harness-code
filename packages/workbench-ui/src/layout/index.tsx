/** 工作台外壳：通顶左侧栏 + 右侧(顶栏 + 舞台/右栏)，仅管理空间、响应折叠与浮层。 */
import { Moon, PanelLeft, PanelLeftClose, PanelRight, Sun, X } from "lucide-react";
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
  /** 可选副标题覆写；用于完整展示原型稿 .tb-path 格式。 */
  subtitle?: string;
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
  /** 自定义单行顶栏标题区渲染器；传入左栏当前是否收起（含窄屏自动收起），返回 null/undefined 或未提供时回退到 context 单行展示。 */
  renderHeaderTitle?: (state: { leftCollapsed: boolean }) => ReactNode;
  /** 顶栏返回按钮（如查看队友跨机只读会话时“← 返回我的会话”）。 */
  backButton?: ReactNode;
  /** 顶栏右侧协作成员区（如头像叠放触发器 + 数量）。 */
  headerExtra?: ReactNode;
  /** 顶栏一键切换浅/深色回调及当前实际主题。 */
  onToggleTheme?: () => void;
  colorScheme?: "light" | "dark";
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
  /** 与工作台外壳同级的全局浮层（协作成员浮层、命令面板、弹窗、Toast）。 */
  overlays?: ReactNode;
};

const LEFT_MIN = 220,
  LEFT_MAX = 380,
  RIGHT_MIN = 260,
  RIGHT_MAX = 560,
  CENTER_MIN = 380;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** 通顶左栏工作台布局；面板保持挂载，自动收合不修改宿主开合偏好。 */
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
  const [leftDragging, setLeftDragging] = useState(false);
  const leftWidth = clamp(props.leftWidthPx || 256, LEFT_MIN, LEFT_MAX);
  const rightWidth = clamp(props.rightWidthPx || 300, RIGHT_MIN, RIGHT_MAX);
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
      setLeftDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
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

  const subtitle = props.context?.subtitle ?? (
    props.context
      ? [
          props.context.projectName,
          props.context.deviceName,
          props.context.connection,
          props.context.handoff,
        ]
          .filter(Boolean)
          .join(" · ")
      : ""
  );

  const isMac = props.titleBarClassName?.includes("macos") ?? false;
  const isWin = props.titleBarClassName?.includes("windows") ?? false;
  const leftCollapsed = leftMode === "hidden";
  const customHeaderTitle = props.renderHeaderTitle?.({ leftCollapsed });

  return (
    <div
      className={[
        "collaboration-layout",
        isMac ? "is-macos" : "",
        isWin ? "is-windows" : "",
      ].filter(Boolean).join(" ")}
      data-left-mode={leftMode}
      data-right-mode={visibleRightMode}
      ref={root}
      onKeyDown={keyDown}
    >
      {/* 左侧边栏：通顶布局，直接触达顶部与底部 */}
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
        aria-label="工作台导航"
        aria-hidden={leftMode === "hidden" || undefined}
        inert={leftMode === "hidden"}
      >
        <div className="collaboration-traffic-drag" aria-hidden="true" />
        {props.navigation}
        {leftMode === "docked" && (
          <div
            className="collaboration-left-resize"
            data-dragging={leftDragging ? "true" : undefined}
            role="separator"
            aria-label="调整导航宽度"
            aria-orientation="vertical"
            onPointerDown={(event: ReactPointerEvent) => {
              event.preventDefault();
              drag.current = { x: event.clientX, width: leftWidth };
              setLeftDragging(true);
            }}
          />
        )}
      </aside>

      {/* 右侧主容器：顶栏 + 舞台/右栏 */}
      <div className="collaboration-main">
        <header
          className={
            props.titleBarClassName
              ? `collaboration-header ${props.titleBarClassName}`
              : "collaboration-header"
          }
        >
          {props.backButton}
          <div className="collaboration-header-context tb-title">
            {customHeaderTitle !== null && customHeaderTitle !== undefined ? (
              customHeaderTitle
            ) : (
              <>
                {leftCollapsed && props.context?.projectName ? (
                  <span className="tb-crumb">
                    <span className="tb-crumb-name">{props.context.projectName}</span>
                    <span className="tb-crumb-sep" aria-hidden="true">/</span>
                  </span>
                ) : null}
                <strong className="tb-name" title={props.context?.title ?? "请选择会话"}>
                  {props.context?.title ?? "请选择会话"}
                </strong>
                {subtitle ? <span className="tb-count">{subtitle}</span> : null}
              </>
            )}
          </div>
          {props.headerExtra ? (
            <div className="collaboration-header-collab">{props.headerExtra}</div>
          ) : null}
          <div className="collaboration-header-right">
            {props.onToggleTheme && (
              <button
                type="button"
                className="collaboration-header-icon"
                onClick={props.onToggleTheme}
                aria-label="切换浅色/深色"
                title="切换浅色/深色"
              >
                {props.colorScheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            )}
            <button
              ref={rightButton}
              type="button"
              className="collaboration-header-icon"
              data-active={visibleRightMode !== "hidden" ? "true" : "false"}
              onClick={() => toggle("right")}
              disabled={!hasRight}
              tabIndex={hasRight ? undefined : -1}
              aria-hidden={!hasRight || undefined}
              title={
                !hasRight
                  ? "当前页面无本机文件栏"
                  : visibleRightMode !== "hidden"
                    ? "收起本机文件栏"
                    : "展开本机文件栏"
              }
              aria-label="切换项目面板"
              aria-expanded={visibleRightMode !== "hidden"}
            >
              <PanelRight size={16} />
            </button>
          </div>
        </header>

        <div className="collaboration-body">
          <main className="collaboration-center" tabIndex={-1}>
            {props.center}
          </main>
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
      </div>

      {/* 左栏折叠/展开按钮固定于左上角红绿灯旁；DOM 必须位于含 -webkit-app-region: drag 的左侧栏与顶栏之后，否则 Electron 会按 DOM 顺序将按钮区域覆盖为拖动区导致点击失效 */}
      <button
        ref={leftButton}
        type="button"
        className="collaboration-header-toggle"
        data-active={leftMode === "overlay" ? "true" : "false"}
        onClick={() => toggle("left")}
        aria-label="切换导航"
        aria-expanded={leftMode !== "hidden"}
        title={leftMode !== "hidden" ? "收起左栏 (⌘\\)" : "展开左栏 (⌘\\)"}
      >
        {leftMode !== "hidden" ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
      </button>

      {props.overlays}

      {props.settingsOpen && (
        <div
          className="collaboration-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) props.closeSettings();
          }}
        >
          <div
            ref={dialog}
            className="collaboration-modal"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
            tabIndex={-1}
          >
            <button
              type="button"
              className="collaboration-modal-close"
              onClick={props.closeSettings}
              aria-label="关闭设置"
            >
              <X size={16} />
            </button>
            <div className="collaboration-modal-scroll">{props.settings}</div>
          </div>
        </div>
      )}
    </div>
  );
}
