/** 将 Worker 的 UTF-8 字节范围映射回 React 文本；任何非法范围都保留原文。 */
import type { ReactNode } from "react"
import type { SyntaxSpan } from "./syntax/protocol.js"

const scopes = new Set(["comment", "keyword", "function", "variable", "string", "number", "type", "operator", "punctuation", "tag", "attribute", "constant", "plain"])

/** 范围为 UTF-8 字节半开区间；不接受越界、重叠或落在多字节字符中间的结果。 */
export function renderSpans(code: string, spans: readonly SyntaxSpan[]): ReactNode {
  if (spans.length === 0) return code
  const encoder = new TextEncoder()
  const byteLength = encoder.encode(code).length
  const byteToChar = new Int32Array(byteLength + 1).fill(-1)
  let byte = 0, charIndex = 0
  for (const char of code) {
    byteToChar[byte] = charIndex
    byte += encoder.encode(char).length
    charIndex += char.length
  }
  byteToChar[byteLength] = code.length
  const ordered = [...spans].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte)
  let previousEnd = 0
  for (const span of ordered) {
    if (!Number.isInteger(span.startByte) || !Number.isInteger(span.endByte) || span.startByte < previousEnd ||
      span.startByte < 0 || span.endByte > byteLength || span.startByte >= span.endByte ||
      byteToChar[span.startByte]! < 0 || byteToChar[span.endByte]! < 0 || !scopes.has(span.scope)) return code
    previousEnd = span.endByte
  }
  const parts: ReactNode[] = []
  let lastChar = 0
  for (const [index, span] of ordered.entries()) {
    const start = byteToChar[span.startByte]!, end = byteToChar[span.endByte]!
    if (start > lastChar) parts.push(code.slice(lastChar, start))
    parts.push(<span key={`${index}-${start}`} className={`syntax-${span.scope}`}>{code.slice(start, end)}</span>)
    lastChar = end
  }
  if (lastChar < code.length) parts.push(code.slice(lastChar))
  return parts
}
