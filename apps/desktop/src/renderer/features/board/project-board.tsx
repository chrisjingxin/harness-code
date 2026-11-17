/** 项目中央看板。只展示简报、任务和同步状态，定位动作交给 Project 外壳。 */
import { useMemo, useState } from "react"
import type { BoardConversation, BoardResponse } from "@workbench/contracts"
import { MemberAvatar } from "@workbench/ui"
import type { ProjectUpdatesStatus } from "../../../project-updates-host.js"
import type { SessionSyncState } from "../session/contracts.js"
import { formatShortTime } from "../session/session-model.js"
import { boardTaskStatuses, buildBoardModel, getBoardSyncLabel } from "./board-model.js"
import "./project-board.css"

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
  readonly onRefresh: () => void
  readonly onOpenProject: () => void
  readonly onOpenTasks: () => void
  readonly onOpenTask: (taskId: string) => void
  readonly onOpenConversation: (conversation: BoardConversation["conversation"]) => boolean
  readonly onCreateTask?: (() => void) | undefined
}

const statusLabels = {
  connecting: "正在连接通知",
  connected: "通知已连接",
  retrying: "通知中断，正在重连",
  unavailable: "通知不可用，可手动刷新",
} satisfies Record<ProjectUpdatesStatus, string>

const conversationLabels = {
  idle: "空闲", running: "执行中", waiting_approval: "待批准", error: "出错",
}

export function ProjectBoard(props: ProjectBoardProps) {
  const { data, projectName, description, busy, error, updatedAt, notification } = props
  const model = useMemo(() => data ? buildBoardModel(data) : null, [data])
  const [locateError, setLocateError] = useState("")
  return <div className="project-board-scroll">
    <main className="project-board" aria-label="项目看板">
      <header className="project-board-heading">
        <div><h1>{projectName}</h1>{description && <p>{description}</p>}</div>
        <div className="project-board-actions">
          <button className="wb-button wb-button-secondary wb-button-small" onClick={props.onOpenProject}>项目资料</button>
          <button className="wb-button wb-button-secondary wb-button-small" disabled={busy} onClick={() => {
            setLocateError("")
            props.onRefresh()
          }}>刷新</button>
          {props.onCreateTask && <button className="wb-button wb-button-primary wb-button-small" onClick={props.onCreateTask}>创建任务</button>}
        </div>
      </header>
      <div className="project-board-summary" aria-label="项目概况">
        {data && model && <>
          <span><strong>{model.activeMembers}</strong> 位成员</span>
          <span><strong>{data.conversations.length}</strong> 条近期会话</span>
          <span><strong>{data.tasks.length}</strong> 项未结束任务</span>
        </>}
        <span className="project-board-updated">
          {busy ? "正在刷新" : updatedAt !== null ? `更新于 ${formatShortTime(updatedAt)}` : null}
          <span className="project-board-notification" aria-live="polite">{statusLabels[notification]}</span>
        </span>
      </div>
      {(error || locateError) && <p className="project-board-error" role="status">{error || locateError}</p>}
      {data && model && <>
        <section aria-labelledby="board-members">
          <div className="project-board-section">
            <h2 id="board-members">成员进展</h2>
            {data.conversationsTruncated && <span>仅展示最近 100 条会话</span>}
          </div>
          {model.members.length === 0 ? <p className="project-board-empty">暂无项目成员。</p> :
            <div className="project-board-grid">
              {model.members.map(member => <article className="project-board-member" key={member.userId}>
                <header><MemberAvatar initial={member.name.slice(0, 1) || "?"} self={member.userId === props.accountId} />
                  <strong>{member.name || "项目成员"}</strong>
                  <span>{member.status === "removed" ? "已离开" : member.deviceOnline ? "有设备在线" : "设备离线"}</span>
                </header>
                {(member.received > 0 || member.sent > 0) && <p className="project-board-meta">
                  接收 {member.received} 项 · 发起 {member.sent} 项
                </p>}
                {member.conversations.length === 0 && <p className="project-board-empty">暂无会话简报。</p>}
                {member.conversations.map(row => {
                  const item = row.conversation
                  return <button className="project-board-conversation" key={item.conversationId} onClick={() => {
                    setLocateError(props.onOpenConversation(item) ? "" : "会话暂时无法定位，请刷新看板。")
                  }}>
                    <strong>{item.title || "未命名会话"}</strong>
                    {item.briefText && <span className="project-board-brief">{item.briefText}</span>}
                    <span className="project-board-meta">
                      {conversationLabels[item.status]} · {row.deviceOnline ? "原设备在线" : "原设备离线"}
                    </span>
                    <span className="project-board-meta">
                      {item.syncedSequence > 0 && item.briefUpdatedAtMs > 0
                        ? `最近上传 ${formatShortTime(item.briefUpdatedAtMs)}`
                        : "暂无上传记录"}
                    </span>
                    <span className="project-board-sync">{getBoardSyncLabel(row, props.accountId, props.localDeviceId,
                      props.syncStates[item.conversationId])}</span>
                  </button>
                })}
              </article>)}
            </div>}
        </section>
        <section aria-labelledby="board-tasks">
          <div className="project-board-section">
            <h2 id="board-tasks">项目任务</h2>
            {data.tasksTruncated && <span>仅展示最近 100 项未结束任务</span>}
            <button className="wb-button wb-button-quiet wb-button-small" onClick={props.onOpenTasks}>查看全部</button>
          </div>
          <div className="project-board-grid">
            {model.columns.map(({ status, tasks }) => <section key={status} className="project-board-task-column">
              <h3>{boardTaskStatuses[status]} <span>{tasks.length}</span></h3>
              {tasks.length === 0 && <p className="project-board-empty">暂无任务</p>}
              {tasks.map(task => <button className="project-board-task" key={task.taskId}
                onClick={() => props.onOpenTask(task.taskId)}>
                <strong>{task.title}</strong>
                <span className="project-board-meta">{model.names.get(task.assigneeId) || "项目成员"} · {formatShortTime(task.updatedAtMs)}</span>
              </button>)}
            </section>)}
          </div>
        </section>
      </>}
    </main>
  </div>
}
