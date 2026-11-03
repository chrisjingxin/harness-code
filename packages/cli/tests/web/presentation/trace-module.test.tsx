/** Trace 模块边界与持续更新回归：窄输入、节点身份、会话隔离和连续拖动。 */
/** @jsxImportSource react */

import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { TraceView, type TraceViewState } from "../../../src/web/presentation/trace"
import type { TraceSpanEvent } from "../../../src/presentation-coordinator/contracts/trace"
import { registerTestDom, render } from "./render"

const unregister = registerTestDom()
afterAll(unregister)

function span(overrides: Partial<TraceSpanEvent> = {}): TraceSpanEvent {
  return {
    traceId: "trace-1", spanId: "span-1", parentSpanId: null,
    threadId: "thread-1", name: "LLM", type: "LLM",
    startTime: 1000, endTime: null, durationMs: null,
    status: "RUNNING", raw: {}, ...overrides,
  }
}

function state(spans: readonly TraceSpanEvent[], threadId = "thread-1"): TraceViewState {
  return { threadId, spans, loading: false, loaded: true, hasAnyTrace: true }
}

test("选中运行中节点后，完成增量更新同一份详情，不抢走选中", () => {
  const initial = span()
  const handle = render(<TraceView state={state([initial])} />)
  try {
    act(() => handle.container.querySelector<HTMLElement>(".trace-node-row")!.click())
    expect(handle.container.querySelector(".trace-detail-meta")?.textContent).toContain("RUNNING")
    act(() => handle.root.render(<TraceView state={state([
      { ...initial, status: "SUCCESS", endTime: 1250, durationMs: 250, raw: { result: "finished" } },
      span({ spanId: "span-2", name: "next" }),
    ])} />))
    expect(handle.container.querySelector(".trace-detail-meta")?.textContent).toContain("250ms")
    expect(handle.container.querySelector(".trace-detail-meta")?.textContent).toContain("SUCCESS")
    expect(handle.container.querySelector(".trace-json")?.textContent).toContain("finished")
    expect(handle.container.querySelector(".trace-node-row.active")?.getAttribute("data-span-key")).toBe("trace-1:span-1")
  } finally { handle.unmount() }
})

test("切换会话后不能继续显示上一会话的选中详情，即使 span ID 相同", () => {
  const initial = span({ raw: { message: "first-thread-only" } })
  const handle = render(<TraceView state={state([initial])} />)
  try {
    act(() => handle.container.querySelector<HTMLElement>(".trace-node-row")!.click())
    expect(handle.container.querySelector(".trace-json")?.textContent).toContain("first-thread-only")
    act(() => handle.root.render(<TraceView state={state([
      { ...initial, threadId: "thread-2", raw: { message: "second-thread" } },
    ], "thread-2")} />))
    expect(handle.container.querySelector('[data-selected="true"]')).toBeNull()
    expect(handle.container.querySelector(".trace-node-row.active")).toBeNull()
  } finally { handle.unmount() }
})

test("增量更新保留用户折叠的轮次；再次点击相同图表节点仍能展开定位", () => {
  const initial = span()
  const handle = render(<TraceView state={state([initial])} />)
  try {
    act(() => handle.container.querySelector<HTMLElement>(".trace-gantt-bar")!.click())
    act(() => handle.container.querySelector<HTMLButtonElement>(".trace-run-header")!.click())
    expect(handle.container.querySelector(".trace-run-header")?.getAttribute("aria-expanded")).toBe("false")
    act(() => handle.root.render(<TraceView state={state([{ ...initial, durationMs: 123 }])} />))
    expect(handle.container.querySelector(".trace-run-header")?.getAttribute("aria-expanded")).toBe("false")
    act(() => handle.container.querySelector<HTMLElement>(".trace-gantt-bar")!.click())
    expect(handle.container.querySelector(".trace-run-header")?.getAttribute("aria-expanded")).toBe("true")
  } finally { handle.unmount() }
})

test("连续拖动按增量位移计算，重复同坐标不继续放大，取消拖动清理光标", () => {
  const handle = render(<TraceView state={state([span()])} />)
  try {
    const divider = handle.container.querySelector<HTMLElement>(".trace-resize-horizontal")!
    const height = () => handle.container.querySelector<HTMLElement>(".trace-gantt-wrap")!.style.height
    act(() => divider.dispatchEvent(new PointerEvent("pointerdown", { clientY: 100, bubbles: true })))
    act(() => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 140 })))
    expect(height()).toBe("160px")
    act(() => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 160 })))
    expect(height()).toBe("170px")
    act(() => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 160 })))
    expect(height()).toBe("170px")
    expect(document.body.classList.contains("trace-resizing-h")).toBe(true)
    act(() => window.dispatchEvent(new PointerEvent("pointercancel")))
    expect(document.body.classList.contains("trace-resizing-h")).toBe(false)
    act(() => window.dispatchEvent(new PointerEvent("pointermove", { clientY: 200 })))
    expect(height()).toBe("170px")
  } finally { handle.unmount() }
})

test("Trace 模块不导入整个 adapter、网络或文件系统；颜色统一来自主题", () => {
  const dir = resolve(import.meta.dir, "../../../src/web/presentation/trace")
  const source = readdirSync(dir).filter(name => /\.(ts|tsx)$/.test(name))
    .map(name => readFileSync(resolve(dir, name), "utf8")).join("\n")
  expect(source).not.toMatch(/from\s+["'][^"']*(?:application\/adapter|ui-client|node:fs|node:path|trace-log)/)
  expect(source).not.toContain("trace-load")
  const css = readFileSync(resolve(dir, "trace.css"), "utf8")
  const colors = readFileSync(resolve(dir, "colors.ts"), "utf8")
  expect(css + colors).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
  const theme = readFileSync(resolve(dir, "../theme.css"), "utf8")
  for (const [, token] of (css + colors).matchAll(/var\((--trace-[\w-]+)/g)) {
    expect(theme).toContain(`${token}:`)
  }
})

test("200 轮的全部节点和图表分界保持完整，两种模式切换后最后一轮仍可定位", () => {
  const spans = Array.from({ length: 200 }, (_, i) => {
    const traceId = `r${i}`
    const root = span({ traceId, spanId: `root-${i}`, name: "run.root", type: "RUN", startTime: i * 1000 })
    const accept = span({ traceId, spanId: `accept-${i}`, parentSpanId: root.spanId, name: "run.accept", type: "RUN", startTime: i * 1000 + 1 })
    const model = span({ traceId, spanId: `model-${i}`, parentSpanId: accept.spanId, name: "model", type: "LLM", startTime: i * 1000 + 2 })
    const tools = span({ traceId, spanId: `tools-${i}`, parentSpanId: accept.spanId, name: "tools", type: "NODE", startTime: i * 1000 + 3 })
    const tool = span({ traceId, spanId: `tool-${i}`, parentSpanId: tools.spanId, name: "shell", type: "TOOL", startTime: i * 1000 + 4 })
    return [root, accept, model, tools, tool]
  }).flat()
  const handle = render(<TraceView state={state(spans)} />)
  try {
    expect(handle.container.querySelectorAll(".trace-run-section")).toHaveLength(200)
    expect(handle.container.querySelectorAll(".trace-node-row")).toHaveLength(1000)
    expect(handle.container.querySelectorAll(".trace-gantt-turn")).toHaveLength(199)
    act(() => handle.root.render(<TraceView state={state(spans)} mode="simple" />))
    expect(handle.container.querySelectorAll(".trace-run-section")).toHaveLength(200)
    expect(handle.container.querySelectorAll(".trace-gantt-turn")).toHaveLength(199)
    act(() => handle.container.querySelector<HTMLElement>('.trace-gantt-bar[data-span-key="r199:model-199"]')!.click())
    expect(handle.container.querySelector(".trace-node-row.active")?.getAttribute("data-span-key")).toBe("r199:model-199")
    act(() => handle.root.render(<TraceView state={state(spans)} mode="dev" />))
    expect(handle.container.querySelectorAll(".trace-node-row")).toHaveLength(1000)
    expect(handle.container.querySelector(".trace-node-row.active")?.getAttribute("data-span-key")).toBe("r199:model-199")
  } finally { handle.unmount() }
}, { timeout: 15000 })
