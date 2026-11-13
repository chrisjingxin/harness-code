/**
 * 桌面原生端口的通用类型。UI 消费接口，preload/main 实现它；不依赖 Electron 或 Agent。
 * 用户动作 → 具名端口 → 主进程校验 → 返回实际窗口状态。
 */
export type ThemeMode = "system" | "light" | "dark"
export type ZoomAction = "in" | "out" | "reset"

/** 当前窗口状态；仅在本次应用运行期间有效，不包含原生句柄或文件权限。 */
export interface WindowState {
  themeMode: ThemeMode
  colorScheme: "light" | "dark"
  zoomPercent: number
}

/** 窄原生接口；请求失败时拒绝 Promise，UI 显示错误，订阅销毁时必须解绑。 */
export interface DesktopHost {
  /** 单选目录；取消返回 null，路径仅用于显示，不构成后续文件授权。 */
  chooseDirectory(): Promise<string | null>
  getWindowState(): Promise<WindowState>
  setThemeMode(mode: ThemeMode): Promise<WindowState>
  /** 按动作调整实际窗口缩放，主进程限制 80%～150%。 */
  adjustZoom(action: ZoomAction): Promise<WindowState>
  /** 将用户选择的文本写入系统剪贴板；失败时拒绝。 */
  copyText(text: string): Promise<void>
  /** 用户主动打开 http、https 或 mailto 地址；无效地址和系统失败均拒绝。 */
  openExternal(href: string): Promise<void>
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
}

export type * from "./identity.js"
export type * from "./conversation.js"
export type * from "./execution.js"
export type * from "./device.js"
export type * from "./organization.js"
export type * from "./session.js"
export * from "./deterministic.js"
export type * from "./project.js"
