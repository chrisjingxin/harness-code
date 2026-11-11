/** 桌面具名项目读取端口，复用共享动作和响应；原目标由服务从会话确认。 */
import type { CollaborationResult, ProjectReadAction, ProjectReadResponse } from "@workbench/contracts"

export interface ProjectReadHost {
  readProject(workspaceId: string, conversationId: string, action: ProjectReadAction): Promise<CollaborationResult<ProjectReadResponse>>
}
