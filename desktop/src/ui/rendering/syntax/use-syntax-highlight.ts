/** 只延迟高亮计算，不延迟原文；输入变化后绝不把旧范围贴到新代码。 */
import { useEffect, useState } from "react"
import { resolveLanguage } from "./language-catalog.js"
import { acquireHighlightService, releaseHighlightService } from "./highlight-service.js"
import type { SyntaxSpan } from "./protocol.js"

export type HighlightResult =
  | { status: "plain" | "loading"; spans: null }
  | { status: "highlighted"; spans: readonly SyntaxSpan[] }

const cache = new Map<string, readonly SyntaxSpan[]>()
const CACHE_LIMIT = 8
const PLAIN: HighlightResult = { status: "plain", spans: null }
const LOADING: HighlightResult = { status: "loading", spans: null }

/** 返回与当前完整文本及规范语言对应的结果；卸载时停止接收旧请求。 */
export function useSyntaxHighlight(input: { code: string; language: string | null }): HighlightResult {
  const { code } = input
  const language = input.language === null ? "plaintext" : resolveLanguage(input.language)
  const key = JSON.stringify([language, "dark-plus", code])
  const [snapshot, setSnapshot] = useState<{ key: string; result: HighlightResult } | null>(null)
  useEffect(() => {
    if (language === "plaintext" || !code.trim()) return
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key); cache.set(key, cached)
      setSnapshot({ key, result: { status: "highlighted", spans: cached } })
      return
    }
    let active = true
    let instance: ReturnType<typeof acquireHighlightService> | null = null
    const timer = setTimeout(() => {
      instance = acquireHighlightService()
      void instance.highlight(language, code).then(response => {
        if (!active) return
        if (response.type === "highlighted") {
          cache.set(key, response.spans)
          while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
          setSnapshot({ key, result: { status: "highlighted", spans: response.spans } })
        } else setSnapshot({ key, result: PLAIN })
      }).catch(() => { if (active) setSnapshot({ key, result: PLAIN }) })
    }, 100)
    return () => {
      active = false
      clearTimeout(timer)
      if (instance) releaseHighlightService(instance)
    }
  }, [code, key, language])
  if (language === "plaintext" || !code.trim()) return PLAIN
  // Effect 尚未执行时也必须立即丢弃前一次文本的结果。
  return snapshot?.key === key ? snapshot.result : LOADING
}
