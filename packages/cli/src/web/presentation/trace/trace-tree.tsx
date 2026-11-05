/** Span 树：对齐 trace_viewer 原型——run 分组头（用户输入 + meta，整体可折叠）+
 *  节点行（toggle ▾/· + 类型 badge + name + dur + status-dot + run.root 的 mode chips）；
 *  children 缩进带左边线，点击选中高亮。 */
/** @jsxImportSource react */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"
import { displayColor, displayName, displayType, outcomeChipText, shownStatus } from "./simple"
import { buildTree, extractRunModes, extractUserMessage, simplifyTree, type TraceTreeNode, type TraceUserMessages } from "./types"

/** 树组件外向回调：选中某个 span（详情面板展示）。 */
export type TraceTreeHandlers = {
  onSelect: (span: TraceSpanEvent) => void
}

/** 树面板：group by trace_id → 每 trace 一棵可折叠树；折叠/选中均为本地状态。
 *  externalSelectedKey：来自甘特条的选中（traceId:spanId），到达时自动展开祖先链与分组并滚动定位。
 *  mode=simple 时先化简树，run 头显示「N 个关键节点」。 */
export function TraceTree({
  spans,
  handlers,
  externalSelectedKey = null,
  selectionRevision = 0,
  mode = "dev",
  userMessages = {},
}: {
  spans: readonly TraceSpanEvent[]
  handlers: TraceTreeHandlers
  externalSelectedKey?: string | null
  selectionRevision?: number
  mode?: "dev" | "simple"
  userMessages?: TraceUserMessages
}): React.ReactElement {
  const [collapsedRuns, setCollapsedRuns] = useState<ReadonlySet<string>>(new Set())
  const [collapsedNodes, setCollapsedNodes] = useState<ReadonlySet<string>>(new Set())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const revealedSelection = useRef<{ key: string | null; revision: number; mode: string } | null>(null)

  // 按 trace_id 分组；组内建树（simple 模式先化简）。
  const groups = useMemo(() => {
    const byTrace = new Map<string, TraceSpanEvent[]>()
    for (const item of spans) {
      const bucket = byTrace.get(item.traceId) ?? []
      bucket.push(item)
      byTrace.set(item.traceId, bucket)
    }
    return [...byTrace.entries()].map(([traceId, items]) => {
      const rawTrees = buildTree(items)
      return { traceId, trees: mode === "simple" ? simplifyTree(rawTrees) : rawTrees }
    })
  }, [spans, mode])

  // 甘特条选中到达时：把目标节点祖先链 + 所在 run 分组从折叠集合中移除（展开），并把选中标记同步过去。
  const ancestorKeys = useMemo(() => {
    if (externalSelectedKey === null) return null
    const [traceId, spanId] = splitKey(externalSelectedKey)
    const group = groups.find(g => g.traceId === traceId)
    if (!group) return null
    const chain: string[] = []
    const walk = (node: TraceTreeNode, path: string[]): boolean => {
      const here = [...path, node.span.spanId]
      if (node.span.spanId === spanId) {
        chain.push(...here)
        return true
      }
      for (const child of node.children) {
        if (walk(child, here)) return true
      }
      return false
    }
    group.trees.some(tree => walk(tree, []))
    return chain.length > 0 ? { runId: traceId, chain } : null
  }, [externalSelectedKey, groups])

  useEffect(() => {
    if (ancestorKeys === null) return
    const previous = revealedSelection.current
    // 只响应选择动作或模式切换；流式更新不能重新展开用户刚折叠的历史轮次。
    if (previous?.key === externalSelectedKey && previous.revision === selectionRevision && previous.mode === mode) return
    revealedSelection.current = { key: externalSelectedKey, revision: selectionRevision, mode }
    // 展开目标所在 run 分组与目标节点祖先链上的所有折叠节点，并把选中标记同步过去。
    setCollapsedRuns(prev => {
      if (!prev.has(ancestorKeys.runId)) return prev
      const next = new Set(prev)
      next.delete(ancestorKeys.runId)
      return next
    })
    setCollapsedNodes(prev => {
      const next = new Set(prev)
      for (const id of ancestorKeys.chain) next.delete(id)
      return next
    })
    setSelectedKey(externalSelectedKey)
  }, [ancestorKeys, externalSelectedKey, selectionRevision, mode])

  const toggleRun = (traceId: string) => {
    setCollapsedRuns(prev => {
      const next = new Set(prev)
      if (next.has(traceId)) next.delete(traceId)
      else next.add(traceId)
      return next
    })
  }

  const toggleNode = (spanId: string) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev)
      if (next.has(spanId)) next.delete(spanId)
      else next.add(spanId)
      return next
    })
  }

  const select = (span: TraceSpanEvent) => {
    setSelectedKey(`${span.traceId}:${span.spanId}`)
    handlers.onSelect(span)
  }

  if (spans.length === 0) return <div className="trace-tree-empty" />

  // 组内统计（span 总数与最早开始时间）与用户原话，供 run 头展示。
  const groupViews = useMemo(
    () =>
      groups.map(group => ({
        group,
        userMessage: extractUserMessage(getGroupSpans(group.trees), userMessages),
        modes: extractRunModes(getGroupSpans(group.trees)),
      })),
    [groups, userMessages],
  )

  return (
    <div className="trace-tree">
      {groupViews.map(({ group, userMessage, modes }) => {
        const collapsed = collapsedRuns.has(group.traceId)
        const total = group.trees.reduce((n, tree) => n + countNodes(tree), 0)
        const countBit = mode === "simple" ? `${total} 个关键节点` : `${total} spans`
        const label = userMessage || "用户输入不可用"
        return (
          <section className="trace-run-section" key={group.traceId}>
            <button
              type="button"
              className={`trace-run-header${collapsed ? " collapsed" : ""}`}
              onClick={() => toggleRun(group.traceId)}
              aria-expanded={!collapsed}
            >
              <span className="trace-run-label" title={label}>{label}</span>
              <span className="trace-run-meta">{countBit} · {Math.round(groupTotalDuration(group.trees))}ms</span>
            </button>
            {!collapsed ? (
              <div className="trace-run-body">
                {group.trees.map(tree => (
                  <TraceNodeRow
                    key={tree.span.spanId}
                    node={tree}
                    modes={modes}
                    collapsedNodes={collapsedNodes}
                    selectedKey={selectedKey}
                    externalSelectedKey={externalSelectedKey}
                    onToggle={toggleNode}
                    onSelect={select}
                  />
                ))}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/** 递归收集组内全部 span（供分组级 user message / mode 提取；simple 模式树中噪声 span
 *  已被提升，但 run.accept 等关键节点仍在，提取结果与 dev 模式一致）。 */
function getGroupSpans(trees: readonly TraceTreeNode[]): TraceSpanEvent[] {
  const out: TraceSpanEvent[] = []
  const walk = (nodes: readonly TraceTreeNode[]) => {
    for (const node of nodes) {
      out.push(node.span)
      walk(node.children)
    }
  }
  walk(trees)
  return out
}

/** 单个 span 行（递归）。有子节点时可折叠；data-depth 供测试断言层级。
 *  externalSelectedKey 匹配本节点时滚动到可视区（展开祖先由父组件 effect 处理）。
 *  modes 为分组级 run.accept 提取的 mode 参数；run.root 行右侧展示 mode chips。 */
function TraceNodeRow({
  node,
  depth = 0,
  modes,
  collapsedNodes,
  selectedKey,
  externalSelectedKey,
  onToggle,
  onSelect,
}: {
  node: TraceTreeNode
  depth?: number
  modes: { mode?: string; requestedApprovalMode?: string }
  collapsedNodes: ReadonlySet<string>
  selectedKey: string | null
  externalSelectedKey: string | null
  onToggle: (spanId: string) => void
  onSelect: (span: TraceSpanEvent) => void
}): React.ReactElement {
  const { span, children } = node
  const hasChildren = children.length > 0
  const collapsed = collapsedNodes.has(span.spanId)
  const selected = selectedKey === `${span.traceId}:${span.spanId}`
  const externalTarget = externalSelectedKey === `${span.traceId}:${span.spanId}`
  const rowRef = useRef<HTMLDivElement | null>(null)
  const isRunRoot = (span.name ?? "") === "run.root" || ((span.name ?? "") === "run" && span.type === "ROOT")

  useLayoutEffect(() => {
    if (externalTarget && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  }, [externalTarget, span.traceId, span.spanId])

  return (
    <div className="trace-node" data-depth={depth}>
      <div
        ref={rowRef}
        className={`trace-node-row${selected ? " active" : ""}`}
        data-depth={depth}
        data-span-key={`${span.traceId}:${span.spanId}`}
        onClick={() => {
          onSelect(span)
        }}
      >
        <span className="trace-toggle" onClick={event => {
          event.stopPropagation()
          if (hasChildren) onToggle(span.spanId)
        }}>
          {hasChildren ? (collapsed ? "▸" : "▾") : "·"}
        </span>
        <span className="trace-badge" style={{ "--trace-kind": displayColor(span) } as React.CSSProperties}>{displayType(span)}</span>
        <span className="trace-name" title={span.name}>{displayName(node)}</span>
        {isRunRoot && modes.mode ? <span className="trace-mode-chip kind-mode">{modes.mode}</span> : null}
        {isRunRoot && modes.requestedApprovalMode ? (
          <span className={`trace-mode-chip ${approvalChipClass(modes.requestedApprovalMode)}`}>{modes.requestedApprovalMode}</span>
        ) : null}
        {outcomeChipText(span) !== null ? <span className="trace-outcome-chip">{outcomeChipText(span)}</span> : null}
        <span className="trace-dur">{span.durationMs !== null ? `${Math.round(span.durationMs)}ms` : "—"}</span>
        <span className="trace-status-dot" data-status={shownStatus(span).toLowerCase()} />
      </div>
      {hasChildren && !collapsed ? (
        <div className="trace-children">
          {children.map(child => (
            <TraceNodeRow
              key={child.span.spanId}
              node={child}
              depth={depth + 1}
              modes={modes}
              collapsedNodes={collapsedNodes}
              selectedKey={selectedKey}
              externalSelectedKey={externalSelectedKey}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** requested_approval_mode 的 chip 视觉类：auto→绿、yolo→橙，其余默认。 */
function approvalChipClass(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "")
  return safe === "auto" || safe === "yolo" ? `appr-${safe}` : ""
}

/** 拆分 "traceId:spanId" 复合键；无冒号时整体视为 spanId（traceId 未知）。 */
function splitKey(key: string): [string, string] {
  const separator = key.indexOf(":")
  return separator < 0 ? ["", key] : [key.slice(0, separator), key.slice(separator + 1)]
}

/** 统计子树节点数。 */
function countNodes(tree: TraceTreeNode): number {
  return 1 + tree.children.reduce((sum, child) => sum + countNodes(child), 0)
}

/** run 总耗时 = 根 span 中最大 endTime - 最小 startTime（无 end 按 start）。 */
function groupTotalDuration(trees: readonly TraceTreeNode[]): number {
  let min = Infinity
  let max = -Infinity
  const walk = (node: TraceTreeNode) => {
    const s = node.span.startTime
    const e = node.span.endTime ?? node.span.startTime
    if (s < min) min = s
    if (e > max) max = e
    node.children.forEach(walk)
  }
  trees.forEach(walk)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0
  return Math.max(0, max - min)
}
