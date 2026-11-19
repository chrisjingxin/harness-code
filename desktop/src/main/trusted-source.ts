/** 桌面具名IPC共用的来源校验：同一主窗口、顶层frame、构建确定的页面必须同时匹配。 */
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"

export function verifyDesktopSource(window: BrowserWindow, trustedUrl: string, event: IpcMainInvokeEvent): void {
  if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedUrl) throw new Error("不允许的桌面请求来源")
}
