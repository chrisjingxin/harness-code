/**
 * HC-212 产品任务装配。列表只取摘要，详情按已保存标识读材料。
 * 角色与状态决定展示的动作，版本校验、关联和重放以服务结果为准。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { CollaborationResult, TaskDetail, TaskStatus, TaskSummary } from "@workbench/contracts"
import type { CollaborationAppsHost } from "../../../../collaboration-apps-host.js"
import { knowledgeReferenceId, parseFixedReference } from "../../../../collaboration-reference.js"
import type { ProjectNavigationScope, ProjectNavigator } from "../../project-navigation/index.js"
import type { ProjectConversationSummary, SessionDraftScope, SessionDraftTarget, SessionIntegrationApi } from "../../session/index.js"
import { readPages } from "../metadata.js"
import { readFixedMaterial, snapshotMaterial } from "../references/fixed-materials.js"
import { snapshotReferenceView } from "../references/conversation-references.js"
import type { ConversationSnapshot } from "../references/conversation-references.js"
import { ProjectTaskDetail, ProjectTaskList, TaskMaterialCard } from "./project-tasks.js"
import type { ProjectTaskSummary, TaskMaterial, TaskMember } from "./project-tasks.js"
import { PublishTaskDialog } from "./publish-task-dialog.js"

export const labels: Record<TaskStatus, string> = {
  todo: "待接收", doing: "进行中", review: "待验收", done: "已完成", cancelled: "已取消",
}

type TaskRows =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tasks: readonly TaskSummary[] }

/** 项目左栏数量和任务列表共用本轮摘要。范围变化后旧页结果不显示。 */
export function useProjectTaskMetadata(host: CollaborationAppsHost | undefined, scope: ProjectNavigationScope | null, revision: number): TaskRows {
  const [state, setState] = useState<{ scope: ProjectNavigationScope; rows: TaskRows }>()
  useEffect(() => {
    if (!host || !scope) return
    let active = true
    void readPages(afterId => host.listTasks(scope.workspaceId, scope.projectId, afterId), page => page.tasks, () => active)
      .then(tasks => {
        if (active) setState({ scope, rows: { status: "ready", tasks: tasks.filter(task => task.projectId === scope.projectId) } })
      }).catch(error => {
        if (active) setState({ scope, rows: { status: "error", message: error instanceof Error ? error.message : "无法读取任务列表。" } })
      })
    return () => { active = false }
  }, [host, scope, revision])
  return scope && state?.scope === scope ? state.rows : { status: "loading" }
}

export type TasksContext = {
  readonly host: CollaborationAppsHost
  readonly scope: ProjectNavigationScope
  readonly projectName: string
  readonly projectActive: boolean
  readonly ownerName: (id: string) => string
  readonly localDeviceId: string | null
  readonly sessions: SessionIntegrationApi
  readonly directories: Readonly<Record<string, string | null>>
  chooseDirectory(): Promise<string | null>
  locateConversation(conversation: ProjectConversationSummary): boolean
  refreshTaskMetadata(scope: ProjectNavigationScope): void
}

function taskView(task: TaskSummary, ownerName: (id: string) => string): ProjectTaskSummary {
  return {
    id: task.taskId, title: task.title, statusLabel: labels[task.status],
    publisher: { id: task.creatorId, name: ownerName(task.creatorId) },
    assignee: { id: task.assigneeId, name: ownerName(task.assigneeId) },
  }
}

function fixedIds(detail: TaskDetail): string[] {
  return [...detail.snapshotIds, ...detail.knowledgeRefs.map(knowledgeReferenceId)]
}

export function ProjectTaskPublication({ context, members, draftMaterials, sources, assigneeId, onClose, onPublished }: {
  readonly context: TasksContext
  readonly members: readonly TaskMember[]
  readonly draftMaterials: readonly ConversationSnapshot[]
  readonly sources: readonly ProjectConversationSummary[]
  readonly assigneeId?: string
  onClose(): void
  onPublished(taskId: string): void
}) {
  const { host, scope, ownerName, refreshTaskMetadata } = context
  return <PublishTaskDialog
    scope={scope}
    members={members}
    materials={draftMaterials.filter(item => !item.archived).map(item => snapshotReferenceView(item))}
    sources={sources.map(item => ({ id: item.conversationId, name: item.title || "未命名会话" }))}
    initialAssigneeId={assigneeId}
    readMaterial={async sourceId => {
      const source = context.sessions.listProjectConversations(scope).find(item => item.conversationId === sourceId)
      if (!source) throw new Error("来源会话暂不可用。")
      const result = await host.createSnapshot(scope.workspaceId, scope.projectId, {
        sourceConversationId: sourceId,
        ...(source.syncedSequence === 0 && source.briefText.trim() ? { range: { type: "brief" } } : {}),
      })
      if (!result.ok) throw new Error(result.error.message)
      return snapshotReferenceView(snapshotMaterial(result.value, ownerName))
    }}
    publishTask={async (_scope, input) => {
      const snapshotIds: string[] = []
      const knowledgeRefs: { knowledgeId: string; versionId: string }[] = []
      for (const id of input.materialIds) {
        const reference = parseFixedReference(id)
        if (!reference) return { status: "rejected", message: "该固定材料已不可用。" }
        if (reference.kind === "snapshot") snapshotIds.push(reference.snapshotId)
        else knowledgeRefs.push({ knowledgeId: reference.knowledgeId, versionId: reference.versionId })
      }
      const result = await host.createTask(scope.workspaceId, scope.projectId, {
        title: input.title, description: input.description, assigneeId: input.assigneeId,
        requestId: input.requestId, snapshotIds, knowledgeRefs,
      })
      if (!result.ok) return {
        status: uncertain(result.error.code) ? "unknown" : "rejected",
        message: result.error.message,
      }
      if (result.value.task.projectId !== scope.projectId) return { status: "unknown", message: "发布范围待确认，请重试同一请求。" }
      refreshTaskMetadata(scope)
      return { status: "published", taskId: result.value.task.taskId }
    }}
    onClose={onClose}
    onPublished={onPublished}
  />
}

const uncertain = (code: string) => ["NETWORK_UNAVAILABLE", "INVALID_SERVER_RESPONSE", "INTERNAL_ERROR"].includes(code)

export function LiveProjectTasks({ context, rows, taskId, navigator, onCreate }: {
  readonly context: TasksContext
  readonly rows: TaskRows
  readonly taskId?: string
  readonly navigator: ProjectNavigator
  onCreate(): void
}) {
  const { scope, projectName, projectActive, ownerName, refreshTaskMetadata } = context
  if (taskId) return <LiveTaskDetail context={context} taskId={taskId} navigator={navigator} />
  if (rows.status !== "ready") return <section className="project-task-page">
    <h1>项目任务</h1>
    <p role={rows.status === "error" ? "alert" : "status"}>{rows.status === "error" ? rows.message : "正在读取项目任务…"}</p>
    {rows.status === "error" && <button className="wb-button wb-button-secondary" onClick={() => refreshTaskMetadata(scope)}>重试</button>}
  </section>
  return <ProjectTaskList accountId={scope.accountId} projectName={projectName}
    tasks={rows.tasks.map(task => taskView(task, ownerName))}
    onCreateTask={projectActive ? onCreate : undefined}
    onOpenTask={id => navigator.openPage({ kind: "task", taskId: id })} />
}

function LiveTaskDetail({ context, taskId, navigator }: { context: TasksContext; taskId: string; navigator: ProjectNavigator }) {
  const { host, scope, projectActive, ownerName, localDeviceId, sessions } = context
  const { workspaceId, projectId, accountId } = scope
  const mounted = useRef(false)
  const replay = useRef<{ signature: string; requestId: string } | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [materials, setMaterials] = useState<TaskMaterial[]>([])
  const [notice, setNotice] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const applying = useRef(false)
  const [description, setDescription] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [commitSha, setCommitSha] = useState("")
  const [linkId, setLinkId] = useState("")
  const [draftAction, setDraftAction] = useState<"reference" | "start" | null>(null)
  const back = () => navigator.openPage({ kind: "tasks" })
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let current = true
    setNotice("")
    void host.readTask(workspaceId, projectId, taskId).then(result => {
      if (!current) return
      if (!result.ok) { setDetail(null); setNotice(result.error.message); return }
      if (result.value.task.projectId !== projectId || result.value.task.taskId !== taskId) {
        setNotice("返回任务与当前项目不一致。")
        return
      }
      setDetail(result.value)
    }).catch(() => { if (current) setNotice("无法读取任务，请重试。") })
    return () => { current = false }
  }, [host, workspaceId, projectId, taskId, attempt])

  const materialKey = JSON.stringify(detail ? fixedIds(detail) : [])
  useEffect(() => {
    let current = true
    const ids = JSON.parse(materialKey) as string[]
    setMaterials(ids.map(id => ({
      id, status: "loading", sourceLabel: "", rangeLabel: "", snapshotText: "", message: "正在读取固定材料…",
    })))
    void Promise.all(ids.map(async (id): Promise<TaskMaterial> => {
      try {
        const result = await readFixedMaterial(host, scope, id, ownerName)
        if (result.ok) return snapshotReferenceView(result.value)
        return { id, status: "unavailable", sourceLabel: "", rangeLabel: "", snapshotText: "", message: result.error.message }
      } catch {
        return { id, status: "error", sourceLabel: "", rangeLabel: "", snapshotText: "", message: "无法读取固定材料。" }
      }
    })).then(items => { if (current) setMaterials(items) })
    return () => { current = false }
  }, [host, scope, materialKey, attempt])

  if (!detail) return <section className="project-task-page">
    <button type="button" className="wb-button wb-button-quiet wb-button-small project-task-back" onClick={back}>返回项目任务</button>
    <h1>任务详情</h1>
    <p role={notice ? "alert" : "status"}>{notice || "正在读取任务…"}</p>
    {notice && <button type="button" className="wb-button wb-button-secondary" onClick={() => setAttempt(value => value + 1)}>重试</button>}
  </section>

  const task = detail.task
  const creator = projectActive && task.creatorId === accountId
  const assignee = projectActive && task.assigneeId === accountId
  const currentLocal = sessions.listMyLocalConversations(scope)
  const canStart = assignee && task.status === "doing" && Boolean(localDeviceId)
  const canReference = Boolean(localDeviceId && materials.length && materials.every(material => material.status === "ready"))
  const linked = task.conversationId
  const display = { ...taskView(task, ownerName), description: detail.description, materials }

  async function write(intent: object, send: (requestId: string) => Promise<CollaborationResult<TaskDetail>>) {
    if (applying.current) return
    const signature = JSON.stringify([task.version, intent])
    if (replay.current?.signature !== signature) replay.current = { signature, requestId: crypto.randomUUID() }
    applying.current = true
    setBusy(true)
    setNotice("")
    try {
      const result = await send(replay.current.requestId)
      if (!mounted.current) return
      if (!result.ok) { setNotice(result.error.message); return }
      if (result.value.task.projectId !== projectId || result.value.task.taskId !== taskId) {
        setNotice("无法确认更新结果，可使用同一请求重试。")
        return
      }
      setDetail(result.value)
      setDescription(null)
      setNote("")
      setCommitSha("")
      context.refreshTaskMetadata(scope)
    } catch {
      if (mounted.current) setNotice("更新结果待确认，可使用同一请求重试。")
    } finally {
      applying.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const transition = (status: TaskStatus) => {
    const extra = { ...(note.trim() ? { note: note.trim() } : {}), ...(status === "review" && commitSha.trim() ? { commitSha: commitSha.trim() } : {}) }
    void write({ status, ...extra }, requestId => host.transitionTask(workspaceId, projectId, taskId, {
      targetStatus: status, expectedVersion: task.version, requestId, ...extra,
    }))
  }

  return <ProjectTaskDetail task={display} onBack={back}>
    <section className="project-task-detail-section">
      <div className="project-task-section-head">
        <h2>任务操作</h2>
        <span className="project-task-version">版本 {task.version}</span>
        <button type="button" className="wb-button wb-button-quiet wb-button-small" disabled={busy} onClick={() => setAttempt(value => value + 1)}>刷新任务</button>
      </div>
      {(canReference || linked) && (
        <div className="project-task-action-row">
          {canReference && <button type="button" className="wb-button wb-button-secondary" onClick={() => setDraftAction("reference")}>引用任务材料</button>}
          {linked && <button type="button" className="wb-button wb-button-secondary" onClick={() => {
            if (!navigator.locateConversation(linked)) setNotice("关联会话当前不可用。")
          }}>打开关联会话</button>}
        </div>
      )}
      <fieldset className="project-task-fields" disabled={busy}>
        <legend className="wb-sr-only">可用操作</legend>
        {creator && task.status === "todo" && <>
          <label>编辑任务说明<textarea value={description ?? detail.description} onChange={event => setDescription(event.target.value)} /></label>
          <button type="button" className="wb-button wb-button-secondary" disabled={!description?.trim()} onClick={() => {
            if (!description) return
            void write({ description }, requestId => host.editTask(workspaceId, projectId, taskId, { description, expectedVersion: task.version, requestId }))
          }}>保存说明</button>
        </>}
        {assignee && task.status === "todo" && <button type="button" className="wb-button wb-button-primary" onClick={() => transition("doing")}>接收任务</button>}
        {assignee && task.status === "doing" && <>
          {!linked && currentLocal.length > 0 && <>
            <label>本机会话<select value={linkId} onChange={event => setLinkId(event.target.value)}>
              <option value="">选择会话</option>
              {currentLocal.map(item => <option key={item.conversationId} value={item.conversationId}>{item.title || "未命名会话"}</option>)}
            </select></label>
            <button type="button" className="wb-button wb-button-secondary" disabled={!linkId} onClick={() => void write({ linkId }, requestId =>
              host.linkTaskConversation(workspaceId, projectId, taskId, { conversationId: linkId, expectedVersion: task.version, requestId }),
            )}>关联会话</button>
          </>}
          <button type="button" className="wb-button wb-button-primary" disabled={!canStart} onClick={() => setDraftAction("start")}>在本机开始</button>
          <label>验收说明<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
          <label>提交标识（可选）<input value={commitSha} onChange={event => setCommitSha(event.target.value)} /></label>
          <button type="button" className="wb-button wb-button-secondary" disabled={Boolean(commitSha.trim() && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha.trim()))}
            onClick={() => transition("review")}>提交验收</button>
        </>}
        {creator && task.status === "review" && <>
          <label>验收说明<textarea value={note} onChange={event => setNote(event.target.value)} /></label>
          <div className="project-task-action-row">
            <button type="button" className="wb-button wb-button-primary" onClick={() => transition("done")}>通过验收</button>
            <button type="button" className="wb-button wb-button-secondary" onClick={() => transition("todo")}>退回待接收</button>
          </div>
        </>}
        {creator && ["todo", "doing", "review"].includes(task.status) &&
          <button type="button" className="wb-button wb-button-secondary" onClick={() => transition("cancelled")}>取消任务</button>}
      </fieldset>
      {notice && <p className="project-task-error" role="alert">{notice}</p>}
    </section>
    <section className="project-task-detail-section">
      <h2>流转记录</h2>
      <ol className="project-task-transitions">{detail.transitions.map(item => <li key={item.version}>
        {ownerName(item.actorId)} · {item.fromStatus ? `${labels[item.fromStatus]} → ` : ""}{labels[item.toStatus]} · v{item.version}
        {" · "}<time dateTime={new Date(item.occurredAtMs).toISOString()}>{new Date(item.occurredAtMs).toLocaleString()}</time>
        {item.note && <p className="project-task-text">{item.note}</p>}
        {item.commitSha && <p><code>{item.commitSha}</code></p>}
      </li>)}</ol>
    </section>
    {draftAction && localDeviceId && <TaskDraftDialog context={context} detail={detail} materials={materials}
      deviceId={localDeviceId} action={draftAction} onClose={() => setDraftAction(null)} />}
  </ProjectTaskDetail>
}

function TaskDraftDialog({ context, detail, deviceId, action, materials, onClose }: {
  context: TasksContext; detail: TaskDetail; deviceId: string; action: "reference" | "start"; materials: readonly TaskMaterial[]; onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const mounted = useRef(false)
  const [choice, setChoice] = useState(detail.task.conversationId ?? "")
  const [prepared, setPrepared] = useState<Extract<SessionDraftTarget, { kind: "new" }> | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const scope: SessionDraftScope = { ...context.scope, conversationId: null, deviceId }
  const local = context.sessions.listMyLocalConversations(scope)
  useLayoutEffect(() => {
    mounted.current = true
    const element = dialog.current
    element?.showModal()
    return () => { mounted.current = false; element?.close() }
  }, [])

  function locate(id: string) {
    const target = context.sessions.listMyLocalConversations(scope).find(item => item.conversationId === id)
    if (!target || !context.locateConversation(target)) { setError("草稿已准备，请重试打开目标会话。"); return }
    context.sessions.revealReferenceDraft(scope, id)
    onClose()
  }

  async function apply() {
    const target = choice === "new" ? prepared : { kind: "existing" as const, conversationId: choice }
    if (!target || busy) return
    setBusy(true)
    setError("")
    try {
      const latest = await context.host.readTask(scope.workspaceId, scope.projectId, detail.task.taskId)
      if (!mounted.current) return
      if (!latest.ok) { setError(latest.error.message); return }
      if (latest.value.task.projectId !== scope.projectId || latest.value.task.taskId !== detail.task.taskId
        || (action === "start" && (latest.value.task.assigneeId !== scope.accountId
          || latest.value.task.status !== "doing" || latest.value.task.version !== detail.task.version))) {
        setError("任务已变化，请刷新后重新准备。")
        return
      }
      const ids = fixedIds(latest.value)
      if (action === "reference" && JSON.stringify(ids) !== JSON.stringify(fixedIds(detail))) {
        setError("任务材料已变化，请刷新后重新预览。")
        return
      }
      const result = await context.sessions.applyReferenceDraft(scope, {
        kind: "add", target, referenceIds: ids,
        ...(action === "start" ? { initialText: [latest.value.task.title, latest.value.description].join("\n\n") } : {}),
      })
      if (!mounted.current) return
      if (!result.ok) {
        if (target.kind === "new" && result.preparedConversationId) setPrepared({ ...target, preparedConversationId: result.preparedConversationId })
        setError(result.message)
        return
      }
      setApplied(result.value.conversationId)
      locate(result.value.conversationId)
    } catch { if (mounted.current) setError("无法准备本机草稿，请重试。") }
    finally { if (mounted.current) setBusy(false) }
  }

  return <dialog className="project-task-dialog" ref={dialog} aria-labelledby={title} onCancel={event => {
    event.preventDefault()
    if (!busy) onClose()
  }}>
    <h2 id={title}>{action === "start" ? "在本机开始" : "引用任务材料"}</h2>
    {action === "start" ? <p>把任务说明和固定材料带入草稿，打开后由你确认并发送。</p> :
      <div>{materials.map(material => <TaskMaterialCard key={material.id} material={material} />)}</div>}
    <fieldset className="project-task-fields" disabled={busy || Boolean(applied)}>
      <label>目标会话<select value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="">选择本人本机会话</option>
        {local.map(item => <option key={item.conversationId} value={item.conversationId}>{item.title || "未命名会话"} {context.directories[item.conversationId] ?? ""}</option>)}
        <option value="new">新建会话</option>
      </select></label>
      {choice === "new" && <button className="wb-button wb-button-secondary" disabled={Boolean(prepared?.preparedConversationId)} onClick={() => {
        setBusy(true)
        void context.chooseDirectory().then(directory => {
          if (mounted.current && directory) setPrepared(previous => previous?.directory === directory ? previous : { kind: "new", directory, requestId: crypto.randomUUID() })
        }).catch(() => { if (mounted.current) setError("无法选择目录。") }).finally(() => { if (mounted.current) setBusy(false) })
      }}>{prepared?.directory ?? "选择工作目录"}</button>}
    </fieldset>
    {error && <p role="alert" className="project-task-error">{error}</p>}
    <div className="project-task-dialog-footer">
      <button className="wb-button wb-button-secondary" disabled={busy} onClick={onClose}>关闭</button>
      <button className="wb-button wb-button-primary" disabled={busy || !(applied || (choice === "new" ? prepared : local.some(item => item.conversationId === choice)))}
        onClick={() => { if (applied) locate(applied); else void apply() }}>
        {applied ? "重试打开会话" : action === "start" ? "准备本机草稿" : "加入草稿"}
      </button>
    </div>
  </dialog>
}
