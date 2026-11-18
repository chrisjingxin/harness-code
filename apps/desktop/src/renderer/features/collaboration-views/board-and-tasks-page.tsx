/**
 * Project 看板（四列）与任务双栏页（1:1 还原原型稿 viewBoard & viewTasks）。
 */
import { useState } from "react"
import type { ReactElement } from "react"
import type { NavigationMember, NavigationSessionEntry } from "@workbench/ui"
import { CheckIcon, ClockIcon, DotIcon, FileIcon, LockIcon, PlusIcon, SendArrowIcon } from "./collab-icons.js"
import { UserAvatar } from "./collab-overlays.js"
import { memberRoleLabel, TASK_PRIO_LABEL, TASK_STATUS_LABEL } from "./collab-store.js"
import type { CollabTask, CollabTaskStatus } from "./collab-store.js"

const BOARD_COLUMNS: readonly { status: CollabTaskStatus; label: string }[] = [
  { status: "open", label: "待认领" },
  { status: "claimed", label: "已认领 · 待启动" },
  { status: "running", label: "进行中" },
  { status: "done", label: "已完成" },
]

export function ProjectBoardPage({
  members,
  tasks,
  onGoTasks,
  onOpenTask,
}: {
  readonly projectName?: string
  readonly members: readonly NavigationMember[]
  readonly tasks: readonly CollabTask[]
  readonly onGoTasks: () => void
  readonly onOpenTask: (taskId: string) => void
}): ReactElement {
  const memberById = new Map(members.map(m => [m.userId, m]))

  return (
    <div className="collab-page-stage">
      <div className="view-bar">
        <span className="meta">{tasks.length} 个任务 · {members.length} 位成员</span>
        <span className="vb-spacer" />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onGoTasks}>去任务列表</button>
      </div>

      <div className="board">
        {BOARD_COLUMNS.map(col => {
          const items = tasks.filter(t => t.status === col.status)
          return (
            <div key={col.status} className="col">
              <div className="col-head">
                <span className="c-name">{col.label}</span>
                <span className="c-count">{items.length}</span>
              </div>
              <div className="col-body">
                {items.length ? items.map(t => {
                  const assignee = memberById.get(t.toUserId)
                  return (
                    <button key={t.id} type="button" className="tcard" onClick={() => onOpenTask(t.id)}>
                      <span className="t-title">{t.title}</span>
                      <span className="t-meta">
                        <UserAvatar user={assignee} name="成员" size={18} />
                        <span>{assignee?.userName ?? "团队成员"}</span>
                        <span className={`prio ${t.prio}`}>{TASK_PRIO_LABEL[t.prio]}</span>
                      </span>
                    </button>
                  )
                }) : <div className="col-empty">暂无任务</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ProjectTasksPage({
  projectName,
  selfUserId,
  members,
  tasks,
  sessions,
  selectedTaskId,
  onSelectTask,
  onClaimTask,
  onOpenStartDialog,
  onFinishTask,
  onOpenDispatchDialog,
  onGotoSession,
}: {
  readonly projectName: string
  readonly selfUserId: string
  readonly members: readonly NavigationMember[]
  readonly tasks: readonly CollabTask[]
  readonly sessions: readonly NavigationSessionEntry[]
  readonly selectedTaskId: string | null
  readonly onSelectTask: (taskId: string) => void
  readonly onClaimTask: (taskId: string) => void
  readonly onOpenStartDialog: (task: CollabTask) => void
  readonly onFinishTask: (taskId: string) => void
  readonly onOpenDispatchDialog: () => void
  readonly onGotoSession: (conversationId: string) => void
}): ReactElement {
  const [filter, setFilter] = useState<"assigned" | "published" | "all">("assigned")
  const memberById = new Map(members.map(m => [m.userId, m]))

  const filtered = tasks.filter(t => {
    if (filter === "assigned") return t.toUserId === selfUserId
    if (filter === "published") return t.fromUserId === selfUserId
    return true
  })

  const activeTask = filtered.find(t => t.id === selectedTaskId) ?? tasks.find(t => t.id === selectedTaskId) ?? filtered[0] ?? null
  const activeFrom = activeTask ? memberById.get(activeTask.fromUserId) : undefined
  const activeTo = activeTask ? memberById.get(activeTask.toUserId) : undefined
  const linkedSession = activeTask?.sessionId ? sessions.find(s => s.conversationId === activeTask.sessionId) : undefined

  return (
    <div className="collab-page-stage">
      <div className="view-bar">
        <div className="seg" role="tablist" aria-label="任务筛选">
          {([
            ["assigned", "指派给我"],
            ["published", "我发布的"],
            ["all", "项目全部"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={filter === id ? "is-active" : undefined}
              aria-selected={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="vb-spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={onOpenDispatchDialog}>
          <PlusIcon size={14} />
          <span>派发任务</span>
        </button>
      </div>

      <div className="tasks-layout">
        <div className="task-list">
          {filtered.length ? filtered.map(t => {
            const active = activeTask?.id === t.id
            const assignee = memberById.get(t.toUserId)
            return (
              <button
                key={t.id}
                type="button"
                className={`trow${active ? " is-active" : ""}`}
                onClick={() => onSelectTask(t.id)}
              >
                <span className="r-main">
                  <span className="r-title">{t.title}</span>
                  <span className="r-meta">
                    <UserAvatar user={assignee} name="成员" size={18} />
                    <span>{assignee?.userName ?? "团队成员"}</span>
                    <span className={`prio ${t.prio}`}>{TASK_PRIO_LABEL[t.prio]}</span>
                    <span className="od-nowrap">{t.time}</span>
                  </span>
                </span>
                <span className={`status-badge ${t.status}`}>{TASK_STATUS_LABEL[t.status]}</span>
              </button>
            )
          }) : (
            <div className="empty-block">
              <span className="eb-title">这里还没有任务</span>
              <span className="eb-body">换一个筛选条件看看，或者点击右上角「派发任务」。</span>
            </div>
          )}
        </div>

        {activeTask ? (
          <div className="detail">
            <div className="od-stack" style={{ ["--od-gap" as string]: "6px" }}>
              <span className="eyebrow">{projectName}</span>
              <h2>{activeTask.title}</h2>
            </div>
            <p className="desc">{activeTask.desc}</p>
            <dl className="kv">
              <dt>发布人</dt>
              <dd><UserAvatar user={activeFrom} name="成员" size={20} /><span>{activeFrom?.userName ?? "团队成员"}</span></dd>
              <dt>指派给</dt>
              <dd><UserAvatar user={activeTo} name="成员" size={20} /><span>{activeTo?.userName ?? "团队成员"} · {memberRoleLabel(activeTo)}</span></dd>
              <dt>优先级</dt>
              <dd><span className={`prio ${activeTask.prio}`}>{TASK_PRIO_LABEL[activeTask.prio]}</span></dd>
              <dt>当前状态</dt>
              <dd><span className={`status-badge ${activeTask.status}`}>{TASK_STATUS_LABEL[activeTask.status]}</span></dd>
              <dt>创建时间</dt>
              <dd style={{ color: "var(--fg-2)" }}>{activeTask.time}</dd>
              {linkedSession && (
                <>
                  <dt>关联会话</dt>
                  <dd>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ paddingLeft: 0 }} onClick={() => onGotoSession(linkedSession.conversationId)}>
                      <FileIcon size={14} />
                      <span>{linkedSession.title}</span>
                    </button>
                  </dd>
                </>
              )}
            </dl>

            {activeTask.toUserId !== selfUserId ? (
              <div className="detail-note"><LockIcon size={15} /><span>这个任务指派给了 {activeTo?.userName ?? "队友"}。只有被指派人可以认领和在本机开始。</span></div>
            ) : activeTask.status === "open" ? (
              <div className="detail-note"><DotIcon size={15} /><span>先认领任务，再决定什么时候在本机开跑。认领只是表态，不会启动任何进程。</span></div>
            ) : activeTask.status === "claimed" ? (
              <div className="detail-note"><LockIcon size={15} /><span>已认领。下一步「在本机开始」需要你自己选会话和工作目录，系统不会自动远程启动。</span></div>
            ) : activeTask.status === "running" ? (
              <div className="detail-note"><ClockIcon size={15} /><span>正在本机执行。任务状态会跟着会话走，会话结束之后再标记完成。</span></div>
            ) : (
              <div className="detail-note"><CheckIcon size={15} /><span>这个任务已经完成。</span></div>
            )}

            <div className="detail-actions">
              {activeTask.toUserId === selfUserId && activeTask.status === "open" && (
                <button type="button" className="btn btn-primary" onClick={() => onClaimTask(activeTask.id)}>
                  <CheckIcon size={15} />
                  <span>认领任务</span>
                </button>
              )}
              {activeTask.toUserId === selfUserId && activeTask.status === "claimed" && (
                <button type="button" className="btn btn-primary" onClick={() => onOpenStartDialog(activeTask)}>
                  <SendArrowIcon size={15} />
                  <span>在本机开始</span>
                </button>
              )}
              {activeTask.toUserId === selfUserId && activeTask.status === "running" && (
                <button type="button" className="btn btn-secondary" onClick={() => onFinishTask(activeTask.id)}>
                  <CheckIcon size={15} />
                  <span>标记完成</span>
                </button>
              )}
              {activeTask.status === "done" && <span className="meta">已完成，无需再操作。</span>}
            </div>
          </div>
        ) : (
          <div className="detail">
            <div className="empty-block">
              <span className="eb-title">没有选中的任务</span>
              <span className="eb-body">从左边的列表里挑一个任务查看详情。</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
