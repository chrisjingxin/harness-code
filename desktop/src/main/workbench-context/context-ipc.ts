/** 两份本机 MD 的受限用户入口：窗口来源与参数 → 本人会话/登录代次 → 完整读取或立即保存。 */
import type { BrowserWindow } from "electron"
import type { CollaborationState } from "@workbench/collaboration-client"
import type { LocalExecutionScope } from "../../shared/local-execution-host.js"
import { createCollaborationIpcRegistrar, formatIpcError, isPlainObject, isUserId, isUuid } from "../ipc-guard.js"
import { CONTEXT_REQUEST_BYTES } from "./types.js"
import { validMemoryDocument, validMemoryInput } from "./memory-store.js"
import type { WorkbenchContextService } from "./service.js"

const validScope = (value: unknown): value is LocalExecutionScope => isPlainObject(value)
  && Object.keys(value).every(k => ["accountId", "workspaceId", "projectId", "conversationId"].includes(k))
  && isUserId(value.accountId) && (value.workspaceId === null || isUuid(value.workspaceId))
  && (value.projectId === null || isUuid(value.projectId)) && isUuid(value.conversationId)

/** 不改变 cwd、不发放文件访问权限；Agent 未连接时仍可通过真实本人会话锚点操作。 */
export function bindWorkbenchContextIpc(window: BrowserWindow, trustedUrl: string, identity: CollaborationState, context: WorkbenchContextService): () => void {
  const ipc = createCollaborationIpcRegistrar({ window, trustedUrl, messages: { sourceRejected: "不允许的项目记忆请求来源。", invalidRequest: "项目记忆参数无效。", internalError: "项目记忆操作失败。" } })
  const invalid = () => formatIpcError("INVALID_REQUEST", "项目记忆参数无效。")
  const generation = () => identity.personalIdentity()?.generation
  const current = (version: number | undefined) => version !== undefined && generation() === version && !window.isDestroyed()
  ipc.handle("workbench:context:read-memory", 2, async (scope, document) => {
    if (!validScope(scope) || !validMemoryDocument(document)) return invalid()
    const version = generation()
    const value = await context.readMemory(scope, document)
    return current(version) ? { ok: true, value } : formatIpcError("AUTHENTICATION_REQUIRED", "发起读取的账号已变化。")
  })
  ipc.handle("workbench:context:update-memory", 2, async (scope, input) => {
    if (!validScope(scope) || !validMemoryInput(input)) return invalid()
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > CONTEXT_REQUEST_BYTES) return formatIpcError("INVALID_REQUEST", "序列化参数超过 64 KiB 技术限制，请整理后重试，文件未变。")
    const version = generation()
    const value = await context.updateMemory(scope, input)
    return current(version) ? { ok: true, value } : formatIpcError("AUTHENTICATION_REQUIRED", "发起保存的账号已变化，请在原账号重读核对结果。")
  })
  return () => ipc.dispose()
}
