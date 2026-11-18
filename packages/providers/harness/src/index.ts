/** Harness Agent Provider 适配包公开入口。 */
import { resolveHarnessCommand } from "./discovery.js"
import { HARNESS_HOST_HINTS } from "./meta.js"
import type { LocalAcpProviderDescriptor } from "./types.js"

export const packageId = "@workbench/harness-provider" as const

export * from "./types.js"
export * from "./discovery.js"
export * from "./meta.js"

/** 默认注册到工作台多代理宿主的 Harness Code 描述符。 */
export const harnessProviderDescriptor: LocalAcpProviderDescriptor = {
  id: "harness",
  label: "Harness Code",
  description: "本机 Harness Agent（支持 Build/Compose 工作流、Plan/Goal 表单与工具审批）",
  family: "harness",
  hostHints: HARNESS_HOST_HINTS,
  resolveCommand: resolveHarnessCommand,
}
