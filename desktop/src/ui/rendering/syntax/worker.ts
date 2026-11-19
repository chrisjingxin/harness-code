/** 离线语法着色：语言/代码 → Shiki 分词 → 原文 UTF-8 字节范围；不输出 HTML。 */
import { resolveLanguage } from "./language-catalog.js"
import { getShikiHighlighter } from "./language-loader.js"
import type { SyntaxScope, SyntaxSpan, SyntaxWorkerRequest, SyntaxWorkerResponse } from "./protocol.js"

function colorToScope(color?: string): SyntaxScope {
  const hex = color?.toLowerCase()
  if (hex === "#6a9955" || hex === "#6e7781" || hex === "#8b949e") return "comment"
  if (hex === "#569cd6" || hex === "#c586c0" || hex === "#cf222e" || hex === "#ff7b72" || hex === "#d73a49") return "keyword"
  if (hex === "#dcdcaa" || hex === "#8250df" || hex === "#d2a8ff" || hex === "#6f42c1") return "function"
  if (hex === "#9cdcfe" || hex === "#4fc1ff" || hex === "#953800" || hex === "#ffa657" || hex === "#0550ae") return "variable"
  if (hex === "#ce9178" || hex === "#d7ba7d" || hex === "#0a3069" || hex === "#a5d6ff" || hex === "#032f62") return "string"
  if (hex === "#b5cea8" || hex === "#79c0ff" || hex === "#005cc5") return "number"
  if (hex === "#4ec9b0") return "type"
  return "plain"
}

async function highlight(request: Extract<SyntaxWorkerRequest, { type: "highlight" }>): Promise<SyntaxWorkerResponse> {
  const { requestId, code } = request
  const language = resolveLanguage(request.language)
  if (language === "plaintext") return { type: "plain", requestId, reason: "unknown-language" }
  const encoder = new TextEncoder()
  if (encoder.encode(code).length > 64 * 1024 || (code ? code.split("\n").length : 0) > 2_000) {
    return { type: "plain", requestId, reason: "too-large" }
  }
  try {
    const highlighter = await getShikiHighlighter()
    const result = highlighter.codeToTokens(code, { lang: language, theme: "dark-plus" })
    const lines = code.split("\n")
    if (result.tokens.length !== lines.length) return { type: "plain", requestId, reason: "parse-failed" }
    const spans: SyntaxSpan[] = []
    let lineStart = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const tokens = result.tokens[i]!
      const rendered = tokens.map(token => token.content).join("")
      // 有些分词结果去掉 CR；字节位置仍以原始 CRLF 为准。
      if (rendered !== line && !(line.endsWith("\r") && rendered === line.slice(0, -1))) {
        return { type: "plain", requestId, reason: "parse-failed" }
      }
      const offsets = new Map<number, number>([[0, 0]])
      let chars = 0, bytes = 0
      for (const char of line) { chars += char.length; bytes += encoder.encode(char).length; offsets.set(chars, bytes) }
      let index = 0
      for (const token of tokens) {
        const start = offsets.get(index)
        index += token.content.length
        const end = offsets.get(index)
        if (start === undefined || end === undefined) return { type: "plain", requestId, reason: "parse-failed" }
        const scope = colorToScope(token.color)
        if (scope !== "plain" && start < end) spans.push({ startByte: lineStart + start, endByte: lineStart + end, scope })
      }
      lineStart += bytes + (i < lines.length - 1 ? 1 : 0)
    }
    return { type: "highlighted", requestId, language, spans }
  } catch {
    return { type: "plain", requestId, reason: "parse-failed" }
  }
}

// 此模块只由 Worker 入口加载，响应按 requestId 与请求对应。
self.onmessage = (event: MessageEvent<SyntaxWorkerRequest>) => {
  if (event.data.type === "highlight") void highlight(event.data).then(response => self.postMessage(response))
}
