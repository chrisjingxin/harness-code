/** Qwen Code Agent Provider 适配包公开入口。 */
import { resolveQwenCommand } from "./discovery.js"
import type { LocalAcpProviderDescriptor } from "./types.js"

export const packageId = "@workbench/qwen-provider" as const

export * from "./types.js"
export * from "./discovery.js"

/** Qwen Code (`qwen --acp`) 描述符：走标准 ACP 会话、审批与工作区读写。 */
export const qwenProviderDescriptor: LocalAcpProviderDescriptor = {
  id: "qwen",
  label: "Qwen Code",
  description: "本机 Qwen Code Agent（通过 qwen --acp 标准协议接入）",
  family: "qwen",
  hostHints: {
    enableElicitation: true,
    enableClientFs: true,
    restorePolicy: "fallback-new",
  },
  resolveCommand: resolveQwenCommand,
}
