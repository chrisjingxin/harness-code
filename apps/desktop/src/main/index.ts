/**
 * Electron 基础装配入口：启动 → 原生窗口 → 关闭/重开/退出。
 * 当前没有运行任务；Runner 后台托管和退出收敛由后续设备/工作台任务接入。
 */
import { app, BrowserWindow, Menu } from "electron"
import { createWindow } from "./window.js"

app.setName("协作工作台")
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: app.name, submenu: [{ role: "about" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }] }] : []),
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "close" }] },
  ]))
  createWindow()
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch(error => { console.error("桌面启动失败", error); app.quit() })
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
