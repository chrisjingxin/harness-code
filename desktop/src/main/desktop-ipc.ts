/**
 * 原生桌面请求边界。preload → 来源与参数校验 → 原生操作 → 实际状态。
 * 目录路径只返回当前窗口显示，不登记项目，也不授予后续文件访问权限。
 */
import { clipboard, dialog, nativeTheme, shell } from "electron"
import type { BrowserWindow } from "electron"
import type { ThemeMode, WindowState } from "../shared/index.js"
import { nativeTheme as workbenchNativeTheme } from "../shared/native-theme.js"
import { createStrictIpcRegistrar, isNonEmptyString } from "./ipc-guard.js"
import type { DeepLinkBroker } from "./deep-link.js"

export type DesktopSelectionCapture = {
  readonly captureDirectorySelection?: () => (path: string) => Promise<void>
  readonly captureAttachmentSelections?: (kind: "file" | "directory") => (paths: readonly string[]) => Promise<readonly string[]>
}

/** 绑定可信主窗口；窗口销毁时移除 IPC 和系统主题监听，允许 macOS 重开。 */
export function bindDesktopIpc(
  window: BrowserWindow,
  trustedUrl: string,
  selectionCapture?: DesktopSelectionCapture,
  deepLinkBroker?: DeepLinkBroker,
): void {
  const contents = window.webContents
  let themeMode: ThemeMode = "system"
  let zoomPercent = 100
  let choosing = false
  const ipc = createStrictIpcRegistrar({ window, trustedUrl })
  const readState = (): WindowState => ({ themeMode, colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light", zoomPercent: Math.round(window.webContents.getZoomFactor() * 100) })
  function publish() {
    if (window.isDestroyed()) return
    const colors = workbenchNativeTheme[nativeTheme.shouldUseDarkColors ? "dark" : "light"]
    window.setBackgroundColor(colors.background)
    if (process.platform === "win32") window.setTitleBarOverlay({ color: colors.background, symbolColor: colors.text })
    window.webContents.send("workbench:window-state", readState())
  }
  ipc.handle("workbench:get-window-state", 0, readState)
  ipc.handle("workbench:choose-directory", 0, async () => {
    if (choosing) throw new Error("目录选择器已打开")
    choosing = true
    const recordSelection = selectionCapture?.captureDirectorySelection?.()
    try {
      const result = await dialog.showOpenDialog(window, { title: "选择工作目录", buttonLabel: "选择目录", properties: ["openDirectory"] })
      const path = result.canceled ? null : result.filePaths[0] ?? null
      if (path) await recordSelection?.(path)
      return path
    } finally { choosing = false }
  })
  ipc.handle("workbench:choose-files", 0, async () => {
    if (choosing) throw new Error("选择器已打开")
    choosing = true
    const recordSelection = selectionCapture?.captureAttachmentSelections?.("file")
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "选择本机文件",
        buttonLabel: "添加文件",
        properties: ["openFile", "multiSelections"],
      })
      if (result.canceled || result.filePaths.length === 0) return []
      return recordSelection ? await recordSelection(result.filePaths) : result.filePaths
    } finally { choosing = false }
  })
  ipc.handle("workbench:choose-context-directories", 0, async () => {
    if (choosing) throw new Error("选择器已打开")
    choosing = true
    const recordSelection = selectionCapture?.captureAttachmentSelections?.("directory")
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "选择本机目录",
        buttonLabel: "添加目录",
        properties: ["openDirectory", "multiSelections"],
      })
      if (result.canceled || result.filePaths.length === 0) return []
      return recordSelection
        ? await recordSelection(result.filePaths)
        : result.filePaths.map(item => (item.endsWith("/") || item.endsWith("\\") ? item : `${item}/`))
    } finally { choosing = false }
  })
  ipc.handle("workbench:set-theme-mode", 1, value => {
    if (value !== "system" && value !== "light" && value !== "dark") throw new Error("主题参数无效")
    themeMode = value
    nativeTheme.themeSource = themeMode
    publish()
    return readState()
  })
  ipc.handle("workbench:adjust-zoom", 1, value => {
    if (value !== "in" && value !== "out" && value !== "reset") throw new Error("缩放参数无效")
    zoomPercent = value === "reset" ? 100 : Math.min(150, Math.max(80, zoomPercent + (value === "in" ? 10 : -10)))
    window.webContents.setZoomFactor(zoomPercent / 100)
    publish()
    return readState()
  })
  ipc.handle("workbench:copy-text", 1, value => {
    if (typeof value !== "string") throw new Error("复制内容无效")
    clipboard.writeText(value)
  })
  ipc.handle("workbench:open-external", 1, async value => {
    if (!isNonEmptyString(value, 8192)) throw new Error("链接无效")
    let url: URL
    try { url = new URL(value.trim()) } catch { throw new Error("链接无效") }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") throw new Error("链接协议不受支持")
    await shell.openExternal(url.href)
  })
  ipc.handle("workbench:consume-deep-link", 0, () => deepLinkBroker?.consumePending() ?? null)
  deepLinkBroker?.attachDeliver(event => {
    if (window.isDestroyed() || contents.isDestroyed() || contents.mainFrame.url !== trustedUrl) return false
    try {
      contents.send("workbench:deep-link", event)
      return true
    } catch {
      return false
    }
  })
  const resetDeepLinkReady = (details: Electron.WebContentsDidStartNavigationEventParams) => {
    if (details.isMainFrame && !details.isSameDocument) deepLinkBroker?.markRendererNotReady()
  }
  const onRendererGone = () => deepLinkBroker?.markRendererNotReady()
  contents.on("did-start-navigation", resetDeepLinkReady)
  contents.on("render-process-gone", onRendererGone)
  nativeTheme.on("updated", publish)
  window.webContents.on("did-finish-load", () => {
    window.webContents.setZoomFactor(zoomPercent / 100)
    void window.webContents.setVisualZoomLevelLimits(1, 1)
    publish()
  })
  window.once("closed", () => {
    nativeTheme.removeListener("updated", publish)
    deepLinkBroker?.detachDeliver()
    if (!contents.isDestroyed()) {
      contents.removeListener("did-start-navigation", resetDeepLinkReady)
      contents.removeListener("render-process-gone", onRendererGone)
    }
    ipc.dispose()
  })
}
