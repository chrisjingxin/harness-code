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
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
}
