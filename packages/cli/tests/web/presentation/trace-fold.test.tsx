/** 长文本折叠（FoldText）测试：阈值内直显、超长折叠、展开/收起交互；接入详情面板的两种模式验证。 */
/** @jsxImportSource react */

import { act } from "react"
import { afterAll, describe, expect, test } from "bun:test"

import type { TraceSpanEvent } from "../../../src/presentation-coordinator/contracts/trace"
import { FoldText } from "../../../src/web/presentation/trace/fold-text"
import { TraceDetail } from "../../../src/web/presentation/trace/trace-detail"
import { registerTestDom, render } from "./render"

const unregister = registerTestDom()
afterAll(unregister)

/** 构造最小 TraceSpanEvent。 */
function span(overrides: Partial<TraceSpanEvent> = {}): TraceSpanEvent {
  return {
    traceId: "t-1",
    spanId: "s-1",
    parentSpanId: null,
    name: "run.accept",
    type: "RUN",
    startTime: 1_000,
    endTime: 2_000,
    durationMs: 1_000,
    status: "SUCCESS",
    metadata: {},
    threadId: "thread-1",
    raw: { trace_id: "t-1" },
    ...overrides,
  }
}

/** 构造单节点树。 */
function node(spanValue: TraceSpanEvent) {
  return { span: spanValue, children: [] as ReadonlyArray<{ span: TraceSpanEvent; children: readonly never[] }> }
}

describe("FoldText", () => {
  test("文本不超过 limit 时直接展示，无折叠按钮", () => {
    const handle = render(<FoldText text="你好，世界" limit={200} />)
    try {
      expect(handle.container.textContent).toBe("你好，世界")
      expect(handle.container.querySelector(".trace-fold-btn")).toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("超过 limit 时折叠为前 limit 字 + 「展开 N 字」按钮", () => {
    const text = "字".repeat(300)
    const handle = render(<FoldText text={text} limit={200} />)
    try {
      const fold = handle.container.querySelector<HTMLElement>(".trace-fold")
      expect(fold?.textContent).toContain("字".repeat(200))
      const btn = handle.container.querySelector<HTMLButtonElement>(".trace-fold-btn")
      expect(btn).not.toBeNull()
      expect(btn?.textContent).toBe("展开 300 字")
      expect(btn?.getAttribute("aria-expanded")).toBe("false")
      // 折叠态不显示后 100 字。
      expect(fold?.textContent).not.toContain("字".repeat(201))
    } finally {
      handle.unmount()
    }
  })

  test("点击展开显示全文，再点收起回到折叠态", () => {
    const text = "字".repeat(300)
    const handle = render(<FoldText text={text} limit={200} />)
    try {
      const btn = handle.container.querySelector<HTMLButtonElement>(".trace-fold-btn")
      act(() => { btn!.click() })
      const fold = handle.container.querySelector(".trace-fold")
      // 展开态 textContent = 全文 + 「收起」按钮文案。
      expect(fold?.textContent).toContain(text)
      expect(btn?.textContent).toBe("收起")
      expect(btn?.getAttribute("aria-expanded")).toBe("true")
      act(() => { btn!.click() })
      expect(handle.container.querySelector(".trace-fold")?.textContent).toContain("字".repeat(200))
      expect(btn?.getAttribute("aria-expanded")).toBe("false")
    } finally {
      handle.unmount()
    }
  })

  test("代理对按 1 个字符计（emoji 不拆半）", () => {
    const text = "😀".repeat(300)
    const handle = render(<FoldText text={text} limit={200} />)
    try {
      expect(handle.container.querySelector<HTMLButtonElement>(".trace-fold-btn")?.textContent).toBe("展开 300 字")
    } finally {
      handle.unmount()
    }
  })
})

describe("开发者模式详情长字符串折叠", () => {
  test("metadata 超长 command 字符串折叠：默认 200 字，展开可见全文", () => {
    const longText = "x".repeat(500)
    const command = `StartRun(input=UserRunInput(message='${longText}'))`
    const detail = span({ metadata: { input: { command } } })
    const handle = render(<TraceDetail node={node(detail)} mode="dev" />)
    try {
      const btn = handle.container.querySelector<HTMLButtonElement>(".trace-kv .trace-fold-btn")
      expect(btn).not.toBeNull()
      // 折叠的是 metadata 区里对象 JSON 化后的长值：按钮字数匹配「展开 N 字」。
      expect(btn?.getAttribute("aria-expanded")).toBe("false")
      expect(btn?.textContent).toMatch(/^展开 \d+ 字$/)
      // metadata 区是最后一个 .trace-section 里的 .trace-kv。
      const sections = handle.container.querySelectorAll<HTMLElement>(".trace-section")
      const metaSection = sections[sections.length - 1]
      act(() => { btn!.click() })
      expect(metaSection?.textContent).toContain(command)
      // 展开后按钮变为「收起」。
      expect(metaSection?.querySelector<HTMLButtonElement>(".trace-fold-btn")?.textContent).toBe("收起")
    } finally {
      handle.unmount()
    }
  })

  test("raw JSON 超长字符串值折叠（pre.trace-json 内的字符串 token）", () => {
    const longText = "y".repeat(300)
    const detail = span({ raw: { trace_id: "t-1", output: { memo: longText } } })
    const handle = render(<TraceDetail node={node(detail)} mode="dev" />)
    try {
      const jsonPre = handle.container.querySelector<HTMLElement>("pre.trace-json")
      expect(jsonPre).not.toBeNull()
      const btn = jsonPre?.querySelector<HTMLButtonElement>(".trace-fold-btn")
      expect(btn).not.toBeNull()
      expect(btn?.textContent).toBe("展开 300 字")
      act(() => { btn!.click() })
      expect(jsonPre?.textContent).toContain(longText)
      // 折叠态按钮显示在字符串值后。
      expect(jsonPre?.querySelector(".trace-json-str")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("raw JSON 键名与短字符串不着色折叠（不出现折叠按钮）", () => {
    const detail = span({ raw: { trace_id: "t-1", name: "ok" } })
    const handle = render(<TraceDetail node={node(detail)} mode="dev" />)
    try {
      const jsonPre = handle.container.querySelector<HTMLElement>("pre.trace-json")
      // 无超长字符串 → 无按钮。
      expect(jsonPre?.querySelector(".trace-fold-btn")).toBeNull()
      // 语法着色仍生效。
      expect(jsonPre?.querySelector(".trace-json-key")).not.toBeNull()
      expect(jsonPre?.querySelector(".trace-json-str")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })
})

describe("简化模式详情长字符串折叠", () => {
  test("回复引语超过 500 字折叠，展开可见全文", () => {
    const longReply = "回答".repeat(600) // 600 × 2 字 = 1200。
    const llm = span({
      name: "qwen",
      type: "LLM",
      metadata: { model: "gpt-x" },
      raw: { trace_id: "t-1", output: { messages: [{ role: "assistant", content: longReply }] } },
    })
    const handle = render(<TraceDetail node={node(llm)} mode="simple" />)
    try {
      const quote = handle.container.querySelector<HTMLElement>(".trace-summary-quote")
      expect(quote).not.toBeNull()
      const btn = quote?.querySelector<HTMLButtonElement>(".trace-fold-btn")
      expect(btn).not.toBeNull()
      expect(btn?.textContent).toBe("展开 1200 字")
      act(() => { btn!.click() })
      expect(quote?.textContent).toContain(longReply)
    } finally {
      handle.unmount()
    }
  })

  test("回复引语不超过 500 字直接展示", () => {
    const shortReply = "好的，我来处理。"
    const llm = span({
      name: "qwen",
      type: "LLM",
      metadata: { model: "gpt-x" },
      raw: { trace_id: "t-1", output: { messages: [{ role: "assistant", content: shortReply }] } },
    })
    const handle = render(<TraceDetail node={node(llm)} mode="simple" />)
    try {
      const quote = handle.container.querySelector<HTMLElement>(".trace-summary-quote")
      expect(quote?.textContent).toContain(shortReply)
      expect(quote?.querySelector(".trace-fold-btn")).toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("关键信息表超长 Token 值折叠（500 字阈值）", () => {
    const longProfile = "模型配置详情" + "很长的上下文描述内容".repeat(100)
    const llm = span({
      name: "model-a",
      type: "LLM",
      metadata: { model: longProfile },
      raw: { trace_id: "t-1", output: { messages: [{ role: "assistant", content: "ok" }] } },
    })
    // simpleFacts 的「模型」行是超长字符串 → 折叠按钮出现。
    const handle = render(<TraceDetail node={node(llm)} mode="simple" />)
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-summary-quote, .trace-kv-row")
      expect(row).not.toBeNull()
      const btn = handle.container.querySelector<HTMLButtonElement>(".trace-fold-btn")
      expect(btn).not.toBeNull()
      expect(btn?.getAttribute("aria-expanded")).toBe("false")
      act(() => { btn!.click() })
      expect(handle.container.querySelector(".trace-kv")?.textContent).toContain(longProfile)
    } finally {
      handle.unmount()
    }
  })
})
