/** 文件等只读容器可组合的代码内容；默认立即显示原文。 */
import type { ReactElement } from "react"
import { renderSpans } from "./render-spans.js"
import { useSyntaxHighlight } from "./syntax/use-syntax-highlight.js"

export function HighlightedCode({ code, language }: { code: string; language: string | null }): ReactElement {
  const result = useSyntaxHighlight({ code, language })
  return <span className="wb-syntax">{result.status === "highlighted" ? renderSpans(code, result.spans) : code}</span>
}
