/** 真实 OpenTUI 渲染同时显示 Lead 与 Sidekick 的执行过程。 */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act, createElement } from "react"
import { ConversationTimeline } from "../../src/tui/presentation/timeline"
import { scopeTimeline } from "../../src/presentation-shared/timeline-scope"
import { makeInteractive } from "../web/presentation/fixtures"
import { liveFusionTimeline } from "../fixtures/fusion-timeline"

test("终端在 Sidekick 未完成时显示两角色、轮次、实时正文和文件工具", async () => {
  const state = liveFusionTimeline()
  const interactive = makeInteractive({
    timeline: scopeTimeline(state.timeline, "root"), activeRun: state.activeRun, activity: state.activity,
  })
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    await act(async () => {
      setup = await testRender(createElement(ConversationTimeline, {
        interactive, scrollRef: { current: null }, showToolDetails: true,
        expandedTools: new Set(), onToggleTool: () => {}, terminalWidth: 140,
      }), { width: 140, height: 42, useMouse: true })
    })
    await act(async () => { await setup!.flush() })
    const frame = setup!.captureCharFrame()
    expect(frame).toContain("Lead · strong-model")
    expect(frame).toContain("Sidekick · fast-model · 第 1 轮")
    expect(frame).toContain("Lead 正在检查代码")
    expect(frame).toContain("Sidekick 正在修改文件")
    expect(frame).toContain("answer.py")
    const row = frame.split("\n").findIndex(line => line.includes("Sidekick · fast-model"))
    const spans = setup!.captureSpans().lines[row]!.spans
    const label = spans.findIndex(span => span.text.includes("Sidekick"))
    expect(label).toBeGreaterThanOrEqual(0)
    const column = spans.slice(0, label).reduce((total, span) => total + span.width, 0) + 2
    await act(async () => { await setup!.mockMouse.click(column, row) })
    // 先提交 React 状态，再绘制下一帧；全套测试负载下不能读取点击前的屏幕缓冲。
    await act(async () => { await setup!.flush() })
    expect(setup!.captureCharFrame()).not.toContain("Sidekick 正在修改文件")
    expect(setup!.captureCharFrame()).toContain("Lead 正在检查代码")
  } finally {
    if (setup) await act(async () => { setup!.renderer.destroy() })
  }
})
