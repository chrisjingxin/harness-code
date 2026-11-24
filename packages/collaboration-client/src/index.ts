/**
 * 【功能定义】第 2 层协调层 Client SDK 公开主入口（`@workbench/collaboration-client`）。
 * 【协作边界】零 Electron、零内部 `@workbench/*` 依赖；打包自带内联 Schema，可供桌面主进程、CLI 或独立 Node 工具直接复用。
 */
import { join } from "node:path"
import { CollaborationState, identityError } from "./collaboration-state.js"
import { ProjectUpdatesService } from "./project-updates-service.js"
import { UserUpdatesService } from "./user-updates-service.js"
import { ConversationUploads, type ConversationUploadPort } from "./conversation-uploads.js"
import type { ConversationUploadNotice } from "./scope.js"

export const packageId = "@workbench/collaboration-client" as const

export * from "./types/index.js"
export * from "./scope.js"
export { CollaborationClient } from "./collaboration-client.js"
export { CollaborationState, identityError } from "./collaboration-state.js"
export { isNotificationCursor, notificationCursor } from "./project-notification-cursor.js"
export { InvalidProjectNotification, readProjectNotifications } from "./project-notification-stream.js"
export { ProjectUpdatesService, type ProjectUpdatesNetwork } from "./project-updates-service.js"
export { UserUpdatesService, type UserUpdatesNetwork } from "./user-updates-service.js"
export {
  ConversationUploads,
  syncPayloadLimit,
  type ConversationUploadPort,
  type FinalizedAttachmentSummary,
  type FinalizedToolSummary,
  type FinalizedTurn,
} from "./conversation-uploads.js"

export type CollaborationSdkOptions = {
  readonly origin?: string
  readonly storageDir: string
  readonly transport?: typeof fetch
  readonly onUploadNotice?: (notice: ConversationUploadNotice) => void
}

/**
 * 在无 Electron 环境中组合创建协调层完整运行件（身份门面、SSE 通知服务与可选定稿上传队列）。
 */
export function createCollaborationSdk(options: CollaborationSdkOptions) {
  const state = new CollaborationState(options.origin, options.transport)
  const client = state.network()
  const updates = new ProjectUpdatesService(join(options.storageDir, "notification-cursors"), options.origin ?? "")
  const userUpdates = new UserUpdatesService(join(options.storageDir, "notification-cursors"), options.origin ?? "")
  const uploadPort: ConversationUploadPort | null = client
    ? {
        watermark: async (scope, signal) => {
          const detail = await client.getProjectConversation(scope.workspaceId, scope.projectId, scope.conversationId, signal)
          if (!detail.ok) return detail
          if (detail.value.conversation.ownerUserId !== scope.accountId) {
            return identityError("CONVERSATION_FORBIDDEN", "仅会话创建者可执行该操作。")
          }
          if (detail.value.conversation.shareStatus === "stopped") {
            return identityError("CONVERSATION_SHARING_STOPPED", "该会话已停止团队共享。")
          }
          return { ok: true, value: detail.value.conversation.syncedSequence }
        },
        upload: (scope, request, signal) =>
          client.syncConversation(scope.workspaceId, scope.projectId, scope.conversationId, request, signal),
      }
    : null
  const uploads = uploadPort
    ? new ConversationUploads(join(options.storageDir, "conversation-uploads"), uploadPort, options.onUploadNotice ?? (() => {}))
    : null

  // 自动将身份门面的登录状态同步到上传队列与通知流，确保无需手调 useAccount 即可在登录后自动排空、登出后立即停流。
  const unsubscribeState = state.onStateChanged(nextState => {
    const accountId = nextState.status === "signedIn" ? nextState.user.id : null
    uploads?.useAccount(accountId)
    if (accountId === null) {
      updates.stop()
      userUpdates.stop()
    }
  })

  return {
    state,
    client,
    updates,
    userUpdates,
    uploads,
    async dispose(): Promise<void> {
      unsubscribeState()
      updates.stop()
      userUpdates.stop()
      uploads?.useAccount(null)
      await uploads?.flush()
      state.dispose()
    },
  }
}

export { isKnowledgeProposalContent, knowledgeProposalToolSchema } from "./knowledge-validation.js"
