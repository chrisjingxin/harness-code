/** 应用生命周期与窗口分离。关窗释放页面会话，明确退出等待本机执行句柄收敛。 */
import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron"
import { createWindow } from "./window.js"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname } from "node:path"
import { createDesktopLocalExecutionRuntime } from "./local-acp-host.js"
import type { LocalExecutionRuntime } from "./local-execution-ipc.js"

if (__WORKBENCH_UI_PREVIEW__) {
  // 预览是独立进程，不能读写正式工作台的用户目录或账号凭据。
  const previewData = process.env.WORKBENCH_UI_PREVIEW_DATA
  const previewPrefix = `${__WORKBENCH_UI_PREVIEW__}-ui-preview-`
  if (!previewData || dirname(realpathSync(previewData)) !== realpathSync(tmpdir()) || !basename(previewData).startsWith(previewPrefix)) {
    throw new Error("组件预览必须使用自身隔离的临时用户目录")
  }
  app.setPath("userData", previewData)
  app.setPath("sessionData", previewData)
}

let execution: LocalExecutionRuntime | undefined
let disposeExecution: (() => Promise<void>) | undefined
let tray: Tray | null = null
let exiting = false
let quitAllowed = false
let quitRequested = false

function openWindow(): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) { window.show(); window.focus() }
  else if (!exiting) createWindow(() => { quitRequested = false; quitAllowed = false; exiting = false }, execution)
}

app.setName(__WORKBENCH_UI_PREVIEW__ ? {
  hc205: "工作台主题预览", hc206: "工作台对话预览", hc207: "工作台项目预览", hc217: "工作台项目导航预览", hc218: "工作台会话预览",
}[__WORKBENCH_UI_PREVIEW__] : "协作工作台")
app.whenReady().then(() => {
  if (!__WORKBENCH_UI_PREVIEW__) {
    const runtime = createDesktopLocalExecutionRuntime(process.env, app.getPath("userData"))
    execution = runtime.localExecution
    disposeExecution = runtime.dispose
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: app.name, submenu: [{ role: "about" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }] }] : []),
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "close" }] },
  ]))
  if (process.platform === "win32") {
    const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
    tray = new Tray(icon)
    tray.setToolTip(app.name)
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "重新打开", click: openWindow }, { label: "退出", click: () => app.quit() }]))
    tray.on("double-click", openWindow)
  }
  openWindow()
  app.on("activate", openWindow)
}).catch(error => { console.error("桌面启动失败", error); app.quit() })

app.on("window-all-closed", () => {
  if (__WORKBENCH_UI_PREVIEW__) { app.quit(); return }
  if (quitRequested) app.quit()
})
app.on("before-quit", event => {
  quitRequested = true
  if (quitAllowed || !disposeExecution) return
  event.preventDefault()
  if (exiting) return
  exiting = true
  void disposeExecution().then(() => true, () => false).then(executionStopped => {
    if (executionStopped) {
      disposeExecution = undefined
      quitAllowed = true
      app.quit()
      return
    }
    exiting = false
    quitRequested = false
    dialog.showErrorBox("停止未确认", "本机执行句柄尚未确认退出。请稍后再试。")
  })
})
app.on("will-quit", () => { tray?.destroy() })
