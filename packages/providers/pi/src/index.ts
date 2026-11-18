/** Pi Agent Provider 适配包公开入口。 */
import { resolvePiCommand } from "./discovery.js"
import type { LocalAcpProviderDescriptor } from "./types.js"

export const packageId = "@workbench/pi-provider" as const

export * from "./types.js"
export * from "./discovery.js"

/** Pi (`pi-acp`) 描述符：走标准 ACP（configOptions 模型/思考级别、usage_update 与 slash 命令）。 */
export const piProviderDescriptor: LocalAcpProviderDescriptor = {
  id: "pi",
  label: "Pi",
  description: "本机 Pi Coding Agent（经 pi-acp 接入，支持模型与思考级别配置）",
  family: "pi",
  hostHints: {
    enableElicitation: true,
    enableClientFs: true,
    restorePolicy: "fallback-new",
  },
  resolveCommand: resolvePiCommand,
}
