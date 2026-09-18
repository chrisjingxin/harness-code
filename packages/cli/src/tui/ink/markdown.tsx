/** 将 Markdown 映射为 Ink Text；高亮失败时固定纯文本，不访问网络。 */
/** @jsxImportSource react */
import { Box, Text } from "ink"
import { marked, type Token } from "marked"
import React from "react"

function renderTokens(tokens: Token[], keyPrefix = "md"): React.ReactNode[] {
  return tokens.flatMap((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.type) {
      case "heading":
        return [<Text key={key} bold>{token.text}</Text>]
      case "paragraph":
        return [<Text key={key}>{token.text}</Text>]
      case "code":
        return [
          <Box key={key} flexDirection="column">
            {token.lang ? <Text dimColor>{token.lang}</Text> : null}
            {token.text.split("\n").map((line: string, lineIndex: number) => (
              <Text key={`${key}-${lineIndex}`}>{line || " "}</Text>
            ))}
          </Box>,
        ]
      case "list":
        return renderTokens(token.items, key)
      case "list_item":
        return [<Text key={key}>{`• ${token.text}`}</Text>]
      case "blockquote":
        return [<Text key={key} dimColor>{token.text}</Text>]
      case "space":
        return []
      default:
        return "text" in token && token.text ? [<Text key={key}>{token.text}</Text>] : []
    }
  })
}

/** 解析失败时退回原文，避免改写已提交 Timeline。 */
export function MarkdownText(props: { source: string }) {
  try {
    const tokens = marked.lexer(props.source)
    return <Box flexDirection="column">{renderTokens(tokens)}</Box>
  } catch {
    return <Text>{props.source}</Text>
  }
}
