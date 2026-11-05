/** 中央文件页签：独立关闭、键盘焦点与隐藏视图保留。 */
/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { WorkbenchViews } from "../../../src/web/presentation/workbench-views"
import { CodePanel } from "../../../src/web/presentation/context-dock/code/code-panel"
import type { WebIntent } from "../../../src/web/application/adapter"
import { makeSnapshot } from "./fixtures"
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
