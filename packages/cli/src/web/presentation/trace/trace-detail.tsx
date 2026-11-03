/** 详情面板：对齐 4.html 原型——h2（badge + name + status-dot + 时长meta）、
 *  sub（span_id/parent/trace_id）、分节（关于/时间/metadata）、pre.json 语法着色（details 折叠）。
 *  长字符串展示统一走 FoldText 折叠：开发者模式 200 字、简化模式 500 字（对齐 4.html applyFolds 的
 *  FOLD_LIMIT=200 与简化详情少而精的 500 字），点击「展开 N 字 / 收起」切换。 */
/** @jsxImportSource react */

import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"
import type { TraceTreeNode } from "./types"
import { FoldText } from "./fold-text"
import { displayColor, displayName, displayType, replyQuote, shownStatus, shownStatusLabel, simpleFacts, summarizeStep, toolPayloadFailure } from "./simple"

/** 开发者模式字符串折叠阈值（对齐 4.html FOLD_LIMIT=200）。 */
const DEV_FOLD_LIMIT = 200
/** 简化模式字符串折叠阈值。 */
const SIMPLE_FOLD_LIMIT = 500

/** 详情面板：选中 span 后展示；无选中时空态。
 *  mode=simple 时用自然语言概括 + 关键信息（模型/token/耗时等），隐藏原始 JSON。
 *  node 为选中 span 的完整子树节点（simple 模式需要 children 提取模型名/工具调用，对齐原型 selectNode）。
 *  modes 为该 span 所在 trace 组级 run.accept 提取的 mode 参数，供 simple 模式 run.root/run.accept 节点使用。 */
export function TraceDetail({
  node,
  mode = "dev",
  modes,
}: {
  node: TraceTreeNode | null
  mode?: "dev" | "simple"
  modes?: { mode?: string; requestedApprovalMode?: string }
}): React.ReactElement {
  if (node === null) {
    return <div className="trace-detail trace-detail-empty">选择左侧节点或时间线查看详情</div>
  }
  if (mode === "simple") return <SimpleDetail node={node} modes={modes} />
  return <DevDetail node={node} />
}

/** 开发者模式：h2 + sub 定位行，分节「关于（raw JSON）/时间/metadata」（对齐 4.html renderDevDetail：
 *  无顶层字段节；mode/requested_approval_mode 值高亮；metadata 跳过一个空的 sessionId 键）。 */
function DevDetail({ node }: { node: TraceTreeNode }): React.ReactElement {
  const span = node.span
  const rawText = JSON.stringify(span.raw, null, 2) ?? ""
  const metadata = span.metadata ?? {}
  const failed = toolPayloadFailure(span) !== null

  return (
    <div className="trace-detail" data-selected="true">
      <h2 className="trace-detail-title">
        <span className="trace-badge" style={{ backgroundColor: displayColor(span) }}>{displayType(span)}</span>
        {displayName(node)}
        <span className="trace-status-dot" data-status={shownStatus(span).toLowerCase()} />
        <span className={`trace-detail-meta${failed ? " is-failed" : ""}`}>
          {span.durationMs !== null ? `${Math.round(span.durationMs)}ms` : "—"} · {shownStatusLabel(span)}
        </span>
      </h2>
      <div className="trace-detail-sub">
        span_id: {span.spanId} | parent_span_id: {span.parentSpanId ?? "—"} | trace_id: {span.traceId}
      </div>

      <div className="trace-section">
        <h3>关于 <span className="trace-section-note">（raw JSON 完整保留，未做任何裁剪）</span></h3>
        <details open>
          <summary className="trace-raw-toggle">展开 / 收起完整原始数据</summary>
          <pre className="trace-json">{renderJson(rawText, DEV_FOLD_LIMIT)}</pre>
        </details>
      </div>

      <div className="trace-section">
        <h3>时间</h3>
        <div className="trace-kv">
          <span className="trace-kv-row"><span className="trace-k">start_time</span><span className="trace-v">{span.startTime}</span></span>
          <span className="trace-kv-row"><span className="trace-k">end_time</span><span className="trace-v">{span.endTime ?? "—"}</span></span>
          <span className="trace-kv-row"><span className="trace-k">duration_ms</span><span className="trace-v">{span.durationMs ?? "—"}</span></span>
        </div>
      </div>

      <div className="trace-section">
        <h3>metadata <span className="trace-section-note">（start + end 已合并）</span></h3>
        {Object.keys(metadata).length > 0 ? (
          <div className="trace-kv">
            {Object.entries(metadata).filter(([key]) => key !== "sessionId").map(([key, value]) => {
              // 对齐 4.html renderKV：只有 mode / requested_approval_mode 值高亮。
              const hl = key === "mode" || key === "requested_approval_mode"
              return (
                <span className="trace-kv-row" key={key}>
                  <span className="trace-k">{key}</span>
                  <span className={`trace-v${hl ? " trace-v-hl" : ""}`}>{formatValue(value, DEV_FOLD_LIMIT)}</span>
                </span>
              )
            })}
          </div>
        ) : (
          <div className="trace-empty-note">（empty）</div>
        )}
      </div>
    </div>
  )
}

/** metadata 值格式化：对象/数组套 JSON 盒子（对齐 4.html renderKV+colorizeJSON：pre.json 边框、
 *  等宽字体、语法着色、超长字符串折叠）；字符串折叠，基本类型直显。 */
function formatValue(value: unknown, limit: number): React.ReactNode {
  if (typeof value === "string") return <FoldText text={value} limit={limit} />
  if (value === null) return "null"
  if (typeof value === "object") return <pre className="trace-json">{renderJson(JSON.stringify(value, null, 2), limit)}</pre>
  return String(value)
}

/** 极简 JSON 语法着色（key/str/num/bool/null），字符串值超过 limit 自动折叠。
 *  返回安全的 ReactNode 数组，不注入 HTML 字符串，并保留交互折叠。 */
function renderJson(text: string, limit: number): readonly React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const [, key, colon, bool, num] = match
    if (key !== undefined) {
      // 字符串：判定是否为 key（后随冒号）；是 key 不着色折叠，是 value 展开字符串内容并折叠超长值。
      if (colon !== undefined) {
        nodes.push(<span key={match.index} className="trace-json-key">{key}</span>)
        nodes.push(colon)
      } else {
        nodes.push(<JsonStringLiteral key={match.index} literal={key} limit={limit} />)
      }
    } else if (bool !== undefined) {
      nodes.push(<span key={match.index} className="trace-json-bool">{bool}</span>)
    } else if (num !== undefined) {
      nodes.push(<span key={match.index} className="trace-json-num">{num}</span>)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** JSON 字符串字面量：解码后按 limit 折叠（对齐 3.html 的 applyFolds 对 span.str 的处理）。 */
function JsonStringLiteral({ literal, limit }: { literal: string; limit: number }): React.ReactElement {
  let decoded: string
  try {
    decoded = JSON.parse(literal)
  } catch {
    decoded = literal.slice(1, -1)
  }
  const chars = Array.from(decoded)
  if (chars.length <= limit) return <span className="trace-json-str">{literal}</span>
  // 超长字符串：折叠态显示前 limit 字 + 省略号，按钮字数按解码后统计；
  // 展开后显示原始引号字面量（保留 JSON 语义）。
  const preview = JSON.stringify(chars.slice(0, limit).join("")).slice(0, -1) + "…\""
  return (
    <span className="trace-json-str">
      <FoldText text={literal} limit={limit} count={chars.length} preview={preview} />
    </span>
  )
}

/** 简化模式详情：自然语言概括 + 回复引语（折叠 500 字）+ 关键信息表（对齐 3.html renderSimpleDetail）。
 *  node 为完整子树节点（children 供模型名/工具调用提取）。 */
function SimpleDetail({ node, modes }: { node: TraceTreeNode; modes?: { mode?: string; requestedApprovalMode?: string } }): React.ReactElement {
  const span = node.span
  const lead = summarizeStep(node, modes)
  const quote = replyQuote(node)
  const facts = simpleFacts(node, modes)
  return (
    <div className="trace-detail trace-detail-simple" data-selected="true">
      <h2 className="trace-detail-title">
        <span className="trace-badge" style={{ backgroundColor: displayColor(span) }}>{displayType(span)}</span>
        {displayName(node)}
        <span className="trace-status-dot" data-status={shownStatus(span).toLowerCase()} />
        <span className="trace-detail-meta">
          {span.durationMs !== null ? `${Math.round(span.durationMs)}ms` : "—"}
        </span>
      </h2>
      <p className="trace-summary-lead">{lead}</p>
      {quote ? (
        <blockquote className="trace-summary-quote">
          <FoldText text={quote} limit={SIMPLE_FOLD_LIMIT} />
        </blockquote>
      ) : null}
      <div className="trace-section">
        <h3>关键信息</h3>
        <div className="trace-kv">
          {facts.map(([key, value]) => (
            <span className="trace-kv-row" key={key}>
              <span className="trace-k">{key}</span>
              <span className="trace-v"><FoldText text={value} limit={SIMPLE_FOLD_LIMIT} /></span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
