/** 公共渲染使用的最小宿主动作；缺失代表对应能力不可用。 */
export interface RenderingActions {
  copyText?: (text: string) => Promise<void>
  openExternal?: (href: string) => Promise<void>
}

export interface MarkdownProps { text: string; actions?: RenderingActions }
export interface CodeBlockProps { code: string; language?: string; actions?: RenderingActions }
