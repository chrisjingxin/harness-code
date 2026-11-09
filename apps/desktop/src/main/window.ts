/// <reference types="vite/client" />
/** 原生窗口装配；可信本地页面与隔离 preload 是边界，不借旧 CLI 或 Web 网关启动。 */
import { BrowserWindow, nativeTheme } from "electron"
import { nativeTheme as workbenchNativeTheme } from "@workbench/ui/native-theme"
import { fileURLToPath } from "node:url"
import { bindDesktopIpc } from "./desktop-ipc.js"
import type { RunnerSupervisor } from "./runner-supervisor.js"
import { bindCollaborationIpc } from "./collaboration-ipc.js"

/** 创建基础窗口；开发 URL 必须是实际 electron-vite 本机端口，生产只读取本地页面。 */
export function createWindow(supervisor: RunnerSupervisor): BrowserWindow {
  // 构建时固定开发标志，避免预览或生产进程继承开发环境变量后加载网络页面。
  const developmentUrl = import.meta.env.DEV ? process.env.ELECTRON_RENDERER_URL : undefined
  let trustedUrl = new URL("../renderer/index.html", import.meta.url).href
  if (developmentUrl) {
    const parsed = new URL(developmentUrl)
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("桌面开发地址无效")
    trustedUrl = parsed.href
  }
  // 新窗口从系统外观开始，页面和原生窗口使用同一份生成色值。
  nativeTheme.themeSource = "system"
  const colors = workbenchNativeTheme[nativeTheme.shouldUseDarkColors ? "dark" : "light"]
  const window = new BrowserWindow({
    width: 1060, height: 760, minWidth: 600, minHeight: 480,
    title: __WORKBENCH_UI_PREVIEW__ ? "工作台主题预览" : "协作工作台", backgroundColor: colors.background, show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(process.platform === "win32" ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: colors.background, symbolColor: colors.text, height: 48 } } : {}),
    webPreferences: { preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  })
  bindDesktopIpc(window, trustedUrl)
  // 预览不挂载身份或设备端口，避免接触现有服务和 Runner。
  if (!__WORKBENCH_UI_PREVIEW__) bindCollaborationIpc(window, trustedUrl, supervisor)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", event => { event.preventDefault() })
  window.webContents.on("will-frame-navigate", event => { event.preventDefault() })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  // 统一从受限按钮调整缩放，避免默认快捷键绕过产品范围。
  window.webContents.on("before-input-event", (event, input) => {
    if ((input.control || input.meta) && ["+", "-", "=", "0"].includes(input.key)) event.preventDefault()
  })
  window.once("ready-to-show", () => { window.show() })
  void window.loadURL(trustedUrl).catch(error => { console.error("桌面页面加载失败", error); window.destroy() })
  return window
}
