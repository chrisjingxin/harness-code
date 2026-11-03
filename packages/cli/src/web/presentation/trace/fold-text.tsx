/** 长文本折叠组件：超过 limit 字符（按 Unicode code point）时默认折叠为前 limit 字 +
 *  「展开 N 字」按钮，点击切换展开/收起。对齐 3.html 的 applyFolds 折叠交互（trace_viewer.py:1120-1184）。 */
/** @jsxImportSource react */

import { useState } from "react"

/** 按 Unicode code point 统计字符数（代理对按 1 个字符计）。 */
export function countChars(value: string): number {
  return Array.from(value).length
}

/** 折叠文本：text 超长时折叠展示；limit 为折叠阈值字符数。
 *  preview 可选：折叠态的预览文本（默认取前 limit 字符 + …）；
 *  count 可选：按钮「展开 N 字」的字符数（JSON 字符串值传解码后字符数，text 本身可能是
 *  带引号/转义的字面量，直接数会偏大）。 */
export function FoldText({ text, limit, preview, count }: { text: string; limit: number; preview?: string; count?: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const chars = Array.from(text)
  const total = count ?? chars.length
  if (total <= limit) {
    return <>{text}</>
  }
  const collapsedText = preview ?? chars.slice(0, limit).join("") + "…"
  return (
    <span className="trace-fold">
      {expanded ? text : collapsedText}
      {expanded ? (
        <button type="button" className="trace-fold-btn" aria-expanded="true" onClick={() => setExpanded(false)}>
          收起
        </button>
      ) : (
        <button type="button" className="trace-fold-btn" aria-expanded="false" onClick={() => setExpanded(true)}>
          展开 {total} 字
        </button>
      )}
    </span>
  )
}
