/** 轨迹展示模块：保留内网三轨顺序图、轮次调用树与详情；由宿主提供当前会话数据。 */
/** @jsxImportSource react */

import { useEffect, useMemo, useRef, useState } from "react"

import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"
import type { TraceViewState } from "./view-state"
import { GanttChart } from "./gantt"
import { TraceDetail } from "./trace-detail"
import { TraceTree } from "./trace-tree"
import { buildTree, extractRunModes, extractUserMessage, type TraceTreeNode, type TraceUserMessages } from "./types"

/** 甘特区请求高度；可视高度由 CSS 按可用空间约束，三条泳道始终完整。 */
const INITIAL_GANTT_HEIGHT = 96
/** 甘特区高度下限。 */
const MIN_GANTT_HEIGHT = 84
/** 详情列初始宽度。 */
const INITIAL_DETAIL_WIDTH = 360
/** 详情列宽度区间。 */
const DETAIL_WIDTH_MIN = 300
const DETAIL_WIDTH_MAX = 600
/** 拖拽灵敏度：鼠标位移 × 该系数 = 边界位移（<1 让边界移动变慢，方便精细调整）。 */
const RESIZE_SENSITIVITY = 0.5

/** 当前会话的链路展示入口；仅接收选取后的数据，加载与传输属于宿主应用层。 */
export function TraceView(props: {
  state: TraceViewState
  disabled?: boolean
  mode?: "dev" | "simple"
  userMessages?: TraceUserMessages
}): React.ReactElement {
  return <ThreadTraceView key={props.state.threadId} {...props} />
}

/** 会话切换重建节点局部状态；同会话增量更新保持选择、折叠和滚动。 */
function ThreadTraceView(props: {
  state: TraceViewState
  disabled?: boolean
  mode?: "dev" | "simple"
  userMessages?: TraceUserMessages
}): React.ReactElement {
  const { state, disabled = false } = props
  const mode = props.mode ?? "dev"
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [ganttHeight, setGanttHeight] = useState(INITIAL_GANTT_HEIGHT)
  const [detailWidth, setDetailWidth] = useState(INITIAL_DETAIL_WIDTH)
  const allSpans = useMemo(() => state.spans.map(span => {
    if (span.raw.schema_version !== 2 || span.type !== "ROOT") return span
    const input = extractUserMessage([span], props.userMessages)
    return input ? { ...span, metadata: { ...span.metadata, user_input: input } } : span
  }), [state.spans, props.userMessages])
  const hasAnyTrace = state.hasAnyTrace
  // spanKey → 完整子树节点索引（simple 详情需要 children 提取模型/工具；对齐原型 selectNode(node)）。
  const nodeIndex = useMemo(() => {
    const index = new Map<string, TraceTreeNode>()
    const byTrace = new Map<string, TraceSpanEvent[]>()
    for (const item of allSpans) {
      const bucket = byTrace.get(item.traceId) ?? []
      bucket.push(item)
      byTrace.set(item.traceId, bucket)
    }
    const visit = (nodes: readonly TraceTreeNode[]) => {
      for (const node of nodes) {
        index.set(`${node.span.traceId}:${node.span.spanId}`, node)
        visit(node.children)
      }
    }
    for (const items of byTrace.values()) visit(buildTree(items))
    return index
  }, [allSpans])
  // 只保存身份；详情始终读取最新快照，运行结束后不保留旧 Span 对象。
  const selectedTreeNode = selectedKey === null ? null : (nodeIndex.get(selectedKey) ?? null)
  const selectedTraceId = selectedTreeNode?.span.traceId
  const selectedModes = useMemo(() => selectedTraceId === undefined ? undefined
    : extractRunModes(allSpans.filter(item => item.traceId === selectedTraceId)), [selectedTraceId, allSpans])
  const selectSpan = (span: TraceSpanEvent) => {
    setSelectedKey(`${span.traceId}:${span.spanId}`)
    setSelectionRevision(previous => previous + 1)
  }
  // 历史 trace 懒加载状态：当前线程加载中 / 已加载（含「找不到文件」）。
  const threadLoading = state.loading
  const threadLoaded = state.loaded

  if (allSpans.length === 0) {
    return (
      <div className="trace-view" aria-label="链路轨迹">
        <div className="trace-view-empty" role="status">
          {!hasAnyTrace && !threadLoading && !threadLoaded ? (
            <>
              <p className="trace-view-empty-title">当前会话未开启链路追踪</p>
              <p className="trace-view-empty-hint">链路数据来自当前工作区 log/*.jsonl；与 Agent 对话后会自动生成并实时刷新。</p>
            </>
          ) : threadLoading ? (
            <>
              <p className="trace-view-empty-title">正在加载该线程的历史轨迹…</p>
              <p className="trace-view-empty-hint">正在读取当前工作区的 session JSONL 并合并调用节点。</p>
            </>
          ) : (
            <>
              <p className="trace-view-empty-title">该线程暂无链路数据</p>
              <p className="trace-view-empty-hint">该线程尚未产生 Span；完成一次对话后可重新进入轨迹查看。</p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="trace-view" aria-label="链路轨迹">
      <div className="trace-gantt-wrap" style={{ height: `${ganttHeight}px` }}>
        <GanttChart spans={allSpans} onSelect={selectSpan} mode={mode} userMessages={props.userMessages} />
      </div>
      <TraceResizeHandle
        orientation="horizontal"
        label="调整甘特图高度"
        disabled={disabled}
        onResize={delta => {
          // 甘特在顶部、向下扩展：向下拖 delta 为正 → 变高，边界跟手。
          setGanttHeight(prev => clamp(prev + delta * RESIZE_SENSITIVITY, MIN_GANTT_HEIGHT, 600))
        }}
        onDragEnd={() => {
          // 无持久化需求：保留当前会话内的拖拽结果即可。
        }}
      />
      <div
        className="trace-view-body"
        style={{ gridTemplateColumns: `minmax(0, 1fr) 9px min(${detailWidth}px, 50%)` }}
      >
        <div className="trace-pane-tree">
          <TraceTree
            spans={allSpans}
            handlers={{ onSelect: selectSpan }}
            mode={mode}
            externalSelectedKey={selectedKey}
            selectionRevision={selectionRevision}
            userMessages={props.userMessages}
          />
        </div>
        <TraceResizeHandle
          orientation="vertical"
          label="调整详情宽度"
          disabled={disabled}
          onResize={delta => {
            // 详情右缘贴容器右边，宽度增加只能向左扩展 → 若用 prev + delta，向右拖反而让边界左移（方向反）。
            // 取负号让边界跟随鼠标：向右拖 → 详情变窄（树变宽）。
            setDetailWidth(prev => clamp(prev - delta * RESIZE_SENSITIVITY, DETAIL_WIDTH_MIN, DETAIL_WIDTH_MAX))
          }}
          onDragEnd={() => {}}
        />
        <div className="trace-pane-detail">
          <TraceDetail node={selectedTreeNode} mode={mode} modes={selectedModes} />
        </div>
      </div>
    </div>
  )
}

/** 分隔条：水平（甘特/树之间，拖 Y）或垂直（树/详情之间，拖 X），本地状态驱动。 */
function TraceResizeHandle({
  orientation,
  label,
  disabled,
  onResize,
  onDragEnd,
}: {
  orientation: "horizontal" | "vertical"
  label: string
  disabled: boolean
  onResize: (delta: number) => void
  onDragEnd: () => void
}): React.ReactElement {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef<{ origin: number } | null>(null)
  const resizeClass = orientation === "horizontal" ? "trace-resizing-h" : "trace-resizing-v"

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.preventDefault()
    startRef.current = { origin: orientation === "horizontal" ? event.clientY : event.clientX }
    setDragging(true)
  }

  useEffect(() => {
    if (!dragging) return
    // 尺寸变化会重建回调；每次订阅都恢复拖动光标，并在终止或卸载时成对清理。
    document.body.classList.add(resizeClass)
    const onMove = (event: PointerEvent) => {
      const start = startRef.current
      if (!start) return
      const position = orientation === "horizontal" ? event.clientY : event.clientX
      const delta = position - start.origin
      // onResize 基于上次尺寸累计，因此基准必须同步前移，不能重复叠加起点差。
      start.origin = position
      onResize(delta)
    }
    const onUp = () => {
      startRef.current = null
      document.body.classList.remove(resizeClass)
      setDragging(false)
      onDragEnd()
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    window.addEventListener("blur", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      window.removeEventListener("blur", onUp)
      document.body.classList.remove(resizeClass)
    }
  }, [dragging, orientation, onResize, onDragEnd, resizeClass])

  return (
    <div
      className={`trace-resize-handle trace-resize-${orientation}${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation={orientation === "horizontal" ? "horizontal" : "vertical"}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
    />
  )
}

/** 数值夹取。 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
