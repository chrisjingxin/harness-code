/** 简化模式的自然语言概括与关键信息抽取。
 *  逻辑平移自 trace_viewer.py 生成的 3.html（renderSimpleDetail/summarizeStep/simpleFacts
 *  等，trace_viewer.py:1501-1980），输入为解析后的 TraceSpanEvent + 树，输出可展示文本。 */

import type { TraceSpanEvent } from "../../../presentation-coordinator/contracts/trace"
import { typeColor } from "./colors"
import type { TraceTreeNode } from "./types"

/** 时长展示：不足 1s ms、否则 s（对齐原型 fmtMs）。 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** 状态中文文案（对齐原型 statusText）。 */
function statusText(status: string | undefined): string {
  const s = String(status ?? "").toUpperCase()
  if (s === "SUCCESS") return "已完成"
  if (s === "FAILED" || s === "ERROR") return "失败"
  if (s === "RUNNING") return "运行中"
  return "已记录"
}

/** 压缩空白为单空格并 trim。 */
function oneLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

/** 截取前 n 个字符（按 Unicode code point），超长加省略号。 */
function clipChars(value: unknown, n: number): string {
  const chars = Array.from(String(value ?? "").trim())
  if (chars.length <= n) return chars.join("")
  return chars.slice(0, n).join("") + "…"
}

/** 从节点 metadata/raw 中取 output 文本（原型 outputText）。 */
function outputText(span: TraceSpanEvent): string {
  const rawOut = span.raw.output
  const metaOut = span.metadata?.output
  const out = rawOut !== undefined && rawOut !== null ? rawOut : metaOut
  if (out === undefined || out === null || out === "") return ""
  return typeof out === "string" ? out : JSON.stringify(out)
}

/** 反转被转义的 HTML 实体（原型 plain）。 */
function plain(value: unknown): string {
  return String(value ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

/** 从 metadata.input.command 提取 UserRunInput.message（原型 userMessageOf）。 */
function userMessageOf(span: TraceSpanEvent): string {
  const input = span.metadata?.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ""
  const cmd = (input as Record<string, unknown>).command
  if (typeof cmd !== "string") return ""
  const re = /UserRunInput\(\s*message=(['"])((?:\\.|(?!\1).)*)\1/
  const m = re.exec(cmd)
  if (!m) return ""
  return m[2]!.replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
}

/** 从 command 字符串提取 mode / requested_approval_mode（原型 modeOf/approvalOf 的宽松版，
 *  允许模式前是任意非单词字符，与 types.startRunFields 语义一致，避免漏掉 `(mode='build'` 这种写法）。 */
function fieldFromCommand(span: TraceSpanEvent, field: "mode" | "requested_approval_mode"): string {
  const input = span.metadata?.input
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ""
  const cmd = (input as Record<string, unknown>).command
  if (typeof cmd !== "string") return ""
  const re = new RegExp(`(?:^|[^\\w_])${field}=(['"])([^'"]*)\\1`)
  const m = re.exec(cmd)
  return m ? m[2]! : ""
}

/** 节点 metadata.custom_metadata（原型 customMeta）。 */
function customMeta(span: TraceSpanEvent): Record<string, unknown> | null {
  const cm = span.metadata?.custom_metadata
  return cm && typeof cm === "object" && !Array.isArray(cm) ? (cm as Record<string, unknown>) : null
}

/** 匹配文本中某 key 后的第一个数字（原型 numAfter）。 */
function numAfter(text: string, key: string): number | null {
  let from = 0
  let found: number | null = null
  while (from < text.length) {
    const at = text.indexOf(key, from)
    if (at < 0) return found
    const prev = at > 0 ? text[at - 1]! : ""
    if (prev && /[A-Za-z0-9_]/.test(prev)) {
      from = at + key.length
      continue
    }
    let i = at + key.length
    if (text[i] === '"' || text[i] === "'") i += 1
    while (text[i] === " " || text[i] === "\t") i += 1
    if (text[i] !== ":" && text[i] !== "=") {
      from = at + key.length
      continue
    }
    i += 1
    while (text[i] === " " || text[i] === "\t") i += 1
    let j = i
    while (text[j] >= "0" && text[j] <= "9") j += 1
    if (j > i) found = Number(text.slice(i, j))
    from = at + key.length
  }
  return found
}

/** 从 output 文本解析 token 用量（原型 parseTokensFromText）。 */
function parseTokensFromText(text: string): { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedTokens: number | null } | null {
  if (!text) return null
  const inputTokens = numAfter(text, "input_tokens")
  const outputTokens = numAfter(text, "output_tokens")
  const totalTokens = numAfter(text, "total_tokens")
  const cachedTokens = numAfter(text, "cached_tokens")
  const cacheRead = numAfter(text, "cache_read")
  const cached = cachedTokens !== null ? cachedTokens : cacheRead
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null
  return { inputTokens, outputTokens, totalTokens, cachedTokens: cached }
}

/** 整棵树的 token 用量（优先 custom_metadata.token_usage，回退 output 文本，再回退子树 LLM；原型 tokenObject）。 */
function tokenObject(node: TraceTreeNode): { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null } | null {
  const span = node.span
  const cm = customMeta(span)
  const usage = cm?.token_usage
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const tu = usage as Record<string, unknown>
    if (tu.input_tokens != null || tu.output_tokens != null) {
      return {
        inputTokens: tu.input_tokens != null ? Number(tu.input_tokens) : null,
        outputTokens: tu.output_tokens != null ? Number(tu.output_tokens) : null,
        cachedTokens: tu.cached_tokens != null ? Number(tu.cached_tokens) : null,
      }
    }
  }
  const parsed = parseTokensFromText(outputText(span))
  if (parsed) return parsed
  // NODE/AGENT 等聚合节点自身无 token，回退子树内首个有 token 用量的 LLM span。
  for (const child of node.children) {
    const hit = tokenObject(child)
    if (hit) return hit
  }
  return null
}

/** token 展示行（原型 tokenLine）。 */
function tokenLine(token: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null } | null): string {
  if (!token) return ""
  const parts: string[] = []
  if (token.inputTokens != null) parts.push(`输入 ${token.inputTokens}`)
  if (token.outputTokens != null) parts.push(`输出 ${token.outputTokens}`)
  if (token.cachedTokens) parts.push(`缓存 ${token.cachedTokens}`)
  return parts.join(" · ")
}

/** 模型名：metadata.model → LLM 节点名 → 子树里首个 LLM 的 metadata.model/name → output 文本（原型 modelOf）。 */
function modelOf(node: TraceTreeNode): string {
  const span = node.span
  const md = span.metadata ?? {}
  if (typeof md.model === "string" && md.model) return md.model
  if (span.type === "LLM" && span.name) return span.name
  for (const child of node.children) {
    if (child.span.type === "LLM") {
      const childMd = child.span.metadata ?? {}
      return (typeof childMd.model === "string" && childMd.model) || child.span.name || ""
    }
  }
  const m = /model_name["']?\s*[:=]\s*['"]([^'"]+)/.exec(outputText(span))
  return m ? m[1]! : ""
}

/** 首字时间（metadata.first_token_time 或 LLM 子树；原型 firstTokenOf）。 */
function firstTokenOf(node: TraceTreeNode): number | null {
  const span = node.span
  const md = span.metadata ?? {}
  if (typeof md.first_token_time === "number") return md.first_token_time
  for (const child of node.children) {
    if (child.span.type === "LLM" && typeof child.span.metadata?.first_token_time === "number") {
      return child.span.metadata.first_token_time
    }
  }
  return null
}

/** 节点耗时：node 自身 durationMs，缺失时回退子树内首个有耗时的 span（LLM/TOOL 只有 start 日志时兜底）。 */
function nodeDurationMs(node: TraceTreeNode): number | null {
  const own = node.span.durationMs
  if (own != null) return own
  for (const child of node.children) {
    const hit = nodeDurationMs(child)
    if (hit != null) return hit
  }
  return null
}

/** finish_reason（metadata 或 LLM 子树或 output 文本；原型 finishOf）。 */
function finishOf(node: TraceTreeNode): string {
  const span = node.span
  const md = span.metadata ?? {}
  if (md.finish_reason) return String(md.finish_reason)
  for (const child of node.children) {
    if (child.span.type === "LLM" && child.span.metadata?.finish_reason) return String(child.span.metadata.finish_reason)
  }
  const m = /finish_reason["']?\s*[:=]\s*['"]([^'"]+)/.exec(outputText(span))
  return m ? m[1]! : ""
}

/** 提取 args 里前 3 个 k=v 简短项（原型 briefArgs）。 */
function briefArgs(args: unknown): string {
  const pairs: string[] = []
  const re = /['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*:\s*(['"])((?:\\.|(?!\2).){0,100})\2/g
  let m: RegExpExecArray | null
  const text = String(args ?? "")
  while ((m = re.exec(text)) !== null) {
    const key = m[1]!
    if (key === "id" || key === "type" || key === "name") continue
    const val = m[3]!.replace(/\\n/g, " ").replace(/\\+"/g, '"').replace(/\\+'/g, "'").replace(/\\+/g, "\\").trim()
    if (!val) continue
    pairs.push(`${key}=${val}`)
  }
  return pairs.slice(0, 3).join("，")
}

/** 从 output 文本抽取最近一次（非 invalid_）tool_calls 里的工具名+参数（原型 pickToolCalls）。 */
function pickToolCalls(text: string): Array<{ name: string; argsText: string }> {
  if (!text) return []
  let anchor = -1
  let from = 0
  while (from < text.length) {
    const at = text.indexOf("tool_calls", from)
    if (at < 0) break
    const prev = text.slice(Math.max(0, at - 8), at)
    if (!prev.endsWith("invalid_")) anchor = at
    from = at + 10
  }
  if (anchor < 0) return []
  const src = text.slice(anchor, anchor + 2500)
  const calls: Array<{ name: string; argsText: string }> = []
  const re = /['"]name['"]\s*:\s*['"]([A-Za-z0-9_.-]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    if (!name) continue
    const ahead = src.slice(m.index, m.index + 90)
    if (!/['"]args['"]/.test(ahead) && !/['"]arguments['"]/.test(ahead)) continue
    const argAt = ahead.search(/['"]arguments['"]|['"]args['"]/)
    const argWindow = src.slice(m.index + argAt, m.index + argAt + 320)
    const argsText = briefArgs(argWindow)
    if (calls.some(c => c.name === name && c.argsText === argsText)) continue
    calls.push({ name, argsText })
    if (calls.length >= 4) break
  }
  return calls
}

/** 工具短语：name（args）…（原型 toolPhrase）。 */
function toolPhrase(calls: readonly { name: string; argsText: string }[]): string {
  if (!calls || !calls.length) return ""
  return calls.map(c => c.name + (c.argsText ? `（${c.argsText}）` : "")).join("、")
}

/** 从 output 提取 assistant/AI 回复文本（原型 assistantReply）。 */
function assistantReply(span: TraceSpanEvent): string {
  const out = span.raw.output !== undefined ? span.raw.output : span.metadata?.output
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const record = out as Record<string, unknown>
    if (Array.isArray(record.messages)) {
      for (let i = record.messages.length - 1; i >= 0; i--) {
        const msg = record.messages[i] as Record<string, unknown> | undefined
        if (!msg || typeof msg.content !== "string" || !msg.content.trim()) continue
        if (msg.role === "assistant" || msg.role === "ai") {
          const s = usableReply(msg.content)
          if (s) return s
        }
      }
    }
    if (Array.isArray(record.generations) && record.generations[0]) {
      const g = record.generations[0] as Record<string, unknown>
      const text = (g.message && (g.message as Record<string, unknown>).content) || g.text || ""
      if (typeof text === "string") {
        const s = usableReply(text)
        if (s) return s
      }
    }
  }
  const blob = outputText(span)
  const py = pyContent(blob)
  if (py) {
    const s = usableReply(py)
    if (s) return s
  }
  const js = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(blob)
  if (js) {
    try {
      const s = JSON.parse('"' + js[1] + '"').trim()
      if (s) return s
    } catch {
      // 非法 JSON 文本不回退。
    }
  }
  return ""
}

/** 从 output 文本里抽取 Python repr 形式的 AIMessage content（原型 pyContent）：
 *  同时匹配单引号与双引号两种写法，取最后一个非空匹配。 */
function pyContent(blob: string): string {
  if (!blob) return ""
  const patterns = [
    /AIMessage\(content='((?:\\'|[^'])*)'/g,
    /AIMessage\(content="((?:\\"|[^"])*)"/g,
  ]
  let last = ""
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(blob)) !== null) {
      if (m[1] && m[1]!.trim()) last = m[1]!
    }
  }
  return last
}

/** 还原 Python repr 里的转义序列（原型 usableReply）：
 *  \\n \\t \\r \\' \\" \\\\ 全部还原，避免详情里出现单独的反斜杠；
 *  还原后若不含任何中文/字母/数字则视为不可用回复，返回空串。 */
function usableReply(value: unknown): string {
  const t = String(value ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim()
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(t)) return ""
  return t
}

/** 工具输出 → 一句话描述（原型 describeToolContent）。 */
function describeToolContent(content: unknown): string {
  if (content === undefined || content === null) return ""
  let text = typeof content === "string" ? content : JSON.stringify(content)
  const exit = text.match(/\[Command (succeeded|failed) with exit code (\d+)\]/)
  text = text.replace(/\n?\[Command (?:succeeded|failed) with exit code \d+\]\s*$/, "").trim()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非 JSON 输出。
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (record.ok === true && record.deleted) {
      return `文件已删除${record.path ? `（${record.path}）` : ""}。`
    }
    if (record.ok === true) {
      return `执行成功${record.path ? `，路径 ${record.path}` : record.message ? `，${record.message}` : ""}。`
    }
    if (record.ok === false) {
      const err = record.error
      const msg = (err && typeof err === "object" && ((err as Record<string, unknown>).message || (err as Record<string, unknown>).code)) || record.message || "执行没有成功"
      const sentence = oneLine(msg)
      return /[。！？.!?]$/.test(sentence) ? sentence : sentence + "。"
    }
  }
  const preview = clipChars(oneLine(text), 120)
  if (exit) {
    const ok = exit[1] === "succeeded"
    const head = ok ? `命令成功，退出码 ${exit[2]}。` : `命令失败，退出码 ${exit[2]}。`
    return preview ? head + `输出是「${preview}」。` : head
  }
  return preview ? `结果是「${preview}」。` : ""
}

/** 工具节点结果文本（原型 resultTextOf）。 */
function resultTextOf(span: TraceSpanEvent): string {
  const out = span.raw.output !== undefined ? span.raw.output : span.metadata?.output
  const msgs: unknown[] = []
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const record = out as Record<string, unknown>
    if (Array.isArray(record.messages)) {
      for (const msg of record.messages) {
        if (msg && typeof msg === "object" && (msg as Record<string, unknown>).content != null) msgs.push((msg as Record<string, unknown>).content)
      }
    } else if (record.content != null) {
      msgs.push(record.content)
    }
  } else if (typeof out === "string") {
    msgs.push(out)
  }
  return msgs.map(describeToolContent).filter(Boolean).join("")
}

/** 工具名（metadata.tool_name 或 TOOL 节点名；原型 toolNameOf）。 */
function toolNameOf(span: TraceSpanEvent): string {
  const md = span.metadata ?? {}
  if (typeof md.tool_name === "string" && md.tool_name) return md.tool_name
  if (span.type === "TOOL") return span.name ?? ""
  return ""
}

/** 单步自然语言概括（对齐原型 summarizeStep）。node 为建树后的节点（含 children）；
 *  modes 为该 trace 组级 run.accept 提取的 mode/requested_approval_mode（原型 stamp 到 run.root 顶层，这里显式传入）。 */
export function summarizeStep(node: TraceTreeNode, modes?: { mode?: string; requestedApprovalMode?: string }): string {
  const span = node.span
  const name = span.name ?? "这一步"
  const type = span.type ?? ""
  const cm = customMeta(span)
  const failed = span.status === "FAILED" || span.status === "ERROR"
  const lead = failed ? "这一步失败了。" : ""

  if (name === "run.root" || (name === "run" && type === "ROOT")) {
    let s = "这是这一轮运行的起点。"
    const mode = modes?.mode ?? modeOf(node)
    const appr = modes?.requestedApprovalMode ?? approvalOf(node)
    if (mode && appr) s += `使用 ${mode} 模式，审批方式是 ${appr}。`
    else if (mode) s += `使用 ${mode} 模式。`
    return lead + s
  }
  if (name === "run.accept") {
    let s = "接收了用户的这次请求，并创建运行。"
    const msg = userMessageOf(span)
    if (msg) s += `用户说：「${clipChars(oneLine(msg), 80)}」。`
    const outcome = cm?.outcome
    if (outcome === "created") s += "运行已创建。"
    else if (outcome) s += `结果是 ${outcome}。`
    return lead + s
  }
  if (name === "run.complete") {
    const st = (cm?.status as string) || ""
    let s = st === "completed" || st === "success" ? "这一轮运行正常结束。" : "这一轮运行结束了。"
    if (st && st !== "completed" && st !== "success") s += `结果是 ${st}。`
    if (cm?.error) s += `错误是「${clipChars(oneLine(cm.error), 120)}」。`
    return lead + s
  }
  if (type === "AGENT") {
    let s = `智能体 ${name} 处理了这一段。`
    const reply = usableReply(assistantReply(span))
    if (reply) s += "它给出了回复。"
    return lead + s
  }
  if (type === "LLM" || name === "model") {
    const model = modelOf(node)
    const calls = logicalTools(node)
    const finish = finishOf(node)
    const reply = usableReply(assistantReply(span))
    let s = model ? `调用了模型 ${model}。` : "做了一次模型推理。"
    if (calls.length) s += `模型决定使用 ${toolPhrase(calls)}。`
    else if (finish === "tool_calls") s += "模型决定调用工具。"
    else if (finish === "length") s += "输出到达长度上限后停了下来。"
    else if (reply) s += "模型直接给出了回复。"
    else if (finish === "stop") s += "模型正常结束，没有再调用工具。"
    return lead + s
  }
  if (type === "TOOL" || name === "tools") {
    if (type === "TOOL") {
      const toolName = toolNameOf(span)
      let s: string
      if (toolName === "ask_user") s = "向用户发起了一次确认或提问。"
      else if (toolName) s = `执行了工具 ${toolName}。`
      else s = "执行了工具调用。"
      const result = resultTextOf(span)
      if (result) s += result
      return lead + s
    }
    // name === "tools"：调用聚合节点，工具名取输出中的调用。
    const calls = pickToolCalls(outputText(span))
    const phrase = toolPhrase(calls)
    let s = phrase ? `执行了 ${phrase}。` : "执行了工具调用。"
    const result = resultTextOf(span)
    if (result) s += result
    return lead + s
  }
  let s = `执行了${type ? ` ${type} ` : " "}${name}。`
  return failed ? "这一步失败了。" + s : s
}

/** 关键信息行（对齐原型 simpleFacts 输出的 [key, value] 对）；modes 为组级 run.accept 提取值。 */
export function simpleFacts(node: TraceTreeNode, modes?: { mode?: string; requestedApprovalMode?: string }): Array<[string, string]> {
  const span = node.span
  const name = span.name ?? ""
  const rows: Array<[string, string]> = []
  const isLlm = span.type === "LLM" || name === "model"
  if (isLlm) {
    const model = modelOf(node)
    if (model) rows.push(["模型", model])
  }
  const cm = customMeta(span)
  const dur = name === "run.complete" && cm && cm.duration_ms != null ? Number(cm.duration_ms) : nodeDurationMs(node)
  rows.push(["耗时", formatMs(dur)])
  const tokens = tokenObject(node)
  const line = tokenLine(tokens)
  if (line) rows.push(["Token", line])
  if (isLlm) {
    const ft = firstTokenOf(node)
    if (ft != null) rows.push(["首字", formatMs(ft)])
  }
  if (name === "run.root" || (name === "run" && span.type === "ROOT") || name === "run.accept") {
    const mode = modes?.mode ?? modeOf(node)
    const appr = modes?.requestedApprovalMode ?? approvalOf(node)
    if (mode) rows.push(["模式", mode])
    if (appr) rows.push(["审批", appr])
  }
  if (span.type === "TOOL" || span.name === "tools") {
    const calls = span.name === "tools" ? logicalTools(node) : []
    const phrase = toolPhrase(calls) || toolNameOf(span)
    if (phrase) rows.push(["工具", phrase])
  }
  const shown = shownStatus(span)
  if (shown && shown !== "SUCCESS") rows.push(["状态", statusText(shown)])
  const payload = toolPayloadFailure(span)
  if (payload && payload.code) rows.push(["结果", payload.code])
  return rows
}

/** 简化详情需要的回复引语（LLM/AGENT/model 的 assistant 回复），原样返回完整文本；
 *  长度折叠由详情面板的 FoldText（limit=500）负责，不在此截断。 */
export function replyQuote(node: TraceTreeNode): string {
  const span = node.span
  const isReply = span.type === "LLM" || span.type === "AGENT" || span.name === "model"
  if (!isReply) return ""
  return plain(usableReply(assistantReply(span)))
}

/** mode / requested_approval_mode：优先 metadata 层字段，其次 command 字符串（原型 modeOf/approvalOf）。 */
function modeOf(node: TraceTreeNode): string {
  const span = node.span
  const md = span.metadata ?? {}
  if (typeof md.mode === "string" && md.mode) return md.mode
  return fieldFromCommand(span, "mode")
}

function approvalOf(node: TraceTreeNode): string {
  const span = node.span
  const md = span.metadata ?? {}
  if (typeof md.requested_approval_mode === "string" && md.requested_approval_mode) return md.requested_approval_mode
  return fieldFromCommand(span, "requested_approval_mode")
}

/** LangGraph 把每次工具执行记成名叫 tools 的 NODE（原型 isLangGraphTools）。
 *  这类节点显示上按 TOOL 处理，badge 用 TOOL 色、名称用实际工具名。 */
export function isLangGraphTools(span: TraceSpanEvent): boolean {
  return (span.name ?? "") === "tools" || ((span.name ?? "") === "graph.node" && span.metadata?.node === "tools")
}

/** 节点应展示的类型：tools 聚合 NODE → TOOL；否则原始 type（原型 displayType）。 */
export function displayType(span: TraceSpanEvent): string {
  if (isLangGraphTools(span)) return "TOOL"
  return span.type ?? "SPAN"
}

/** 节点应展示的条形/徽标颜色：tools 聚合 NODE → TOOL 色；否则按原始 type 取色（原型 displayColor）。 */
export function displayColor(span: TraceSpanEvent): string {
  return typeColor(displayType(span))
}

/** 从 metadata.input / raw.input 的 tool_calls 数组提取工具调用（原型 ownToolCalls）。 */
export function ownToolCalls(span: TraceSpanEvent): Array<{ name: string; argsText: string }> {
  let inp = span.metadata?.input
  if (inp === undefined && span.raw) inp = span.raw.input
  if (typeof inp === "string") {
    const t = inp.trim()
    if (!t.startsWith("[") && !t.startsWith("{")) return []
    try {
      inp = JSON.parse(t)
    } catch {
      return []
    }
  }
  const record = inp as Record<string, unknown> | undefined
  const list = Array.isArray(inp) ? inp : (record && Array.isArray(record.tool_calls) ? record.tool_calls : null)
  if (!list) return []
  const calls: Array<{ name: string; argsText: string }> = []
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const name = rec.name ?? rec.tool_name
    if (!name || name === "tool_call") continue
    let args = rec.args !== null && rec.args !== undefined ? rec.args : (rec.arguments !== null && rec.arguments !== undefined ? rec.arguments : rec.tool_args)
    const argsText = briefArgs(args)
    if (calls.some(c => c.name === name && c.argsText === argsText)) continue
    calls.push({ name: String(name), argsText })
  }
  return calls.slice(0, 4)
}

/** 工具调用提取（增强版，对齐原型 logicalTools）：tools/LLM 节点优先看自身 input 的
 *  tool_calls，其次 output 文本里最近一次 tool_calls；无果再回退子树内首个 LLM 的调用。 */
function logicalTools(node: TraceTreeNode): Array<{ name: string; argsText: string }> {
  const span = node.span
  const own = ownToolCalls(span)
  if (own.length) return own
  const fromText = pickToolCalls(outputText(span))
  if (fromText.length) return fromText
  // 回退子树：tools 聚合节点可能把工具结果挂在下方 LLM/子 span 的 output 里。
  for (const child of node.children) {
    const hit = logicalTools(child)
    if (hit.length) return hit
  }
  return []
}

/** tools 聚合节点去重后的展示名（原型 displayName）：真实工具名列表；取不到退回 "tools"。 */
export function displayName(node: TraceTreeNode): string {
  const span = node.span
  if (!isLangGraphTools(span)) return span.name ?? ""
  const names: string[] = []
  for (const c of logicalTools(node)) {
    if (c && c.name && names.indexOf(c.name) < 0) names.push(c.name)
  }
  return names.length ? names.join("、") : (span.name === "graph.node" ? "tools" : (span.name || "tools"))
}

/** 是否可判定工具失败（tools 聚合节点或 TOOL 类型，原型 isToolish）。 */
function isToolish(span: TraceSpanEvent): boolean {
  return isLangGraphTools(span) || String(span.type ?? "").toUpperCase() === "TOOL"
}

/** 工具节点返回正文列表（原型 toolContents）：messages[].content / content / 纯字符串。 */
function toolContents(span: TraceSpanEvent): unknown[] {
  const out = span.raw.output !== undefined ? span.raw.output : span.metadata?.output
  const msgs: unknown[] = []
  if (out && typeof out === "object" && !Array.isArray(out)) {
    const record = out as Record<string, unknown>
    if (Array.isArray(record.messages)) {
      for (const msg of record.messages) {
        if (msg && typeof msg === "object" && (msg as Record<string, unknown>).content != null) msgs.push((msg as Record<string, unknown>).content)
      }
    } else if (record.content != null) {
      msgs.push(record.content)
    }
  } else if (typeof out === "string") {
    msgs.push(out)
  }
  return msgs
}

/** 单条工具返回正文 → 失败判定（原型 classifyToolContent）：
 *  解析 JSON（ok:false / isError:true → error.code / error.info.code）；
 *  命令结果 `[Command failed with exit code N]` → failed。成功或不可判返回 null。 */
function classifyToolContent(content: unknown): { failed: boolean; code: string } | null {
  if (content === undefined || content === null) return null
  const text = typeof content === "string" ? content : JSON.stringify(content)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非 JSON 输出。
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (record.ok === false || record.isError === true) {
      const err = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : null
      const info = err?.info && typeof err.info === "object" ? (err.info as Record<string, unknown>) : null
      const code = (err && (err.code ?? info?.code)) ?? "error"
      return { failed: true, code: String(code) }
    }
  }
  const exit = text.match(/\[Command (succeeded|failed) with exit code (\d+)\]/)
  if (exit && exit[1] === "failed") return { failed: true, code: `exit ${exit[2]}` }
  return null
}

/** 工具是否失败（看返回正文而非 span status，原型 toolPayloadFailure）：
 *  任一正文判定失败即失败，返回去重的错误码；全部成功或不可判返回 null。 */
export function toolPayloadFailure(span: TraceSpanEvent): { code: string } | null {
  if (!isToolish(span)) return null
  const codes: string[] = []
  let failed = false
  for (const content of toolContents(span)) {
    const one = classifyToolContent(content)
    if (!one || !one.failed) continue
    failed = true
    if (one.code && codes.indexOf(one.code) < 0) codes.push(one.code)
  }
  if (!failed) return null
  return { code: codes.join("、") || "error" }
}

/** 展示状态：payload 失败 → FAILED；否则回退 span.status（原型 shownStatus）。 */
export function shownStatus(span: TraceSpanEvent): string {
  if (toolPayloadFailure(span)) return "FAILED"
  return span.status ?? ""
}

/** 状态小圆点语义类补丁：TRUE 状态的取反值（原类型用 data-status，这里给成分 CSS 提供一致语义）。 */
/** 详情 meta 文案：payload 失败 → 失败 · 错误码；否则状态（原型 shownStatusLabel）。 */
export function shownStatusLabel(span: TraceSpanEvent): string {
  const payload = toolPayloadFailure(span)
  if (payload && payload.code) return `失败 · ${payload.code}`
  return shownStatus(span) || "—"
}

/** 行内错误码徽标文案（原型 outcomeChip 的文本）；无失败返回 null。 */
export function outcomeChipText(span: TraceSpanEvent): string | null {
  const payload = toolPayloadFailure(span)
  if (!payload) return null
  return payload.code
}
