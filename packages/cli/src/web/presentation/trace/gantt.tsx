/** Gantt 时间线：对齐 4.html 原型的三行等宽概览——收集所有需要画条的 span 按 start_time 排序，
 *  每轮（trace）之间画分界竖线，条块按 lane（0=Input/1=Model/2=Tools）落位，不按真实时长拉条，
 *  短调用也能看见。条块可点击，点击定位到下方树。 */
/** @jsxImportSource react */

import { useMemo } from "react"

import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"
import { displayColor, displayName, displayType, formatMs, shownStatusLabel, toolPayloadFailure } from "./simple"
import { buildTree, extractUserMessage, ganttLanes, simplifyTree, type TraceTreeNode, type TraceUserMessages } from "./types"

/** 三行甘特的 lane 标签（对齐 4.html gantt-labels）。 */
const LANE_LABELS = ["Input", "Model", "Tools"]

/** Gantt 组件：spans 按 trace 分组建树，收集 lane 节点（dev/simple 用同一套 lane 逻辑；
 *  simple 先化简树，噪声节点不参与画条）。 */
export function GanttChart({
  spans,
  onSelect,
  mode = "dev",
  userMessages = {},
}: {
  spans: readonly TraceSpanEvent[]
  onSelect?: (item: TraceSpanEvent) => void
  mode?: "dev" | "simple"
  userMessages?: TraceUserMessages
}): React.ReactElement {
  const groups = useMemo(() => {
    const byTrace = new Map<string, TraceSpanEvent[]>()
    for (const item of spans) {
      const bucket = byTrace.get(item.traceId) ?? []
      bucket.push(item)
      byTrace.set(item.traceId, bucket)
    }
    return [...byTrace.entries()].map(([traceId, items]) => {
      const rawTrees = buildTree(items)
      const trees = mode === "simple" ? simplifyTree(rawTrees) : rawTrees
      const flatSpans: TraceSpanEvent[] = []
      const walk = (nodes: readonly TraceTreeNode[]) => {
        for (const node of nodes) {
          flatSpans.push(node.span)
          walk(node.children)
        }
      }
      walk(trees)
      return { traceId, trees, userMessage: extractUserMessage(flatSpans, userMessages) }
    })
  }, [spans, mode, userMessages])

  // 全部 lane 节点（含所属 trace 顺序）：flatMap 保持 trace 分组序，组内按 start_time 稳定排序，
  // 保证多轮时条块的「码放顺序」与 4.html collectGanttSpans 一致。
  const barNodes = useMemo(() => {
    const out: Array<{ node: TraceTreeNode; lane: number }> = []
    for (const group of groups) {
      const lanes = ganttLanes(group.trees)
      const nodes: Array<{ node: TraceTreeNode; lane: number }> = []
      const collect = (tree: TraceTreeNode) => {
        const lane = lanes.get(`${tree.span.traceId}:${tree.span.spanId}`)
        if (lane !== undefined) nodes.push({ node: tree, lane })
        for (const child of tree.children) collect(child)
      }
      for (const tree of group.trees) collect(tree)
      nodes.sort((a, b) => a.node.span.startTime - b.node.span.startTime)
      out.push(...nodes)
    }
    return out
  }, [groups])

  if (barNodes.length === 0) return <div className="trace-gantt-empty">没有可绘制的事件</div>
  const select = onSelect ?? (() => {})
  const n = barNodes.length
  const title = groups.length > 1
    ? `全部 ${groups.length} 轮 · ${n} 个事件`
    : `${(groups[0]?.userMessage || "用户输入不可用").slice(0, 40)} · ${n} 个事件`

  return (
    <div className="trace-gantt trace-gantt-lanes3">
      <div className="trace-gantt-plot">
        <div className="trace-gantt-labels" aria-hidden="true">
          {LANE_LABELS.map(label => <span key={label}>{label}</span>)}
        </div>
        <div className="trace-gantt-track">
          {barNodes.map((item, i) => {
            const prevTrace = i > 0 ? barNodes[i - 1]!.node.span.traceId : null
            return (
              <Bar
                key={item.node.span.spanId}
                node={item.node}
                lane={item.lane}
                index={i}
                count={n}
                boundary={prevTrace !== null && prevTrace !== item.node.span.traceId}
                onSelect={select}
              />
            )
          })}
        </div>
      </div>
      <div className="trace-gantt-header">
        <span className="trace-gantt-title" title={groups.map(g => g.userMessage || "用户输入不可用").join(" / ")}>{title}</span>
      </div>
    </div>
  )
}

/** 单个条块：等宽（100/n）按序号排布，落在指定 lane；轮次分界时前置一条 gantt-turn 竖线。
 *  onSelect 触发时联动下方树定位。 */
function Bar({
  node,
  lane,
  index,
  count,
  boundary,
  onSelect,
}: {
  node: TraceTreeNode
  lane: number
  index: number
  count: number
  boundary: boolean
  onSelect: (item: TraceSpanEvent) => void
}) {
  const span = node.span
  const width = 100 / count
  const failed = toolPayloadFailure(span) !== null
  const style: React.CSSProperties = {
    "--lane": String(lane),
    "--left": `${(index / count) * 100}%`,
    "--width": `${width}%`,
    backgroundColor: failed ? "var(--danger)" : displayColor(span),
  } as React.CSSProperties
  return (
    <>
      {boundary ? <div className="trace-gantt-turn" style={{ left: `${(index / count) * 100}%` }} /> : null}
      <div
        className="trace-gantt-bar"
        data-span-key={`${span.traceId}:${span.spanId}`}
        style={style}
        title={`${displayName(node) || displayType(span)}  ${formatMs(span.durationMs)}  ${shownStatusLabel(span)}`}
        onClick={() => onSelect(span)}
      />
    </>
  )
}
