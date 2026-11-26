/** 统一项目看板：合并 HC-220 看板与 HC-219 任务管理，支持状态四列 / 成员进展视角切换与右侧滑出任务抽屉。 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { IconRefresh, IconX } from "@tabler/icons-react"
import type { BoardConversation, BoardResponse, TaskSummary } from "@workbench/collaboration-client/types"
import type { ProjectUpdatesStatus } from "../../../shared/index.js"
import { MemberAvatar } from "../../../ui/index.js"
import { formatRelativeTime } from "../inbox/inbox-model.js"
import type { SessionSyncState } from "../session/contracts.js"
import { formatShortTime } from "../session/session-model.js"
import {
  boardTaskStatusTone,
  boardTaskStatuses,
  buildBoardModel,
  buildBoardTaskColumns,
  getBoardSyncLabel,
  type BoardTaskScope,
  type BoardViewMode,
} from "./board-model.js"
import "./project-board.css"

export interface BoardProjectOption {
  readonly projectId: string
  readonly name: string
  readonly status: string
}

export interface ProjectBoardProps {
  readonly projectName: string
  readonly description?: string | undefined
  readonly accountId: string
  readonly localDeviceId: string | null
  readonly syncStates: Readonly<Record<string, SessionSyncState>>
  readonly data: BoardResponse | null
  readonly updatedAt: number | null
  readonly busy: boolean
  readonly error: string
  readonly notification: ProjectUpdatesStatus
  readonly projects?: readonly BoardProjectOption[] | undefined
  readonly currentProjectId?: string | null | undefined
  readonly allTasks?: readonly TaskSummary[] | undefined
  readonly tasksLoading?: boolean | undefined
  readonly tasksError?: string | undefined
  readonly activeTaskId?: string | null | undefined
  readonly onRefresh: () => void
  readonly onOpenProject: () => void
  readonly onOpenTasks: () => void
  readonly onOpenTask: (taskId: string) => void
  readonly onCloseTask?: (() => void) | undefined
  readonly onSelectProject?: ((projectId: string) => void) | undefined
  readonly onOpenConversation: (conversation: BoardConversation["conversation"]) => boolean
  readonly onCreateTask?: (() => void) | undefined
  readonly resolveOwnerName?: ((userId: string) => string) | undefined
  readonly onQuickAcceptTask?: ((task: TaskSummary) => Promise<string | null>) | undefined
  readonly renderTaskDrawer?: ((taskId: string, onClose: () => void) => ReactNode) | undefined
}

const statusLabels: Record<ProjectUpdatesStatus, string> = {
  connecting: "正在连接通知",
  connected: "通知已连接",
  retrying: "通知中断，正在重连",
  unavailable: "通知不可用",
}

const notificationTones: Record<ProjectUpdatesStatus, "info" | "success" | "warn" | "muted"> = {
  connecting: "info",
  connected: "success",
  retrying: "warn",
  unavailable: "muted",
}

const conversationLabels = {
  idle: "空闲", running: "执行中", waiting_approval: "待批准", error: "出错",
}

const scopeFilters: ReadonlyArray<{ readonly id: BoardTaskScope; readonly label: string }> = [
  { id: "all", label: "全部任务" },
  { id: "assigned", label: "指派给我" },
  { id: "published", label: "我发布的" },
]

export function ProjectBoard(props: ProjectBoardProps) {
  const {
    projectName,
    description,
    accountId,
    localDeviceId,
    syncStates,
    data,
    updatedAt,
    busy,
    error,
    notification,
    projects,
    currentProjectId,
    allTasks,
    tasksLoading = false,
    tasksError = "",
    activeTaskId = null,
    onCloseTask,
  } = props

  const [viewMode, setViewMode] = useState<BoardViewMode>("status")
  const [taskScope, setTaskScope] = useState<BoardTaskScope>("all")
  const [showCancelled, setShowCancelled] = useState(false)
  const [locateError, setLocateError] = useState("")
  const [actionError, setActionError] = useState("")
  const [acceptingTaskId, setAcceptingTaskId] = useState<string | null>(null)
  const drawerRef = useRef<HTMLElement>(null)

  const model = useMemo(() => (data ? buildBoardModel(data) : null), [data])
  const taskSource = allTasks ?? data?.tasks ?? []
  const columnsModel = useMemo(
    () => buildBoardTaskColumns({ tasks: taskSource, scope: taskScope, accountId }),
    [taskSource, taskScope, accountId],
  )

  useEffect(() => {
    setActionError("")
    setLocateError("")
  }, [currentProjectId])

  useEffect(() => {
    if (!activeTaskId) return
    const drawer = drawerRef.current
    if (!drawer) return
    if (!drawer.contains(document.activeElement)) {
      drawer.focus({ preventScroll: true })
    }
  }, [activeTaskId])

  // 当已有模态 <dialog>（如任务创建或本机开始弹窗）或全局命令面板打开时，交由上层优先处理 Esc。
  useEffect(() => {
    if (!activeTaskId || !onCloseTask) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector("dialog[open], .palette-wrap")) return
      event.preventDefault()
      onCloseTask()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [activeTaskId, onCloseTask])

  const resolveName = (userId: string) => {
    if (props.resolveOwnerName) return props.resolveOwnerName(userId)
    return model?.names.get(userId) || "项目成员"
  }

  const handleCloseDrawer = () => {
    if (onCloseTask) onCloseTask()
    else props.onOpenTasks()
  }

  const handleQuickAccept = async (task: TaskSummary) => {
    if (!props.onQuickAcceptTask || acceptingTaskId) return
    setAcceptingTaskId(task.taskId)
    setActionError("")
    try {
      const err = await props.onQuickAcceptTask(task)
      if (err) setActionError(err)
    } catch {
      setActionError("接收任务失败，请打开详情重试。")
    } finally {
      setAcceptingTaskId(null)
    }
  }

  const currentProjectMeta = projects?.find(p => p.projectId === currentProjectId)
  const showCreateButton = Boolean(props.onCreateTask || currentProjectMeta)
  const hasTasksReady = allTasks !== undefined || Boolean(data)
  const combinedError = error || tasksError || locateError || actionError

  return (
    <div className="project-board-scroll">
      <main className="project-board page-shell" aria-label="Project 看板">
        <header className="page-head project-board-head">
          <div>
            <h1 className="sr">Project 看板</h1>
            <p>{description?.trim() ? description : `${projectName} · 统一追踪任务四列流转与成员协同进展`}</p>
          </div>
          <div className="project-board-actions">
            <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={props.onOpenProject}>
              项目资料
            </button>
            <button
              type="button"
              className="wb-button wb-button-secondary wb-button-small"
              disabled={busy || tasksLoading}
              onClick={() => {
                setLocateError("")
                setActionError("")
                props.onRefresh()
              }}
            >
              <IconRefresh size={13} aria-hidden="true" />
              <span>{busy || tasksLoading ? "刷新中…" : "刷新"}</span>
            </button>
            {showCreateButton && (
              <button
                type="button"
                className="wb-button wb-button-primary wb-button-small"
                disabled={!props.onCreateTask}
                title={!props.onCreateTask ? "仅活跃协作项目可新建并指派任务" : undefined}
                onClick={props.onCreateTask}
              >
                新建并指派任务
              </button>
            )}
          </div>
        </header>

        <div className="view-bar project-board-bar">
          <div className="seg" role="tablist" aria-label="看板视角">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "status"}
              className={viewMode === "status" ? "is-active" : undefined}
              onClick={() => setViewMode("status")}
            >
              状态四列
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "members"}
              className={viewMode === "members" ? "is-active" : undefined}
              onClick={() => setViewMode("members")}
            >
              成员进展
            </button>
          </div>

          {projects && projects.length > 0 && props.onSelectProject && (
            <select
              className="c4-select project-board-select"
              aria-label="选择 Project"
              value={currentProjectId ?? ""}
              onChange={event => props.onSelectProject?.(event.target.value)}
            >
              {projects.map(project => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name}{project.status === "archived" ? "（已归档）" : ""}
                </option>
              ))}
            </select>
          )}

          {viewMode === "status" && (
            <div className="project-board-scope-pills" role="group" aria-label="任务归属筛选">
              {scopeFilters.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`project-board-filter-btn${taskScope === item.id ? " is-soft" : ""}`}
                  aria-pressed={taskScope === item.id}
                  onClick={() => setTaskScope(item.id)}
                >
                  {item.label}
                </button>
              ))}
              {columnsModel.counts.cancelled > 0 && (
                <button
                  type="button"
                  className={`project-board-filter-btn${showCancelled ? " is-soft" : ""}`}
                  aria-pressed={showCancelled}
                  onClick={() => setShowCancelled(prev => !prev)}
                >
                  已取消 ({columnsModel.counts.cancelled})
                </button>
              )}
            </div>
          )}

          <span className="vb-spacer" />

          <div className="project-board-status-group">
            {viewMode === "status" && hasTasksReady && (
              <span className="project-board-summary">
                <strong>{columnsModel.counts.active}</strong> 项推进中 · <strong>{columnsModel.counts.done}</strong> 项已完成
              </span>
            )}
            {viewMode === "members" && data && model && (
              <span className="project-board-summary">
                <strong>{model.activeMembers}</strong> 人 · <strong>{data.conversations.length}</strong> 条会话 · <strong>{data.tasks.length}</strong> 项未结束
              </span>
            )}
            {updatedAt !== null && !busy && (
              <span className="project-board-updated">更新于 {formatShortTime(updatedAt)}</span>
            )}
            <span
              className="hui-badge project-board-notification"
              data-tone={notificationTones[notification]}
              data-size="xs"
              role="status"
              aria-live="polite"
            >
              <span className="hui-lamp" aria-hidden="true" />
              <span>{statusLabels[notification]}</span>
            </span>
          </div>
        </div>

        {combinedError && (
          <p className="project-board-error" role="alert">{combinedError}</p>
        )}

        {viewMode === "status" ? (
          tasksLoading && !hasTasksReady ? (
            <div className="panel project-board-empty-panel" role="status">
              <p className="project-board-empty">正在加载项目任务四列视图…</p>
            </div>
          ) : (
            <>
              <section className="board" aria-label="任务状态四列">
                {columnsModel.columns.map(col => (
                  <section key={col.status} className="col" aria-label={col.label} title={col.tasks.length === 0 ? `暂无${col.label}任务` : undefined}>
                    <header className="col-head">
                      <span className="hui-badge" data-tone={boardTaskStatusTone(col.status)} data-size="xs">
                        {col.label}
                      </span>
                      <span className="c-count">{col.tasks.length}</span>
                    </header>
                    {col.tasks.length === 0 ? (
                      <p className="project-board-empty col-empty">暂无{col.label}任务</p>
                    ) : (
                      col.tasks.map(task => {
                        const assigneeName = resolveName(task.assigneeId)
                        const creatorName = resolveName(task.creatorId)
                        const isActive = activeTaskId === task.taskId
                        const canQuickAccept = task.status === "todo"
                          && task.assigneeId === accountId
                          && Boolean(props.onQuickAcceptTask)
                        return (
                          <article key={task.taskId} className={`tcard${isActive ? " is-active" : ""}`}>
                            <button
                              type="button"
                              className="tcard-main"
                              onClick={() => props.onOpenTask(task.taskId)}
                            >
                              <span className="t-title">{task.title}</span>
                              <span className="t-meta">
                                <MemberAvatar
                                  initial={(assigneeName || "?").slice(0, 1)}
                                  self={task.assigneeId === accountId}
                                  size={18}
                                />
                                <span className="t-assignee">{assigneeName}</span>
                                <span aria-hidden="true">·</span>
                                <span className="t-creator">{creatorName} 发布</span>
                                <span aria-hidden="true">·</span>
                                <span>{formatRelativeTime(task.updatedAtMs)}</span>
                              </span>
                              <span className="t-tags">
                                <span className="hui-badge mono" data-tone="muted" data-size="xs">v{task.version}</span>
                                {task.conversationId && (
                                  <span className="hui-badge" data-tone="info" data-size="xs">已关联会话</span>
                                )}
                              </span>
                            </button>
                            {canQuickAccept && (
                              <div className="tcard-acts">
                                <button
                                  type="button"
                                  className="wb-button wb-button-soft wb-button-xs"
                                  disabled={acceptingTaskId === task.taskId}
                                  onClick={() => { void handleQuickAccept(task) }}
                                >
                                  {acceptingTaskId === task.taskId ? "接收中…" : "接收任务"}
                                </button>
                                <button
                                  type="button"
                                  className="wb-button wb-button-quiet wb-button-xs"
                                  onClick={() => props.onOpenTask(task.taskId)}
                                >
                                  详情
                                </button>
                              </div>
                            )}
                          </article>
                        )
                      })
                    )}
                  </section>
                ))}
              </section>

              {allTasks === undefined && data?.tasksTruncated && (
                <p className="project-board-empty" role="status">仅展示最近 100 项未结束任务。</p>
              )}

              {showCancelled && columnsModel.cancelledTasks.length > 0 && (
                <section className="panel project-board-cancelled" aria-label="已取消任务归档">
                  <div className="panel-head">
                    <h2>已取消任务（{columnsModel.cancelledTasks.length}）</h2>
                  </div>
                  <div className="project-board-cancelled-list">
                    {columnsModel.cancelledTasks.map(task => (
                      <button
                        key={task.taskId}
                        type="button"
                        className={`k-row project-board-cancelled-row${activeTaskId === task.taskId ? " is-active" : ""}`}
                        onClick={() => props.onOpenTask(task.taskId)}
                      >
                        <span className="kr-title">{task.title}</span>
                        <span className="kr-meta">
                          <span className="hui-badge" data-tone="danger" data-size="xs">{boardTaskStatuses.cancelled}</span>
                          <span>受让人：{resolveName(task.assigneeId)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatRelativeTime(task.updatedAtMs)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )
        ) : (
          data && model ? (
            <section aria-labelledby="board-members">
              <div className="project-board-section">
                <h2 id="board-members">成员协同进展</h2>
                {data.conversationsTruncated && <span>仅展示最近 100 条会话</span>}
              </div>
              {model.members.length === 0 ? (
                <div className="panel project-board-empty-panel">
                  <p className="project-board-empty">暂无项目成员。</p>
                </div>
              ) : (
                <div className="project-board-grid">
                  {model.members.map(member => (
                    <article className="project-board-member" key={member.userId}>
                      <header>
                        <MemberAvatar initial={member.name.slice(0, 1) || "?"} self={member.userId === accountId} size={24} />
                        <strong>{member.name || "项目成员"}</strong>
                        <span
                          className="hui-badge"
                          data-tone={member.status === "removed" ? "warn" : member.deviceOnline ? "success" : "muted"}
                          data-size="xs"
                        >
                          {member.status === "removed" ? "已离开" : member.deviceOnline ? "有设备在线" : "设备离线"}
                        </span>
                      </header>
                      {(member.received > 0 || member.sent > 0) && (
                        <p className="project-board-meta">
                          接收 {member.received} 项 · 发起 {member.sent} 项
                        </p>
                      )}
                      {member.conversations.length === 0 && (
                        <p className="project-board-empty">暂无共享会话简报。</p>
                      )}
                      {member.conversations.map(row => {
                        const item = row.conversation
                        return (
                          <button
                            type="button"
                            className="project-board-conversation"
                            key={item.conversationId}
                            onClick={() => {
                              setLocateError(props.onOpenConversation(item) ? "" : "会话暂时无法定位，请刷新看板。")
                            }}
                          >
                            <strong>{item.title || "未命名会话"}</strong>
                            {item.briefText && <span className="project-board-brief">{item.briefText}</span>}
                            <span className="project-board-meta">
                              {item.shareMode === "summary_only" ? "仅共享状态与成果摘要" : conversationLabels[item.status]}
                              {" · "}
                              {item.shareStatus === "stopped"
                                ? "已停止同步（只读）"
                                : row.deviceOnline ? "原设备在线" : "原设备离线"}
                            </span>
                            <span className="project-board-meta">
                              {item.shareMode === "summary_only"
                                ? (item.briefUpdatedAtMs > 0 ? `摘要更新 ${formatShortTime(item.briefUpdatedAtMs)}` : "暂无摘要记录")
                                : item.syncedSequence > 0 && item.briefUpdatedAtMs > 0
                                  ? `最近上传 ${formatShortTime(item.briefUpdatedAtMs)}`
                                  : "暂无上传记录"}
                            </span>
                            <span className="project-board-sync">
                              {getBoardSyncLabel(row, accountId, localDeviceId, syncStates[item.conversationId])}
                            </span>
                          </button>
                        )
                      })}
                    </article>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <div className="panel project-board-empty-panel" role="status">
              <p className="project-board-empty">{busy ? "正在读取成员协同进展…" : "暂无法读取成员协同进展，请点击刷新重试。"}</p>
            </div>
          )
        )}
      </main>

      {activeTaskId && (
        <>
          <div className="t-drawer-backdrop" aria-hidden="true" onClick={handleCloseDrawer} />
          <aside ref={drawerRef} tabIndex={-1} className="t-drawer" role="dialog" aria-modal="false" aria-label="任务详情抽屉">
            <div className="t-drawer-head">
              <span className="t-drawer-kicker">任务详情</span>
              <button
                type="button"
                className="wb-icon-button t-drawer-x"
                aria-label="关闭任务详情"
                title="关闭 (Esc)"
                onClick={handleCloseDrawer}
              >
                <IconX size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="t-drawer-body">
              {props.renderTaskDrawer
                ? props.renderTaskDrawer(activeTaskId, handleCloseDrawer)
                : <p className="project-board-empty" role="status">任务详情服务尚未接入，请重连协作服务后查看。</p>}
            </div>
          </aside>
        </>
      )}
    </div>
  )
}
