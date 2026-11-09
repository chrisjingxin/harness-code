/** 应用级 Runner 与窗口分离。关窗释放页面会话，明确退出等待本机子进程收敛。 */
import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron"
import { createWindow } from "./window.js"
import { RunnerSupervisor } from "./runner-supervisor.js"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname } from "node:path"

if (__WORKBENCH_UI_PREVIEW__) {
  // 预览是独立进程，不能读写正式工作台的用户目录或设备账本。
  const previewData = process.env.WORKBENCH_UI_PREVIEW_DATA
  if (!previewData || dirname(realpathSync(previewData)) !== realpathSync(tmpdir()) || !basename(previewData).startsWith("hc205-ui-preview-")) {
    throw new Error("主题预览必须使用隔离的临时用户目录")
  }
  app.setPath("userData", previewData)
  app.setPath("sessionData", previewData)
}

const supervisor = new RunnerSupervisor()
let tray: Tray | null = null
let exiting = false
let quitAllowed = false

function openWindow(): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (window) { window.show(); window.focus() }
  else if (!exiting) createWindow(supervisor)
}

app.setName(__WORKBENCH_UI_PREVIEW__ ? "工作台主题预览" : "协作工作台")
app.whenReady().then(() => {
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
  if (process.platform !== "darwin" && !supervisor.hasChild()) app.quit()
})
app.on("before-quit", event => {
  if (quitAllowed || !supervisor.hasChild()) return
  event.preventDefault()
  if (exiting) return
  exiting = true
  void supervisor.stop().then(stopped => {
    if (stopped) {
      quitAllowed = true
      tray?.destroy()
      app.quit()
      return
    }
    exiting = false
    dialog.showErrorBox("停止未确认", "本机执行器尚未确认退出。请稍后再试。")
  })
})
