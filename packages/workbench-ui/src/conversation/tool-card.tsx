/**
 * 普通工具文本卡：紧凑工作日志行，参数、输出与差异折叠进详情区。
 *
 * 上游先给出显示文案和原文；这里不按工具名解析 Harness 载荷，也不执行工具。
 * 没有任何可展开内容的调用渲染为不可点的静态行，不再出现空详情。
 */
import { Check, ChevronRight, Copy, FilePenLine, FileText, Loader2, Wrench } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"

import type { RenderingActions } from "../rendering/types.js"
import { Disclosure } from "./disclosure.js"
import { ConversationToolBlocks, countToolBlockLines, usableToolBlocks } from "./tool-blocks.js"
import type { ConversationTimelineEntry } from "./types.js"

type ConversationTextTool = Extract<ConversationTimelineEntry, { kind: "tool" }>
type CopyStatus = "idle" | "copying" | "copied" | "error"

/** 原 Web 以 24 行作为展示“展开全部”的边界。 */
const COLLAPSE_LINES = 24

/** 摘要像路径时（含 /、无空白）拆成可省略的目录与完整显示的文件名。 */
function PathSummary({ text }: { text: string }): ReactNode {
  if (!text.includes("/") || /\s/.test(text)) return <span className="wb-conversation-tool-summary">{text}</span>
  const cut = text.lastIndexOf("/")
  return (
    <span className="wb-conversation-tool-summary">
      <span className="wb-conversation-tool-summary-dir">{text.slice(0, cut + 1)}</span>
      <span className="wb-conversation-tool-summary-name">{text.slice(cut + 1)}</span>
    </span>
  )
}

/** 单个工具的展开选择由对话视图持有者按会话保存。 */
export function ConversationToolCard({
  tool,
  expanded,
  outputExpanded,
  onToggle,
  onToggleOutput,
  rendering,
}: {
  tool: ConversationTextTool
  expanded: boolean
  outputExpanded: boolean
  onToggle?: () => void
  onToggleOutput?: () => void
  rendering?: RenderingActions
}): ReactElement {
  const detailsId = useId()
  const detail = tool.detail
  const output = detail?.outputText
  const blocks = useMemo(() => usableToolBlocks(detail?.blocks), [detail?.blocks])
  const argumentsText = detail?.argumentsText
  const hasOutput = blocks.length > 0 || (output !== undefined && output.length > 0)
  const hasArguments = argumentsText !== undefined && argumentsText.length > 0
  const hasExtension = detail?.extension != null
  const expandable = hasOutput || hasArguments || hasExtension
  const statusLabel = tool.status === "running" ? "运行中" : tool.status === "failed" ? "失败" : "已完成"
  const Icon = tool.tone === "read" ? FileText : tool.tone === "write" ? FilePenLine : Wrench
  const failed = tool.status === "failed"

  const head = (
    <>
      <Icon aria-hidden="true" focusable="false" className="wb-conversation-tool-icon" data-failed={failed || undefined} />
      <span className="wb-conversation-tool-label" title={tool.originalName ?? tool.label}>{tool.label}</span>
      {tool.summary ? <PathSummary text={tool.summary} /> : null}
      <span className="wb-conversation-tool-status" role="img" aria-label={statusLabel} title={statusLabel}>
        {tool.status === "running" ? <Loader2 aria-hidden="true" className="wb-conversation-spin" />
          : failed ? <span className="wb-conversation-tool-failed-badge">失败</span>
            : null}
      </span>
      {expandable && onToggle ? <ChevronRight aria-hidden="true" focusable="false" className={expanded ? "wb-conversation-chevron is-expanded" : "wb-conversation-chevron"} /> : null}
    </>
  )

  return (
    <div className={`wb-conversation-tool-row wb-conversation-tool-${tool.status}`} data-tone={tool.tone}>
      {expandable && onToggle ? (
        <button
          type="button"
          className="wb-conversation-tool-header"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          onClick={onToggle}
        >
          {head}
        </button>
      ) : (
        <div className="wb-conversation-tool-header" aria-label={`${tool.label} · ${statusLabel}`}>{head}</div>
      )}
      {expandable ? (
        <Disclosure open={expanded} className="wb-conversation-tool-details-disclosure">
          <div id={detailsId} className="wb-conversation-tool-details">
            {hasOutput ? (
              <ConversationToolOutput
                text={output ?? ""}
                blocks={blocks}
                copyText={detail?.copyText}
                expanded={outputExpanded}
                onToggle={onToggleOutput}
                rendering={rendering}
              />
            ) : null}
            {hasExtension ? <div className="wb-conversation-tool-extension">{detail?.extension}</div> : null}
            {hasArguments ? (
              <details className="wb-conversation-detail-card wb-conversation-arguments">
                <summary className="wb-conversation-detail-header wb-conversation-arguments-summary">
                  <span className="wb-conversation-detail-title">参数</span>
                  <ChevronRight aria-hidden="true" className="wb-conversation-detail-chevron" />
                </summary>
                <div className="wb-conversation-detail-body" data-clamped="false">
                  <pre className="wb-conversation-detail-pre">{prettifyObject(argumentsText) ?? argumentsText}</pre>
                </div>
              </details>
            ) : null}
          </div>
        </Disclosure>
      ) : null}
    </div>
  )
}

/** 输出显示可以美化 JSON；复制始终使用单独提供的文本。 */
function ConversationToolOutput({
  text,
  blocks,
  copyText,
  expanded,
  onToggle,
  rendering,
}: {
  text: string
  blocks: ReturnType<typeof usableToolBlocks>
  copyText?: string
  expanded: boolean
  onToggle?: () => void
  rendering?: RenderingActions
}): ReactElement {
  const displayed = prettifyObject(text) ?? text
  const lines = blocks.length ? countToolBlockLines(blocks) : displayed.split("\n").length
  const collapsible = lines > COLLAPSE_LINES
  const [status, setStatus] = useState<CopyStatus>("idle")
  const mounted = useRef(false)
  const request = useRef(0)
  const clearTimer = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current += 1
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    }
  }, [])

  useLayoutEffect(() => {
    // 内容改变后，旧复制回调不能给新的输出显示成功。
    request.current += 1
    setStatus("idle")
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    clearTimer.current = null
  }, [copyText, text])

  const canCopy = copyText !== undefined && Boolean(rendering?.copyText)
  const copy = async (): Promise<void> => {
    if (copyText === undefined || !rendering?.copyText) return
    const current = ++request.current
    setStatus("copying")
    try {
      await rendering.copyText(copyText)
      if (!mounted.current || request.current !== current) return
      setStatus("copied")
      clearTimer.current = window.setTimeout(() => {
        if (mounted.current && request.current === current) setStatus("idle")
      }, 1200)
    } catch {
      if (mounted.current && request.current === current) setStatus("error")
    }
  }

  return (
    <section className="wb-conversation-detail-card">
      <header className="wb-conversation-detail-header">
        <span className="wb-conversation-detail-title">输出</span>
        <span className="wb-conversation-detail-meta">{lines} 行</span>
        <button
          type="button"
          className={status === "copied" ? "wb-conversation-detail-copy is-copied" : "wb-conversation-detail-copy"}
          aria-label="复制输出"
          title={canCopy ? "复制输出" : "当前无法复制，请手动选择文本"}
          disabled={!canCopy || status === "copying"}
          onClick={() => { void copy() }}
        >
          {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </header>
      <div className="wb-conversation-detail-body" data-clamped={collapsible && !expanded}>
        {blocks.length ? <ConversationToolBlocks blocks={blocks} /> : <pre className="wb-conversation-detail-pre">{displayed}</pre>}
      </div>
      {collapsible ? (
        <button type="button" className="wb-conversation-detail-expand" disabled={!onToggle} onClick={onToggle}>
          {expanded ? "收起" : "展开全部"}
        </button>
      ) : null}
      <span className="wb-conversation-copy-feedback" data-status={status} role="status" aria-live="polite">
        {status === "copied" ? "已复制" : status === "error" ? "复制失败，请手动选择文本。" : ""}
      </span>
    </section>
  )
}

/** 只美化 JSON 对象和数组；其他内容原样显示。 */
function prettifyObject(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : null
  } catch {
    return null
  }
}
