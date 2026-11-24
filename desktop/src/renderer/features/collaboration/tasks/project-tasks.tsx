/** 项目任务列表与详情消费桌面装配方提供的显示数据和定位动作。 */
import { useId, useState } from "react"
import type { ReactNode } from "react"
import type { ConversationReferenceView } from "../../../../ui/index.js"
import "./tasks.css"

/** 成员以稳定标识匹配，姓名用于展示。 */
export interface TaskMember {
  readonly id: string
  readonly name: string
}

/** 使用现有引用的固定标识与正文。上游按当前权限提供显示状态。 */
export type TaskMaterial = Pick<ConversationReferenceView,
  "id" | "sourceLabel" | "rangeLabel" | "snapshotText" | "status" | "message">

/** 状态文案由装配方提供。列表只按发布人与被指派人筛选。 */
export interface ProjectTaskSummary {
  readonly id: string
  readonly title: string
  readonly publisher: TaskMember
  readonly assignee: TaskMember
  readonly statusLabel: string
}

/** 详情显示当前任务及其已保存的固定材料。 */
export interface ProjectTaskDetails extends ProjectTaskSummary {
  readonly description: string
  readonly materials: readonly TaskMaterial[]
}

const filters = [
  { id: "assigned", label: "指派给我" },
  { id: "published", label: "我发布的" },
  { id: "all", label: "项目全部" },
] as const

/** 任务行以返回的任务标识请求定位，列表数据由宿主更新。 */
export function ProjectTaskList({ accountId, tasks, onCreateTask, onOpenTask }: {
  readonly accountId: string
  readonly projectName?: string
  readonly tasks: readonly ProjectTaskSummary[]
  onCreateTask?(): void
  onOpenTask(taskId: string): void
}) {
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("assigned")
  const visibleTasks = tasks.filter(task => (
    filter === "all" || (filter === "assigned" ? task.assignee.id : task.publisher.id) === accountId
  ))

  return (
    <section className="project-task-page" aria-label="项目任务">
      <div className="view-bar">
        <div className="project-task-filters" role="group" aria-label="任务筛选">
          {filters.map(item => (
            <button key={item.id} type="button" className="wb-button wb-button-quiet wb-button-small"
              aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="vb-spacer" />
        {onCreateTask && <button type="button" className="wb-button wb-button-primary" onClick={onCreateTask}>创建任务</button>}
      </div>
      {visibleTasks.length ? (
        <ul className="project-task-list">
          {visibleTasks.map(task => (
            <li key={task.id}>
              <button type="button" className="project-task-row" onClick={() => onOpenTask(task.id)}>
                <span>
                  <strong>{task.title}</strong>
                  <small>{task.id} · {task.publisher.name} 发布 · 指派给 {task.assignee.name}</small>
                </span>
                <span className="project-task-status">{task.statusLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="project-task-empty" role="status">当前筛选下暂无任务。</p>}
    </section>
  )
}

/** 详情复用表单的引用预览，展示发布结果所关联的材料；支持嵌入 `.t-drawer` 抽屉或独立页展示。 */
export function ProjectTaskDetail({
  task,
  onBack,
  embeddedInDrawer = false,
  statusTone = "accent",
  delegated = false,
  children,
}: {
  readonly task: ProjectTaskDetails
  onBack(): void
  readonly embeddedInDrawer?: boolean
  readonly statusTone?: "accent" | "muted" | "info" | "warn" | "success" | "danger"
  readonly delegated?: boolean
  children?: ReactNode
}) {
  const heading = useId()
  return (
    <article className={`project-task-page${embeddedInDrawer ? " is-drawer" : ""}`} aria-labelledby={heading}>
      {!embeddedInDrawer && (
        <button type="button" className="wb-button wb-button-quiet wb-button-small project-task-back" onClick={onBack}>
          返回项目任务
        </button>
      )}
      <header className="project-task-detail-heading">
        <p>{task.id}</p>
        <h1 id={heading}>{task.title}</h1>
      </header>
      <dl className="project-task-properties">
        <dt>发布人</dt><dd>{task.publisher.name}</dd>
        <dt>被指派人</dt><dd>{task.assignee.name}</dd>
        <dt>状态</dt>
        <dd className="project-task-status-cell">
          <span className="hui-badge" data-tone={statusTone}>{task.statusLabel}</span>
          {delegated && (
            <span className="hui-badge" data-tone="accent" data-size="xs" title="原创建人已离开团队，由项目负责人代管验收">
              代管验收
            </span>
          )}
        </dd>
      </dl>
      <section className="project-task-detail-section">
        <h2>任务说明</h2>
        <p className="project-task-text">{task.description}</p>
      </section>
      <section className="project-task-detail-section">
        <h2>附带材料</h2>
        {task.materials.length
          ? task.materials.map(material => <TaskMaterialCard key={material.id} material={material} />)
          : <p className="project-task-empty">暂无附带材料。</p>}
      </section>
      {children}
    </article>
  )
}

/** 可展开查看固定材料。来源或正文不可读时使用现有引用状态的提示。 */
export function TaskMaterialCard({ material, selected, children }: {
  readonly material: TaskMaterial
  readonly selected?: boolean
  readonly children?: ReactNode
}) {
  const ready = material.status === "ready"
  return (
    <details className="project-task-material">
      <summary>
        <span className="project-task-material-title">{ready ? material.sourceLabel : "引用不可用"}</span>
        {ready && <small>{material.rangeLabel}</small>}
        {selected && <small className="project-task-material-selected">已附带</small>}
      </summary>
      <div className="project-task-material-body">
        <p className="project-task-text">
          {ready ? material.snapshotText : material.message || "暂时无法读取引用。"}
        </p>
        {children}
      </div>
    </details>
  )
}
