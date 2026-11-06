/**
 * 审批卡片无倒计时（§5.6 第 4 条）：`deadlineAtMs = Infinity` 时
 * InteractionForm 不渲染 `.interaction-deadline`，按钮仍可点。
 */
/** @jsxImportSource react */

import { afterAll, describe, expect, test } from "bun:test"

import { WebApp } from "../../src/web/presentation/web-app"
import type { WebAdapterSnapshot, WebInteractiveAdapter } from "../../src/web/application/adapter"
import { makeApproval, makeSnapshot } from "../web/presentation/fixtures"
import { registerTestDom, render } from "../web/presentation/render"

const unregisterTestDom = registerTestDom()
afterAll(() => unregisterTestDom())

describe("审批无超时呈现", () => {
  test("deadlineAtMs=Infinity → 无 .interaction-deadline，批准按钮可点", () => {
    const approval = { ...makeApproval("int-1"), deadlineAtMs: Number.POSITIVE_INFINITY }
    const snapshot = makeSnapshot({
      interactive: { ...makeSnapshot().interactive, interaction: approval },
    })
    const adapter: WebInteractiveAdapter = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      dispatch: async () => {},
      close: async () => {},
    }
    const handle = render(<WebApp adapter={adapter} active={true} handoffControls={false} />)
    try {
      expect(handle.container.querySelector(".interaction-deadline")).toBeNull()
      const button = handle.container.querySelector<HTMLButtonElement>(".interaction-card button")
      expect(button).not.toBeNull()
      expect(button!.disabled).toBe(false)
    } finally {
      handle.unmount()
    }
  })
})
