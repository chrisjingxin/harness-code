/** 将主进程提供的受限桌面端口注入正式工作台。 */
import { createRoot } from "react-dom/client"
import "../ui/theme.css"
import "../ui/project/project.css"
import { DesktopWorkbench } from "./desktop-workbench.js"

// 禁用触控板捏合对应的页面缩放，窗口缩放统一由主进程限制范围。
window.addEventListener("wheel", event => { if (event.ctrlKey) event.preventDefault() }, { passive: false })

createRoot(document.getElementById("root")!).render(
  <DesktopWorkbench
    host={window.workbench}
    collaboration={window.collaboration}
    collaborationApps={window.collaborationApps}
    projectUpdates={window.projectUpdates}
    organization={window.organization}
    projectConversations={window.projectConversations}
    localDirectory={window.localDirectory}
    localExecution={window.localExecution}
    personalHost={window.personal}
  />,
)
