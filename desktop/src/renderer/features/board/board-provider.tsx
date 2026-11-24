/** 正式中央看板接点：统一承接 board / tasks / task 页面，并将任务详情嵌入右侧 .t-drawer 抽屉。 */
import type { ReactNode } from "react"
import type { ProjectNavigator, ProjectPageProvider } from "../project-navigation/contracts.js"
import { ProjectBoard } from "./project-board.js"
import type { ProjectBoardProps } from "./project-board.js"

type BoardProviderOptions = Omit<
  ProjectBoardProps,
  "activeTaskId" | "onOpenProject" | "onOpenTasks" | "onOpenTask" | "onCloseTask" | "onOpenConversation" | "renderTaskDrawer"
> & {
  readonly renderTaskDrawer?: (taskId: string, onClose: () => void, navigator: ProjectNavigator) => ReactNode
}

export function createBoardPageProvider({ renderTaskDrawer, ...options }: BoardProviderOptions): ProjectPageProvider {
  return {
    render({ scope, page, navigator, visible }) {
      if (!visible || (page.kind !== "board" && page.kind !== "tasks" && page.kind !== "task")) return null
      const activeTaskId = page.kind === "task" ? page.taskId : null
      const closeTask = () => navigator.openPage({ kind: "board" })
      return (
        <ProjectBoard
          key={scope.projectId}
          {...options}
          activeTaskId={activeTaskId}
          onCloseTask={closeTask}
          onOpenProject={() => navigator.openPage({ kind: "info" })}
          onOpenTasks={() => navigator.openPage({ kind: "board" })}
          onOpenTask={taskId => navigator.openPage({ kind: "task", taskId })}
          onOpenConversation={conversation => conversation.projectId === scope.projectId
            && navigator.locateConversation(conversation.conversationId)}
          renderTaskDrawer={renderTaskDrawer
            ? (taskId, onClose) => renderTaskDrawer(taskId, onClose, navigator)
            : undefined}
        />
      )
    },
  }
}
