/** ContextDock：文件/变更标签、文件预览、关闭与宽度调整。 */
/** @jsxImportSource react */

import { afterAll, describe, expect, test } from "bun:test"
import { act } from "react"

import { ContextDock } from "../../../src/web/presentation/context-dock/context-dock"
import type { ContextDockPanel, WebAdapterSnapshot, WebIntent } from "../../../src/web/application/adapter"
import { makeInteractive, makeRuntime, makeSnapshot } from "./fixtures"
import { registerTestDom, render, type RenderHandle } from "./render"

const unregisterTestDom = registerTestDom()
afterAll(() => unregisterTestDom())

function mountDock(snapshot: WebAdapterSnapshot, intents: WebIntent[]): RenderHandle {
  return render(
    <ContextDock snapshot={snapshot} dispatch={intent => intents.push(intent)} />,
  )
}

function dockSnapshot(activePanel: ContextDockPanel, overrides: Partial<WebAdapterSnapshot> = {}): WebAdapterSnapshot {
  return makeSnapshot({
    contextDock: { open: true, activePanel, widthPx: 560, code: { tabs: [], activePath: null, previews: {}, previewErrors: {} } },
    ...overrides,
  })
}

describe("ContextDock", () => {
  test("dock 关闭时保持挂载但 inert + aria-hidden（开关平移过渡的载体）", () => {
    const intents: WebIntent[] = []
    const handle = mountDock(makeSnapshot(), intents)
    try {
      const dock = handle.container.querySelector(".context-dock")
      expect(dock).not.toBeNull()
      expect(dock?.getAttribute("aria-hidden")).toBe("true")
      expect(dock?.hasAttribute("inert")).toBe(true)
    } finally {
      handle.unmount()
    }
  })

  test("Code 面板与主 tab 共用一个 Dock，并填满剩余高度", () => {
    const intents: WebIntent[] = []
    const handle = mountDock(dockSnapshot("code", {
      contextDock: {
        open: true,
        activePanel: "code",
        widthPx: 560,
        code: {
          tabs: [{ path: "src/example.ts", name: "example.ts", language: "typescript" }],
          activePath: "src/example.ts",
          previews: {},
          previewErrors: {},
        },
      },
    }), intents)
    try {
      expect(handle.container.querySelector(".context-dock-code-scroll")).not.toBeNull()
      expect(handle.container.querySelector(".context-dock-stack")).toBeNull()
      expect(handle.container.querySelector(".context-dock-status-card")).toBeNull()
      expect(handle.container.querySelector(".context-dock-model-card")).toBeNull()
      expect(handle.container.querySelector(".context-dock-code-footer")).toBeNull()
    } finally {
      handle.unmount()
    }
  })






  test("dock 关闭按钮 dispatch dock-close", () => {
    const intents: WebIntent[] = []
    const handle = mountDock(dockSnapshot("code"), intents)
    try {
      const close = handle.container.querySelector<HTMLButtonElement>(".panel-close")
      expect(close).not.toBeNull()
      act(() => { close?.click() })
      expect(intents).toContainEqual({ type: "dock-close" })
    } finally {
      handle.unmount()
    }
  })

  test("主 tab 使用 tablist/tab 语义：Code 恒可见；点击 dispatch dock-panel-select", () => {
    const intents: WebIntent[] = []
    const handle = mountDock(dockSnapshot("changes"), intents)
    try {
      const tablist = handle.container.querySelector<HTMLElement>('[role="tablist"]')
      expect(tablist).not.toBeNull()
      const header = handle.container.querySelector<HTMLElement>(".context-dock-header")
      expect(header?.querySelector('[role="tablist"]')).toBe(tablist)
      expect(header?.querySelector(".context-dock-title")).toBeNull()
      expect(header?.querySelector(".panel-close")).not.toBeNull()
      expect(handle.container.querySelectorAll(".context-dock-header")).toHaveLength(1)
      const tabs = Array.from(handle.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      expect(tabs.length).toBe(2)
      const changesTab = tabs.find(tab => tab.textContent === "变更")
      const codeTab = tabs.find(tab => tab.textContent === "文件")
      expect(changesTab?.getAttribute("aria-selected")).toBe("true")
      expect(codeTab?.getAttribute("aria-selected")).toBe("false")
      act(() => { codeTab?.click() })
      expect(intents).toContainEqual({ type: "dock-panel-select", panel: "code" })
      const panel = handle.container.querySelector('[role="tabpanel"]')
      expect(panel?.getAttribute("id")).toBe("context-dock-panel")
    } finally {
      handle.unmount()
    }
  })

  test("主 tab 支持 Arrow/Home/End：移动焦点并派发对应 dock-panel-select", () => {
    const intents: WebIntent[] = []
    const handle = mountDock(dockSnapshot("changes"), intents)
    try {
      const tablist = handle.container.querySelector<HTMLElement>('[role="tablist"]')
      const tabs = Array.from(handle.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      tabs[0]?.focus() // Code 是第一个 tab
      act(() => { tablist?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })) })
      expect(document.activeElement).toBe(tabs[1])
      expect(intents).toContainEqual({ type: "dock-panel-select", panel: "changes" })
      act(() => { tablist?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })) })
      expect(document.activeElement).toBe(tabs[tabs.length - 1])
      expect(intents).toContainEqual({ type: "dock-panel-select", panel: "changes" })
    } finally {
      handle.unmount()
    }
  })

  test("右侧只显示文件和变更，与设置目录能力无关", () => {
    const intents: WebIntent[] = []
    const interactive = makeInteractive({
      runtime: makeRuntime({ capabilities: ["status.read"] }),
    })
    const handle = mountDock(dockSnapshot("code", { interactive }), intents)
    try {
      const tabs = Array.from(handle.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      expect(tabs.map(tab => tab.textContent)).toEqual(["文件", "变更"])
    } finally {
      handle.unmount()
    }
  })

  test("Dock 宽度：左缘拖动 dispatch dock-width-change（宽度随位移递减）", () => {
    const intents: WebIntent[] = []
    const handle = mountDock(dockSnapshot("code"), intents)
    try {
      const resizeHandle = handle.container.querySelector<HTMLElement>(".dock-resize-handle")
      expect(resizeHandle).not.toBeNull()
      act(() => { resizeHandle!.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, bubbles: true })) })
      act(() => { window.dispatchEvent(new PointerEvent("pointermove", { clientX: 450, bubbles: true })) })
      act(() => { window.dispatchEvent(new PointerEvent("pointerup", { clientX: 450, bubbles: true })) })
      const widthIntent = intents.find(intent => intent.type === "dock-width-change")
      expect(widthIntent?.type).toBe("dock-width-change")
      if (widthIntent?.type === "dock-width-change") {
        // 起始 560 - (450 - 500) = 610（向左拖变宽）
        expect(widthIntent.widthPx).toBe(610)
      }
    } finally {
      handle.unmount()
    }
  })
})

test("文件树在右侧，打开文件复用现有预览与意图", () => {
  const intents: WebIntent[] = []
  const snapshot = dockSnapshot("code", { workspaceTree: {
    status: "ready", rows: [{ path: "a.ts", name: "a.ts", kind: "file", depth: 0, expanded: false, loading: false, hasChildren: false }], selectedPath: null, limited: false,
  } })
  const handle = mountDock(snapshot, intents)
  try {
    const file = handle.container.querySelector<HTMLButtonElement>(".file-row")
    expect(file).not.toBeNull()
    act(() => file!.click())
    expect(intents).toContainEqual({ type: "workspace-file-open", path: "a.ts" })
    expect(handle.container.querySelector(".file-explorer-title")?.textContent).toBe("workspace")
  } finally { handle.unmount() }
})
