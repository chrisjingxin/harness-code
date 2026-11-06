/** ACP 入口浏览器包：boot → ws-stream → 会话 → React 的启动链路。 */
/** @jsxImportSource react */

import { createRoot } from "react-dom/client"

import { createWebInteractiveAdapter } from "../../web/application/adapter"
import { PresentationErrorBoundary } from "../../web/presentation/error-boundary"
import { WebApp } from "../../web/presentation/web-app"
import { configureSyntaxWorkerUrl, closeHighlightService } from "../../web/syntax/highlight-service"
import { bootAcpTransport, BootError } from "./boot"
import { composeAcpWebSession } from "./session"
import { createWebSocketStream } from "./ws-stream"
import "../../web/presentation/theme.css"
import "../../web/presentation/styles.css"
import "../../web/presentation/workbench-views.css"
import "../../web/presentation/trace/trace.css"

/** 启动/启动失败的统一静态呈现；与 html.ts 的占位文本同一形状。 */
function renderStatic(root: Element, message: string, kind: "loading" | "fatal"): void {
  root.innerHTML = `<main class="web-static-state"><p class="${kind === "fatal" ? "web-static-state-error" : ""}">${message}</p></main>`
}

const BOOT_MESSAGES: Record<BootError["code"], string> = {
  "missing-code": "缺少接入凭据，请在终端重新运行 harness web 并打开打印的地址",
  "invalid-code": "接入凭据已失效，请回到终端重新运行 harness web",
  "locked": "本地服务暂时被锁定，请稍后在终端重新运行 harness web",
  "unavailable": "本地 Agent 暂时不可用，请稍后刷新或回到终端重新运行 harness web",
}

export async function bootstrapAcpWebApp(): Promise<void> {
  const root = document.querySelector("#root")
  if (!root) throw new Error("missing #root")
  renderStatic(root, "正在启动本地 Agent…", "loading")

  try {
    const transport = await bootAcpTransport()
    const { stream, closed, close } = createWebSocketStream(transport.socket)
    configureSyntaxWorkerUrl("/assets/syntax-worker.js")
    const session = await composeAcpWebSession({ stream, cwd: transport.cwd, closed })
    const adapter = createWebInteractiveAdapter({ client: session.client })
    createRoot(root).render(
      <PresentationErrorBoundary onError={(error) => { console.error("web-render", error) }}>
        <WebApp adapter={adapter} active={true} handoffControls={false} />
      </PresentationErrorBoundary>,
    )
    window.addEventListener("pagehide", () => {
      void adapter.close()
      void session.close()
      closeHighlightService()
      close(1000, "page-hide")
    }, { once: true })
    // 网关 onClose 之后的界面状态由控制器横幅承担（整页只读），不再 renderStatic。
  } catch (error) {
    renderStatic(
      root,
      error instanceof BootError ? BOOT_MESSAGES[error.code] : "无法启动本地 Agent，请回到终端查看 harness web 的输出",
      "fatal",
    )
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") void bootstrapAcpWebApp()
