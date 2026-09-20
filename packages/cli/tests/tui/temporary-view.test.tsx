/** Ink 覆盖视图测试：Workspace / Tool Inspector / Status / BTW / Inspect 的统一外壳与键盘操作。 */
/** @jsxImportSource react */
import React from "react"
import { describe, expect, it } from "vitest"
import { render, renderToString, Text } from "ink"
import { PassThrough } from "node:stream"

import { TemporaryView, OverlayShell } from "../../src/tui/ink/temporary-view"
import { FullscreenConversationView } from "../../src/tui/ink/app"
import type { TuiAdapter, TuiAdapterSnapshot } from "../../src/tui/application/adapter"

function createSnapshot(overrides: Partial<TuiAdapterSnapshot> = {}): TuiAdapterSnapshot {
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
    workspace: {
      fileTree: {
        status: "idle",
        rows: [
          { name: "src", path: "/ws/src", depth: 0, kind: "directory", expanded: true },
          { name: "index.ts", path: "/ws/src/index.ts", depth: 1, kind: "file" },
          { name: "package.json", path: "/ws/package.json", depth: 0, kind: "file" },
        ],
        selectedIndex: 1,
        selectedPath: "/ws/src/index.ts",
        limited: false,
      },
      preview: { status: "ready", file: { path: "/ws/src/index.ts", content: "console.log('hi')", lineCount: 1, truncated: false } },
    },
    toolInspector: { selectedToolId: "t1" },
    btw: { visible: false, question: "如何运行测试？", answer: "使用 npm test", status: "ready", copied: false },
    statusModal: { visible: false },
    inspectOverlay: { visible: false, kind: "goal", title: "目标详情", body: "目标正文行 1\n目标正文行 2" },
    toasts: [],
    inputMode: "chat",
    interactive: {
      runtime: {
        workspace: "/test-workspace",
        cliVersion: "0.1.0",
        modelConfigured: true,
        executionMode: "local",
        approvalMode: "default",
        modelName: "test-model",
        gitWorkspace: { kind: "branch", branch: "feat-tui", clean: true, root: "/test-workspace" },
      },
      connection: { status: "open" },
      workMode: "build",
      timeline: [
        {
          type: "tool",
          tool: {
            id: "t1",
            name: "read_file",
            arguments: { path: "src/index.ts" },
            status: "completed",
            output: "file contents\nsecond line",
            startedAt: 1,
            completedAt: 2,
          },
        },
      ],
    },
    ...overrides,
  } as TuiAdapterSnapshot
}

describe("OverlayShell", () => {
  it("renders title, page info, children, and footer in a unified border", () => {
    const output = renderToString(
      <OverlayShell title="测试覆盖视图" pageInfo="1/3" footer="Esc 关闭">
        <Text>视图内容正文</Text>
      </OverlayShell>,
      { columns: 72 },
    )
    expect(output).toContain("测试覆盖视图")
    expect(output).toContain("1/3")
    expect(output).toContain("视图内容正文")
    expect(output).toContain("Esc 关闭")
  })
})

describe("WorkspaceView", () => {
  it("renders file tree rows and preview path with selection styling", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({ temporaryView: { kind: "workspace" } })
    const output = renderToString(<TemporaryView snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("工作区")
    expect(output).toContain("src/")
    expect(output).toContain("index.ts")
    expect(output).toContain("package.json")
    expect(output).toContain("Esc 关闭")
  })

  it("dispatches file-preview-insert-ref when pressing @ on selected file", async () => {
    const dispatched: unknown[] = []
    const adapter = { dispatch: async (intent: unknown) => { dispatched.push(intent) } } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({ temporaryView: { kind: "workspace" } })
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    const instance = render(<TemporaryView snapshot={snapshot} adapter={adapter} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))
    stdin.write("@")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(dispatched).toContainEqual({ type: "file-preview-insert-ref", path: "/ws/src/index.ts" })
  })

  it("dispatches file-tree-preview when pressing Enter on selected file", async () => {
    const dispatched: unknown[] = []
    const adapter = { dispatch: async (intent: unknown) => { dispatched.push(intent) } } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({ temporaryView: { kind: "workspace" } })
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    })
    const stdout = Object.assign(new PassThrough(), { columns: 72, rows: 24, isTTY: true })
    const instance = render(<TemporaryView snapshot={snapshot} adapter={adapter} />, {
      stdin: stdin as NodeJS.ReadStream,
      stdout: stdout as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
    })
    await new Promise(resolve => setImmediate(resolve))
    stdin.write("\r")
    await new Promise(resolve => setImmediate(resolve))
    instance.unmount()

    expect(dispatched).toContainEqual({ type: "file-tree-preview", path: "/ws/src/index.ts" })
  })
})

describe("ToolInspectorView", () => {
  it("renders tool inspector with tool names, status, output and selection styling", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({ temporaryView: { kind: "tool-inspector" } })
    const output = renderToString(<TemporaryView snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("Tool Inspector")
    expect(output).toContain("read_file")
    expect(output).toContain("completed")
    expect(output).toContain("file contents")
    expect(output).toContain("Esc 关闭")
  })

  it("renders empty state when there are no tool executions", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({
      temporaryView: { kind: "tool-inspector" },
      interactive: {
        ...createSnapshot().interactive,
        timeline: [],
      },
    })
    const output = renderToString(<TemporaryView snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("Tool Inspector")
    expect(output).toContain("暂无工具记录")
  })
})

describe("BTW and Inspect View", () => {
  it("renders BTW question, answer, and copy hint", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({ temporaryView: { kind: "btw" } })
    const output = renderToString(<TemporaryView snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("BTW")
    expect(output).toContain("如何运行测试？")
    expect(output).toContain("使用 npm test")
    expect(output).toContain("按 c 复制")
  })

  it("renders Inspect overlay with title and content lines", () => {
    const adapter = { dispatch: async () => {} } as Pick<TuiAdapter, "dispatch"> as TuiAdapter
    const snapshot = createSnapshot({
      temporaryView: { kind: "inspect" },
      inspectOverlay: { visible: true, kind: "goal", title: "目标详情", body: "第一行目标\n第二行目标" },
    })
    const output = renderToString(<TemporaryView snapshot={snapshot} adapter={adapter} />, { columns: 72 })
    expect(output).toContain("目标详情")
    expect(output).toContain("第一行目标")
    expect(output).toContain("第二行目标")
  })
})

describe("Overlay in FullscreenConversationView", () => {
  it("replaces timeline viewport with overlay content while keeping header and footer intact", () => {
    const output = renderToString(
      <FullscreenConversationView
        committed={[{ type: "message", message: { id: "m1", role: "assistant", content: "时间线消息不该被看到" } }]}
        live={[]}
        draft=""
        terminalWidth={72}
        terminalHeight={24}
        hideInput
        overlay={<Text>这是覆盖视图内容</Text>}
        status={<Text>STATUS_FOOTER</Text>}
      />,
      { columns: 72 },
    )
    expect(output).toContain("Harness Code")
    expect(output).toContain("这是覆盖视图内容")
    expect(output).not.toContain("时间线消息不该被看到")
    expect(output).toContain("STATUS_FOOTER")
  })
})
