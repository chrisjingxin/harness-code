/** 将受限桌面端口注入通用视图；本入口不组装任何 Agent 或旧 Web 服务。 */
import { createRoot } from "react-dom/client"
import "@workbench/ui/theme.css"
import { DesktopWorkbench } from "./desktop-workbench.js"

// 禁用触控板捏合对应的页面缩放，窗口缩放统一由主进程限制范围。
window.addEventListener("wheel", event => { if (event.ctrlKey) event.preventDefault() }, { passive: false })

createRoot(document.getElementById("root")!).render(<DesktopWorkbench host={window.workbench} collaboration={window.collaboration} conversations={window.conversations} devices={window.devices} projects={window.projects} personalHost={window.personal} />)
