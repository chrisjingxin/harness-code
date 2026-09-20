/** Ink 最小对话根的输入映射与静态渲染测试。 */
/** @jsxImportSource react */
import { render, renderToString, Text, useInput } from "ink"
import React from "react"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"

import type { TimelineItem } from "../../src/interactive/state"
import { FullscreenConversationView, resolveInkInput } from "../../src/tui/ink/app"
import { createInputBuffer, inputBufferReducer } from "../../src/tui/ink/input-buffer"
import { ToastViewport } from "../../src/tui/ink/fullscreen-shell"

const emptyKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, home: false, end: false, return: false,
  escape: false, ctrl: false, shift: false, tab: false, backspace: false,
  delete: false, meta: false, super: false, hyper: false, capsLock: false,
  numLock: false,
}

describe("Ink input mapping", () => {
  it("submits on Enter and inserts newlines through all fallbacks", () => {
    expect(resolveInkInput("", { ...emptyKey, return: true }, { hasDraft: true, activeRun: false })).toEqual({ type: "submit" })
    expect(resolveInkInput("", { ...emptyKey, return: true, shift: true }, { hasDraft: true, activeRun: false })).toEqual({ type: "buffer", action: { type: "insert", text: "\n" } })
    expect(resolveInkInput("", { ...emptyKey, return: true, meta: true }, { hasDraft: true, activeRun: false })).toEqual({ type: "buffer", action: { type: "insert", text: "\n" } })
    expect(resolveInkInput("j", { ...emptyKey, ctrl: true }, { hasDraft: true, activeRun: false })).toEqual({ type: "buffer", action: { type: "insert", text: "\n" } })
  })

  it("keeps multi-character paste as one buffer update", () => {
    expect(resolveInkInput("a\nb", emptyKey, { hasDraft: false, activeRun: false })).toEqual({ type: "buffer", action: { type: "insert", text: "a\nb" } })
  })

  it("applies the three-stage Ctrl+C behavior", () => {
    expect(resolveInkInput("c", { ...emptyKey, ctrl: true }, { hasDraft: true, activeRun: true })).toEqual({ type: "shortcut", action: "clear-draft" })
    expect(resolveInkInput("c", { ...emptyKey, ctrl: true }, { hasDraft: false, activeRun: true })).toEqual({ type: "shortcut", action: "cancel-run" })
    expect(resolveInkInput("c", { ...emptyKey, ctrl: true }, { hasDraft: false, activeRun: false })).toEqual({ type: "shortcut", action: "exit" })
  })

  it("ignores kitty key-release events so each character is inserted once", () => {
    expect(resolveInkInput("s", { ...emptyKey, eventType: "release" }, { hasDraft: false, activeRun: false })).toEqual({ type: "ignore" })
  })

  it("does not treat SGR mouse reports as draft text", () => {
    const context = { hasDraft: false, activeRun: false }

    expect(resolveInkInput("\u001b[<64;12;5M", emptyKey, context)).toEqual({ type: "ignore" })
    expect(resolveInkInput("[<64;12;5M", emptyKey, context)).toEqual({ type: "ignore" })
    expect(resolveInkInput("\u001b[<65;12;5M", emptyKey, context)).toEqual({ type: "ignore" })
    expect(resolveInkInput("[<65;49;44M[<64;49;44M[<64;49;44M[<64;49;44M[<65;49;42M[", emptyKey, context)).toEqual({ type: "ignore" })
    expect(resolveInkInput("[<0;10;10M[<0;10;10m", emptyKey, context)).toEqual({ type: "ignore" })
    expect(resolveInkInput("[<64;12;8", emptyKey, context)).toEqual({ type: "ignore" })
    expect(resolveInkInput("[", emptyKey, context)).toEqual({ type: "buffer", action: { type: "insert", text: "[" } })
    expect(resolveInkInput("[link]", emptyKey, context)).toEqual({ type: "buffer", action: { type: "insert", text: "[link]" } })
    expect(resolveInkInput("\u001b[<64;12;5Mfoo", emptyKey, context)).toEqual({ type: "buffer", action: { type: "insert", text: "foo" } })
  })

  it("does not insert an SGR wheel report delivered through a real Ink input stream", async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    const values: string[] = []
    const instance = render(<InputProbe onValue={value => values.push(value)} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))

    stdin.write("\u001b[<64;12;5M")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(values).toEqual([])
  })

  it("routes Ctrl+Home and Ctrl+End to the local viewport owner", () => {
    const context = { hasDraft: true, activeRun: false }

    expect(resolveInkInput("", { ...emptyKey, ctrl: true, home: true }, context)).toEqual({
      type: "viewport",
      action: "top",
    })
    expect(resolveInkInput("", { ...emptyKey, ctrl: true, end: true }, context)).toEqual({
      type: "viewport",
      action: "bottom",
    })
    expect(resolveInkInput("", { ...emptyKey, home: true }, context)).toEqual({ type: "buffer", action: { type: "home" } })
    expect(resolveInkInput("", { ...emptyKey, end: true }, context)).toEqual({ type: "buffer", action: { type: "end" } })
  })

  it("routes PageUp and PageDown to the local viewport owner", () => {
    const context = { hasDraft: false, activeRun: false }

    expect(resolveInkInput("", { ...emptyKey, pageUp: true }, context)).toEqual({ type: "viewport", action: "page-up" })
    expect(resolveInkInput("", { ...emptyKey, pageDown: true }, context)).toEqual({ type: "viewport", action: "page-down" })
  })

  it("treats the terminal DEL sequence emitted by Backspace as backward deletion", async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    const values: string[] = []
    const instance = render(<InputProbe onValue={value => values.push(value)} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))

    stdin.write("\u007f")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(values).toEqual(["a"])
  })
})

describe("FullscreenConversationView input", () => {
  it("renders conversation and the InputBar without writing terminal control sequences", () => {
    const timeline: TimelineItem[] = [
      { type: "message", message: { id: "u", role: "user", content: "你好" } },
      { type: "message", message: { id: "a", role: "assistant", content: "你好！" } },
    ]

    const output = renderToString(
      <FullscreenConversationView committed={timeline} live={[]} draft="next" terminalWidth={72} terminalHeight={24} />,
      { columns: 72 },
    )

    expect(output).toContain("Harness Code")
    expect(output).toContain("你好！")
    expect(output).toContain("❯ next")
    expect(output).not.toContain("\u001b[?1049h")
  })

  it("keeps a long single-line draft on one prompt row without the placeholder", () => {
    const output = renderToString(
      <FullscreenConversationView committed={[]} live={[]} draft="sdsdsdasdadsadsa" terminalWidth={40} terminalHeight={24} />,
      { columns: 40 },
    )

    expect(output).toContain("sdsdsdasdadsadsa")
    expect(output).not.toContain("输入消息")
    expect(output.split("❯ ").length - 1).toBe(1)
  })

  it("renders at most four draft rows so the complete InputBar stays within six rows", () => {
    const output = renderToString(
      <FullscreenConversationView committed={[]} live={[]} draft={"0\n1\n2\n3\n4\n5\n6"} terminalWidth={72} terminalHeight={24} />,
      { columns: 72 },
    )

    expect(output).not.toContain("❯ 0")
    expect(output).not.toContain("  2")
    expect(output).toContain("❯ 3")
    expect(output).toContain("  6")
  })

  it("shows the editing cursor at a grapheme seam", async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => { output += chunk.toString() })
    const instance = render(
      <FullscreenConversationView committed={[]} live={[]} draft="a中b" draftCursor={1} terminalWidth={72} terminalHeight={24} />,
      { stdout: stdout as NodeJS.WriteStream, debug: true, exitOnCtrlC: false },
    )
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(output).toMatch(/a.*中.*b/)
  })

  it("redraws streaming finalization and later messages inside the same full-screen root", async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => { output += chunk.toString() })
    const instance = render(
      <FullscreenConversationView committed={[]} live={[message("m1", "stream", true)]} draft="" terminalWidth={72} terminalHeight={24} />,
      { stdout: stdout as NodeJS.WriteStream, debug: true, exitOnCtrlC: false },
    )
    await new Promise(resolve => setImmediate(resolve))
    instance.rerender(
      <FullscreenConversationView committed={[]} live={[message("m1", "final"), message("m2", "second")]} draft="" terminalWidth={72} terminalHeight={24} />,
    )
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(output).toMatch(/final/)
    expect(output).toMatch(/second/)
    expect(output).not.toContain("Harness:")
  })

  it("renders typed timeline entries with Chinese status and safe grouping", () => {
    const timeline: TimelineItem[] = [
      { type: "message", message: { id: "u", role: "user", content: "检查项目", workMode: "compose" } },
      { type: "reasoning", reasoning: { id: "r", runId: "run", text: "分析依赖", active: true } },
      tool("read", "read_file", "completed"),
      tool("grep", "grep", "completed"),
      tool("execute", "execute", "failed"),
      { type: "interaction", interaction: { id: "approval", runId: "run", type: "approval", status: "approved", description: "允许执行" } },
      {
        type: "compose-summary",
        summary: { id: "summary", runId: "run", status: "passed", text: "实现完成", composeScope: { activityId: "activity", stage: "implement", attempt: 1 } },
      },
      {
        type: "goal-evaluation",
        evaluation: { id: "goal", runId: "run", phase: "result", iteration: 1, result: "satisfied", graderProfileId: "default" },
      },
    ]

    const output = renderToString(
      <FullscreenConversationView committed={timeline} live={[]} draft="" terminalWidth={72} terminalHeight={32} />,
      { columns: 72 },
    )

    expect(output).toContain("检查项目")
    expect(output).toContain("正在思考")
    expect(output).toContain("读取活动")
    expect(output).toContain("2 项")
    expect(output).toContain("执行命令")
    expect(output).toContain("失败")
    expect(output).toContain("审批")
    expect(output).toContain("验收通过")
    expect(output).not.toMatch(/You:|Harness:|Reasoning:|Tool:|Interaction:|Goal evaluation:/)
  })

  it("renders completed reasoning collapsed as single line with summary and count", () => {
    const timeline: TimelineItem[] = [
      { type: "reasoning", reasoning: { id: "r1", runId: "run", text: "首先解析语法树\n然后遍历AST\n最后输出代码", active: false } },
    ]
    const output = renderToString(
      <FullscreenConversationView committed={timeline} live={[]} draft="" terminalWidth={72} terminalHeight={32} />,
      { columns: 72 },
    )
    expect(output).toContain("◆")
    expect(output).toContain("思考完成 · 首先解析语法树 (共 3 行)")
    expect(output).not.toContain("遍历AST")
  })

  it("renders active streaming reasoning with unbroken guide rail and bounded rolling tail", () => {
    const longThought = "Analyzing requirements for a simplified wc tool. Core functionality will encompass counting lines, words, and characters within specified files. Considering a design that supports command-line file path arguments for input.\n\nHandling standard input when no file arguments are provided ensures compatibility with common Unix patterns."
    const timeline: TimelineItem[] = [
      { type: "reasoning", reasoning: { id: "r-active", runId: "run", text: longThought, active: true } },
    ]
    const output = renderToString(
      <FullscreenConversationView committed={[]} live={timeline} draft="" terminalWidth={60} terminalHeight={32} />,
      { columns: 60 },
    )
    expect(output).toContain("正在思考…")
    const lines = visibleLines(output).filter(l => l.startsWith("  │ "))
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(lines.every(l => l.startsWith("  │ "))).toBe(true)
    expect(lines.every(l => l.trim() !== "│")).toBe(true)
  })

  it("renders distinct tool colors and highlighted +/- diffs for mutations", () => {
    const editItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "edit",
        runId: "run",
        name: "edit_file",
        arguments: JSON.stringify({
          file_path: "/workspace/test.py",
          old_string: "assert res.words == 0",
          new_string: "assert res.words == 7",
        }),
        output: JSON.stringify({
          ok: true,
          path: "/workspace/test.py",
          changed_range: { start_line: 56, end_line: 56, added_lines: 1, removed_lines: 1 },
          total_lines: 132,
        }),
        status: "completed",
      },
    }
    const execItem: TimelineItem = {
      type: "tool",
      tool: {
        id: "exec",
        runId: "run",
        name: "execute",
        arguments: JSON.stringify({ command: "pytest -v" }),
        output: "passed",
        status: "completed",
      },
    }
    const output = renderToString(
      <FullscreenConversationView committed={[editItem, execItem]} live={[]} draft="" terminalWidth={72} terminalHeight={32} />,
      { columns: 72 },
    )
    // 写入/编辑文件拥有翠绿标签与彩色 diff
    expect(output).toContain("\u001b[38;5;114m")
    expect(output).toContain("编辑文件")
    expect(output).toContain("+1")
    expect(output).toContain("-1")
    expect(output).toContain("\u001b[38;5;203m- assert res.words == 0")
    expect(output).toContain("\u001b[38;5;114m+ \u001b[39m")
    // 命令执行拥有琥珀金色标签与参数
    expect(output).toContain("\u001b[38;5;214m")
    expect(output).toContain("执行命令")
    expect(output).toContain("\u001b[38;5;223mpytest -v\u001b[39m")
  })

  it("uses the terminal Markdown projection in the production timeline path", () => {
    const content = "# 结果\n\n**重点** 与 `code`\n\n| 名称 | 状态 |\n| --- | --- |\n| TUI | 完成 |\n\n```ts\nconst value = 1\n```"
    const output = renderToString(
      <FullscreenConversationView committed={[message("markdown", content)]} live={[]} draft="" terminalWidth={72} terminalHeight={32} />,
      { columns: 72 },
    )
    const visible = visibleLines(output).join("\n")

    expect(visible).toContain("▌ 结果")
    expect(visible).toContain("重点 与 code")
    expect(visible).toContain("名称")
    expect(visible).toContain("const value = 1")
    expect(visible).not.toContain("**")
    expect(visible).not.toContain("```")
    expect(output).toContain("\u001b[38;5;176mconst\u001b[39m")
  })
})

describe("FullscreenConversationView", () => {
  it("fills the viewport and keeps the draft and status in the bottom slots", () => {
    const output = renderToString(
      <FullscreenConversationView
        committed={[message("history", "历史消息")]}
        live={[]}
        draft="下一条"
        terminalWidth={72}
        terminalHeight={12}
        status={<Text>STATUS</Text>}
      />,
      { columns: 72 },
    )
    const lines = visibleLines(output)

    expect(lines).toHaveLength(12)
    expect(lines.at(-1)).toContain("STATUS")
    expect(lines.findIndex(line => line.includes("❯ 下一条"))).toBeGreaterThanOrEqual(0)
    expect(lines.findIndex(line => line.includes("❯ 下一条"))).toBeLessThan(lines.length - 1)
  })

  it("clips application-owned history to the available timeline viewport", () => {
    const timeline = Array.from({ length: 24 }, (_, index) => message(`m-${index}`, `历史-${index}`))
    const output = renderToString(
      <FullscreenConversationView
        committed={timeline}
        live={[]}
        draft=""
        terminalWidth={72}
        terminalHeight={12}
      />,
      { columns: 72 },
    )

    expect(output).toContain("历史-23")
    expect(output).not.toContain("历史-0")
  })

  it("shows only the too-small state below 40 columns or 12 rows", () => {
    const output = renderToString(
      <FullscreenConversationView
        committed={[message("history", "不应显示的历史")]}
        live={[]}
        draft="不应显示的草稿"
        terminalWidth={39}
        terminalHeight={11}
      />,
      { columns: 39 },
    )

    expect(output).toContain("终端过小")
    expect(output).toContain("40")
    expect(output).toContain("12")
    expect(output).not.toContain("不应显示的历史")
    expect(output).not.toContain("不应显示的草稿")
  })

  it("shows an unseen-content prompt without moving the bottom input slot", () => {
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[message("latest", "当前阅读位置")]}
        draft="继续输入"
        terminalWidth={72}
        terminalHeight={12}
        unseenCount={3}
      />,
      { columns: 72 },
    )
    const lines = visibleLines(output)

    expect(output).toContain("3 条新内容")
    expect(lines.findIndex(line => line.includes("❯ 继续输入"))).toBeGreaterThan(lines.findIndex(line => line.includes("3 条新内容")))
  })

  it("keeps timeline and input positions stable when a toast appears", () => {
    const renderFrame = (active: boolean) => visibleLines(renderToString(
      <FullscreenConversationView
        committed={[message("history", "稳定历史位置")]}
        live={[]}
        draft="稳定输入位置"
        terminalWidth={72}
        terminalHeight={12}
        toast={<ToastViewport
          width={72}
          toasts={active ? [{ id: "toast", message: "保存完成", variant: "success" }] : []}
        />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 72 },
    ))
    const empty = renderFrame(false)
    const active = renderFrame(true)

    expect(active).toHaveLength(empty.length)
    expect(active.findIndex(line => line.includes("稳定历史位置"))).toBe(empty.findIndex(line => line.includes("稳定历史位置")))
    expect(active.findIndex(line => line.includes("❯ 稳定输入位置"))).toBe(empty.findIndex(line => line.includes("❯ 稳定输入位置")))
  })
})

function message(id: string, content: string, streaming = false): TimelineItem {
  return { type: "message", message: { id, role: "assistant", content, streaming } }
}

function tool(id: string, name: string, status: "running" | "completed" | "failed"): TimelineItem {
  return {
    type: "tool",
    tool: {
      id,
      runId: "run",
      name,
      arguments: JSON.stringify({ file_path: `/workspace/${id}.ts`, pattern: id, command: `echo ${id}` }),
      output: status === "failed" ? "command failed" : "",
      status,
      executionId: "root",
      activityId: "activity",
    },
  }
}

function InputProbe(props: { onValue: (value: string) => void }) {
  useInput((input, key) => {
    const resolution = resolveInkInput(input, key, { hasDraft: true, activeRun: false })
    if (resolution.type !== "buffer") return
    props.onValue(inputBufferReducer(createInputBuffer("ab"), resolution.action).value)
  })
  return null
}

function visibleLines(output: string): string[] {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
}
