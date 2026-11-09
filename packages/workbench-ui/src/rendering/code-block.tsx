/** 代码块：当前原文 → 可选高亮或 Diff → 用户主动复制；不直接访问宿主。 */
import { useEffect, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { renderSpans } from "./render-spans.js"
import { resolveLanguage } from "./syntax/language-catalog.js"
import { useSyntaxHighlight } from "./syntax/use-syntax-highlight.js"
import type { CodeBlockProps } from "./types.js"

/** 显示原文并通过显式动作复制；缺少能力或复制失败时仍可手动选择。 */
export function CodeBlock({ code, language = "", actions }: CodeBlockProps): ReactElement {
  const canonical = resolveLanguage(language)
  const diff = isDiff(language, code)
  const highlight = useSyntaxHighlight({ code, language: diff || canonical === "plaintext" ? null : canonical })
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentCode = useRef(code)
  const currentRequest = useRef(0)
  const mounted = useRef(false)
  currentCode.current = code
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current) }
  }, [])
  useEffect(() => {
    currentRequest.current += 1
    if (timer.current) clearTimeout(timer.current)
    setCopyStatus("idle")
  }, [code])

  async function copy() {
    if (!actions?.copyText) return
    const request = ++currentRequest.current
    const text = code
    if (timer.current) clearTimeout(timer.current)
    try {
      await actions.copyText(text)
      if (!mounted.current || currentCode.current !== text || currentRequest.current !== request) return
      setCopyStatus("copied")
    } catch {
      if (!mounted.current || currentCode.current !== text || currentRequest.current !== request) return
      setCopyStatus("failed")
    }
    timer.current = setTimeout(() => setCopyStatus("idle"), 1500)
  }

  const label = canonical !== "plaintext" ? canonical : (language || "文本")
  return <div className="code-block">
    <div className="code-block-header">
      <span className="code-block-lang">{label}{highlight.status === "loading" ? <span className="code-block-loading-hint"> (高亮中)</span> : null}</span>
      <div className="code-block-actions">
        {!actions?.copyText && <span className="code-block-unavailable">复制不可用，可手动选择</span>}
        <button type="button" className="code-block-copy" aria-label={actions?.copyText ? "复制代码" : "复制不可用"} title={actions?.copyText ? "复制代码" : "复制不可用，请手动选择代码"} disabled={!actions?.copyText} onClick={() => { void copy() }}>
          {copyStatus === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
    </div>
    <div className="code-block-body"><pre className="code-block-pre"><code data-language={language || undefined} className="wb-syntax">
      {diff ? renderDiff(code) : highlight.status === "highlighted" ? renderSpans(code, highlight.spans) : code}
    </code></pre></div>
    <span className="wb-sr-only" role="status" aria-live="polite">{copyStatus === "copied" ? "代码已复制" : copyStatus === "failed" ? "复制失败，请手动选择代码" : ""}</span>
    {copyStatus === "failed" && <span className="code-block-error">复制失败，请手动选择代码</span>}
  </div>
}

function isDiff(language: string, code: string): boolean {
  return ["diff", "patch", "udiff", "unified-diff"].includes(language.trim().toLowerCase()) || /^(?:diff --git |@@ .* @@|\+\+\+ |--- )/m.test(code)
}

function renderDiff(code: string): ReactNode {
  const lines = code.split("\n")
  return lines.map((line, index) => {
    const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "hunk" : "context"
    return <span key={index} className={`diff-code-line diff-code-${kind}`}>{line}{index < lines.length - 1 ? "\n" : null}</span>
  })
}
