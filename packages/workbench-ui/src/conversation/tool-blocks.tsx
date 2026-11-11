/**
 * 结构化工具显示块：只渲染调用方已经投影的文本、路径和差异行。
 * 路径图标共用 HC-207 实现；本模块不读取文件、解析私有载荷或解释审批。
 */
import type { ReactElement } from "react"
import { FileTypeIcon } from "../common/file-type-icon.js"
import type { ConversationToolBlock } from "./types.js"

type DisplayLine = { readonly number?: number; readonly text: string }

/** 结构化内容不完整时整体退回原文，避免显示一半结果误以为完整。 */
export function usableToolBlocks(blocks: readonly ConversationToolBlock[] | undefined): readonly ConversationToolBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0 || !blocks.every(isUsableBlock)) return []
  return blocks
}

function isLine(value: unknown): value is DisplayLine {
  if (!value || typeof value !== "object") return false
  const line = value as { number?: unknown; text?: unknown }
  return typeof line.text === "string" && (line.number === undefined || typeof line.number === "number")
}

function isUsableBlock(value: unknown): value is ConversationToolBlock {
  if (!value || typeof value !== "object") return false
  const block = value as Record<string, unknown>
  if (block.kind === "text" || block.kind === "json") return typeof block.text === "string"
  if (block.kind === "file") return typeof block.path === "string" && typeof block.rangeLabel === "string" && typeof block.truncated === "boolean" && Array.isArray(block.lines) && block.lines.every(isLine)
  if (block.kind === "paths") return Array.isArray(block.paths) && block.paths.every(path => typeof path === "string")
  if (block.kind === "matches") return Array.isArray(block.groups) && block.groups.every(group => group && typeof group === "object" && typeof group.path === "string" && Array.isArray(group.lines) && group.lines.every(isLine))
  if (block.kind === "diff") return (block.path === undefined || typeof block.path === "string") && Array.isArray(block.rows) && block.rows.every(row => row && typeof row === "object" && ["add", "remove", "context"].includes(row.kind) && typeof row.text === "string")
  if (block.kind === "terminal") return (block.command === undefined || typeof block.command === "string") && typeof block.truncated === "boolean" && Array.isArray(block.lines) && block.lines.every(line => typeof line === "string")
  return false
}

export function countToolBlockLines(blocks: readonly ConversationToolBlock[]): number {
  return blocks.reduce((total, block) => {
    switch (block.kind) {
      case "text": case "json": return total + block.text.split("\n").length
      case "file": return total + block.lines.length + 1 + Number(block.truncated)
      case "paths": return total + block.paths.length
      case "matches": return total + block.groups.reduce((sum, group) => sum + group.lines.length + 1, 0)
      case "diff": return total + block.rows.length + Number(Boolean(block.path))
      case "terminal": return total + block.lines.length + Number(Boolean(block.command)) + Number(block.truncated)
    }
    return total
  }, 0)
}

function PathLabel({ path }: { path: string }): ReactElement {
  const name = path.split(/[\\/]/).pop() || path
  return <div className="wb-conversation-block-path"><FileTypeIcon name={name} size={14} /><span>{path}</span></div>
}

function NumberedLines({ lines }: { lines: readonly DisplayLine[] }): ReactElement {
  return <div className="wb-conversation-block-lines">{lines.map((line, index) => <div className="wb-conversation-block-line" key={index}><span className="wb-conversation-block-number" aria-hidden="true">{line.number ?? ""}</span><span>{line.text || "\u00a0"}</span></div>)}</div>
}

export function ConversationToolBlocks({ blocks }: { blocks: readonly ConversationToolBlock[] }): ReactElement {
  return <div className="wb-conversation-blocks">{blocks.map((block, index) => {
    if (block.kind === "text" || block.kind === "json") return <pre className="wb-conversation-detail-pre" key={index}>{block.text}</pre>
    if (block.kind === "file") return <section className="wb-conversation-block" key={index}><div className="wb-conversation-block-heading"><PathLabel path={block.path} /><span>{block.rangeLabel}</span></div><NumberedLines lines={block.lines} />{block.truncated ? <p className="wb-conversation-block-notice">内容已截断</p> : null}</section>
    if (block.kind === "paths") return <div className="wb-conversation-block" key={index}>{block.paths.map((path, pathIndex) => <PathLabel key={pathIndex} path={path} />)}</div>
    if (block.kind === "matches") return <div className="wb-conversation-block" key={index}>{block.groups.map((group, groupIndex) => <section key={groupIndex}><PathLabel path={group.path} /><NumberedLines lines={group.lines} /></section>)}</div>
    if (block.kind === "diff") return <div className="wb-conversation-block" key={index}>{block.path ? <PathLabel path={block.path} /> : null}<div className="wb-conversation-diff">{block.rows.map((row, rowIndex) => <div key={rowIndex} className={`wb-conversation-diff-${row.kind}`}><span aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span><span>{row.text || "\u00a0"}</span></div>)}</div></div>
    if (block.kind === "terminal") return <div className="wb-conversation-block wb-conversation-terminal" key={index}>{block.command ? <div className="wb-conversation-terminal-command">$ {block.command}</div> : null}<pre className="wb-conversation-detail-pre">{block.lines.join("\n")}</pre>{block.truncated ? <p className="wb-conversation-block-notice">输出已截断</p> : null}</div>
    return null
  })}</div>
}
