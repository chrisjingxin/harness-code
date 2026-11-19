/**
 * 本机执行 IPC 通道注册表。
 *
 * 【功能定义】统一经 `ipc-guard.ts` 注册 `workbench:local-execution:*` 全部 8 条受保护通道，
 * 对请求来源、参数个数、标识与结构化载体做白名单校验后转交 `LocalExecutionCoordinator`。
 * 【协作边界】不包含目录持久化与 ACP 状态机细节（分别位于 `local-directory-grants.ts` 与 `local-execution-coordinator.ts`）。
 */
import type { BrowserWindow } from "electron"
import type { LocalAcpElicitationAnswer } from "@workbench/acp-runtime"
import { parseFixedReference, type LocalExecutionScope } from "../shared/index.js"
import {
  createCollaborationIpcRegistrar,
  formatIpcError,
  hasNoControlChars,
  isNonControlString,
  isPlainObject,
  isUserId,
  isUuid,
  type IpcMainLike,
} from "./ipc-guard.js"
import { MAX_ATTACHMENTS } from "./local-directory-grants.js"
import type { LocalExecutionCoordinator } from "./local-execution-coordinator.js"

const PROVIDER_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i

function isLocalExecutionScope(value: unknown): value is LocalExecutionScope {
  return isPlainObject(value)
    && isUserId(value.accountId)
    && isUuid(value.workspaceId)
    && isUuid(value.projectId)
    && isUuid(value.conversationId)
}

function isValidAttachments(value: unknown): value is string[] | undefined {
  if (value === undefined) return true
  return Array.isArray(value)
    && value.length <= MAX_ATTACHMENTS
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 1024 && hasNoControlChars(item))
}

function isValidElicitationValue(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 32_768
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "boolean") return true
  if (Array.isArray(value)) {
    return value.length <= 200 && value.every(item => typeof item === "string" && item.length <= 4096)
  }
  return false
}

function isValidElicitationAnswer(value: unknown): value is LocalAcpElicitationAnswer {
  if (!isPlainObject(value) || typeof value.action !== "string") return false
  if (value.action === "decline" || value.action === "cancel") {
    return Object.keys(value).every(key => key === "action" || (key === "content" && value.content === undefined))
  }
  if (value.action !== "accept") return false
  if (!Object.keys(value).every(key => key === "action" || key === "content")) return false
  if (value.content === undefined) return true
  if (!isPlainObject(value.content)) return false
  const entries = Object.entries(value.content)
  if (entries.length > 200) return false
  return entries.every(([key, val]) => key.length > 0 && key.length <= 256 && isValidElicitationValue(val))
}

/** 绑定本机执行 IPC 通道；统一由 `ipc-guard.ts` 校验来源与参数计数，窗口关闭时统一注销。 */
export function bindLocalExecutionIpc(
  window: BrowserWindow,
  trustedUrl: string,
  execution: LocalExecutionCoordinator,
  targetIpc?: IpcMainLike,
): () => void {
  const ipc = createCollaborationIpcRegistrar({
    window,
    trustedUrl,
    ipc: targetIpc,
    messages: {
      sourceRejected: "不允许的本机执行请求来源。",
      invalidRequest: "请求参数无效。",
      internalError: "操作暂时无法完成。",
    },
  })

  ipc.handle("workbench:local-execution:list-providers", 0, () => execution.listProviders())
  ipc.handle("workbench:local-execution:prepare", [2, 3], (scope, directory, providerId) =>
    isLocalExecutionScope(scope) && isNonControlString(directory, 4096)
    && (providerId === undefined || providerId === null || (typeof providerId === "string" && PROVIDER_ID_PATTERN.test(providerId)))
      ? execution.prepare(scope, directory, typeof providerId === "string" ? providerId : undefined)
      : formatIpcError("INVALID_REQUEST", "本机会话、目录或 Agent 类型参数无效。"))
  ipc.handle("workbench:local-execution:send", [5, 6], (scope, bindingId, requestId, text, referenceIds, attachments) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isUuid(requestId)
      && typeof text === "string" && text.length <= 16_384 && Buffer.byteLength(text, "utf8") <= 32_768
      && Array.isArray(referenceIds) && referenceIds.length <= 2000
      && referenceIds.every(id => parseFixedReference(id) !== null)
      && isValidAttachments(attachments)
      && (text.trim() || referenceIds.length || (Array.isArray(attachments) && attachments.length > 0))
      ? execution.send(scope, bindingId, requestId, text, referenceIds as string[], (attachments as string[] | undefined) ?? [])
      : formatIpcError("INVALID_REQUEST", "请输入有效的文本消息、固定引用或工作区文件附件。文字最长 16,384 字符且不超过 32 KiB。"))
  ipc.handle("workbench:local-execution:cancel", 3, (scope, bindingId, turnId) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isUuid(turnId)
      ? execution.cancel(scope, bindingId, turnId)
      : formatIpcError("INVALID_REQUEST", "停止参数无效。"))
  ipc.handle("workbench:local-execution:answer-permission", 5, (scope, bindingId, turnId, requestId, optionId) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isUuid(turnId) && isUuid(requestId) && isNonControlString(optionId, 1024)
      ? execution.answerPermission(scope, bindingId, turnId, requestId, optionId)
      : formatIpcError("INVALID_REQUEST", "审批参数无效。"))
  ipc.handle("workbench:local-execution:set-mode", 3, (scope, bindingId, modeId) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isNonControlString(modeId, 256)
      ? execution.setMode(scope, bindingId, modeId)
      : formatIpcError("INVALID_REQUEST", "会话模式参数无效。"))
  ipc.handle("workbench:local-execution:set-config-option", 4, (scope, bindingId, configId, value) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isNonControlString(configId, 256)
    && (typeof value === "boolean" || isNonControlString(value, 1024))
      ? execution.setConfigOption(scope, bindingId, configId, value)
      : formatIpcError("INVALID_REQUEST", "会话配置参数无效。"))
  ipc.handle("workbench:local-execution:answer-elicitation", 4, (scope, bindingId, requestId, answer) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isNonControlString(requestId, 256) && isValidElicitationAnswer(answer)
      ? execution.answerElicitation(scope, bindingId, requestId, answer)
      : formatIpcError("INVALID_REQUEST", "表单应答参数无效。"))

  return () => ipc.dispose()
}
