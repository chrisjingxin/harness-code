/**
 * 本机个人会话存储 IPC 通道注册表。
 *
 * 【功能定义】经 `ipc-guard.ts` 校验同源主窗口来源与参数格式后，将 `workbench:local-conversations:*`
 * 转交主进程 `LocalConversationStore`，并在停止共享或删除时同步清理未排空的云端待传队列。
 * 【协作边界】允许已登录及断网离线续用态（`identity.personalIdentity()` 非空）正常访问与管理本机会话。
 */
import type { BrowserWindow } from "electron"
import type { CollaborationState, ConversationUploads } from "@workbench/collaboration-client"
import type {
  CreateLocalConversationInput,
  LocalConversationsListFilter,
  MarkLocalConversationPublishedInput,
  UpdateLocalConversationBindingPatch,
} from "../shared/index.js"
import {
  createCollaborationIpcRegistrar,
  formatIpcError,
  isNonNegativeSafeInteger,
  isNullableUuid,
  isPlainObject,
  isUuid,
  type IpcMainLike,
} from "./ipc-guard.js"
import type { LocalConversationStore } from "./local-conversation-store.js"

function isListFilter(value: unknown): value is LocalConversationsListFilter | undefined {
  if (value === undefined) return true
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key => key !== "workspaceId" && key !== "includePublished")) return false
  if (value.workspaceId !== undefined && !isNullableUuid(value.workspaceId)) return false
  if (value.includePublished !== undefined && typeof value.includePublished !== "boolean") return false
  return true
}

function isCreateInput(value: unknown): value is CreateLocalConversationInput {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key =>
    key !== "conversationId" && key !== "workspaceId" && key !== "title" && key !== "directoryPath" && key !== "providerId")) {
    return false
  }
  if (!isNullableUuid(value.workspaceId)) return false
  if (value.conversationId !== undefined && !isUuid(value.conversationId)) return false
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 256)) return false
  if (value.directoryPath !== undefined && value.directoryPath !== null && (typeof value.directoryPath !== "string" || value.directoryPath.length > 4096)) {
    return false
  }
  if (value.providerId !== undefined && value.providerId !== null && (typeof value.providerId !== "string" || value.providerId.length > 64)) {
    return false
  }
  return true
}

function isBindingPatch(value: unknown): value is UpdateLocalConversationBindingPatch {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key => key !== "directoryPath" && key !== "providerId" && key !== "status")) return false
  if (value.directoryPath !== undefined && value.directoryPath !== null && (typeof value.directoryPath !== "string" || value.directoryPath.length > 4096)) {
    return false
  }
  if (value.providerId !== undefined && value.providerId !== null && (typeof value.providerId !== "string" || value.providerId.length > 64)) {
    return false
  }
  if (value.status !== undefined && (typeof value.status !== "string" || !["idle", "running", "waiting_approval", "error"].includes(value.status))) {
    return false
  }
  return true
}

function isMarkPublishedInput(value: unknown): value is MarkLocalConversationPublishedInput {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).some(key =>
    key !== "workspaceId"
    && key !== "projectId"
    && key !== "shareMode"
    && key !== "syncedSequence"
    && key !== "historyFromTurnIndex")) {
    return false
  }
  if (!isUuid(value.workspaceId) || !isUuid(value.projectId)) return false
  if (value.shareMode !== "full" && value.shareMode !== "summary_only") return false
  if (value.syncedSequence !== undefined && !isNonNegativeSafeInteger(value.syncedSequence)) return false
  if (value.historyFromTurnIndex !== undefined && !isNonNegativeSafeInteger(value.historyFromTurnIndex)) return false
  return true
}

/** 绑定本机个人会话 IPC 通道；窗口关闭时统一注销。 */
export function bindLocalConversationsIpc(
  window: BrowserWindow,
  trustedUrl: string,
  identity: CollaborationState,
  store: LocalConversationStore,
  uploads: ConversationUploads | null,
  targetIpc?: IpcMainLike,
): () => void {
  const ipc = createCollaborationIpcRegistrar({
    window,
    trustedUrl,
    ipc: targetIpc,
    messages: {
      sourceRejected: "不允许的本机会话请求来源。",
      invalidRequest: "本机会话参数无效。",
      internalError: "本机会话操作暂时无法完成。",
    },
  })

  const accountId = () => identity.personalIdentity()?.accountId ?? null
  const requireLogin = () => formatIpcError("AUTHENTICATION_REQUIRED", "请先登录后访问本机会话。")

  ipc.handle("workbench:local-conversations:list", [0, 1], filter => {
    const id = accountId()
    if (!id) return requireLogin()
    return isListFilter(filter)
      ? store.list(id, filter)
      : formatIpcError("INVALID_REQUEST", "本机会话列表筛选参数无效。")
  })

  ipc.handle("workbench:local-conversations:get", 1, conversationId => {
    const id = accountId()
    if (!id) return requireLogin()
    return isUuid(conversationId)
      ? store.get(id, conversationId)
      : formatIpcError("INVALID_REQUEST", "本机会话标识无效。")
  })

  ipc.handle("workbench:local-conversations:create", 1, input => {
    const id = accountId()
    if (!id) return requireLogin()
    return isCreateInput(input)
      ? store.create(id, input)
      : formatIpcError("INVALID_REQUEST", "创建本机会话参数无效。")
  })

  ipc.handle("workbench:local-conversations:rename", 2, (conversationId, title) => {
    const id = accountId()
    if (!id) return requireLogin()
    return isUuid(conversationId) && typeof title === "string"
      ? store.rename(id, conversationId, title)
      : formatIpcError("INVALID_REQUEST", "会话标题参数无效。")
  })

  ipc.handle("workbench:local-conversations:update-workspace", 2, (conversationId, workspaceId) => {
    const id = accountId()
    if (!id) return requireLogin()
    return isUuid(conversationId) && isNullableUuid(workspaceId)
      ? store.updateWorkspace(id, conversationId, workspaceId)
      : formatIpcError("INVALID_REQUEST", "团队上下文参数无效。")
  })

  ipc.handle("workbench:local-conversations:update-binding", 2, (conversationId, patch) => {
    const id = accountId()
    if (!id) return requireLogin()
    return isUuid(conversationId) && isBindingPatch(patch)
      ? store.updateBinding(id, conversationId, patch)
      : formatIpcError("INVALID_REQUEST", "会话绑定参数无效。")
  })

  ipc.handle("workbench:local-conversations:mark-published", 2, async (conversationId, binding) => {
    const id = accountId()
    if (!id) return requireLogin()
    if (!isUuid(conversationId) || !isMarkPublishedInput(binding)) {
      return formatIpcError("INVALID_REQUEST", "会话发布绑定参数无效。")
    }
    const result = await store.markPublished(id, conversationId, binding)
    if (result.ok && binding.shareMode === "full" && binding.historyFromTurnIndex !== undefined && uploads) {
      const detail = await store.get(id, conversationId).catch(() => null)
      if (detail?.ok) {
        const scope = {
          accountId: id,
          workspaceId: binding.workspaceId,
          projectId: binding.projectId,
          conversationId,
        }
        for (const turn of detail.value.turns.slice(binding.historyFromTurnIndex)) {
          if (turn.status !== "completed") continue
          const userText = turn.images?.length
            ? (turn.userText.trim()
                ? `${turn.userText}\n\n[附 ${turn.images.length} 张本机图片]`
                : `[附 ${turn.images.length} 张本机图片]`)
            : turn.userText
          const shareableAttachments = turn.attachments?.map(item => ({
            label: item.label,
            kind: item.kind,
            ...(item.path && !item.path.startsWith("/") && !item.path.startsWith("\\") && !/^[a-zA-Z]:/.test(item.path)
              ? { path: item.path }
              : {}),
          }))
          await uploads.enqueue(scope, {
            turnId: turn.turnId,
            shareMode: "full",
            userText,
            ...(turn.referenceIds?.length ? { referenceIds: turn.referenceIds } : {}),
            ...(shareableAttachments?.length ? { attachments: shareableAttachments } : {}),
            ...(turn.followUps?.length ? { followUps: turn.followUps } : {}),
            ...(turn.tools?.length ? { tools: turn.tools } : {}),
            reply: turn.reply,
            acceptedAtMs: turn.acceptedAtMs,
            completedAtMs: turn.completedAtMs,
          }).catch(() => {})
        }
      }
    }
    return result
  })

  ipc.handle("workbench:local-conversations:mark-sharing-stopped", [1, 2], async (conversationId, stoppedAtMs) => {
    const id = accountId()
    if (!id) return requireLogin()
    if (!isUuid(conversationId) || (stoppedAtMs !== undefined && (typeof stoppedAtMs !== "number" || !Number.isFinite(stoppedAtMs) || stoppedAtMs < 0))) {
      return formatIpcError("INVALID_REQUEST", "停止共享参数无效。")
    }
    const result = await store.markSharingStopped(id, conversationId, stoppedAtMs)
    if (result.ok && result.value.workspaceId && result.value.projectId && uploads) {
      await uploads.cancelConversation({
        accountId: id,
        workspaceId: result.value.workspaceId,
        projectId: result.value.projectId,
        conversationId,
      }).catch(() => {})
    }
    return result
  })

  ipc.handle("workbench:local-conversations:remove", 1, async conversationId => {
    const id = accountId()
    if (!id) return requireLogin()
    if (!isUuid(conversationId)) return formatIpcError("INVALID_REQUEST", "本机会话标识无效。")
    const existing = await store.getRecord(id, conversationId).catch(() => null)
    const result = await store.remove(id, conversationId)
    if (result.ok && existing?.workspaceId && existing.projectId && uploads) {
      await uploads.cancelConversation({
        accountId: id,
        workspaceId: existing.workspaceId,
        projectId: existing.projectId,
        conversationId,
      }).catch(() => {})
    }
    return result
  })

  return () => ipc.dispose()
}
