/** 桌面端项目会话与本机只读目录的宿主窄端口契约（不构成线上服务端接口）。 */
import type { CollaborationResult } from "./identity.js"
import type {
  ConversationDetailResponse,
  ConversationHistoryResponse,
  ConversationListResponse,
  ConversationRegisterRequest,
  ConversationStatus,
} from "./organization.js"
import type { ProjectReadAction, ProjectReadResponse } from "./project.js"

/** 项目级会话读取与登记端口：身份与凭据由主进程窗口隔离维护，不暴露设备写同步接口。 */
export interface ProjectConversationHost {
  listConversations(
    workspaceId: string,
    projectId: string,
    query?: { ownerId?: string; status?: ConversationStatus },
  ): Promise<CollaborationResult<ConversationListResponse>>
  registerConversation(
    workspaceId: string,
    projectId: string,
    request: ConversationRegisterRequest,
  ): Promise<CollaborationResult<ConversationDetailResponse>>
  getConversation(
    workspaceId: string,
    projectId: string,
    conversationId: string,
  ): Promise<CollaborationResult<ConversationDetailResponse>>
  readHistory(
    workspaceId: string,
    projectId: string,
    conversationId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<CollaborationResult<ConversationHistoryResponse>>
}

export type LocalDirectoryBinding = { conversationKey: string; directoryPath: string }

/** 本机授权目录只读端口：由渲染进程提交原生选择路径，主进程校验防逃逸后绑定读取。 */
export interface LocalDirectoryHost {
  bindDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    directoryPath: string,
  ): Promise<CollaborationResult<{ directoryPath: string; isGitRepository: boolean }>>
  readDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    action: ProjectReadAction,
  ): Promise<CollaborationResult<ProjectReadResponse>>
}
