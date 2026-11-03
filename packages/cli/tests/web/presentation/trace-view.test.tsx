/** 轨迹视图（TraceView）测试：Gantt 条块、树层级/折叠、详情切换、空态。 */
/** @jsxImportSource react */

import { act, useState } from "react"
import { afterAll, describe, expect, test } from "bun:test"

import type { TraceSpanEvent } from "../../../src/presentation-coordinator/contracts/trace"
import { TraceView } from "../../../src/web/presentation/trace/trace-view"
import { buildTree, ganttLanes, simplifyTree, spansForThread } from "../../../src/web/presentation/trace/types"
import { displayColor, displayName, displayType, outcomeChipText, toolPayloadFailure } from "../../../src/web/presentation/trace/simple"
import { registerTestDom, render } from "./render"

const unregister = registerTestDom()
afterAll(unregister)

/** 构造最小 TraceSpanEvent。 */
function span(overrides: Partial<TraceSpanEvent> = {}): TraceSpanEvent {
  return {
    traceId: "t-1",
    spanId: "s-" + Math.random().toString(36).slice(2, 8),
    parentSpanId: null,
    name: "run.accept",
    type: "RUN",
    startTime: 1_000,
    endTime: 2_000,
    durationMs: 1_000,
    status: "SUCCESS",
    metadata: { input: { run_id: "r1" } },
    threadId: "thread-1",
    raw: { trace_id: "t-1" },
    ...overrides,
  }
}

/** 用当前会话窄接口渲染 TraceView；加载请求不属于展示层。 */
function mountTraceView(
  perThread: Record<string, readonly TraceSpanEvent[]>,
  options: {
    currentThreadId?: string | null
    traceLoadedThreads?: ReadonlySet<string>
    traceLoadingThread?: string | null
  } = {},
) {
  const threadId = options.currentThreadId ?? "thread-1"
  const handle = render(<TraceView state={{
    threadId, spans: spansForThread(perThread, threadId),
    loaded: options.traceLoadedThreads?.has(threadId) ?? false,
    loading: options.traceLoadingThread === threadId,
    hasAnyTrace: Object.keys(perThread).length > 0,
  }} />)
  return { handle }
}

describe("TraceView", () => {
  test("无 trace 数据时显示空态提示", () => {
    const { handle } = mountTraceView({})
    try {
      expect(handle.container.querySelector(".trace-view-empty")?.textContent).toContain("当前会话未开启链路追踪")
      expect(handle.container.querySelector(".trace-gantt")).toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("当前线程加载中显示加载空态", () => {
    const { handle } = mountTraceView({}, {
      currentThreadId: "thread-1",
      traceLoadedThreads: new Set(),
      traceLoadingThread: "thread-1",
    })
    try {
      expect(handle.container.querySelector(".trace-view-empty")?.textContent).toContain("正在加载该线程的历史轨迹")
    } finally {
      handle.unmount()
    }
  })

  test("trace 模式：当前线程已加载但无 span（找不到 trace 文件）显示线程空态", () => {
    const { handle } = mountTraceView({}, {
      currentThreadId: "thread-1",
      traceLoadedThreads: new Set(["thread-1"]),
      traceLoadingThread: null,
    })
    try {
      expect(handle.container.querySelector(".trace-view-empty")?.textContent).toContain("该线程暂无链路数据")
    } finally {
      handle.unmount()
    }
  })

  test("有 trace 但当前线程无数据时显示线程空态", () => {
    const { handle } = mountTraceView(
      { "thread-2": [span({ spanId: "sX" })] },
      { currentThreadId: "thread-1" },
    )
    try {
      expect(handle.container.querySelector(".trace-view-empty")?.textContent).toContain("该线程暂无链路数据")
    } finally {
      handle.unmount()
    }
  })

  test("有 span 时渲染 Gantt 条块（lane 节点 = run.accept 与 tool）与树", () => {
    const spans = [
      span({ spanId: "s1", name: "run.accept", type: "RUN", startTime: 100, endTime: 900, durationMs: 800 }),
      span({ spanId: "s2", name: "tool.call", type: "TOOL", parentSpanId: "s1", startTime: 200, endTime: 500, durationMs: 300 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      expect(handle.container.querySelector(".trace-gantt")).not.toBeNull()
      // 三行甘特：run.accept → Input lane、tool.call → Tools lane，都有条块。
      const bars = handle.container.querySelectorAll(".trace-gantt-bar")
      expect(bars.length).toBe(2)
      // lane 标记：0=Input，2=Tools。
      const lanes = [...bars].map(b => b.style.getPropertyValue("--lane"))
      expect(lanes).toContain("0")
      expect(lanes).toContain("2")
      // 树节点（不含根分组头）：run.accept 与 tool.call 两级。
      const nodes = handle.container.querySelectorAll(".trace-node-row")
      expect(nodes.length).toBe(2)
      // 子节点缩进深度标记。
      const depths = [...nodes].map(node => node.getAttribute("data-depth"))
      expect(depths).toContain("0")
      expect(depths).toContain("1")
    } finally {
      handle.unmount()
    }
  })

  test("点击树节点 → 详情面板展示该 span 的 metadata 与原始 JSON", () => {
    const spans = [
      span({ spanId: "s1", name: "run.accept", type: "RUN", startTime: 100, endTime: 900, durationMs: 800, metadata: { input: { command: "init" } } }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      const node = handle.container.querySelector<HTMLElement>(".trace-node-row")
      act(() => { node!.click() })
      const detail = handle.container.querySelector(".trace-detail")
      expect(detail).not.toBeNull()
      expect(detail?.textContent).toContain("run.accept")
      expect(detail?.textContent).toContain("init")
      // 原始 JSON 存在（>200 字折叠逻辑在 D6）。
      expect(detail?.querySelector("pre")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("dev 详情 metadata：对象值渲染进 JSON 盒子（着色+边框），标量值内联不套盒子", () => {
    const { handle } = mountTraceView({
      "thread-1": [
        span({
          spanId: "s1",
          name: "run.accept",
          type: "RUN",
          metadata: { input: { command: "init" }, status_code: 200, mode: "build" },
        }),
      ],
    })
    try {
      const node = handle.container.querySelector<HTMLElement>(".trace-node-row")
      act(() => { node!.click() })
      const detail = handle.container.querySelector(".trace-detail")
      expect(detail).not.toBeNull()
      // 对象值 input 进入 pre.trace-json 盒子，且带语法着色键。
      const box = detail?.querySelector(".trace-kv .trace-kv-row .trace-v pre.trace-json")
      expect(box).not.toBeNull()
      expect(box?.textContent).toContain('"command"')
      expect(box?.querySelector(".trace-json-key")).not.toBeNull()
      // 标量 status_code 内联，不套盒子。
      const rows = detail?.querySelectorAll(".trace-kv .trace-kv-row") ?? []
      const scalarRow = [...rows].find(r => r.querySelector(".trace-k")?.textContent === "status_code")
      expect(scalarRow?.querySelector("pre.trace-json")).toBeNull()
      expect(scalarRow?.textContent).toContain("200")
      // 只有 mode 值高亮（4.html renderKV 语义），input / status_code 不高亮。
      const modeRow = [...rows].find(r => r.querySelector(".trace-k")?.textContent === "mode")
      expect(modeRow?.querySelector(".trace-v")?.classList.contains("trace-v-hl")).toBe(true)
      expect(scalarRow?.querySelector(".trace-v")?.classList.contains("trace-v-hl")).toBe(false)
    } finally {
      handle.unmount()
    }
  })

  test("树节点折叠：点击折叠头收起子节点", () => {
    const spans = [
      span({ spanId: "root", name: "run.accept", type: "RUN", startTime: 100, endTime: 900, durationMs: 800 }),
      span({ spanId: "child", name: "tool.call", type: "TOOL", parentSpanId: "root", startTime: 200, endTime: 500, durationMs: 300 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      const rows = handle.container.querySelectorAll(".trace-node-row")
      expect(rows.length).toBe(2)
      const rootRow = handle.container.querySelector<HTMLElement>(".trace-node-row[data-depth='0'] .trace-toggle")
      act(() => { rootRow!.click() })
      // 折叠后只有 1 个节点行可见（子节点隐藏）。
      const visibleRows = handle.container.querySelectorAll(".trace-node-row:not(.trace-collapsed-hidden)")
      expect(visibleRows.length).toBe(1)
    } finally {
      handle.unmount()
    }
  })

  test("不同线程 trace 隔离：只渲染当前线程的 span", () => {
    const spansA = [span({ spanId: "sA", name: "run.accept", type: "RUN" })]
    const spansB = [span({ spanId: "sB", name: "run.accept", type: "RUN" })]
    const { handle } = mountTraceView({ "thread-1": spansA, "thread-2": spansB }, { currentThreadId: "thread-2" })
    try {
      const bars = handle.container.querySelectorAll(".trace-gantt-bar")
      expect(bars.length).toBe(1)
      expect(handle.container.querySelector(".trace-gantt-bar")?.getAttribute("data-span-key")).toBe("t-1:sB")
    } finally {
      handle.unmount()
    }
  })

  test("spansForThread：无 threadId 归属的会话级 span 在当前线程下仍可见（兜底合并）", () => {
    const threadSpan = span({ spanId: "sT", threadId: "thread-1", name: "context.project" })
    const sessionSpan = span({ spanId: "sS", threadId: null, name: "run.root", type: "RUN" })
    const merged = spansForThread({ "thread-1": [threadSpan], "": [sessionSpan] }, "thread-1")
    const ids = merged.map(item => item.spanId)
    expect(ids).toContain("sT")
    expect(ids).toContain("sS") // 会话级兜底可见
    // 去重：同 spanId 不重复。
    const dup = spansForThread({ "thread-1": [threadSpan], "": [threadSpan] }, "thread-1")
    expect(dup.filter(item => item.spanId === "sT")).toHaveLength(1)
  })

  test("spansForThread：switch 到无当前线程（null）时只展示会话级", () => {
    const sessionSpan = span({ spanId: "sS", threadId: null })
    const merged = spansForThread({ "thread-1": [span({ spanId: "sT" })], "": [sessionSpan] }, null)
    expect(merged.map(item => item.spanId)).toEqual(["sS"])
  })

  test("点击甘特条块 → 详情面板展示该 span 并在树中高亮对应行", () => {
    const spans = [
      span({ spanId: "s1", name: "run.accept", type: "RUN", startTime: 100, endTime: 900, durationMs: 800, metadata: { input: { command: "init" } } }),
      span({ spanId: "s2", name: "tool.call", type: "TOOL", parentSpanId: "s1", startTime: 200, endTime: 500, durationMs: 300 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      const bar = handle.container.querySelector<HTMLElement>(".trace-gantt-bar[data-span-key='t-1:s2']")
      expect(bar).not.toBeNull()
      act(() => { bar!.click() })
      // 详情面板展示 tool.call。
      const detail = handle.container.querySelector(".trace-detail")
      expect(detail).not.toBeNull()
      expect(detail?.textContent).toContain("tool.call")
      // 树中对应行高亮 active；甘特条与树行使用同一 data-span-key。
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:s2']")
      expect(row).not.toBeNull()
      expect(row?.classList.contains("active")).toBe(true)
      const otherRow = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:s1']")
      expect(otherRow?.classList.contains("active")).toBe(false)
    } finally {
      handle.unmount()
    }
  })

  test("多 trace：与 4.html 一致全部展示（三行甘特 + 轮次分界竖线），树并列两组", () => {
    const spans = [
      span({ traceId: "t-1", spanId: "a1", name: "run.accept", type: "RUN", startTime: 100, endTime: 900, durationMs: 800 }),
      span({ traceId: "t-2", spanId: "b1", name: "run.accept", type: "RUN", startTime: 5_000, endTime: 6_000, durationMs: 1_000 }),
      span({ traceId: "t-2", spanId: "b2", name: "tool.call", type: "TOOL", parentSpanId: "b1", startTime: 5_100, endTime: 5_500, durationMs: 400 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      // 没有轮次 tab 栏。
      expect(handle.container.querySelector(".trace-round-list")).toBeNull()
      expect(handle.container.querySelectorAll(".trace-round-item").length).toBe(0)
      // 三行甘特：不按 trace 分行，而是单轨等宽 + 轮次分界竖线。
      expect(handle.container.querySelector(".trace-gantt-plot")).not.toBeNull()
      expect(handle.container.querySelectorAll(".trace-gantt-lane").length).toBe(0)
      expect(handle.container.querySelector(".trace-gantt-turn")).not.toBeNull()
      // 全部 lane 节点的条块都在（a1、b1、b2）。
      expect(handle.container.querySelectorAll(".trace-gantt-bar").length).toBe(3)
      // 树：两组分组头并列，两个 trace 的节点都可见。
      expect(handle.container.querySelectorAll(".trace-run-section").length).toBe(2)
      expect(handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:a1']")).not.toBeNull()
      expect(handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-2:b1']")).not.toBeNull()
      expect(handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-2:b2']")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("甘特条块点击：目标所在 run 分组折叠时自动展开并定位到该行", () => {
    const spans = [
      span({ traceId: "t-1", spanId: "r1", name: "run.root", type: "RUN", startTime: 100, endTime: 9_000, durationMs: 8_900 }),
      span({ traceId: "t-1", spanId: "c1", name: "LLM", type: "LLM", parentSpanId: "r1", startTime: 200, endTime: 500, durationMs: 300 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      const targetRow = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:c1']")
      expect(targetRow).not.toBeNull()
      // 点击甘特条选中 c1（此时树中该行已有节点，展开祖先由 effect 完成后滚动定位）。
      act(() => {
        handle.container.querySelector<HTMLElement>(".trace-gantt-bar[data-span-key='t-1:c1']")?.click()
      })
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:c1']")
      expect(row?.classList.contains("active")).toBe(true)
    } finally {
      handle.unmount()
    }
  })

  test("run 头显示用户原话（来自 run.accept.command 的 message），不回退到 traceId", () => {
    const accept = span({
      spanId: "s1",
      name: "run.accept",
      type: "RUN",
      metadata: { input: { command: "StartRun(mode='build', input=UserRunInput(message='你好，介绍一下项目', requested_skill=None), requested_approval_mode='auto')" } },
    })
    const { handle } = mountTraceView({ "thread-1": [accept] })
    try {
      const label = handle.container.querySelector(".trace-run-label")
      expect(label?.textContent).toContain("你好，介绍一下项目")
      expect(label?.textContent).not.toContain("t-1")
      // 甘特单轮标题也显示用户原话。
      const title = handle.container.querySelector(".trace-gantt-title")?.textContent ?? ""
      expect(title).toContain("你好，介绍一下项目")
      expect(title).not.toContain("t-1")
    } finally {
      handle.unmount()
    }
  })

  test("无 user message 时 run 头回退到 traceId", () => {
    const accept = span({ spanId: "s1", name: "run.accept", metadata: { input: { run_id: "r1" } } })
    const { handle } = mountTraceView({ "thread-1": [accept] })
    try {
      const label = handle.container.querySelector(".trace-run-label")
      expect(label?.textContent).toContain("t-1")
    } finally {
      handle.unmount()
    }
  })

  test("run.root 行展示 mode 与 requested_approval_mode chips", () => {
    const root = span({
      spanId: "r1",
      name: "run.root",
      type: "RUN",
      parentSpanId: null,
      metadata: {},
    })
    const accept = span({
      spanId: "s1",
      name: "run.accept",
      type: "RUN",
      parentSpanId: "r1",
      metadata: { input: { command: "StartRun(mode='build', input=UserRunInput(message='hi'), requested_approval_mode='auto')" } },
    })
    const { handle } = mountTraceView({ "thread-1": [root, accept] })
    try {
      const rootRow = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:r1']")
      expect(rootRow).not.toBeNull()
      const chips = rootRow!.querySelectorAll(".trace-mode-chip")
      expect(chips.length).toBe(2)
      expect(chips[0]?.textContent).toBe("build")
      expect(chips[0]?.classList.contains("kind-mode")).toBe(true)
      expect(chips[1]?.textContent).toBe("auto")
      expect(chips[1]?.classList.contains("appr-auto")).toBe(true)
      // 非 run.root 的节点不显示 chips。
      const acceptRow = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:s1']")
      expect(acceptRow?.querySelectorAll(".trace-mode-chip").length ?? 0).toBe(0)
    } finally {
      handle.unmount()
    }
  })

  test("水平分隔条拖拽：甘特高度随 pointermove 变化，结束后恢复 cursor", () => {
    const spans = [span({ spanId: "s1", name: "run.accept", type: "RUN" })]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      const wrap = handle.container.querySelector<HTMLElement>(".trace-gantt-wrap")
      expect(wrap).not.toBeNull()
      const before = parseInt(wrap!.style.height, 10)
      expect(before).toBe(140)

      const handleEl = handle.container.querySelector<HTMLElement>(".trace-resize-horizontal")
      expect(handleEl).not.toBeNull()
      act(() => {
        handleEl!.dispatchEvent(new PointerEvent("pointerdown", { clientY: 100, bubbles: true }))
      })
      expect(document.body.classList.contains("trace-resizing-h")).toBe(true)
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientY: 140 }))
      })
      // 灵敏度 0.5：位移 40px → 高度 +20px。
      const after = parseInt(wrap!.style.height, 10)
      expect(after).toBe(160)
      act(() => {
        window.dispatchEvent(new PointerEvent("pointerup"))
      })
      expect(document.body.classList.contains("trace-resizing-h")).toBe(false)
    } finally {
      handle.unmount()
      document.body.classList.remove("trace-resizing-h", "trace-resizing-v")
    }
  })

  test("垂直分隔条拖拽：详情列宽随 pointermove 变化，边界跟随鼠标（向右拖变窄）、灵敏度 0.5", () => {
    const spans = [span({ spanId: "s1", name: "run.accept", type: "RUN" })]
    const { handle } = mountTraceView({ "thread-1": spans })
    try {
      const body = handle.container.querySelector<HTMLElement>(".trace-view-body")
      expect(body).not.toBeNull()
      expect(body!.style.gridTemplateColumns).toBe("minmax(0, 1fr) 9px 360px")

      const handleEl = handle.container.querySelector<HTMLElement>(".trace-resize-vertical")
      expect(handleEl).not.toBeNull()
      act(() => {
        handleEl!.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, bubbles: true }))
      })
      expect(document.body.classList.contains("trace-resizing-v")).toBe(true)
      // 向右拖 12px → 详情 360 - 12*0.5 = 354（边界跟随鼠标右移，详情变窄）。
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 512 }))
      })
      expect(body!.style.gridTemplateColumns).toBe("minmax(0, 1fr) 9px 354px")
      // 向左拖 24px（相对起点 500 → 476）→ 详情 360 + 24*0.5 = 372（边界左移，详情变宽）。
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 476 }))
      })
      expect(body!.style.gridTemplateColumns).toBe("minmax(0, 1fr) 9px 372px")
      act(() => {
        window.dispatchEvent(new PointerEvent("pointerup"))
      })
      expect(document.body.classList.contains("trace-resizing-v")).toBe(false)
    } finally {
      handle.unmount()
      document.body.classList.remove("trace-resizing-h", "trace-resizing-v")
    }
  })
})

describe("4.html 对齐：tools 聚合节点 / 失败标记（display 系列）", () => {
  /** LangGraph tools 聚合节点：type=NODE、name=tools，工具名藏在 input（tool_call 数组）。 */
  function toolsSpan(overrides: Partial<TraceSpanEvent> = {}): TraceSpanEvent {
    return span({
      spanId: "tg1",
      name: "tools",
      type: "NODE",
      metadata: {
        input: [
          { name: "bash", args: { command: "ls" }, id: "id-1", type: "tool_call" },
          { name: "read_file", args: { file_path: "/a.txt" }, id: "id-2", type: "tool_call" },
        ],
      },
      ...overrides,
    })
  }

  test("displayType/displayColor/displayName：tools 聚合 NODE → TOOL 色与真实工具名", () => {
    const node = { span: toolsSpan(), children: [] as const }
    expect(displayType(node.span)).toBe("TOOL")
    expect(displayColor(node.span)).toBe("var(--trace-tool)") // TOOL 类型色由主题提供。
    expect(displayName(node)).toBe("bash、read_file")
  })

  test("树中 tools 聚合节点：badge 显示 TOOL、行名显示真实工具名", () => {
    const { handle } = mountTraceView({ "thread-1": [toolsSpan()] })
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:tg1']")
      expect(row).not.toBeNull()
      expect(row?.querySelector(".trace-badge")?.textContent).toBe("TOOL")
      expect(row?.querySelector(".trace-name")?.textContent).toBe("bash、read_file")
    } finally {
      handle.unmount()
    }
  })

  test("失败工具（output ok:false）→ 行内 outcome chip、状态点 failed", () => {
    const failed = toolsSpan({
      metadata: {
        input: [
          { name: "read_file", args: { file_path: "/a" }, id: "id-1", type: "tool_call" },
        ],
      },
      raw: {
        trace_id: "t-1",
        output: { messages: [{ content: '{"ok": false, "error": {"code": "E_PERMISSION"}}', role: "tool", tool_call_id: "id-1" }] },
      },
    })
    const { handle } = mountTraceView({ "thread-1": [failed] })
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:tg1']")
      const chip = row?.querySelector(".trace-outcome-chip")
      expect(chip?.textContent).toBe("E_PERMISSION")
      expect(row?.querySelector(".trace-status-dot")?.getAttribute("data-status")).toBe("failed")
      // 单位元断言：payload 失败判定与文本提取。
      expect(toolPayloadFailure(failed)).toEqual({ code: "E_PERMISSION" })
      expect(outcomeChipText(failed)).toBe("E_PERMISSION")
    } finally {
      handle.unmount()
    }
  })

  test("甘特条：失败工具变红色（--danger），title 含失败文案", () => {
    const failed = toolsSpan({
      startTime: 1_000,
      endTime: 1_500,
      durationMs: 500,
      raw: {
        trace_id: "t-1",
        output: { messages: [{ content: '{"ok": false, "error": {"code": "E_BAD"}}', role: "tool", tool_call_id: "id-1" }] },
      },
    })
    const { handle } = mountTraceView({ "thread-1": [failed] })
    try {
      const bar = handle.container.querySelector<HTMLElement>(".trace-gantt-bar[data-span-key='t-1:tg1']")
      expect(bar).not.toBeNull()
      expect(bar!.style.backgroundColor).toBe("var(--danger)")
      expect(bar!.title).toContain("失败 · E_BAD")
    } finally {
      handle.unmount()
    }
  })

  test("dev 详情：失败工具 meta 加 is-failed 类并显示失败码", () => {
    const failed = toolsSpan({
      durationMs: 300,
      raw: {
        trace_id: "t-1",
        output: { messages: [{ content: '{"ok": false, "error": {"code": "E_TIME"}}', role: "tool", tool_call_id: "id-1" }] },
      },
    })
    const { handle } = mountTraceView({ "thread-1": [failed] })
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:tg1']")
      act(() => { row!.click() })
      const meta = handle.container.querySelector<HTMLElement>(".trace-detail-meta")
      expect(meta?.classList.contains("is-failed")).toBe(true)
      expect(meta?.textContent).toContain("失败 · E_TIME")
      // h2 标题用真实工具名。
      const title = handle.container.querySelector<HTMLElement>(".trace-detail-title")
      expect(title?.textContent).toContain("bash、read_file")
    } finally {
      handle.unmount()
    }
  })

  test("成功工具（output ok:true）无 outcome chip，状态点走原 status", () => {
    const ok = toolsSpan({
      status: "SUCCESS",
      raw: {
        trace_id: "t-1",
        output: { messages: [{ content: "文件内容…", role: "tool", tool_call_id: "id-1" }] },
      },
    })
    const { handle } = mountTraceView({ "thread-1": [ok] })
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row[data-span-key='t-1:tg1']")
      expect(row?.querySelector(".trace-outcome-chip")).toBeNull()
      expect(row?.querySelector(".trace-status-dot")?.getAttribute("data-status")).toBe("success")
      expect(toolPayloadFailure(ok)).toBeNull()
    } finally {
      handle.unmount()
    }
  })
})

describe("ganttLanes（4.html 三行 lane 分配）", () => {
  test("TYPE/NAME → lane：TOOL→2、LLM/model→1、run.accept/INTERACTION→0、其余不画", () => {
    const spans = [
      span({ spanId: "accept", name: "run.accept", type: "RUN" }),
      span({ spanId: "llm", name: "model", type: "NODE", parentSpanId: "accept" }),
      span({ spanId: "tool", name: "tool.call", type: "TOOL", parentSpanId: "llm" }),
      span({ spanId: "ctx", name: "context.project", type: "CONTEXT", parentSpanId: "tool" }),
    ]
    const lanes = ganttLanes(buildTree(spans))
    expect(lanes.get("t-1:accept")).toBe(0)
    expect(lanes.get("t-1:llm")).toBe(1)
    expect(lanes.get("t-1:tool")).toBe(2)
    // CONTEXT 无 lane 不画；LLM 与 tools 父子不同 lane 都要画。
    expect(lanes.has("t-1:ctx")).toBe(false)
  })

  test("父节点与子节点同 lane 时只画子节点（避免重叠）", () => {
    // run.accept（lane 0）下直接挂 INTERACTION（lane 0）：父不画、子画。
    const spans = [
      span({ spanId: "accept", name: "run.accept", type: "RUN" }),
      span({ spanId: "interact", name: "ask_user", type: "INTERACTION", parentSpanId: "accept" }),
    ]
    const lanes = ganttLanes(buildTree(spans))
    expect(lanes.has("t-1:accept")).toBe(false)
    expect(lanes.get("t-1:interact")).toBe(0)
  })

  test("POLICY 节点及其子树不画条", () => {
    const spans = [
      span({ spanId: "accept", name: "run.accept", type: "RUN" }),
      span({ spanId: "policy", name: "policy.evaluate", type: "POLICY", parentSpanId: "accept" }),
      span({ spanId: "llm", name: "model", type: "NODE", parentSpanId: "policy" }),
    ]
    const lanes = ganttLanes(buildTree(spans))
    expect(lanes.has("t-1:policy")).toBe(false)
    expect(lanes.has("t-1:llm")).toBe(false)
    expect(lanes.get("t-1:accept")).toBe(0)
  })

  test("simplifyTree 后只画关键节点（CONTEXT 与 model 外壳不出现在三行甘特，LLM 提升后仍画）", () => {
    const spans = [
      span({ spanId: "accept", name: "run.accept", type: "RUN" }),
      span({ spanId: "agent", name: "agent", type: "AGENT", parentSpanId: "accept" }),
      span({ spanId: "ctx", name: "context.project", type: "CONTEXT", parentSpanId: "agent" }),
      span({ spanId: "shell", name: "model", type: "NODE", parentSpanId: "ctx" }),
      span({ spanId: "llm", name: "qwen3p8-27b-256k", type: "LLM", parentSpanId: "shell" }),
    ]
    const simple = simplifyTree(buildTree(spans))
    const lanes = ganttLanes(simple)
    // CONTEXT 被提升移除、model 外壳去掉 LLM 提升：accept(0) 画；agent 无 lane；LLM 提升到 agent 下画 lane 1。
    expect(lanes.get("t-1:accept")).toBe(0)
    expect(lanes.get("t-1:llm")).toBe(1)
    expect(lanes.has("t-1:ctx")).toBe(false)
    expect(lanes.has("t-1:shell")).toBe(false)
  })
})
