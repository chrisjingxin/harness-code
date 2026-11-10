/**
 * 对话时间线：按调用方给定顺序展示消息、推理、普通工具文本及已处理交互。
 *
 * 工作台装配方提供当前会话的显示值和个人状态，本组件只负责阅读、展开与滚动；
 * Markdown、头像和复制动作复用公共视图，不访问 Agent、项目服务或旧 Web 控制器。
 *
 * 显示条目 → 按相邻 Agent 内容分组 → 渲染消息/工具 → 按个人锚点恢复或跟随滚动。
 */
import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import type { ReactElement } from "react"

import { RoleAvatar } from "../common/brand.js"
import { formatElapsed } from "../common/formatters.js"
import { Markdown } from "../rendering/markdown.js"
import type { RenderingActions } from "../rendering/types.js"
import { ConversationToolCard } from "./tool-card.js"
import type { ConversationTimelineActivity, ConversationTimelineEntry, ConversationTimelineProps } from "./types.js"
import { useTimelineScroll } from "./use-timeline-scroll.js"

type MessageEntry = Extract<ConversationTimelineEntry, { kind: "message" }>

/** 以完整 scope 切开组件实例，避免相同条目 ID 在账号或会话切换时串用本地引用。 */
export function ConversationTimeline(props: ConversationTimelineProps): ReactElement {
  const { namespace, accountId, workspaceId, conversationId } = props.scope
  const scopeKey = JSON.stringify([namespace, accountId, workspaceId, conversationId])
  return <ConversationTimelineInstance key={scopeKey} {...props} />
}

function ConversationTimelineInstance(props: ConversationTimelineProps): ReactElement {
  const { entries, visible, scope, personal, onPersonalChange, rendering, activity, contentRevision } = props
  const visibleEntries = entries.filter(entry => {
    if (entry.kind === "reasoning") return entry.active
    if (entry.kind === "message" && entry.role === "assistant" && !entry.streaming) return entry.text.trim().length > 0
    return true
  })
  const entryIds = visibleEntries.map(entry => entry.id)
  const scroll = useTimelineScroll({
    scope,
    visible,
    contentRevision,
    entryIds,
    saved: personal.scroll,
    onChange: onPersonalChange,
  })
  const lastId = visibleEntries.at(-1)?.id ?? null
  const groups = groupEntries(visibleEntries)
  const toggleTool = (id: string) => {
    onPersonalChange?.(scope, { kind: "tool", entryId: id, expanded: !personal.expandedTools.includes(id) })
  }
  const toggleOutput = (id: string) => {
    onPersonalChange?.(scope, { kind: "output", entryId: id, expanded: !personal.expandedOutputs.includes(id) })
  }

  return (
    <div className="wb-conversation" hidden={!visible} inert={!visible}>
      <div ref={scroll.scrollerRef} className="wb-conversation-scroll" onScroll={scroll.onScroll}>
        <div className="wb-conversation-timeline" role="log" aria-relevant="additions" aria-label="对话与工具时间线">
          {visibleEntries.length === 0 ? (
            <div className="wb-conversation-empty" role="status">发送第一条消息后，这里会显示 Agent 的回答、工具调用与审批记录。</div>
          ) : groups.map(group => (
            <TimelineGroup
              key={group[0].id}
              entries={group}
              lastId={lastId}
              expandedTools={personal.expandedTools}
              expandedOutputs={personal.expandedOutputs}
              onToggleTool={onPersonalChange ? toggleTool : undefined}
              onToggleOutput={onPersonalChange ? toggleOutput : undefined}
              rendering={rendering}
            />
          ))}
          <ActivityStatus activity={activity} />
          {scroll.anchorUnavailable ? (
            <p className="wb-conversation-anchor-notice" role="status">原阅读位置暂不可用，已定位到可见内容。</p>
          ) : null}
          {scroll.showBottomButton ? (
            <button
              type="button"
              className="wb-conversation-to-bottom"
              data-new={scroll.hasNewOutput}
              aria-label={scroll.hasNewOutput ? "跳到最新输出" : "回到底部"}
              onClick={scroll.scrollToBottom}
            >
              {scroll.hasNewOutput ? "有新输出" : "回到底部"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 一组最多包含一个 Assistant 消息；工具和推理不改变原始顺序。 */
function groupEntries(entries: readonly ConversationTimelineEntry[]): ConversationTimelineEntry[][] {
  const groups: ConversationTimelineEntry[][] = []
  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index]
    if (!isAssistant(item) && !isAgentContinuation(item)) {
      groups.push([item])
      continue
    }
    const group = [item]
    let hasAssistant = isAssistant(item)
    while (index + 1 < entries.length) {
      const next = entries[index + 1]
      if (isAssistant(next)) {
        if (hasAssistant) break
        hasAssistant = true
      } else if (!isAgentContinuation(next)) {
        break
      }
      index += 1
      group.push(next)
    }
    groups.push(group)
  }
  return groups
}

function isAssistant(entry: ConversationTimelineEntry): entry is MessageEntry {
  return entry.kind === "message" && entry.role === "assistant"
}

function isAgentContinuation(entry: ConversationTimelineEntry): boolean {
  return entry.kind === "reasoning" || entry.kind === "tool"
}

function TimelineGroup({
  entries,
  lastId,
  expandedTools,
  expandedOutputs,
  onToggleTool,
  onToggleOutput,
  rendering,
}: {
  entries: readonly ConversationTimelineEntry[]
  lastId: string | null
  expandedTools: readonly string[]
  expandedOutputs: readonly string[]
  onToggleTool?: (id: string) => void
  onToggleOutput?: (id: string) => void
  rendering?: RenderingActions
}): ReactElement {
  const agentGroup = entries.some(entry => isAgentContinuation(entry))
  const assistant = entries.find(isAssistant)
  if (!agentGroup && entries.length === 1) {
    return <TimelineRow entry={entries[0]} lastId={lastId} expandedTools={expandedTools} expandedOutputs={expandedOutputs} onToggleTool={onToggleTool} onToggleOutput={onToggleOutput} rendering={rendering} />
  }
  return (
    <div className="wb-conversation-agent-group">
      <MessageHeader role="assistant" author={assistant?.author?.displayName} createdAtMs={assistant?.createdAtMs} />
      {entries.map(entry => (
        <TimelineRow key={entry.id} entry={entry} grouped lastId={lastId} expandedTools={expandedTools} expandedOutputs={expandedOutputs} onToggleTool={onToggleTool} onToggleOutput={onToggleOutput} rendering={rendering} />
      ))}
    </div>
  )
}

function TimelineRow({
  entry,
  grouped = false,
  lastId,
  expandedTools,
  expandedOutputs,
  onToggleTool,
  onToggleOutput,
  rendering,
}: {
  entry: ConversationTimelineEntry
  grouped?: boolean
  lastId: string | null
  expandedTools: readonly string[]
  expandedOutputs: readonly string[]
  onToggleTool?: (id: string) => void
  onToggleOutput?: (id: string) => void
  rendering?: RenderingActions
}): ReactElement {
  if (entry.kind === "message") {
    if (entry.role === "system") {
      return <div data-conversation-entry-id={entry.id} className="wb-conversation-system" role="status">{entry.text}</div>
    }
    return (
      <div data-conversation-entry-id={entry.id} className={`wb-conversation-message wb-conversation-message-${entry.role}`}>
        {grouped && entry.role === "assistant" ? null : <MessageHeader role={entry.role} author={entry.author?.displayName} createdAtMs={entry.createdAtMs} />}
        <div className="wb-conversation-message-body">
          <div className="wb-conversation-message-content">
            {entry.role === "assistant" ? <>{entry.text ? <Markdown text={entry.text} actions={rendering} /> : null}{entry.streaming && entry.id === lastId ? <span className="wb-conversation-streaming-cursor" aria-hidden="true" /> : null}</> : entry.text}
          </div>
        </div>
      </div>
    )
  }
  if (entry.kind === "tool") {
    return (
      <div data-conversation-entry-id={entry.id} className="wb-conversation-tool">
        <ConversationToolCard
          tool={entry}
          expanded={expandedTools.includes(entry.id)}
          outputExpanded={expandedOutputs.includes(entry.id)}
          onToggle={onToggleTool ? () => onToggleTool(entry.id) : undefined}
          onToggleOutput={onToggleOutput ? () => onToggleOutput(entry.id) : undefined}
          rendering={rendering}
        />
      </div>
    )
  }
  if (entry.kind === "reasoning") {
    return (
      <div data-conversation-entry-id={entry.id} className="wb-conversation-reasoning" role="status" aria-live="polite">
        <div className="wb-conversation-reasoning-header"><Loader2 aria-hidden="true" className="wb-conversation-progress-icon wb-conversation-spin" /><span>思考中</span></div>
        <div className="wb-conversation-reasoning-text">{entry.text}</div>
      </div>
    )
  }
  if (entry.kind === "extension") {
    return <div data-conversation-entry-id={entry.id} className="wb-conversation-extension">{entry.content}</div>
  }
  return (
    <div data-conversation-entry-id={entry.id} className="wb-conversation-interaction-history">
      <div className="wb-conversation-interaction-header"><span>{entry.title}</span><span>{entry.statusLabel}</span></div>
      {entry.description ? <p>{entry.description}</p> : null}
    </div>
  )
}

function MessageHeader({ role, author, createdAtMs }: { role: "user" | "assistant"; author?: string; createdAtMs?: number }): ReactElement {
  const date = typeof createdAtMs === "number" && Number.isFinite(createdAtMs) ? new Date(createdAtMs) : null
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null
  return (
    <div className="wb-conversation-message-head">
      <RoleAvatar kind={role} />
      <span className="wb-conversation-author-group">
        <span className="wb-conversation-author">{author || (role === "assistant" ? "Agent" : "用户")}</span>
        {validDate ? <time className="wb-conversation-time" dateTime={validDate.toISOString()}>{validDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time> : null}
      </span>
    </div>
  )
}

/** 计时只刷新状态行，避免每秒重复计算整个会话的内容。 */
function ActivityStatus({ activity }: { activity?: ConversationTimelineActivity | null }): ReactElement {
  const elapsed = useElapsed(activity?.active === true, activity?.elapsedMs)
  return (
    <div className="wb-conversation-live" aria-live="polite">
      {activity ? (
        <div className="wb-conversation-progress" role="status">
          {activity.active ? <Loader2 aria-hidden="true" className="wb-conversation-progress-icon wb-conversation-spin" /> : null}
          <span>{[activity.label, activity.phaseLabel, activity.elapsedMs === undefined ? undefined : `已运行 ${formatElapsed(elapsed)}`].filter(Boolean).join(" · ")}</span>
        </div>
      ) : null}
    </div>
  )
}

/** 只按调用方给出的活动事实计时；结束后停止更新。 */
function useElapsed(active: boolean, elapsedMs: number | undefined): number {
  const base = typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const [elapsed, setElapsed] = useState(base)
  useEffect(() => {
    setElapsed(base)
    if (!active) return
    const startedAt = Date.now() - base
    const timer = window.setInterval(() => setElapsed(Math.max(0, Date.now() - startedAt)), 1000)
    return () => window.clearInterval(timer)
  }, [active, base])
  return elapsed
}
