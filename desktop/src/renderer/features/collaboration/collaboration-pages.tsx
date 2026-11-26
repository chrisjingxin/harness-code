/** 在 Project 外壳装配任务与知识页面。调用方提供显示数据和可用动作，导航仍由外壳维护。 */
import { useState } from "react"
import type { ProjectNavigationScope, ProjectNavigator, ProjectPageProviders } from "../project-navigation/index.js"
import { TeamKnowledge } from "./knowledge/team-knowledge.js"
import type { TeamKnowledgeProps } from "./knowledge/team-knowledge.js"
import { ProjectTaskDetail, ProjectTaskList } from "./tasks/project-tasks.js"
import type { ProjectTaskDetails, ProjectTaskSummary } from "./tasks/project-tasks.js"
import { PublishTaskDialog } from "./tasks/publish-task-dialog.js"
import type { PublishTaskDialogProps } from "./tasks/publish-task-dialog.js"
import "./collaboration-pages.css"

/** 桌面已确认属于当前范围的任务显示数据。只有具备发布动作时才装配表单。 */
interface TaskPageData {
  readonly scope: ProjectNavigationScope
  readonly tasks: readonly ProjectTaskSummary[]
  readonly details: ReadonlyMap<string, ProjectTaskDetails>
  readonly publish?: Pick<PublishTaskDialogProps, "members" | "materials" | "publishTask">
}

interface CollaborationPageOptions {
  readonly projectName: string
  readonly workspaceName: string
  readonly tasks?: TaskPageData
  readonly knowledge?: Pick<TeamKnowledgeProps, "items" | "actions" | "rendering"> & {
    readonly scope: ProjectNavigationScope
  }
}

function scopeKey({ namespace, accountId, workspaceId, projectId }: ProjectNavigationScope): string {
  return JSON.stringify([namespace, accountId, workspaceId, projectId])
}

/**
 * 缺少业务数据时展示尚未接入。页面按当前账号、团队和项目挂载，
 * 切换范围会销毁表单与预览，并使旧页面的异步结果失效。
 */
export function createCollaborationPageProviders({
  projectName, workspaceName, tasks, knowledge,
}: CollaborationPageOptions): Required<Pick<ProjectPageProviders, "tasks" | "knowledge">> {
  return {
    tasks: {
      render({ scope, page, navigator, visible }) {
        if (!visible || (page.kind !== "tasks" && page.kind !== "task")) return null
        const key = scopeKey(scope)
        const data = tasks && scopeKey(tasks.scope) === key ? tasks : undefined
        const back = page.kind === "task" ? () => navigator.openPage({ kind: "tasks" }) : undefined
        const title = page.kind === "task" ? "任务详情" : "项目任务"
        let content
        if (!data) {
          content = <UnavailablePage title={title} contextName={projectName}
            message="项目任务服务尚未接入，暂无法查看或发布任务。" onBack={back} />
        } else if (page.kind === "task") {
          const task = data.details.get(page.taskId)
          content = task
            ? <ProjectTaskDetail task={task} onBack={() => navigator.openPage({ kind: "tasks" })} />
            : <UnavailablePage title={title} contextName={projectName} message="当前任务详情暂不可用。" onBack={back} />
        } else {
          content = <TaskListPage scope={scope} projectName={projectName} data={data} navigator={navigator} />
        }
        return <div className="collaboration-page-scroll" key={page.kind === "task" ? JSON.stringify([key, page.taskId]) : key}>
          {content}
        </div>
      },
    },
    knowledge: {
      render({ scope, page, visible }) {
        if (!visible || page.kind !== "knowledge") return null
        const key = scopeKey(scope)
        return <div className="collaboration-page-scroll" key={key}>
          {knowledge && scopeKey(knowledge.scope) === key ? <TeamKnowledge
            scope={{ namespace: scope.namespace, accountId: scope.accountId, teamId: scope.workspaceId }}
            teamName={workspaceName}
            items={knowledge.items}
            actions={knowledge.actions}
            rendering={knowledge.rendering}
          /> : <UnavailablePage title="团队知识" contextName={workspaceName}
            message="团队知识服务尚未接入，暂无法阅读、编辑或引用条目。" />}
        </div>
      },
    },
  }
}

function TaskListPage({ scope, projectName, data, navigator }: {
  scope: ProjectNavigationScope
  projectName: string
  data: TaskPageData
  navigator: ProjectNavigator
}) {
  const [creating, setCreating] = useState(false)
  const openTask = (taskId: string) => navigator.openPage({ kind: "task", taskId })

  return <>
    <ProjectTaskList
      accountId={scope.accountId}
      projectName={projectName}
      tasks={data.tasks}
      onCreateTask={data.publish ? () => setCreating(true) : undefined}
      onOpenTask={openTask}
    />
    {creating && data.publish && <PublishTaskDialog
      {...data.publish}
      scope={scope}
      onClose={() => setCreating(false)}
      onPublished={openTask}
    />}
  </>
}

function UnavailablePage({ title, contextName, message, onBack }: {
  title: string
  contextName: string
  message: string
  onBack?: () => void
}) {
  return (
    <section className="collaboration-unavailable page-shell" aria-label={title}>
      <header className="page-head">
        <div>
          {onBack && <button type="button" className="wb-button wb-button-quiet wb-button-small" onClick={onBack}>返回看板</button>}
          <h1>{title}</h1>
          <p>{contextName}</p>
        </div>
      </header>
      <div className="panel" role="status">
        <p>{message}</p>
      </div>
    </section>
  )
}
