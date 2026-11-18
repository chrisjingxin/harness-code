/**
 * 对话时间线：按调用方给定顺序展示消息、推理、普通工具文本及已处理交互。
 *
 * 工作台装配方提供当前会话的显示值和个人状态，本组件只负责阅读、展开与滚动；
 * Markdown、头像和复制动作复用公共视图，不访问 Agent、项目服务或旧 Web 控制器。
 *
 * 显示条目 → 按相邻 Agent 内容分组 → 渲染消息/工具 → 按个人锚点恢复或跟随滚动。
 */
import { ArrowDown, Brain, Check, ChevronRight, Copy, Loader2, Wrench } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"

import { formatElapsed } from "../common/formatters.js"
import { Markdown } from "../rendering/markdown.js"
import type { RenderingActions } from "../rendering/types.js"
import { Disclosure } from "./disclosure.js"
import { deriveMinimapItems, isTurnActive, segmentAgentEntries } from "./timeline-model.js"
import { TimelineMinimap } from "./timeline-minimap.js"
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
  // 已结束的推理保留在时间线里渲染成可折叠行；空回答仍不显示。
  const visibleEntries = entries.filter(entry =>
    !(entry.kind === "message" && entry.role === "assistant" && !entry.streaming && entry.text.trim().length === 0),
  )
  const entryIds = visibleEntries.map(entry => entry.id)
  /* 进场动效只对挂载后新出现的条目播放：首屏 id 快照进 ref，历史加载与滚动恢复不播。 */
  const initialEntryIds = useRef<ReadonlySet<string> | null>(null)
  if (initialEntryIds.current === null) initialEntryIds.current = new Set(entryIds)
  const mountedEntryIds = initialEntryIds.current
  const isNewEntry = (id: string) => !mountedEntryIds.has(id)
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
  const minimapItems = deriveMinimapItems(visibleEntries)
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
          ) : groups.map((group, index) => (
            <TimelineGroup
              key={group[0].id}
              entries={group}
              lastId={lastId}
              isNewEntry={isNewEntry}
              expandedTools={personal.expandedTools}
              expandedOutputs={personal.expandedOutputs}
              onToggleTool={onPersonalChange ? toggleTool : undefined}
              onToggleOutput={onPersonalChange ? toggleOutput : undefined}
              rendering={rendering}
              activity={index === groups.length - 1 ? activity : null}
            />
          ))}
          {/* 末组不是 Agent 组时（如刚发出提问），状态行落在一个只有名称行和状态行的占位组里。 */}
          {activity && !groups.at(-1)?.some(isAgentGroupEntry) ? (
            <div className="wb-conversation-agent-group">
              <MessageMeta role="assistant" />
              <ActivityStatus activity={activity} />
            </div>
          ) : null}
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
              <ArrowDown aria-hidden="true" />
              {scroll.hasNewOutput ? <span aria-hidden="true" className="wb-conversation-to-bottom-dot" /> : null}
            </button>
          ) : null}
        </div>
      </div>
      <TimelineMinimap scrollerRef={scroll.scrollerRef} items={minimapItems} onJump={scroll.scrollToEntry} />
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

/** Agent 组成分：Agent 回答或它的工具/推理延续。 */
function isAgentGroupEntry(entry: ConversationTimelineEntry): boolean {
  return isAssistant(entry) || isAgentContinuation(entry)
}

function TimelineGroup({
  entries,
  lastId,
  isNewEntry,
  expandedTools,
  expandedOutputs,
  onToggleTool,
  onToggleOutput,
  rendering,
  activity,
}: {
  entries: readonly ConversationTimelineEntry[]
  lastId: string | null
  isNewEntry: (id: string) => boolean
  expandedTools: readonly string[]
  expandedOutputs: readonly string[]
  onToggleTool?: (id: string) => void
  onToggleOutput?: (id: string) => void
  rendering?: RenderingActions
  activity?: ConversationTimelineActivity | null
}): ReactElement {
  const agentGroup = entries.some(entry => isAgentContinuation(entry))
  const assistant = entries.find(isAssistant)
  if (!agentGroup && entries.length === 1) {
    const row = <TimelineRow entry={entries[0]} enter={isNewEntry(entries[0].id)} lastId={lastId} expandedTools={expandedTools} expandedOutputs={expandedOutputs} onToggleTool={onToggleTool} onToggleOutput={onToggleOutput} rendering={rendering} />
    if (!activity || !assistant) return row
    return <div className="wb-conversation-agent-group">{row}<ActivityStatus activity={activity} /></div>
  }
  /* 整组同时出现时只播一次组级动效；组已存在、后续追加的单条仍各自播进入。 */
  const groupIsNew = entries.every(entry => isNewEntry(entry.id))
  const turnActive = isTurnActive(entries, activity)
  return (
    <div className="wb-conversation-agent-group" data-enter={groupIsNew || undefined}>
      <MessageMeta role="assistant" author={assistant?.author?.displayName} createdAtMs={assistant?.createdAtMs} />
      {segmentAgentEntries(entries).map(segment => segment.kind === "tool-group" ? (
        <ToolGroupRows
          key={segment.id}
          groupId={segment.id}
          tools={segment.tools}
          turnActive={turnActive}
          enter={!groupIsNew && segment.tools.every(tool => isNewEntry(tool.id))}
          expandedTools={expandedTools}
          expandedOutputs={expandedOutputs}
          onToggleTool={onToggleTool}
          onToggleOutput={onToggleOutput}
          rendering={rendering}
        />
      ) : (
        <TimelineRow key={segment.entry.id} entry={segment.entry} grouped enter={!groupIsNew && isNewEntry(segment.entry.id)} lastId={lastId} expandedTools={expandedTools} expandedOutputs={expandedOutputs} onToggleTool={onToggleTool} onToggleOutput={onToggleOutput} rendering={rendering} />
      ))}
      {activity ? <ActivityStatus activity={activity} /> : null}
    </div>
  )
}

/** 工具组头：N 个操作、失败数与运行进度；运行中或整轮进行时强制展开。 */
function ToolGroupRows({
  groupId,
  tools,
  turnActive,
  enter,
  expandedTools,
  expandedOutputs,
  onToggleTool,
  onToggleOutput,
  rendering,
}: {
  groupId: string
  tools: readonly ToolEntry[]
  turnActive: boolean
  enter: boolean
  expandedTools: readonly string[]
  expandedOutputs: readonly string[]
  onToggleTool?: (id: string) => void
  onToggleOutput?: (id: string) => void
  rendering?: RenderingActions
}): ReactElement {
  const runningIndex = tools.findIndex(tool => tool.status === "running")
  const running = runningIndex >= 0
  const failedCount = tools.filter(tool => tool.status === "failed").length
  const forced = running || turnActive
  const expanded = forced || expandedTools.includes(groupId)
  const detailsId = `${groupId}:body`.replaceAll(":", "-")
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stuckToBottom = useRef(true)
  const [fadeTop, setFadeTop] = useState(false)
  const [fadeBottom, setFadeBottom] = useState(false)

  // 运行中贴底跟随；用户在组内向上滚过后停止跟随，滚回底部恢复。
  useEffect(() => {
    const body = bodyRef.current
    if (body && running && stuckToBottom.current) body.scrollTop = body.scrollHeight
  }, [tools, running, expanded])
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const update = () => {
      stuckToBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24
      setFadeTop(body.scrollTop > 4)
      setFadeBottom(body.scrollHeight - body.scrollTop - body.clientHeight > 4)
    }
    update()
    body.addEventListener("scroll", update)
    return () => body.removeEventListener("scroll", update)
  }, [expanded, tools.length])

  const label = `${tools.length} 个操作`
  return (
    <div className="wb-conversation-tool-group" data-enter={enter || undefined}>
      {onToggleTool ? (
        <button
          type="button"
          className="wb-conversation-tool-group-header"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-disabled={forced || undefined}
          onClick={() => { if (!forced) onToggleTool(groupId) }}
        >
          {running ? <Loader2 aria-hidden="true" className="wb-conversation-tool-icon wb-conversation-spin" /> : <Wrench aria-hidden="true" className="wb-conversation-tool-icon" />}
          <span className="wb-conversation-tool-group-label">
            {label}
            {running ? <span className="wb-conversation-tool-group-progress"> · 正在执行 · 第 {runningIndex + 1} 个</span> : null}
            {failedCount > 0 ? <span className="wb-conversation-tool-group-failures"> · 含 {failedCount} 个失败</span> : null}
          </span>
          <ChevronRight aria-hidden="true" focusable="false" className={expanded ? "wb-conversation-chevron is-expanded" : "wb-conversation-chevron"} />
        </button>
      ) : (
        <div className="wb-conversation-tool-group-header">
          {running ? <Loader2 aria-hidden="true" className="wb-conversation-tool-icon wb-conversation-spin" /> : <Wrench aria-hidden="true" className="wb-conversation-tool-icon" />}
          <span className="wb-conversation-tool-group-label">{label}{failedCount > 0 ? <span className="wb-conversation-tool-group-failures"> · 含 {failedCount} 个失败</span> : null}</span>
        </div>
      )}
      <Disclosure open={expanded}>
        <div
          id={detailsId}
          ref={bodyRef}
          className="wb-conversation-tool-group-body"
          data-fade-top={fadeTop || undefined}
          data-fade-bottom={fadeBottom || undefined}
        >
          {tools.map(tool => (
            <ConversationToolCard
              key={tool.id}
              tool={tool}
              expanded={expandedTools.includes(tool.id)}
              outputExpanded={expandedOutputs.includes(tool.id)}
              onToggle={onToggleTool ? () => onToggleTool(tool.id) : undefined}
              onToggleOutput={onToggleOutput ? () => onToggleOutput(tool.id) : undefined}
              rendering={rendering}
            />
          ))}
        </div>
      </Disclosure>
    </div>
  )
}

/** 思考行：进行中默认展开（收起只记组件本地），结束后按个人展开状态折叠。 */
function ReasoningRow({
  entry,
  enter,
  expanded,
  onToggle,
}: {
  entry: Extract<ConversationTimelineEntry, { kind: "reasoning" }>
  enter: boolean
  expanded: boolean
  onToggle?: () => void
}): ReactElement {
  const [localCollapsed, setLocalCollapsed] = useState(false)
  const open = entry.active ? !localCollapsed : expanded
  const bodyId = `${entry.id.replaceAll(":", "-")}-body`
  return (
    <div data-conversation-entry-id={entry.id} data-enter={enter || undefined} className="wb-conversation-reasoning" data-active={entry.active || undefined}>
      <button
        type="button"
        className="wb-conversation-reasoning-header"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => { entry.active ? setLocalCollapsed(value => !value) : onToggle?.() }}
      >
        <Brain aria-hidden="true" className="wb-conversation-tool-icon" />
        <span className={entry.active ? "wb-conversation-reasoning-label wb-conversation-shimmer" : "wb-conversation-reasoning-label"}>
          {entry.active ? "思考中" : "思考过程"}
        </span>
        <ChevronRight aria-hidden="true" focusable="false" className={open ? "wb-conversation-chevron is-expanded" : "wb-conversation-chevron"} />
      </button>
      <Disclosure open={open}>
        <div id={bodyId} className="wb-conversation-reasoning-body" role={entry.active ? "status" : undefined} aria-live={entry.active ? "polite" : undefined}>
          <div className="wb-conversation-reasoning-text">{entry.text}</div>
        </div>
      </Disclosure>
    </div>
  )
}

type ToolEntry = Extract<ConversationTimelineEntry, { kind: "tool" }>

function TimelineRow({
  entry,
  grouped = false,
  enter = false,
  lastId,
  expandedTools,
  expandedOutputs,
  onToggleTool,
  onToggleOutput,
  rendering,
}: {
  entry: ConversationTimelineEntry
  grouped?: boolean
  enter?: boolean
  lastId: string | null
  expandedTools: readonly string[]
  expandedOutputs: readonly string[]
  onToggleTool?: (id: string) => void
  onToggleOutput?: (id: string) => void
  rendering?: RenderingActions
}): ReactElement {
  if (entry.kind === "message") {
    if (entry.role === "system") {
      return <div data-conversation-entry-id={entry.id} data-enter={enter || undefined} className="wb-conversation-system" role="status">{entry.text}</div>
    }
    const isStreaming = entry.role === "assistant" && Boolean(entry.streaming && entry.id === lastId)
    return (
      <div data-conversation-entry-id={entry.id} data-enter={enter || undefined} className={`wb-conversation-message wb-conversation-message-${entry.role}`}>
        {grouped && entry.role === "assistant" ? null : <MessageMeta role={entry.role} author={entry.author?.displayName} createdAtMs={entry.createdAtMs} />}
        <div className="wb-conversation-message-body">
          <div className="wb-conversation-message-content" data-streaming={isStreaming || undefined}>
            {entry.role === "assistant"
              ? entry.text
                ? <Markdown text={entry.text} actions={rendering} />
                : isStreaming
                  ? <span className="wb-conversation-streaming-cursor" aria-hidden="true" />
                  : null
              : entry.text}
          </div>
        </div>
        {entry.role === "assistant" && !entry.streaming && entry.text.trim().length > 0 && typeof rendering?.copyText === "function" ? (
          <ReplyFooter text={entry.text} rendering={rendering} />
        ) : null}
      </div>
    )
  }
  if (entry.kind === "tool") {
    return (
      <div data-conversation-entry-id={entry.id} data-enter={enter || undefined} className="wb-conversation-tool">
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
      <ReasoningRow
        entry={entry}
        enter={enter}
        expanded={expandedTools.includes(entry.id)}
        onToggle={onToggleTool ? () => onToggleTool(entry.id) : undefined}
      />
    )
  }
  if (entry.kind === "extension") {
    return <div data-conversation-entry-id={entry.id} data-enter={enter || undefined} className="wb-conversation-extension">{entry.content}</div>
  }
  return (
    <div data-conversation-entry-id={entry.id} data-enter={enter || undefined} className="wb-conversation-interaction-history">
      <Check aria-hidden="true" className="wb-conversation-tool-icon" />
      <span className="wb-conversation-interaction-history-title">{entry.title}</span>
      <span className="wb-conversation-interaction-history-status">{entry.statusLabel}</span>
      {entry.description ? <span className="wb-conversation-interaction-history-desc">{entry.description}</span> : null}
    </div>
  )
}

/** “名称 · 时间”一行小字：用户消息靠右、Agent 组靠左；头像已取消，时间无效时只留名称。 */
function MessageMeta({ role, author, createdAtMs }: { role: "user" | "assistant"; author?: string; createdAtMs?: number }): ReactElement {
  const date = typeof createdAtMs === "number" && Number.isFinite(createdAtMs) ? new Date(createdAtMs) : null
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null
  return (
    <div className="wb-conversation-message-meta">
      <span className="wb-conversation-author">{author || (role === "assistant" ? "Agent" : "用户")}</span>
      {validDate ? <><span aria-hidden="true"> · </span><time className="wb-conversation-time" dateTime={validDate.toISOString()}>{validDate.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></> : null}
    </div>
  )
}

/** 回复底栏：落定回答的悬停复制入口；成败只在本组件内播报与回弹，不写入个人状态。 */
function ReplyFooter({ text, rendering }: { text: string; rendering: RenderingActions }): ReactElement {
  const [copied, setCopied] = useState(false)
  const [announce, setAnnounce] = useState("")
  const resetTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])
  const copy = async () => {
    if (!rendering.copyText) return
    try {
      await rendering.copyText(text)
      setCopied(true)
      setAnnounce("已复制")
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      setCopied(false)
      setAnnounce(error instanceof Error && error.message ? `复制失败：${error.message}` : "复制失败")
    }
  }
  return (
    <div className="wb-conversation-reply-actions">
      <button
        type="button"
        className="wb-conversation-reply-copy"
        data-copied={copied || undefined}
        aria-label="复制回答"
        title="复制回答"
        onClick={() => { void copy() }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <span className="sr" role="status">{announce}</span>
    </div>
  )
}

/** 计时只刷新状态行，避免每秒重复计算整个会话的内容。 */
function ActivityStatus({ activity }: { activity?: ConversationTimelineActivity | null }): ReactElement {
  const elapsed = useElapsed(activity?.active === true, activity?.elapsedMs)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const paused = useShimmerPaused(rowRef)
  return (
    <div ref={rowRef} className="wb-conversation-live" aria-live="polite" data-paused={paused || undefined}>
      {activity ? (
        <div className="wb-conversation-progress" role="status">
          {activity.active ? <Loader2 aria-hidden="true" className="wb-conversation-progress-icon wb-conversation-spin" /> : null}
          <span className={activity.active ? "wb-conversation-shimmer" : undefined}>
            {[activity.label, activity.phaseLabel, activity.elapsedMs === undefined ? undefined : `已运行 ${formatElapsed(elapsed)}`].filter(Boolean).join(" · ")}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** 扫光只在行可见且页面在前台时运行；离屏或切到后台即暂停。 */
function useShimmerPaused(ref: { readonly current: HTMLElement | null }): boolean {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    let inView = true
    const update = () => setPaused(!inView || document.visibilityState === "hidden")
    const observer = new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting)
      update()
    })
    observer.observe(element)
    document.addEventListener("visibilitychange", update)
    update()
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", update)
    }
  }, [ref])
  return paused
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
