/** 公共渲染使用的最小宿主动作；缺失代表对应能力不可用。 */
export interface RenderingActions {
  copyText?: (text: string) => Promise<void>
  openExternal?: (href: string) => Promise<void>
  /** 打开会话工作目录中的文件；返回多个路径时由用户选择，resolved 表示选择了明确路径。 */
  openFile?: (path: string, resolved?: boolean) => Promise<readonly string[] | void>
}

export interface MarkdownProps { text: string; actions?: RenderingActions }
export interface CodeBlockProps { code: string; language?: string; actions?: RenderingActions }
