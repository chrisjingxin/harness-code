/**
 * 【功能定义】Harness Agent ACP 适配桥公开入口：导出默认 `harnessAcpDescriptor`、`agent/.venv` 探测与 `_meta.harnessCode` 解析工具。
 * 【协作边界】仅依赖 `@workbench/acp-runtime`，不持有窗口、会话或进程实例状态。
 */
import type { AcpAgentDescriptor } from "@workbench/acp-runtime"
import { resolveHarnessCommand } from "./discovery.js"
import { HARNESS_HOST_HINTS } from "./meta.js"

export const packageId = "@workbench/harness-acp" as const

export * from "./discovery.js"
export * from "./meta.js"

/** 默认注册到工作台多代理宿主的 Harness Code 描述符。 */
export const harnessAcpDescriptor: AcpAgentDescriptor = {
  id: "harness",
  label: "Harness Code",
  description: "本机 Harness Agent（支持 Build/Compose 工作流、Plan/Goal 表单与工具审批）",
  family: "harness",
  hostHints: HARNESS_HOST_HINTS,
  resolveCommand: resolveHarnessCommand,
}
