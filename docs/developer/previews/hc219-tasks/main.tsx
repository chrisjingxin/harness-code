/** 项目任务独立预览。成员、任务、固定材料与发布回调都使用本页的示例数据。 */
import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { BrandMark } from "@workbench/ui"
import { snapshotReferenceView } from "../../../../apps/desktop/src/renderer/features/collaboration/references/conversation-references.js"
import { ProjectTaskDetail, ProjectTaskList } from "../../../../apps/desktop/src/renderer/features/collaboration/tasks/project-tasks.js"
import type { ProjectTaskDetails } from "../../../../apps/desktop/src/renderer/features/collaboration/tasks/project-tasks.js"
import { PublishTaskDialog } from "../../../../apps/desktop/src/renderer/features/collaboration/tasks/publish-task-dialog.js"
import type { PublishTaskDialogProps, TaskProjectScope } from "../../../../apps/desktop/src/renderer/features/collaboration/tasks/publish-task-dialog.js"
import "@workbench/ui/theme.css"
import "./preview.css"

const publisher = { id: "zhang", name: "张三" }
const lee = { id: "li", name: "李四" }
const wang = { id: "wang", name: "王五" }
const members = [publisher, lee, wang]
const projectName = "支付体验优化"
const scope: TaskProjectScope = {
  namespace: "hc219-tasks-preview",
  accountId: publisher.id,
  workspaceId: "demo-team",
  projectId: "payment-experience",
}
const material = snapshotReferenceView({
  id: "payment-discussion-16-08",
  title: "支付回调的幂等规则",
  owner: lee.name,
  version: "v1",
  uploadedAt: "2026-11-13 16:08",
  rangeLabel: "第 3–5 条消息",
  text: "支付回调重复到达时，按支付请求 ID 查找首次处理结果。遇到超时先查订单状态，再决定是否重试。",
})
const materials = [material]
const initialTasks: readonly ProjectTaskDetails[] = [
  {
    id: "TASK-024",
    title: "对齐支付超时与重试边界",
    publisher: lee,
    assignee: publisher,
    statusLabel: "待处理",
    description: "核对哪些支付结果可以重试，哪些需要等待确认。",
    materials,
  },
  {
    id: "TASK-025",
    title: "补充订单状态回传的接口约定",
    publisher,
    assignee: wang,
    statusLabel: "进行中",
    description: "补充订单状态回传的返回示例。",
    materials: [],
  },
  {
    id: "TASK-026",
    title: "整理支付幂等用例",
    publisher: wang,
    assignee: lee,
    statusLabel: "待处理",
    description: "整理重复支付请求的校验场景。",
    materials: [],
  },
]

function Preview() {
  const [tasks, setTasks] = useState(initialTasks)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [form, setForm] = useState<{ initialAssigneeId?: string } | null>(null)
  const nextId = useRef(27)
  const detail = tasks.find(task => task.id === detailId)

  const publishTask: PublishTaskDialogProps["publishTask"] = async (_scope, input) => {
    const assignee = members.find(member => member.id === input.assigneeId)
    if (!assignee) return { status: "rejected", message: "请选择项目内的成员。" }

    const task: ProjectTaskDetails = {
      id: `TASK-${String(nextId.current++).padStart(3, "0")}`,
      title: input.title,
      publisher,
      assignee,
      statusLabel: "待处理",
      description: input.description,
      materials: materials.filter(item => input.materialIds.includes(item.id)),
    }
    setTasks(previous => [task, ...previous])
    return { status: "published", taskId: task.id }
  }

  return (
    <main>
      <header className="hc219-tasks-preview-header">
        <BrandMark />
        <p>项目任务预览 · 固定示例</p>
        <button type="button" className="wb-button wb-button-quiet wb-button-small" onClick={() => setForm({ initialAssigneeId: lee.id })}>
          为李四创建任务
        </button>
      </header>
      <div hidden={Boolean(detail)} inert={Boolean(detail)}>
        <ProjectTaskList
          accountId={scope.accountId}
          projectName={projectName}
          tasks={tasks}
          onCreateTask={() => setForm({})}
          onOpenTask={setDetailId}
        />
      </div>
      {detail && <ProjectTaskDetail task={detail} onBack={() => setDetailId(null)} />}
      {form && <PublishTaskDialog
        scope={scope}
        members={members}
        materials={materials}
        initialAssigneeId={form.initialAssigneeId}
        publishTask={publishTask}
        onClose={() => setForm(null)}
        onPublished={taskId => {
          setDetailId(taskId)
          setForm(null)
        }}
      />}
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Preview />)
