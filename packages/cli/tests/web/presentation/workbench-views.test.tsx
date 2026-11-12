/** 中央文件页签：独立关闭、键盘焦点与隐藏视图保留。 */
/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { WorkbenchViews } from "../../../src/web/presentation/workbench-views"
import { CodePanel } from "../../../src/web/presentation/context-dock/code/code-panel"
import type { WebIntent } from "../../../src/web/application/adapter"
import { makeInteractive, makeSnapshot } from "./fixtures"
import { registerTestDom, render } from "./render"
const unregister = registerTestDom()
afterAll(unregister)

test("右侧预览提供在主区域打开入口", () => {
  const intents: WebIntent[] = []
  const snapshot = makeSnapshot()
  const handle = render(<CodePanel snapshot={{ ...snapshot, contextDock: { ...snapshot.contextDock, code: {
    tabs: [{ path: "src/a.ts", name: "a.ts", language: "typescript" }], activePath: "src/a.ts", previews: {}, previewErrors: {},
  } } }} dispatch={intent => intents.push(intent)} />)
  try {
    const button = handle.container.querySelector<HTMLButtonElement>('[aria-label="在主区域打开"]')
    expect(button).not.toBeNull()
    act(() => button!.click())
    expect(intents).toEqual([{ type: "workbench-file-open", path: "src/a.ts" }])
  } finally { handle.unmount() }
})

test("文件标签显示完整路径提示，关闭不触发打开；箭头和 Delete 可操作", () => {
  const intents: WebIntent[] = []
  const snapshot = makeSnapshot({ viewMode: "file", fileViews: { paths: ["src/a.ts", "test/a.ts"], activePath: "src/a.ts" } })
  const handle = render(<WorkbenchViews snapshot={snapshot} dispatch={intent => intents.push(intent)} disabled={false}><textarea defaultValue="草稿" /></WorkbenchViews>)
  try {
    const tabs = handle.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(tabs.length).toBe(4)
    expect(tabs[2]!.title).toBe("src/a.ts")
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true")
    expect(handle.container.querySelector<HTMLElement>('#view-panel-chat')!.hidden).toBe(true)
    expect(handle.container.querySelector('textarea')!.value).toBe("草稿")
    act(() => tabs[2]!.focus())
    act(() => tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })))
    expect(intents.at(-1)).toEqual({ type: "workbench-file-open", path: "test/a.ts" })
    expect(document.activeElement).toBe(tabs[3]!)
    act(() => tabs[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })))
    expect(intents.at(-1)).toEqual({ type: "workbench-file-close", path: "test/a.ts" })
    intents.length = 0
    act(() => handle.container.querySelector<HTMLButtonElement>('[aria-label="关闭文件 src/a.ts"]')!.click())
    expect(intents).toEqual([{ type: "workbench-file-close", path: "src/a.ts" }])
  } finally { handle.unmount() }
})

test("轨迹固定开发者展示且无模式切换，并关联时间线用户输入", () => {
  const snapshot = makeSnapshot({
    viewMode: "trace",
    interactive: makeInteractive({
      timeline: [{
        type: "message",
        message: { id: "m1", role: "user", content: "时间线里的用户输入", runId: "run-1" },
      }],
    }),
    trace: {
      threadId: "thread-1",
      spans: [{
        traceId: "trace-number-must-not-show",
        spanId: "span-1",
        parentSpanId: null,
        name: "run.accept",
        type: "ROOT",
        startTime: 1,
        endTime: 2,
        durationMs: 1,
        status: "SUCCESS",
        metadata: { mode: "build", requested_approval_mode: "auto" },
        threadId: "thread-1",
        raw: { run_id: "run-1" },
      }],
      loading: false,
      loaded: true,
      hasAnyTrace: true,
    },
  })
  const handle = render(<WorkbenchViews snapshot={snapshot} dispatch={() => {}} disabled={false}><div /></WorkbenchViews>)
  try {
    const modes = handle.container.querySelectorAll(".trace-mode-switch button")
    expect(modes.length).toBe(0)
    expect(handle.container.querySelector(".trace-run-label")?.textContent).toBe("时间线里的用户输入")
    expect(handle.container.querySelector(".trace-run-label")?.textContent).not.toContain("trace-number-must-not-show")
  } finally { handle.unmount() }
})
