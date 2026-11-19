/**
 * 项目任务发布表单。装配方提供成员、固定材料和发布动作，成功后使用返回标识定位详情。
 * 选成员与材料 → 用户点击发布 → 应用发布结果。请求未完成时保留表单并阻止重复提交。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { TaskMaterialCard } from "./project-tasks.js"
import type { TaskMaterial, TaskMember } from "./project-tasks.js"

/** 发布动作的当前身份与项目，用于隔离表单和迟到的提交结果。 */
export interface TaskProjectScope {
  readonly namespace: string
  readonly accountId: string
  readonly workspaceId: string
  readonly projectId: string
}

/** 表单提交给客户端的意图，材料标识对应用户选定的固定内容。 */
export interface PublishTaskInput {
  readonly assigneeId: string
  readonly title: string
  readonly description: string
  readonly materialIds: readonly string[]
  readonly requestId: string
}

/** 客户端发布结果。受理后只按返回的标识定位，结果未知时保留当前表单供核对。 */
export type PublishTaskResult =
  | { readonly status: "published"; readonly taskId: string }
  | { readonly status: "rejected" | "unknown"; readonly message: string }

export interface PublishTaskDialogProps {
  readonly scope: TaskProjectScope
  readonly members: readonly TaskMember[]
  readonly materials: readonly TaskMaterial[]
  readonly initialAssigneeId?: string
  /** 从会话发起时默认准备该来源的固定快照，等待用户核对后发布。 */
  readonly initialSourceId?: string
  readonly sources?: readonly TaskMember[]
  readMaterial?(sourceId: string): Promise<TaskMaterial>
  publishTask(scope: TaskProjectScope, input: PublishTaskInput): Promise<PublishTaskResult>
  onClose(): void
  onPublished(taskId: string): void
}

/** 每个入口打开同一表单，可预选仍在当前项目的成员。 */
export function PublishTaskDialog(props: PublishTaskDialogProps) {
  const { namespace, accountId, workspaceId, projectId } = props.scope
  return <TaskForm key={JSON.stringify([namespace, accountId, workspaceId, projectId, props.initialSourceId])} {...props} />
}

function TaskForm({ scope, members, materials, initialAssigneeId, initialSourceId, sources, readMaterial, publishTask, onClose, onPublished }: PublishTaskDialogProps) {
  const heading = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<symbol | null>(null)
  const materialRequest = useRef<symbol | null>(null)
  const current = useRef(false)
  const replay = useRef<{ signature: string; requestId: string } | null>(null)
  const [assigneeId, setAssigneeId] = useState(initialAssigneeId ?? "")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [materialIds, setMaterialIds] = useState<readonly string[]>([])
  const [submission, setSubmission] = useState<PublishTaskResult | { status: "submitting" } | null>(null)
  const [sourceId, setSourceId] = useState(initialSourceId ?? "")
  const [addedMaterials, setAddedMaterials] = useState<TaskMaterial[]>([])
  const [reading, setReading] = useState(Boolean(initialSourceId))
  const [readingError, setReadingError] = useState("")
  const [sourceUnresolved, setSourceUnresolved] = useState(Boolean(initialSourceId))

  useLayoutEffect(() => {
    const element = dialog.current
    current.current = true
    element?.showModal()
    return () => { current.current = false; pending.current = null; materialRequest.current = null; element?.close() }
  }, [])

  useEffect(() => {
    if (initialSourceId) void attachSource(initialSourceId)
  }, [initialSourceId])

  const assignee = members.find(member => member.id === assigneeId)
  const materialById = new Map([...materials, ...addedMaterials].map(material => [material.id, material]))
  const missingIds = materialIds.filter(id => !materialById.has(id))
  const blockedByMaterial = materialIds.some(id => materialById.get(id)?.status !== "ready")
  const busy = submission?.status === "submitting" || submission?.status === "published"
  const canPublish = Boolean(assignee && title.trim() && description.trim() && !blockedByMaterial
    && !busy && !reading && !sourceUnresolved)
  const uncertain = submission?.status === "unknown"

  async function attachSource(selectedSourceId: string): Promise<void> {
    if (!selectedSourceId || materialRequest.current || busy || uncertain) return
    const request = Symbol()
    materialRequest.current = request
    setReading(true)
    setReadingError("")
    setSourceUnresolved(true)
    try {
      if (!readMaterial) throw new Error("当前无法读取来源会话，请选择不附带此来源或稍后重试。")
      const material = await readMaterial(selectedSourceId)
      if (!current.current || materialRequest.current !== request) return
      if (material.status !== "ready") throw new Error(material.message || "来源会话材料暂不可用。")
      setAddedMaterials(previous => [...previous.filter(item => item.id !== material.id), material])
      // 读取和附带是同一个用户动作，发布使用预览卡对应的固定标识。
      setMaterialIds(ids => ids.includes(material.id) ? ids : [...ids, material.id])
      setSourceUnresolved(false)
    } catch (error) {
      if (current.current && materialRequest.current === request) {
        setReadingError(error instanceof Error ? error.message : "无法读取会话材料。")
      }
    } finally {
      if (current.current && materialRequest.current === request) {
        materialRequest.current = null
        setReading(false)
      }
    }
  }

  async function submit(): Promise<void> {
    if (!canPublish || pending.current || materialRequest.current) return
    const request = Symbol()
    pending.current = request
    setSubmission({ status: "submitting" })
    const input = { assigneeId, title: title.trim(), description: description.trim(), materialIds: [...materialIds] }
    const signature = JSON.stringify(input)
    if (replay.current?.signature !== signature) replay.current = { signature, requestId: crypto.randomUUID() }
    let result: PublishTaskResult
    try {
      result = await publishTask(scope, { ...input, requestId: replay.current.requestId })
    } catch {
      result = { status: "unknown", message: "发布结果待确认，可使用同一请求重试。" }
    }
    // 账号或项目切换后，旧表单的结果不能打开当前项目的详情。
    if (pending.current !== request) return
    setSubmission(result)
    if (result.status === "published") onPublished(result.taskId)
    else pending.current = null
  }

  return (
    <dialog ref={dialog} className="project-task-dialog" aria-labelledby={heading} onCancel={event => {
      event.preventDefault()
      if (!pending.current) onClose()
    }}>
      <h2 id={heading}>创建任务</h2>
      <form onSubmit={event => event.preventDefault()}>
        <fieldset className="project-task-fields" disabled={busy || uncertain}>
          <legend className="wb-sr-only">任务内容</legend>
          <label>被指派人
            <select required value={assignee?.id ?? ""} onChange={event => setAssigneeId(event.currentTarget.value)}>
              <option value="" disabled>选择项目成员</option>
              {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label>任务标题
            <input required value={title} onChange={event => setTitle(event.currentTarget.value)} />
          </label>
          <label>任务说明
            <textarea required rows={4} value={description} onChange={event => setDescription(event.currentTarget.value)} />
          </label>
          <section className="project-task-attachments" aria-label="附带材料">
            <h3>附带材料</h3>
            {readMaterial && Boolean(sources?.length) && <div className="project-task-source-picker">
              <label>来源会话
                <select value={sourceId} disabled={reading} onChange={event => setSourceId(event.currentTarget.value)}>
                  <option value="">选择来源会话</option>
                  {sources?.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
                </select>
              </label>
              <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={reading || !sourceId}
                onClick={() => void attachSource(sourceId)}>{reading ? "正在准备快照…" : "附带会话快照"}</button>
            </div>}
            {reading && <p className="project-task-empty" role="status">正在准备来源会话快照，完成后可预览或移除。</p>}
            {readingError && <div>
              <p className="project-task-error" role="alert">{readingError}</p>
              {sourceUnresolved && !reading && <button type="button" className="wb-button wb-button-quiet wb-button-small" onClick={() => {
                setSourceUnresolved(false)
                setReadingError("")
              }}>不附带此来源</button>}
            </div>}
            <p className="project-task-empty" role="status">{materialIds.length
              ? `已附带 ${materialIds.length} 份材料。`
              : "未附带来源对话。可选择来源后附带会话快照。"}</p>
            {materialById.size === 0 && missingIds.length === 0 && <p className="project-task-empty">暂无可附带的材料。</p>}
            {[...materialById.values()].map(material => {
              const selected = materialIds.includes(material.id)
              return (
                <TaskMaterialCard key={material.id} material={material} selected={selected}>
                  {selected ? (
                    <button type="button" className="wb-button wb-button-quiet wb-button-small"
                      onClick={() => setMaterialIds(ids => ids.filter(id => id !== material.id))}>
                      移除材料
                    </button>
                  ) : (
                    <button type="button" className="wb-button wb-button-secondary wb-button-small"
                      disabled={material.status !== "ready"}
                      onClick={() => setMaterialIds(ids => ids.includes(material.id) ? ids : [...ids, material.id])}>
                      附带此材料
                    </button>
                  )}
                </TaskMaterialCard>
              )
            })}
            {missingIds.map(id => (
              <div key={id} className="project-task-missing">
                <span>引用不可用</span>
                <button type="button" className="wb-button wb-button-quiet wb-button-small"
                  onClick={() => setMaterialIds(ids => ids.filter(value => value !== id))}>
                  移除材料
                </button>
              </div>
            ))}
          </section>
        </fieldset>
        {blockedByMaterial && <p className="project-task-error" role="status">请移除不可用的材料后发布。</p>}
        {(submission?.status === "rejected" || submission?.status === "unknown") &&
          <p className="project-task-error" role="alert">{submission.message}</p>}
        {submission?.status === "submitting" && <p className="wb-sr-only" role="status">正在发布任务</p>}
        <div className="project-task-dialog-footer">
          <button type="button" className="wb-button wb-button-secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="wb-button wb-button-primary" disabled={!canPublish} onClick={() => void submit()}>
            {submission?.status === "submitting" ? "正在发布…" : uncertain ? "重试发布" : "发布任务"}
          </button>
        </div>
      </form>
    </dialog>
  )
}
