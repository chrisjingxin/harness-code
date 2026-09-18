/** Ink 内联菜单与临时视图：无鼠标、无绝对定位，只消费 Adapter snapshot。 */
/** @jsxImportSource react */
import { renderToString } from "ink"
import React from "react"
import { describe, expect, it } from "vitest"

import { InlineMenus } from "../../src/tui/ink/menus"
import { TemporaryView } from "../../src/tui/ink/temporary-view"
import { MarkdownText } from "../../src/tui/ink/markdown"
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
    expect(output).toContain("标题")
    expect(output).toContain("const n = 1")
  })
})
