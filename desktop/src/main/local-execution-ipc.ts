/**
 * 本机执行 IPC 通道注册表。
 *
 * 【功能定义】统一经 `ipc-guard.ts` 注册 `workbench:local-execution:*` 受保护通道，
 * 对请求来源、参数个数、标识与结构化载体做白名单校验后转交 `LocalExecutionCoordinator`。
 * 【协作边界】不包含目录持久化与 ACP 状态机细节（分别位于 `local-directory-grants.ts` 与 `local-execution-coordinator.ts`）。
 */
import type { BrowserWindow } from "electron"
import type { LocalAcpElicitationAnswer } from "@workbench/acp-runtime"
import { isSteerText, parseFixedReference, type CodeCheckpointAction, type LocalExecutionScope, type LocalSteerInput, type PromptQueueAction, type QueuedPrompt } from "../shared/index.js"
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

function isCheckpointAction(value: unknown): value is CodeCheckpointAction {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value).sort().join(",")
  if (value.kind === "history") return keys === "kind"
  if (value.kind === "restore") return keys === "kind,token" && isUuid(value.token)
  if (!isUuid(value.turnId)) return false
  if (value.kind === "changes") return keys === "kind,turnId"
  if (value.kind === "diff") return keys === "kind,path,turnId"
    && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 4096 && !value.path.includes("\0")
  return value.kind === "preview" && (value.target === "guard"
    ? keys === "guardId,kind,target,turnId" && isUuid(value.guardId)
    : keys === "kind,target,turnId" && (value.target === "base" || value.target === "post"))
}

function isValidAttachments(value: unknown): value is string[] | undefined {
  if (value === undefined) return true
  return Array.isArray(value)
    && value.length <= MAX_ATTACHMENTS
    && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 1024 && hasNoControlChars(item))
}

function isPromptText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16_384 && Buffer.byteLength(value, "utf8") <= 32_768
}

function isSteerInput(value: unknown): value is LocalSteerInput {
  if (!isPlainObject(value) || !isUuid(value.requestId)) return false
  const keys = Object.keys(value).sort().join(",")
  return value.kind === "queued" ? keys === "kind,requestId"
    : value.kind === "draft" && keys === "kind,requestId,text" && isPromptText(value.text) && isSteerText(value.text)
}

function isPromptContent(text: unknown, referenceIds: unknown, attachments: unknown): boolean {
  return isPromptText(text) && Array.isArray(referenceIds) && referenceIds.length <= 2000
    && referenceIds.every(id => parseFixedReference(id) !== null) && isValidAttachments(attachments)
    && Boolean(text.trim() || referenceIds.length || attachments?.length)
}

function isQueuedPrompt(item: unknown): item is QueuedPrompt {
  return isPlainObject(item) && Object.keys(item).sort().join(",") === "attachments,referenceIds,requestId,text"
    && isUuid(item.requestId) && Array.isArray(item.attachments) && isPromptContent(item.text, item.referenceIds, item.attachments)
}

function isPromptQueueAction(value: unknown): value is PromptQueueAction {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value).sort().join(",")
  switch (value.kind) {
    case "read": return keys === "kind"
    case "add": return keys === "bindingId,item,kind" && isUuid(value.bindingId) && isQueuedPrompt(value.item)
    case "resume": return keys === "bindingId,kind" && isUuid(value.bindingId)
    case "remove": return keys === "kind,requestId" && isUuid(value.requestId)
    case "edit": return keys === "kind,requestId,text" && isUuid(value.requestId) && isPromptText(value.text)
    default: return false
  }
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
  ipc.handle("workbench:local-execution:prompt-queue", 2, (scope, action) =>
    isLocalExecutionScope(scope) && isPromptQueueAction(action)
      ? execution.promptQueue(scope, action)
      : formatIpcError("INVALID_REQUEST", "待发消息或队列操作无效。"))
  ipc.handle("workbench:local-execution:prepare", [2, 3], (scope, directory, providerId) =>
    isLocalExecutionScope(scope) && isNonControlString(directory, 4096)
    && (providerId === undefined || providerId === null || (typeof providerId === "string" && PROVIDER_ID_PATTERN.test(providerId)))
      ? execution.prepare(scope, directory, typeof providerId === "string" ? providerId : undefined)
      : formatIpcError("INVALID_REQUEST", "本机会话、目录或 Agent 类型参数无效。"))
  ipc.handle("workbench:local-execution:confirm-directory", 1, scope =>
    isLocalExecutionScope(scope)
      ? execution.confirmDirectory(scope)
      : formatIpcError("INVALID_REQUEST", "本机会话参数无效。"))
  ipc.handle("workbench:local-execution:send", [5, 6], (scope, bindingId, requestId, text, referenceIds, attachments) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isUuid(requestId)
      && isPromptContent(text, referenceIds, attachments)
      ? execution.send(scope, bindingId, requestId, text as string, referenceIds as string[], (attachments as string[] | undefined) ?? [])
      : formatIpcError("INVALID_REQUEST", "请输入有效的文本消息、固定引用或工作区文件附件。文字最长 16,384 字符且不超过 32 KiB。"))
  ipc.handle("workbench:local-execution:steer", 4, (scope, bindingId, turnId, input) =>
    isLocalExecutionScope(scope) && isUuid(bindingId) && isUuid(turnId) && isSteerInput(input)
      ? execution.steer(scope, bindingId, turnId, input)
      : formatIpcError("INVALID_REQUEST", "追发仅支持普通文本。"))
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

  ipc.handle("workbench:local-execution:code-checkpoint", 2, (scope, action) =>
    isLocalExecutionScope(scope) && isCheckpointAction(action)
      ? execution.codeCheckpoint(scope, action)
      : formatIpcError("INVALID_REQUEST", "轮次快照参数无效。"))

  return () => ipc.dispose()
}
