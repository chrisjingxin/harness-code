/** Ink 最小对话根的输入映射与静态渲染测试。 */
/** @jsxImportSource react */
import { render, renderToString } from "ink"
import React from "react"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"

import type { TimelineItem } from "../../../src/interactive/state"
import { MinimalConversationView, ProjectedConversationView, resolveInkInput } from "../../../src/tui/ink/app"

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
})

describe("MinimalConversationView", () => {
  it("renders committed conversation and the InputBar without alternate-screen output", () => {
    const timeline: TimelineItem[] = [
      { type: "message", message: { id: "u", role: "user", content: "你好" } },
      { type: "message", message: { id: "a", role: "assistant", content: "你好！" } },
    ]

    const output = renderToString(<MinimalConversationView committed={timeline} live={[]} draft="next" />, { columns: 72 })

    expect(output).toContain("Harness Code")
    expect(output).toContain("你好！")
    expect(output).toContain("> next")
    expect(output).not.toContain("\u001b[?1049h")
  })

  it("renders at most the six draft lines nearest the cursor", () => {
    const output = renderToString(
      <MinimalConversationView committed={[]} live={[]} draft={"0\n1\n2\n3\n4\n5\n6"} />,
      { columns: 72 },
    )

    expect(output).not.toContain("> 0")
    expect(output).toContain("> 1")
    expect(output).toContain("  6")
  })

  it("shows the editing cursor at a grapheme seam", async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => { output += chunk.toString() })
    const instance = render(
      <MinimalConversationView committed={[]} live={[]} draft="a中b" draftCursor={1} />,
      { stdout: stdout as NodeJS.WriteStream, debug: true, exitOnCtrlC: false },
    )
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(output).toContain("a▏中b")
  })

  it("prints streaming finalization and later committed messages through a real Ink Static mount", async () => {
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    let output = ""
    stdout.on("data", chunk => { output += chunk.toString() })
    const instance = render(
      <ProjectedConversationView timeline={[message("m1", "stream", true)]} draft="" />,
      { stdout: stdout as NodeJS.WriteStream, debug: true, exitOnCtrlC: false },
    )
    await new Promise(resolve => setImmediate(resolve))
    instance.rerender(
      <ProjectedConversationView timeline={[message("m1", "final"), message("m2", "second")]} draft="" />,
    )
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(output).toContain("Harness: final")
    expect(output).toContain("Harness: second")
  })
})

function message(id: string, content: string, streaming = false): TimelineItem {
  return { type: "message", message: { id, role: "assistant", content, streaming } }
}
