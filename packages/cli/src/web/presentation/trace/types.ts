/** 轨迹视图数据模型：TraceSpanEvent 消费侧类型 + 建树工具。与 trace_viewer.py build_tree 语义对齐。 */

import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"

/** 树节点：包装 span 并挂载子节点。 */
export type TraceTreeNode = {
  readonly span: TraceSpanEvent
  readonly children: readonly TraceTreeNode[]
}

/**
 * 按 parent_span_id 建树：parent="0"/自环/父不在当前集合时挂根；子节点与根均按
 * startTime 升序（对齐 trace_viewer.py TraceGroup.build_tree）。
 * 分两趟：第一趟填 byId（父可能出现在子之后），第二趟判定父子关系。
 */
/** 简化模式丢弃的噪声节点类型：上下文/库、策略、中间件与等待交互（对齐 3.html NOISE_TYPES）。 */
const NOISE_TYPES = new Set(["CONTEXT", "DB", "POLICY", "INTERACTION"])

/** 判断节点是否属于简化模式要隐藏的噪声节点；子节点会提升到最近的可见父节点。 */
export function isNoiseNode(node: TraceTreeNode): boolean {
  const kind = String(node.span.type ?? "").toUpperCase()
  if (NOISE_TYPES.has(kind)) return true
  return /middleware/i.test(String(node.span.name ?? ""))
}

/** 判断节点是否为 LangGraph 的 model NODE 外壳：type=NODE 且 name=model。
 *  名叫 model 的 NODE 与里面的 LLM 总是成对出现，简化模式去掉这层外壳、LLM 提升一级
 *  （对齐 trace_viewer.py isModelShell / simplifyTree 的 liftsLlm 分支）。 */
export function isModelShell(node: TraceTreeNode): boolean {
  const kind = String(node.span.type ?? "").toUpperCase()
  const name = String(node.span.name ?? "")
  return kind === "NODE" && name === "model"
}

/** 判断节点是否为 tools NODE（name=tools 的 LangGraph 工具聚合外壳）。 */
export function isToolsNode(node: TraceTreeNode): boolean {
  return String(node.span.name ?? "") === "tools"
}

/** 把树按简化模式过滤：噪声节点丢弃、其子节点递归提升到可见父下；model NODE 外壳
 *  去掉并将 LLM（及其它子节点）提升一级；tools NODE 丢弃 type=TOOL 子节点。
 *  后两者对齐 trace_viewer.py simplifyTree + 4.html 的展示效果：每个工具回合只
 *  保留一个 TOOL 行（工具名由 tools 的 input.tool_calls 表达），不重复显示行内 ask_user 等。 */
export function simplifyTree(nodes: readonly TraceTreeNode[]): readonly TraceTreeNode[] {
  const out: TraceTreeNode[] = []
  for (const node of nodes ?? []) {
    const kids = simplifyTree(node.children)
    if (isNoiseNode(node)) {
      out.push(...kids)
      continue
    }
    if (isModelShell(node)) {
      out.push(...kids)
      continue
    }
    if (isToolsNode(node)) {
      out.push({ span: node.span, children: kids.filter(child => String(child.span.type ?? "").toUpperCase() !== "TOOL") })
      continue
    }
    out.push({ span: node.span, children: kids })
  }
  return out
}

/**
 * 4.html 三行甘特的行分配：对树遍历计算每个节点所属 lane（0=Input，1=Model，2=Tools），
 * 平移 trace_viewer.py TraceGroup.to_tree_dict 的 lane_of / has_same_lane / walk：
 * - TOOL 类型或名为 tools → 2；LLM 类型或名为 model → 1；run.accept / INTERACTION → 0；其余 → 不画；
 * - POLICY 节点及其子树不画条（避免策略阻塞路径里无效条块）；
 * - 父节点与子节点落在同一 lane 时只画子节点（模型与工具条不重叠）；
 * - 返回键为 `traceId:spanId` → lane 的映射，仅包含需要画条的节点。
 */
export function ganttLanes(nodes: readonly TraceTreeNode[]): ReadonlyMap<string, number> {
  const lanes = new Map<string, number>()

  const laneOf = (node: TraceTreeNode): number | null => {
    const type = String(node.span.type ?? "").toUpperCase()
    const name = node.span.name ?? ""
    if (type === "TOOL" || name === "tools") return 2
    if (type === "LLM" || name === "model") return 1
    if (name === "run.accept" || type === "INTERACTION") return 0
    return null
  }

  const hasSameLane = (node: TraceTreeNode, lane: number, blocked: boolean): boolean => {
    for (const child of node.children) {
      const childBlocked = blocked || String(child.span.type ?? "").toUpperCase() === "POLICY"
      if (!childBlocked && laneOf(child) === lane) return true
      if (hasSameLane(child, lane, childBlocked)) return true
    }
    return false
  }

  const walk = (node: TraceTreeNode, blocked: boolean): void => {
    const type = String(node.span.type ?? "").toUpperCase()
    const blockedHere = blocked || type === "POLICY"
    const lane = blockedHere ? null : laneOf(node)
    if (lane !== null && !hasSameLane(node, lane, blockedHere)) {
      lanes.set(`${node.span.traceId}:${node.span.spanId}`, lane)
    }
    for (const child of node.children) walk(child, blockedHere)
  }

  for (const node of nodes) walk(node, false)
  return lanes
}

export function buildTree(spans: readonly TraceSpanEvent[]): readonly TraceTreeNode[] {
  const byId = new Set<string>()
  for (const item of spans) byId.add(item.spanId)
  const childrenOf = new Map<string, TraceSpanEvent[]>()
  const roots: TraceSpanEvent[] = []
  for (const item of spans) {
    const parent = item.parentSpanId
    if (parent === null || parent === item.spanId || !byId.has(parent)) {
      roots.push(item)
    } else {
      const bucket = childrenOf.get(parent) ?? []
      bucket.push(item)
      childrenOf.set(parent, bucket)
    }
  }
  const sortSpan = (a: TraceSpanEvent, b: TraceSpanEvent) => a.startTime - b.startTime
  const build = (span: TraceSpanEvent): TraceTreeNode => {
    const kids = (childrenOf.get(span.spanId) ?? []).sort(sortSpan).map(build)
    return { span, children: kids }
  }
  return roots.sort(sortSpan).map(build)
}

/**
 * 当前线程的 span 集：优先按 currentThreadId 取，末尾并入会话级（key ""）的 span 作为兜底——
 * 无任何 thread_id 绑定的 trace（如纯 SDK 内部链路）不会因线程过滤而整条丢失。
 */
export function spansForThread(
  traces: Readonly<Record<string, readonly TraceSpanEvent[]>>,
  currentThreadId: string | null,
): readonly TraceSpanEvent[] {
  const threadSpans = currentThreadId !== null ? (traces[currentThreadId] ?? []) : (traces[""] ?? [])
  const sessionSpans = traces[""] ?? []
  if (currentThreadId === null || sessionSpans.length === 0) return threadSpans
  // 合并去重：同一 spanId 只保留一份（thread 桶优先）。
  const seen = new Set(threadSpans.map(item => item.spanId))
  const merged = [...threadSpans]
  for (const item of sessionSpans) {
    if (!seen.has(item.spanId)) merged.push(item)
  }
  return merged
}

/** StartRun 命令里的 `key='value'` 字段：mode / requested_approval_mode / message 等。
 *  与 trace_viewer.py `_START_RUN_FIELD_RE` 语义对齐；重复出现取首个。 */
function startRunFields(command: unknown): Record<string, string> {
  const fields: Record<string, string> = {}
  if (typeof command !== "string") return fields
  const re = /(?<key>mode|requested_approval_mode|message)=(['"])(?<val>(?:\\.|(?!\2).)*)\2/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    const key = match.groups!.key
    if (!(key in fields)) fields[key] = match.groups!.val
  }
  return fields
}

/** 反转 command repr 中的转义引号/反斜杠。 */
function unescapeMessage(raw: string): string {
  return raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

/** 从 metadata.input.command 提取 StartRun 的 mode 参数（如 build）+ requested_approval_mode（如 auto）。 */
export function extractRunMode(span: TraceSpanEvent): { mode?: string; requestedApprovalMode?: string } {
  const input = span.metadata?.input
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const fields = startRunFields((input as Record<string, unknown>).command)
    const result: { mode?: string; requestedApprovalMode?: string } = {}
    if (fields.mode) result.mode = fields.mode
    if (fields.requested_approval_mode) result.requestedApprovalMode = fields.requested_approval_mode
    return result
  }
  return {}
}

/** 一组 span 内首个 run.accept 的 mode 参数（mode/requested_approval_mode），用于 run 根节点展示。
 *  对齐 trace_viewer.py extract_run_modes。 */
export function extractRunModes(spans: readonly TraceSpanEvent[]): { mode?: string; requestedApprovalMode?: string } {
  for (const span of spans) {
    if ((span.name ?? "") === "run.accept") {
      const fields = extractRunMode(span)
      if (fields.mode || fields.requestedApprovalMode) return fields
    }
  }
  return {}
}

/** 从 metadata.input.command / AGENT input.messages 提取本轮用户原话（对齐 trace_viewer.extract_user_message）。
 *  优先 run.accept.command 里的 message，其次 AGENT 的 input.messages[0].content。 */
export function extractUserMessage(spans: readonly TraceSpanEvent[]): string {
  for (const span of spans) {
    const input = span.metadata?.input
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const raw = (input as Record<string, unknown>).command
      if (typeof raw === "string") {
        const fields = startRunFields(raw)
        if (fields.message) return unescapeMessage(fields.message)
      }
    }
  }
  for (const span of spans) {
    if (span.type !== "AGENT") continue
    const input = span.metadata?.input ?? span.raw.input
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue
    const messages = (input as Record<string, unknown>).messages
    if (!Array.isArray(messages)) continue
    for (const msg of messages) {
      if (typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).role === "user") {
        const content = (msg as Record<string, unknown>).content
        if (typeof content === "string" && content.trim()) return content.trim()
      }
    }
  }
  return ""
}
