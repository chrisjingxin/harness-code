/** Ink 内联菜单与临时视图：无鼠标、无绝对定位，只消费 Adapter snapshot。 */
/** @jsxImportSource react */
import { renderToString, Text } from "ink"
import React from "react"
import { describe, expect, it } from "vitest"

import { InlineMenus } from "../../src/tui/ink/menus"
import { TemporaryView } from "../../src/tui/ink/temporary-view"
import { MarkdownText } from "../../src/tui/ink/markdown"
import { FullscreenConversationView } from "../../src/tui/ink/app"
import { ToastViewport } from "../../src/tui/ink/fullscreen-shell"
import type { TimelineItem } from "../../src/interactive/state"
import type { TuiAdapter, TuiAdapterSnapshot } from "../../src/tui/application/adapter"

function snapshot(overrides: Partial<TuiAdapterSnapshot>): TuiAdapterSnapshot {
  return {
    commandMenu: { visible: false, selectedIndex: 0, windowStart: 0 },
    commandOptions: [],
    mentionMenu: {
      visible: false, selectedIndex: 0, windowStart: 0, browsePath: "", query: "",
      start: 0, end: 0, isQuoted: false, workspaceStatus: "idle", workspaceLimited: false,
    },
    mentionSearch: { items: [], totalMatches: 0, truncated: false },
    skills: { visible: false, loading: false, query: "", selectedIndex: 0, items: [] },
    threads: { visible: false, loading: false, query: "", selectedIndex: 0, items: [] },
    models: { visible: false, loading: false, query: "", selectedIndex: 0, items: [] },
    agents: { visible: false, loading: false, query: "", selectedIndex: 0, items: [] },
    undo: { visible: false, loading: false, query: "", selectedIndex: 0, items: [] },
    temporaryView: { kind: "none" },
    workspace: { fileTree: { status: "idle", rows: [], selectedIndex: 0, selectedPath: null, limited: false }, preview: null },
    toolInspector: { selectedToolId: null },
    btw: { visible: false, question: "", status: "loading" },
    statusModal: { visible: false },
    inspectOverlay: { visible: false, kind: "goal", title: "", body: "" },
    toasts: [],
    inputMode: "chat",
    interactive: { runtime: { workspace: "/ws", cliVersion: "0.1.0", modelConfigured: true, executionMode: "local", approvalMode: "default" }, connection: { status: "open" }, workMode: "build", timeline: [] },
    ...overrides,
  } as TuiAdapterSnapshot
}

describe("InlineMenus", () => {
  it("renders the command menu from snapshot without mouse chrome", () => {
    const output = renderToString(
      <InlineMenus snapshot={snapshot({
        commandMenu: { visible: true, selectedIndex: 0, windowStart: 0 },
        commandOptions: [
          { kind: "command", command: { id: "model.select", name: "model", description: "选择模型", source: { type: "builtin" }, presentation: "picker" }, availability: { status: "available" } },
        ],
      } as Partial<TuiAdapterSnapshot>)} />,
      { columns: 72 },
    )
    expect(output).toContain("/model")
    expect(output).toContain("选择模型")
    expect(output).not.toContain("hover")
  })

  it("keeps the selected menu row, header, input, and status visible in a 12-row terminal", () => {
    const options = Array.from({ length: 8 }, (_, index) => ({
      kind: "command" as const,
      command: { id: `command-${index}`, name: `command-${index}`, description: `选项 ${index} `.repeat(20), source: { type: "builtin" as const }, presentation: "immediate" as const },
      availability: { status: "available" as const },
    }))
    const menuSnapshot = snapshot({
      commandMenu: { visible: true, selectedIndex: 6, windowStart: 0 },
      commandOptions: options,
    } as Partial<TuiAdapterSnapshot>)
    const timeline = Array.from({ length: 30 }, (_, index): TimelineItem => ({
      type: "message",
      message: { id: `message-${index}`, role: "assistant", content: `历史 ${index}` },
    }))
    const output = renderToString(
      <FullscreenConversationView
        committed={timeline}
        live={[]}
        draft="继续输入"
        terminalWidth={40}
        terminalHeight={12}
        footer={<InlineMenus snapshot={menuSnapshot} maxItems={1} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )

    expect(visibleLines(output)).toHaveLength(12)
    expect(output).toContain("Harness Code")
    expect(output).toContain("/command-6")
    expect(output).not.toContain("/command-0")
    expect(output).toContain("❯ 继续输入")
    expect(output).toContain("STATUS")
  })

  it("keeps a long confirmation actionable in a 40x12 frame", () => {
    const dialogSnapshot = snapshot({
      commandDialog: {
        kind: "confirm-quit",
        title: "确认退出",
        message: "当前任务仍在运行，退出将中断它。".repeat(30),
        confirmLabel: "继续退出",
        cancelLabel: "取消",
      },
    } as Partial<TuiAdapterSnapshot>)
    const output = renderToString(
      <FullscreenConversationView
        committed={[]}
        live={[]}
        draft="继续输入"
        terminalWidth={40}
        terminalHeight={12}
        footer={<InlineMenus snapshot={dialogSnapshot} maxItems={1} maxRows={5} />}
        toast={<ToastViewport toasts={[]} width={40} />}
        status={<Text>STATUS</Text>}
      />,
      { columns: 40 },
    )

    expect(visibleLines(output)).toHaveLength(12)
    expect(output).toContain("继续退出")
    expect(output).toContain("取消")
    expect(output).toContain("❯ 继续输入")
    expect(output).toContain("STATUS")
  })
})

describe("TemporaryView", () => {
  it("renders status without reprinting committed history chrome", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const output = renderToString(
      <TemporaryView snapshot={snapshot({ temporaryView: { kind: "status" } })} adapter={adapter} />,
      { columns: 72 },
    )
    expect(output).toContain("状态")
    expect(output).toContain("/ws")
    expect(output).toContain("Esc 关闭")
  })
})

describe("MarkdownText", () => {
  it("renders headings and fenced code as readable Ink text", () => {
    const output = renderToString(<MarkdownText source={"# 标题\n\n```ts\nconst n = 1\n```"} />, { columns: 72 })
    const visible = visibleLines(output).join("\n")
    expect(visible).toContain("标题")
    expect(visible).toContain("const n = 1")
    expect(output).toContain("\u001b[38;5;176mconst\u001b[39m")
  })
})

function visibleLines(output: string): string[] {
  return output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line, index, lines) => !(index === lines.length - 1 && line === ""))
}
