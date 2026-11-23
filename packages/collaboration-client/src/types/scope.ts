/**
 * 【功能定义】协调层会话定稿上传作用域与稳定复合键生成函数。
 * 【协作边界】纯数据结构与确定性序列化函数，零 Node/Electron 依赖；消除第 2 层 SDK 对桌面本地执行层的反向耦合。
 */

export type CollaborationConversationScope = {
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly conversationId: string
}

/** 共享定稿上传的异步结果通知（与执行终态解耦，失败时保留待传账本供下次重试）。 */
export type ConversationUploadNotice = {
  readonly scope: CollaborationConversationScope
  readonly turnId: string
  readonly kind: "upload"
  readonly failure?: string
  /** 服务端明确返回 409 CONVERSATION_SHARING_STOPPED 时为 true，提示宿主收敛本地共享状态并停止后续入队。 */
  readonly sharingStopped?: boolean
  /** 上传确认后附带服务器写入的最小/最大 sequence，供消费端去重已同步记录。 */
  readonly firstSequence?: number
  readonly syncedSequence?: number
}

/** 构造四元组作用域的稳定可比字符串键。 */
export function collaborationConversationKey(scope: CollaborationConversationScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId])
}
