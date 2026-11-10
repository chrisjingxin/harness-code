/**
 * `session.ts`：把网关 + 控制器 + 本地 UI client 组装成一个 ACP Web 会话。
 * 全仓库第二个（也是唯一另一个）`createInteractiveController(` 调用点
 * （第一个是 `src/index.ts` 的 TUI 装配）；与 `app.tsx` 分离是因为
 * 本模块不依赖 DOM，可以在 bun 里对"桥 + 真实 Python + 网关 + 控制器"
 * 链路做集成测试（§6.7）。
 */

import type { Stream } from "@agentclientprotocol/sdk"

import { createInteractiveController } from "../../interactive/controller"
import type { InteractiveController } from "../../interactive/types"
import { AcpAgentGateway, type AcpBootInfo } from "./acp-agent-gateway"
import { createLocalUiClient } from "./local-ui-client"
import { createAcpRuntime } from "./runtime"
import type { WebUiClient } from "../../web/ui-client"
import type { WsCloseInfo } from "./ws-stream"

export type AcpWebSession = {
  readonly client: WebUiClient
  readonly controller: InteractiveController
  readonly gateway: AcpAgentGateway
  readonly boot: AcpBootInfo
  close(): Promise<void>
}

export async function composeAcpWebSession(options: {
  stream: Stream
  cwd: string
  closed?: Promise<WsCloseInfo>
  now?: () => number
  uuid?: () => string
  commandsTimeoutMs?: number
}): Promise<AcpWebSession> {
  const { gateway, boot } = await AcpAgentGateway.connect(options)
  const runtime = createAcpRuntime(boot)
  // 不传 resolveMentions（直通）、不传 workspaceGit、不传 initialThreadId（空首页）。
  const controller = createInteractiveController({ gateway, baseRuntime: runtime })
  const client = createLocalUiClient({ controller })
  return {
    client,
    controller,
    gateway,
    boot,
    async close(): Promise<void> {
      client.close()
      await controller.close()
      // socket 由 app 持有，不在这里关。
    },
  }
}
