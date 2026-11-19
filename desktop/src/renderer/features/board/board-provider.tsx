/** 正式中央页面接点复用 HC-217 的导航和 HC-218 的会话定位。 */
import type { ProjectPageProvider } from "../project-navigation/contracts.js"
import { ProjectBoard } from "./project-board.js"
import type { ProjectBoardProps } from "./project-board.js"

type BoardProviderOptions = Omit<ProjectBoardProps, "onOpenProject" | "onOpenTasks" | "onOpenTask" | "onOpenConversation">

export function createBoardPageProvider(options: BoardProviderOptions): ProjectPageProvider {
  return {
    render({ scope, page, navigator, visible }) {
      if (!visible || page.kind !== "board") return null
      return <ProjectBoard
        key={scope.projectId}
        {...options}
        onOpenProject={() => navigator.openPage({ kind: "info" })}
        onOpenTasks={() => navigator.openPage({ kind: "tasks" })}
        onOpenTask={taskId => navigator.openPage({ kind: "task", taskId })}
        onOpenConversation={conversation => conversation.projectId === scope.projectId
          && navigator.locateConversation(conversation.conversationId)}
      />
    },
  }
}
