/** 桌面端具名端口。preload 只向页面暴露看板读取与当前团队的通知生命周期。 */
import type { BoardResponse, CollaborationResult, NotificationEvent } from "@workbench/contracts"

export type ProjectUpdatesStatus = "connecting" | "connected" | "retrying" | "unavailable"

export type ProjectUpdatesNotice = { readonly subscriptionId: string } & (
  | { readonly kind: "status"; readonly status: ProjectUpdatesStatus }
  | { readonly kind: "event"; readonly event: NotificationEvent }
)

export const projectUpdatesChannels = {
  board: "workbench:project-updates:board",
  subscribe: "workbench:project-updates:subscribe",
  acknowledge: "workbench:project-updates:acknowledge",
  unsubscribe: "workbench:project-updates:unsubscribe",
  notice: "workbench:project-updates:notice",
} as const

export interface ProjectUpdatesHost {
  readBoard(workspaceId: string, projectId: string): Promise<CollaborationResult<BoardResponse>>
  subscribe(workspaceId: string, subscriptionId: string): Promise<CollaborationResult<null>>
  acknowledge(subscriptionId: string, eventId: number): Promise<void>
  unsubscribe(subscriptionId: string): Promise<void>
  onNotice(listener: (notice: ProjectUpdatesNotice) => void): () => void
}
