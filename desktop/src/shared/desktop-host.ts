/**
 * 【功能定义】桌面原生窗口与系统动作端口契约（主题、缩放、目录选择器、剪贴板与外部链接）。
 * 【协作边界】纯 TypeScript 接口定义，零 Node/Electron 运行时依赖；供 Preload、Main 与 Renderer/UI 共用。
 */
export type ThemeMode = "system" | "light" | "dark"
export type ZoomAction = "in" | "out" | "reset"

/** 当前窗口状态；仅在本次应用运行期间有效，不包含原生句柄或文件权限。 */
export interface WindowState {
  themeMode: ThemeMode
  colorScheme: "light" | "dark"
  zoomPercent: number
}

/** `workbench://` 白名单只读跳转目标；首期仅放行收件箱首页与指定任务详情。 */
export type WorkbenchDeepLinkTarget =
  | { readonly kind: "inbox" }
  | {
      readonly kind: "task"
      readonly workspaceId: string
      readonly projectId: string
      readonly taskId: string
    }

/** 主进程校验后的深链接投递载荷；畸形/未声明路径在主进程拦截并返回安全错误。 */
export type WorkbenchDeepLinkEvent =
  | { readonly ok: true; readonly target: WorkbenchDeepLinkTarget }
  | { readonly ok: false; readonly message: string }

/** 窄原生接口；请求失败时拒绝 Promise，UI 显示错误，订阅销毁时必须解绑。 */
export interface DesktopHost {
  /** 单选目录；取消返回 null，路径仅用于显示，不构成后续文件授权。 */
  chooseDirectory(): Promise<string | null>
  /** 多选本机文件作为上下文附件；取消返回空数组。 */
  chooseFiles(): Promise<readonly string[]>
  /** 多选本机目录作为上下文附件（不切换工作目录）；取消返回空数组。 */
  chooseContextDirectories(): Promise<readonly string[]>
  getWindowState(): Promise<WindowState>
  setThemeMode(mode: ThemeMode): Promise<WindowState>
  /** 按动作调整实际窗口缩放，主进程限制 80%～150%。 */
  adjustZoom(action: ZoomAction): Promise<WindowState>
  /** 将用户选择的文本写入系统剪贴板；失败时拒绝。 */
  copyText(text: string): Promise<void>
  /** 用户主动打开 http、https 或 mailto 地址；无效地址和系统失败均拒绝。 */
  openExternal(href: string): Promise<void>
  onWindowStateChanged(listener: (state: WindowState) => void): () => void
  /** 读取并消费冷启动或未登录期间挂起的只读 Deep-Link。 */
  consumePendingDeepLink?(): Promise<WorkbenchDeepLinkEvent | null>
  /** 监听主窗口运行期收到的热启动 Deep-Link 路由。 */
  onDeepLink?(listener: (event: WorkbenchDeepLinkEvent) => void): () => void
}
