/** HC-183 WP8：Ink 只负责承载终端 Markdown 的纯文本投影。 */
/** @jsxImportSource react */
import { Text } from "ink"
import React from "react"

import { formatTerminalMarkdown } from "./terminal-markdown"

/** 渲染与纯终端投影完全一致的 Markdown 文本，不访问网络或注入 HTML。 */
export function MarkdownText(props: { source: string; width?: number }) {
  return <Text>{formatTerminalMarkdown(props.source, props.width ?? 80)}</Text>
}
