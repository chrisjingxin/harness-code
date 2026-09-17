/** 执行中取消保留草稿；无浮层 Esc 只提示中断键。 */

import { expect, test } from "vitest"

import { Capability, type CodeIndexApplyParams } from "@za38/protocol"
import { createTuiAdapter } from "../../src/tui/application/adapter"
import { makeHarness } from "../interactive/harness"

test("执行中 cancel-run 保留草稿", async () => {
  const harness = makeHarness()
  const adapter = createTuiAdapter({
    controller: harness.controller,
    onRequestExit: () => {},
  })
  try {
    await harness.controller.dispatch({ type: "input.submit", value: "开始干活" })
    expect(harness.controller.getSnapshot().activeRun).not.toBeNull()
    await adapter.dispatch({ type: "draft-input", value: "还没发出去" })
    await adapter.dispatch({ type: "shortcut", action: "cancel-run" })
    expect(adapter.getSnapshot().draft).toBe("还没发出去")
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("执行中 /quit 弹出确认；取消后任务继续", async () => {
  const harness = makeHarness()
  const adapter = createTuiAdapter({
    controller: harness.controller,
    onRequestExit: () => {},
  })
  try {
    await harness.controller.dispatch({ type: "input.submit", value: "开始干活" })
    await adapter.dispatch({ type: "submit", value: "/quit" })
    expect(adapter.getSnapshot().commandDialog).toMatchObject({
      kind: "confirm-quit",
      message: expect.stringContaining("当前任务将被中止"),
    })
    await adapter.dispatch({ type: "dialog-resolve", kind: "command", confirmed: false })
    expect(adapter.getSnapshot().commandDialog).toBeUndefined()
    expect(adapter.getSnapshot().interactive.activeRun).not.toBeNull()
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("hint-interrupt 弹出 Ctrl+C 提示", async () => {
  const harness = makeHarness()
  const adapter = createTuiAdapter({
    controller: harness.controller,
    onRequestExit: () => {},
  })
  try {
    await adapter.dispatch({ type: "shortcut", action: "hint-interrupt" })
    expect(adapter.getSnapshot().toasts.some(item => item.message === "中断请用 Ctrl+C")).toBe(true)
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("受理后清空草稿，拒绝时保留草稿", async () => {
  const harness = makeHarness()
  const adapter = createTuiAdapter({ controller: harness.controller, onRequestExit: () => {} })
  try {
    await adapter.dispatch({ type: "draft-input", value: "第一条" })
    await adapter.dispatch({ type: "submit", value: "第一条" })
    expect(adapter.getSnapshot().draft).toBe("")

    await adapter.dispatch({ type: "draft-input", value: "第二条" })
    await adapter.dispatch({ type: "submit", value: "第二条" })
    expect(adapter.getSnapshot().draft).toBe("第二条")
    expect(adapter.getSnapshot().transientNotice?.message).toBeTruthy()
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("adapter close 重复调用不会重复触发退出", async () => {
  let exits = 0
  const harness = makeHarness()
  const adapter = createTuiAdapter({ controller: harness.controller, onRequestExit: () => { exits += 1 } })

  await adapter.close()
  await adapter.close()

  expect(exits).toBe(0)
  await harness.controller.close()
})

test("/code-index remove 在 TUI 使用共享确认后才删除", async () => {
  const requests: CodeIndexApplyParams[] = []
  const harness = makeHarness({
    capabilities: [Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => ({
      revision: 3,
      generation: 1,
      engine_version: "1.1.6",
      data_directory: ".harness-index",
      runtime_status: "ready",
      index_status: "ready",
      query_status: "ready",
      watcher_status: "ready",
      job: null,
      stats: null,
      error: null,
    }),
    codeIndexApplyImpl: async params => {
      requests.push(params)
      return {
        revision: 4,
        generation: 1,
        engine_version: "1.1.6",
        data_directory: ".harness-index",
        runtime_status: "ready",
        index_status: "absent",
        query_status: "stopped",
        watcher_status: "stopped",
        job: null,
        stats: null,
        error: null,
      }
    },
  })
  const adapter = createTuiAdapter({ controller: harness.controller, onRequestExit: () => {} })
  try {
    await adapter.dispatch({ type: "submit", value: "/code-index remove" })
    expect(adapter.getSnapshot().commandDialog).toMatchObject({
      kind: "confirm-code-index-remove",
      title: "删除代码索引？",
    })
    expect(requests).toEqual([])
    await adapter.dispatch({ type: "dialog-resolve", kind: "command", confirmed: true })
    expect(requests).toEqual([{ action: "remove", expected_revision: 3, confirmed: true }])
    expect(adapter.getSnapshot().inspectOverlay).toMatchObject({ visible: true, kind: "code-index" })
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})
