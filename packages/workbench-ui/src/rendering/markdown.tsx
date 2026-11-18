/** Web 安全 Markdown：只把 marked token 转成 React 节点，绝不把 HTML 字符串交给 DOM。 */
/** @jsxImportSource react */

import { lexer, type Token, type Tokens } from "marked"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import type { ReactElement, ReactNode } from "react"

import { FileTypeIcon, fileIconFor } from "../common/file-type-icon.js"
import { CodeBlock } from "./code-block.js"
import type { MarkdownProps, RenderingActions } from "./types.js"

const ActionsContext = createContext<RenderingActions | undefined>(undefined)

/**
 * 渲染支持 GFM 的安全 Markdown。
 *
 * marked 只用于把字符串切分为 token 树；不允许的 token（raw HTML、image、非法 scheme）
 * 全部降级为纯文本或 alt 文本。模型输出不会因为 Markdown 解析而触发脚本、事件属性、
 * SVG 或远端图片请求，也不会把字符串直接交给 DOM 渲染为 HTML。
 */
export function Markdown({ text, actions }: MarkdownProps): ReactElement {
  let tokens: Token[]
  try {
    tokens = lexer(text, { gfm: true })
  } catch {
    // 解析失败时仍要保留原文，避免 Agent 输出因渲染失败而丢失。
    return <div className="markdown markdown-content">{text}</div>
  }
  return <ActionsContext.Provider value={actions}><div className="markdown markdown-content">{renderBlocks(tokens, "md")}</div></ActionsContext.Provider>
}

/** 把 block 级 token 列表逐项转换为 React 节点；空 space token 跳过以收紧 DOM。 */
function renderBlocks(tokens: readonly Token[] | undefined, prefix: string): ReactNode[] {
  if (!tokens || tokens.length === 0) return []
  const nodes: ReactNode[] = []
  tokens.forEach((token, index) => {
    const node = renderBlock(token, `${prefix}-${index}`)
    if (node !== null) nodes.push(node)
  })
  return nodes
}

function renderBlock(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "space":
      return null
    case "heading": {
      const heading = token as Tokens.Heading
      const Tag = headingTag(heading.depth)
      return <Tag key={key}>{renderInline(heading.tokens, key, heading.text)}</Tag>
    }
    case "paragraph": {
      const para = token as Tokens.Paragraph
      return <p key={key}>{renderInline(para.tokens, key, para.text)}</p>
    }
    case "text": {
      const textToken = token as Tokens.Text
      return <p key={key}>{renderInline(textToken.tokens, key, textToken.text)}</p>
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote
      return <blockquote key={key}>{renderBlocks(quote.tokens, key)}</blockquote>
    }
    case "code": {
      const code = token as Tokens.Code
      return <MarkdownCode key={key} code={code.text} language={code.lang} />
    }
    case "hr":
      return <hr key={key} />
    case "list": {
      const list = token as Tokens.List
      const ListTag = list.ordered ? "ol" : "ul"
      const startAttr = list.ordered && typeof list.start === "number" ? list.start : undefined
      return (
        <ListTag key={key} start={startAttr}>
          {list.items.map((item, index) => renderListItem(item, `${key}-${index}`))}
        </ListTag>
      )
    }
    case "table": {
      const table = token as Tokens.Table
      return (
        <div key={key} className="markdown-table-wrap">
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => renderTableCell(cell, `${key}-head-${index}`, true))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => renderTableCell(cell, `${key}-${rowIndex}-${cellIndex}`, false))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case "html": {
      const html = token as Tokens.HTML
      // raw HTML 永远按纯文本渲染，绝不会成为 DOM 节点。
      return <span key={key} className="markdown-raw">{html.text}</span>
    }
    case "def":
      return null
    default:
      return <span key={key}>{safeTokenText(token)}</span>
  }
}

/** 任务列表已由外层 <li> 渲染复选框，需剥离 marked 留在块首或首段内的重复 checkbox token。 */
function stripLeadingTaskCheckbox(tokens: readonly Token[]): readonly Token[] {
  const trimmed = tokens[0]?.type === "checkbox" ? tokens.slice(1) : tokens
  const first = trimmed[0]
  if (
    first
    && (first.type === "paragraph" || first.type === "text")
    && "tokens" in first
    && Array.isArray(first.tokens)
    && first.tokens[0]?.type === "checkbox"
  ) {
    return [{ ...first, tokens: first.tokens.slice(1) } as Token, ...trimmed.slice(1)]
  }
  return trimmed
}

/** list_item 单独抽出来以便把任务复选框 token 提升为可读控件。 */
function renderListItem(item: Tokens.ListItem, key: string): ReactNode {
  // 松散列表的 item.tokens 是 paragraph 等 block；紧凑列表则是带 nested tokens 的 text。
  // 一律按 block 渲染，否则 paragraph 会落到 inline 的 default 分支，把 ** 与反引号当纯文本。
  const effectiveTokens = item.task && item.tokens
    ? stripLeadingTaskCheckbox(item.tokens)
    : item.tokens
  const body = effectiveTokens && effectiveTokens.length > 0
    ? renderBlocks(effectiveTokens, key)
    : item.task
      ? item.text.replace(/^\s*\[[ xX]\]\s+/, "")
      : item.text
  if (item.task) {
    const checked = item.checked === true
    return (
      <li key={key} className="markdown-task">
        <input type="checkbox" checked={checked} disabled readOnly aria-label={checked ? "已完成" : "未完成"} />
        <span>{body}</span>
      </li>
    )
  }
  return <li key={key}>{body}</li>
}

function renderTableCell(cell: Tokens.TableCell, key: string, header: boolean): ReactNode {
  const Tag = header ? "th" : "td"
  return (
    <Tag key={key} data-align={cell.align ?? undefined}>
      {renderInline(cell.tokens, key, cell.text)}
    </Tag>
  )
}

function renderInline(tokens: readonly Token[] | undefined, prefix: string, fallback = "", fileReferences = true): ReactNode[] {
  if (!tokens || tokens.length === 0) return fallback ? [fallback] : []
  return tokens.map((token, index) => renderInlineToken(token, `${prefix}-inline-${index}`, fileReferences))
}

function renderInlineToken(token: Token, key: string, fileReferences: boolean): ReactNode {
  switch (token.type) {
    case "strong": {
      const strong = token as Tokens.Strong
      return <strong key={key}>{renderInline(strong.tokens, key, strong.text, fileReferences)}</strong>
    }
    case "em": {
      const em = token as Tokens.Em
      return <em key={key}>{renderInline(em.tokens, key, em.text, fileReferences)}</em>
    }
    case "del": {
      const del = token as Tokens.Del
      return <del key={key}>{renderInline(del.tokens, key, del.text, fileReferences)}</del>
    }
    case "codespan": {
      const code = token as Tokens.Codespan
      // ponytail: 无空白的代码片段才推测为文件；带空格的路径可通过 Markdown 链接明确指定。
      const file = fileReferences && /^[^\s<>"'`=(){}]+$/u.test(code.text) && isLocalFileReference(code.text, true)
      return file ? <FileReference key={key} path={code.text} code>{code.text}</FileReference> : <code key={key}>{code.text}</code>
    }
    case "br":
      return <br key={key} />
    case "checkbox": {
      const checkbox = token as Tokens.Checkbox
      return (
        <input
          key={key}
          type="checkbox"
          checked={checkbox.checked === true}
          disabled
          readOnly
          aria-label={checkbox.checked ? "已完成" : "未完成"}
        />
      )
    }
    case "link": {
      const link = token as Tokens.Link
      const children = renderInline(link.tokens, key, link.text, false)
      const href = safeLink(link.href)
      if (href) return <SafeLink key={key} href={href}>{children}</SafeLink>
      if (fileReferences && isLocalFileReference(link.href, false)) return <FileReference key={key} path={link.href}>{children}</FileReference>
      return <span key={key} className="markdown-unsafe-link">{children}</span>
    }
    case "image": {
      // 图片只显示 alt 文本；不渲染 <img>，不发起任何网络请求。
      const image = token as Tokens.Image
      return <span key={key} className="markdown-image-alt">{image.text}</span>
    }
    case "html": {
      const html = token as Tokens.HTML
      return <span key={key} className="markdown-raw">{html.text}</span>
    }
    case "escape": {
      const escape = token as Tokens.Escape
      return <span key={key}>{escape.text}</span>
    }
    case "text": {
      const textToken = token as Tokens.Text
      return textToken.tokens && textToken.tokens.length > 0
        ? <span key={key}>{renderInline(textToken.tokens, key, textToken.text, fileReferences)}</span>
        : <span key={key}>{textToken.text}</span>
    }
    default:
      return <span key={key}>{safeTokenText(token)}</span>
  }
}

/** 只识别看起来像文件的本地引用；具体路径和授权由装配方及宿主再次校验。 */
function isLocalFileReference(value: string, knownOnly: boolean): boolean {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("//")) return false
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^file:\/\//i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return false
  const path = value.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/i, "")
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? ""
  return fileIconFor(name).type !== "default" || (!knownOnly && /\.[\p{L}\p{N}_-]{1,24}$/u.test(name))
}

/** 消息中的文件只在宿主提供本机打开能力时可点；同名文件需要用户明确选择。 */
export function FileReference({ path, children, code = false, openFile: suppliedOpenFile }: { path: string; children: ReactNode; code?: boolean; openFile?: RenderingActions["openFile"] }): ReactElement {
  const contextOpenFile = useContext(ActionsContext)?.openFile
  const openFile = suppliedOpenFile ?? contextOpenFile
  const [choices, setChoices] = useState<readonly string[]>([])
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const active = useRef(true)
  const sequence = useRef(0)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; sequence.current += 1 }
  }, [])
  useEffect(() => { sequence.current += 1; setChoices([]); setError(""); setPending(false) }, [path])
  const icon = <FileTypeIcon name={path.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/i, "")} />
  if (!openFile) return code
    ? <code className="markdown-file-reference">{icon}{children}</code>
    : <span className="markdown-file-reference">{icon}{children}</span>
  const open = async (candidate: string, resolved = false): Promise<void> => {
    const current = ++sequence.current
    setPending(true); setError("")
    try {
      const matches = await openFile(candidate, resolved)
      if (active.current && sequence.current === current) setChoices(matches ?? [])
    } catch (failure) {
      if (active.current && sequence.current === current) setError(failure instanceof Error ? failure.message : "文件打开失败。")
    } finally {
      if (active.current && sequence.current === current) setPending(false)
    }
  }
  return <span className="markdown-file-control">
    <button type="button" className="markdown-file-reference" title={path} aria-label={`打开文件 ${path}`} disabled={pending}
      onClick={() => { void open(path) }}>{icon}{children}</button>
    {choices.length ? <span className="markdown-file-options" role="group" aria-label="选择同名文件">
      <span>请选择文件：</span>{choices.map(choice => <button type="button" key={choice} disabled={pending}
        onClick={() => { void open(choice, true) }}>{choice}</button>)}
    </span> : null}
    {error ? <span className="markdown-file-error" role="status">{error}</span> : null}
  </span>
}

/** heading depth 固定到 h2~h6；h1 升级为 h2 避免和页面主标题重复。 */
function headingTag(depth: number): "h2" | "h3" | "h4" | "h5" | "h6" {
  if (depth <= 2) return "h2"
  if (depth === 3) return "h3"
  if (depth === 4) return "h4"
  if (depth === 5) return "h5"
  return "h6"
}

/**
 * 校验链接 scheme：只允许 http(s) 与 mailto；其它协议（如 javascript:、data:、file:）
 * 一律降级为普通文本，避免模型输出触发脚本或本地文件读取。
 */
function safeLink(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined
    return url.href
  } catch {
    // 相对路径或无法解析的 URL 视作不安全；只渲染文本，不生成 <a>。
    return undefined
  }
}

function safeTokenText(token: Token): string {
  const value = token as { text?: unknown; raw?: unknown }
  return typeof value.text === "string" ? value.text : typeof value.raw === "string" ? value.raw : ""
}

function MarkdownCode({ code, language }: { code: string; language?: string }): ReactElement {
  const actions = useContext(ActionsContext)
  return <CodeBlock code={code} language={language} actions={actions} />
}

function SafeLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  const action = useContext(ActionsContext)?.openExternal
  const [failed, setFailed] = useState(false)
  if (!action) return <span className="markdown-unsafe-link" title="当前无法打开链接">{children}</span>
  return <>
    <a href={href} onClick={event => {
      event.preventDefault()
      setFailed(false)
      void Promise.resolve().then(() => action(href)).catch(() => setFailed(true))
    }}>{children}</a>
    {failed && <span className="markdown-link-error" role="status">（链接打开失败）</span>}
  </>
}
