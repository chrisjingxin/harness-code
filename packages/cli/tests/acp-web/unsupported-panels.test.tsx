/**
 * 缺口面板的呈现（§5.6）：文件树/GiT 不改组件，`workspaceTree.error`
 * 与 `runtime.git.error` 的固定值让现有组件自己渲染告警文案。
 */
/** @jsxImportSource react */

import { afterAll, describe, expect, test } from "bun:test"

import { WebApp } from "../../src/web/presentation/web-app"
import type { WebAdapterSnapshot, WebInteractiveAdapter } from "../../src/web/application/adapter"
import { makeSnapshot } from "../web/presentation/fixtures"
import { registerTestDom, render } from "../web/presentation/render"

const unregisterTestDom = registerTestDom()
afterAll(() => unregisterTestDom())

function fakeAdapter(snapshot: WebAdapterSnapshot): WebInteractiveAdapter {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    dispatch: async () => {},
    close: async () => {},
  }
}

describe("缺口面板：固定值走现有组件的告警路径", () => {
  test("文件树 workspaceTree.status=error → role=alert 且文案含 GAP-11", () => {
    const handle = render(<WebApp adapter={fakeAdapter(makeSnapshot({
      workspaceTree: { status: "error", rows: [], selectedPath: null, limited: false, message: "当前入口暂不支持浏览工作区文件（GAP-11）" },
    }))} active={true} handoffControls={false} />)
    try {
      const alert = handle.container.querySelector('[role="alert"]')
      expect(alert).not.toBeNull()
      expect(alert!.textContent).toContain("GAP-11")
    } finally {
      handle.unmount()
    }
  })

  test("Git 面板 runtime.git.error 非空 → 告警行含 GAP-12", () => {
    const handle = render(<WebApp adapter={fakeAdapter(makeSnapshot({
      contextDock: { open: true, activePanel: "changes", widthPx: 560 },
      interactive: {
        ...makeSnapshot().interactive,
        git: { busy: false, repository: null, diff: null, result: null, error: "当前入口暂不支持 Git（GAP-12）" },
      },
    }))} active={true} handoffControls={false} />)
    try {
      expect(handle.container.textContent).toContain("GAP-12")
    } finally {
      handle.unmount()
    }
  })
})
