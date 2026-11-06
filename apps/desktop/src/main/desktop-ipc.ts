/**
 * 原生桌面请求边界。preload → 来源与参数校验 → 原生操作 → 实际状态。
 * 目录路径只返回当前窗口显示，不登记项目，也不授予后续文件访问权限。
 */
import { dialog, ipcMain, nativeTheme } from "electron"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import type { ThemeMode, WindowState } from "@workbench/contracts"

/** 绑定可信主窗口；窗口销毁时移除 IPC 和系统主题监听，允许 macOS 重开。 */
export function bindDesktopIpc(window: BrowserWindow, trustedUrl: string): void {
  let themeMode: ThemeMode = "system"
  let zoomPercent = 100
  let choosing = false
  const channels: string[] = []
  const readState = (): WindowState => ({ themeMode, colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light", zoomPercent: Math.round(window.webContents.getZoomFactor() * 100) })
  function publish() {
    if (window.isDestroyed()) return
    const dark = nativeTheme.shouldUseDarkColors
    window.setBackgroundColor(dark ? "#191f1d" : "#f5f5f1")
    if (process.platform === "win32") window.setTitleBarOverlay({ color: dark ? "#191f1d" : "#f5f5f1", symbolColor: dark ? "#e7ede7" : "#242b28" })
    window.webContents.send("workbench:window-state", readState())
  }
  function verify(event: IpcMainInvokeEvent) {
    // 不只核对 URL：子 frame 和其他窗口即使地址相同，也不能操作本窗口。
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedUrl) throw new Error("不允许的桌面请求来源")
  }
  function handle(channel: string, count: number, action: (...args: unknown[]) => unknown) {
    channels.push(channel)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      verify(event)
      if (args.length !== count) throw new Error("桌面请求参数无效")
      return action(...args)
    })
  }
  handle("workbench:get-window-state", 0, readState)
  handle("workbench:choose-directory", 0, async () => {
    if (choosing) throw new Error("目录选择器已打开")
    choosing = true
    try {
      const result = await dialog.showOpenDialog(window, { title: "选择工作目录", buttonLabel: "选择目录", properties: ["openDirectory"] })
      return result.canceled ? null : result.filePaths[0] ?? null
    } finally { choosing = false }
  })
  handle("workbench:set-theme-mode", 1, value => {
    if (value !== "system" && value !== "light" && value !== "dark") throw new Error("主题参数无效")
    themeMode = value
    nativeTheme.themeSource = themeMode
    publish()
    return readState()
  })
  handle("workbench:adjust-zoom", 1, value => {
    if (value !== "in" && value !== "out" && value !== "reset") throw new Error("缩放参数无效")
    zoomPercent = value === "reset" ? 100 : Math.min(150, Math.max(80, zoomPercent + (value === "in" ? 10 : -10)))
    window.webContents.setZoomFactor(zoomPercent / 100)
    publish()
    return readState()
  })
  nativeTheme.themeSource = "system"
  nativeTheme.on("updated", publish)
  window.webContents.on("did-finish-load", () => {
    window.webContents.setZoomFactor(zoomPercent / 100)
    void window.webContents.setVisualZoomLevelLimits(1, 1)
    publish()
  })
  window.once("closed", () => {
    nativeTheme.removeListener("updated", publish)
    for (const channel of channels) ipcMain.removeHandler(channel)
  })
}
