/** 验证终端 Markdown 富文本、代码语法高亮与 Ink 渲染器。 */
/** @jsxImportSource react */
import React from "react"
import { renderToString } from "ink"
import stringWidth from "string-width"
import { describe, expect, it } from "vitest"

import { formatTerminalMarkdown, stripAnsi, highlightCodeLine } from "../../src/tui/ink/terminal-markdown"
import { MarkdownText } from "../../src/tui/ink/markdown"

describe("formatTerminalMarkdown", () => {
  it("将标题、强调和行内代码投影为富文本高亮样式", () => {
    const output = formatTerminalMarkdown("# 标题\n\n**粗体** 与 *斜体* 和 `inline`", 72)
    const plain = stripAnsi(output)

    expect(plain).toContain("标题")
    expect(plain).toContain("粗体")
    expect(plain).toContain("斜体")
    expect(plain).toContain("inline")
    expect(plain).not.toContain("# ")
    expect(plain).not.toContain("**")
    expect(plain).not.toContain("`inline`")

    // 包含 ANSI 高亮样式
    expect(output).toContain("\u001b[")
  })

  it("保留围栏语言、代码内容与语法高亮外框", () => {
    const output = formatTerminalMarkdown(
      "```ts\nconst value = 1\n```\n\n1. first\n2. second\n\n- [x] done\n- [ ] next",
      72,
    )
    const plain = stripAnsi(output)

    expect(plain).toContain("ts")
    expect(plain).toContain("const value = 1")
    expect(plain).toContain("1. first")
    expect(plain).toContain("2. second")
    expect(plain).toContain("☑ done")
    expect(plain).toContain("☐ next")

    // 包含代码块边框外壳与高亮关键字
    expect(output).toContain("╭─")
    expect(output).toContain("╰─")
    expect(output).toContain("\u001b[38;5;176mconst\u001b[0m")
  })

  it("用稳定 gutter 表达引用，并只为 http(s) 链接显示 URL", () => {
    const output = formatTerminalMarkdown(
      "> 引用内容\n\n[文档](https://example.com/docs) 与 [危险](javascript:alert(1))",
      72,
    )
    const plain = stripAnsi(output)

    expect(plain).toContain("│ 引用内容")
    expect(plain).toContain("文档 (https://example.com/docs)")
    expect(plain).toContain("危险")
    expect(plain).not.toContain("javascript:")
  })

  it("宽屏对齐表格，窄屏降级为 key/value", () => {
    const source = "| Name | Value |\n| --- | --- |\n| mode | build |\n| path | /workspace |"
    const wide = formatTerminalMarkdown(source, 72)
    const compact = formatTerminalMarkdown(source, 40)
    const widePlain = stripAnsi(wide)
    const compactPlain = stripAnsi(compact)

    expect(widePlain).toContain("Name")
    expect(widePlain).toContain("Value")
    expect(widePlain).toMatch(/\|\s*Name\s*\|\s*Value\s*\|/)
    expect(compactPlain).toContain("Name: mode")
    expect(compactPlain).toContain("Value: build")
    expect(compactPlain).not.toMatch(/^\|/m)
  })

  it("超宽单元格降级但不静默丢失内容", () => {
    const identifier = "important_identifier"
    const value = "x".repeat(100)
    const output = formatTerminalMarkdown(
      `| Key | Value |\n| --- | --- |\n| ${identifier} | ${value} |`,
      72,
    )
    const plain = stripAnsi(output)

    expect(plain.replace(/\s/g, "")).toContain(identifier)
    expect(plain.replace(/\s/g, "")).toContain(value)
    expect(output.split("\n").every((line) => stringWidth(line) <= 72)).toBe(true)
  })

  it("紧凑表格的超长表头不会吞掉字段值", () => {
    const header = "header".repeat(8)
    const output = formatTerminalMarkdown(
      `| ${header} |\n| --- |\n| VALUE |`,
      40,
    )
    const compact = stripAnsi(output).replace(/\s/g, "")

    expect(compact).toContain(header)
    expect(compact).toContain("VALUE")
  })

  it("清理不可信输入中的控制字符，并保证 40/72/120 列按 cell width 有界换行", () => {
    const source = "标题\u0007\n\n" + "中文🙂组合 e\u0301 ".repeat(20)

    for (const columns of [40, 72, 120]) {
      const output = formatTerminalMarkdown(source, columns)
      expect(output).not.toContain("\u0007")
      expect(output.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true)
    }
  })
})

describe("MarkdownText", () => {
  it("渲染有界的 Markdown 文本组件", () => {
    const source = "## 标题\n\n内容与 `code`。"
    const actual = renderToString(<MarkdownText source={source} width={40} />, { columns: 40 })

    expect(actual).toContain("标题")
    expect(actual).toContain("code")
  })
})
