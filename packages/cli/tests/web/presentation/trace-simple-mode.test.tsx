/** 简化模式（simple）测试：树化简、自然语言概括、顶栏切换、甘特/树/详情在 simple 下的行为。 */
/** @jsxImportSource react */

import { act } from "react"
import { afterAll, describe, expect, test } from "bun:test"

import type { TraceSpanEvent } from "../../../src/presentation-coordinator/contracts/trace"
import { TraceView } from "../../../src/web/presentation/trace/trace-view"
import { buildTree, spansForThread, isModelShell, isNoiseNode, simplifyTree, type TraceTreeNode } from "../../../src/web/presentation/trace/types"
import { replyQuote, simpleFacts, summarizeStep } from "../../../src/web/presentation/trace/simple"
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

/** 把树拍平收集（调试断言）。 */
function collectNodes(nodes: readonly TraceTreeNode[]): TraceSpanEvent[] {
  return nodes.flatMap(node => [node.span, ...collectNodes(node.children)])
}

function mountTraceView(
  perThread: Record<string, readonly TraceSpanEvent[]>,
  options: { currentThreadId?: string | null; mode?: "dev" | "simple" } = {},
) {
  const threadId = options.currentThreadId ?? "thread-1"
  const handle = render(<TraceView state={{
    threadId, spans: spansForThread(perThread, threadId), loading: false,
    loaded: true, hasAnyTrace: Object.keys(perThread).length > 0,
  }} mode={options.mode ?? "dev"} />)
  return { handle }
}

describe("simplifyTree / isNoiseNode", () => {
  test("噪声节点（CONTEXT/DB/POLICY/INTERACTION/middleware）被识别", () => {
    expect(isNoiseNode({ span: span({ type: "CONTEXT" }), children: [] })).toBe(true)
    expect(isNoiseNode({ span: span({ type: "DB" }), children: [] })).toBe(true)
    expect(isNoiseNode({ span: span({ type: "POLICY" }), children: [] })).toBe(true)
    expect(isNoiseNode({ span: span({ type: "INTERACTION" }), children: [] })).toBe(true)
    expect(isNoiseNode({ span: span({ name: "policy.middleware.check" }), children: [] })).toBe(true)
    expect(isNoiseNode({ span: span({ type: "LLM" }), children: [] })).toBe(false)
    expect(isNoiseNode({ span: span({ type: "RUN" }), children: [] })).toBe(false)
  })

  test("simplifyTree 丢弃噪声节点并把子节点提升到最近的可见父", () => {
    const root = span({ spanId: "r1", name: "run.root", type: "RUN" })
    const agent = span({ spanId: "a1", name: "agent", type: "AGENT", parentSpanId: "r1" })
    const ctx = span({ spanId: "c1", name: "context.project", type: "CONTEXT", parentSpanId: "a1" })
    const llm = span({ spanId: "l1", name: "LLM", type: "LLM", parentSpanId: "c1" })
    const tool = span({ spanId: "t1", name: "tools", type: "TOOL", parentSpanId: "l1" })

    const rawTrees = buildTree([root, agent, ctx, llm, tool])
    const simple = simplifyTree(rawTrees)

    const names = collectNodes(simple).map(s => s.spanId)
    expect(names).toEqual(["r1", "a1", "l1", "t1"]) // c1 (CONTEXT) 被丢弃，llm/tool 提升
    // 层级：root → agent → llm → tool。
    const rootNode = simple[0]!
    expect(rootNode.children[0]?.span.spanId).toBe("a1")
    expect(rootNode.children[0]?.children[0]?.span.spanId).toBe("l1")
    expect(rootNode.children[0]?.children[0]?.children[0]?.span.spanId).toBe("t1")
  })
})

describe("isModelShell / simplifyTree 的 model NODE 外壳提升", () => {
  test("isModelShell 识别 type=NODE 且 name=model 的 LangGraph 外壳节点；非 shell 返回 false", () => {
    expect(isModelShell({ span: span({ name: "model", type: "NODE" }), children: [] })).toBe(true)
    expect(isModelShell({ span: span({ name: "model", type: "LLM" }), children: [] })).toBe(false)
    expect(isModelShell({ span: span({ name: "tools", type: "NODE" }), children: [] })).toBe(false)
    expect(isModelShell({ span: span({ name: "agent", type: "AGENT" }), children: [] })).toBe(false)
  })

  test("simplifyTree 去掉 model NODE 外壳，LLM 提升一级（对齐 trace_viewer.py simplifyTree 注释）", () => {
    const root = span({ spanId: "r1", name: "run.root", type: "RUN" })
    const modelNode = span({ spanId: "m1", name: "model", type: "NODE", parentSpanId: "r1", durationMs: null, metadata: { node_id: "model" } })
    const llm = span({ spanId: "l1", name: "qwen3p8-27b-256k", type: "LLM", parentSpanId: "m1", metadata: { model: "qwen3p8-27b-256k" } })
    const tool = span({ spanId: "t1", name: "tools", type: "TOOL", parentSpanId: "l1" })

    const simple = simplifyTree(buildTree([root, modelNode, llm, tool]))
    // 树节点不含 m1（model NODE），LLM 提升一级：root → llm → tool。
    expect(collectNodes(simple).map(s => s.spanId)).toEqual(["r1", "l1", "t1"])
    const rootNode = simple[0]!
    expect(rootNode.children[0]?.span.spanId).toBe("l1")
    expect(rootNode.children[0]?.children[0]?.span.spanId).toBe("t1")
  })

  test("model NODE 本身也有非 LLM 子节点时，外壳去掉后其它子节点一并提升", () => {
    const modelNode = span({ spanId: "m1", name: "model", type: "NODE" })
    const llm = span({ spanId: "l1", name: "qwen3p8-27b-256k", type: "LLM", parentSpanId: "m1", metadata: { model: "qwen3p8-27b-256k" } })
    const embedding = span({ spanId: "e1", name: "embed", type: "EMBEDDING", parentSpanId: "m1" })

    const simple = simplifyTree(buildTree([modelNode, llm, embedding]))
    expect(collectNodes(simple).map(s => s.spanId)).toEqual(["l1", "e1"])
  })
})

describe("simplifyTree 的 tools NODE 与 TOOL 子节点合并", () => {
  test("tools NODE（name=tools）丢弃 type=TOOL 子节点，避免工具行重复（对齐 4.html 每回合单个 TOOL 行）", () => {
    // 真实 SDK 日志：tools NODE 下挂 ask_user [TOOL] + POLICY；简化模式应只剩 tools 行（工具名由 displayName 从 input.tool_calls 取）。
    const root = span({ spanId: "r1", name: "run.root", type: "RUN" })
    const agent = span({ spanId: "a1", name: "za38", type: "AGENT", parentSpanId: "r1" })
    const tools = span({
      spanId: "tg1",
      name: "tools",
      type: "NODE",
      parentSpanId: "a1",
      metadata: { input: [{ name: "ask_user", args: {}, id: "call-1", type: "tool_call" }] },
    })
    const askUser = span({ spanId: "au1", name: "ask_user", type: "TOOL", parentSpanId: "tg1" })
    const policy = span({ spanId: "p1", name: "policy.evaluate", type: "POLICY", parentSpanId: "tg1" })
    const llm = span({ spanId: "l1", name: "qwen3p8-27b-256k", type: "LLM", parentSpanId: "a1" })

    const simple = simplifyTree(buildTree([root, agent, tools, askUser, policy, llm]))
    const ids = collectNodes(simple).map(s => s.spanId)
    expect(ids).toEqual(["r1", "a1", "tg1", "l1"])
    // tools NODE 保留、其 TOOL/POLICY 子节点被合并移除；LLM 兄弟保留。
    const toolsNode = simple[0]!.children[0]!.children[0]!
    expect(toolsNode.span.name).toBe("tools")
    expect(toolsNode.children.length).toBe(0)
  })

  test("tools NODE 的非 TOOL 子节点（如 EMBEDDING）仍保留", () => {
    const agent = span({ spanId: "a1", name: "za38", type: "AGENT" })
    const tools = span({ spanId: "tg1", name: "tools", type: "NODE", parentSpanId: "a1", metadata: { input: [{ name: "bash", args: {}, id: "c1", type: "tool_call" }] } })
    const embed = span({ spanId: "e1", name: "embed", type: "EMBEDDING", parentSpanId: "tg1" })
    const askUser = span({ spanId: "au1", name: "ask_user", type: "TOOL", parentSpanId: "tg1" })

    const simple = simplifyTree(buildTree([agent, tools, embed, askUser]))
    expect(collectNodes(simple).map(s => s.spanId)).toEqual(["a1", "tg1", "e1"])
  })
})

describe("summarizeStep", () => {
  test("run.root 概括提到模式与审批", () => {
    const root = span({
      spanId: "r1",
      name: "run.root",
      type: "RUN",
      metadata: { input: { command: "StartRun(mode='build', requested_approval_mode='auto', input=UserRunInput(message='hi'))" } },
    })
    const s = summarizeStep({ span: root, children: [] })
    expect(s).toContain("这是这一轮运行的起点")
    expect(s).toContain("build")
    expect(s).toContain("auto")
  })

  test("run.accept 概括提到用户原话", () => {
    const accept = span({
      spanId: "s1",
      name: "run.accept",
      type: "RUN",
      metadata: { input: { command: "StartRun(mode='build', input=UserRunInput(message='你好，介绍下项目', requested_skill=None), requested_approval_mode='auto')" } },
    })
    const s = summarizeStep({ span: accept, children: [] })
    expect(s).toContain("接收了用户的这次请求")
    expect(s).toContain("你好，介绍下项目")
  })

  test("LLM 概括提到模型名与工具调用", () => {
    const llm = span({
      spanId: "l1",
      name: "model-a",
      type: "LLM",
      metadata: { model: "gpt-x", custom_metadata: { token_usage: { input_tokens: 10, output_tokens: 8 } } },
      raw: {
        trace_id: "t-1",
        output: {
          messages: [
            { role: "assistant", content: "我来调用工具" },
          ],
        },
      },
    })
    const s = summarizeStep({ span: llm, children: [] })
    expect(s).toContain("调用了模型 gpt-x")
  })

  test("TOOL 概括提到工具名", () => {
    const tool = span({ spanId: "t1", name: "write_file", type: "TOOL", metadata: { tool_name: "write_file" } })
    const s = summarizeStep({ span: tool, children: [] })
    expect(s).toContain("执行了工具 write_file")
  })

  test("LLM 回复引语还原 Python repr 转义，不残留多余反斜杠", () => {
    // raw.output 是已 JSON.parse 的 JS 字符串，repr 转义为单层反斜杠：
    // \\' 源码字面量 → JS 值 \'（repr 里的字面单引号）；
    // \\\\ 源码字面量 → JS 值 \\（repr 里的字面反斜杠）；
    // \\t 源码字面量 → JS 值 \t（repr 里的制表符）。
    // usableReply 应全部还原：\'→'、\\→\、\t→tab，不再出现未还原的 `\`。
    // 注意：反斜杠路径必须用 \\ 表示字面反斜杠（如 C:\\dir\\file.txt），
    // 不能用 \tmp 这种会被 repr 当作制表符转义的写法。
    const llm = span({
      spanId: "l2",
      name: "model-a",
      type: "LLM",
      metadata: { model: "gpt-x" },
      raw: {
        trace_id: "t-1",
        output: "AIMessage(content='他说：\\'好用\\'，绝对路径C:\\\\dir\\\\file.txt，\\t制表符，结束。')",
      },
    })
    const s = summarizeStep({ span: llm, children: [] })
    expect(s).toContain("模型直接给出了回复")
    const quote = replyQuote({ span: llm, children: [] })
    // \\' → ' ；\\\\ → \\；\\t → 制表符。不出现未还原的转义反斜杠。
    expect(quote).toContain("他说：'好用'，绝对路径C:\\dir\\file.txt")
    // \\t 源码字面量 → 值 \t，被还原为真正的制表符。
    expect(quote.includes("\t")).toBe(true)
    // 还原后不再残留字面 \t、\'、\\ 形式的转义序列。
    expect(quote.includes("\\t")).toBe(false)
    expect(quote.includes("\\'")).toBe(false)
  })


  test("失败节点概括带失败提示", () => {
    const tool = span({ spanId: "t1", name: "read_file", type: "TOOL", status: "FAILED", metadata: { tool_name: "read_file" } })
    const s = summarizeStep({ span: tool, children: [] })
    expect(s).toContain("这一步失败了")
  })
})

describe("summarizeStep/simpleFacts 真实合并形状", () => {
  test("LLM 节点：概括提模型名、facts 含耗时/Token/首字（对齐真实 SDK LLM end 日志）", () => {
    const llm = span({
      spanId: "l1",
      name: "qwen3p8",
      type: "LLM",
      durationMs: 5_823,
      metadata: { model: "qwen3p8-27b-256k", first_token_time: 2_130, custom_metadata: { token_usage: { input_tokens: 1_116_360, output_tokens: 6_835, cached_tokens: 12_288 } } },
    })
    const s = summarizeStep({ span: llm, children: [] })
    expect(s).toContain("调用了模型 qwen3p8-27b-256k")
    const facts = simpleFacts({ span: llm, children: [] })
    const map = new Map(facts)
    expect(map.get("模型")).toBe("qwen3p8-27b-256k")
    expect(map.get("耗时")).toContain("5.82 s")
    expect(map.get("Token")).toContain("输入 1116360")
    expect(map.get("Token")).toContain("输出 6835")
    expect(map.get("首字")).toContain("2.13 s")
  })

  test("model NODE 节点：children 中 LLM 提供模型名与 Token（真实 SDK model 节点无 metadata.model）", () => {
    const modelNode = span({
      spanId: "m1",
      name: "model",
      type: "NODE",
      durationMs: null, // NODE 自身可能无 duration，走子树回退。
      metadata: { node_id: "model" },
    })
    const llm = span({
      spanId: "l1",
      name: "qwen3p8-27b-256k",
      type: "LLM",
      parentSpanId: "m1",
      durationMs: 5_823,
      metadata: { model: "qwen3p8-27b-256k", first_token_time: 2_130, custom_metadata: { token_usage: { input_tokens: 100, output_tokens: 50 } } },
    })
    const node = { span: modelNode, children: [{ span: llm, children: [] }] }
    const s = summarizeStep(node)
    expect(s).toContain("调用了模型 qwen3p8-27b-256k")
    const facts = new Map(simpleFacts(node))
    expect(facts.get("模型")).toBe("qwen3p8-27b-256k")
    expect(facts.get("耗时")).toContain("5.82 s") // 子树回退到 LLM 耗时。
    expect(facts.get("Token")).toContain("输入 100")
  })

  test("execute 工具：概括含命令结果描述（命令成功 + 退出码 + 输出摘录）", () => {
    const tool = span({
      spanId: "t1",
      name: "execute",
      type: "TOOL",
      durationMs: 268,
      metadata: { tool_name: "execute" },
      raw: {
        trace_id: "t-1",
        output: "[Command succeeded with exit code 0]\nls: cannot access 'D:/result.txt': No such file or directory\n```bash\nls D:/result.txt\n```\n[Command succeeded with exit code 0]",
      },
    })
    const s = summarizeStep({ span: tool, children: [] })
    expect(s).toContain("执行了工具 execute")
    expect(s).toContain("命令成功，退出码 0")
    expect(s).toContain("D:/result.txt")
    const facts = new Map(simpleFacts({ span: tool, children: [] }))
    expect(facts.get("耗时")).toContain("268.0 ms")
  })

  test("run.root 耗时回退子树（自身无 duration 时取最大子跨度）", () => {
    const root = span({ spanId: "r1", name: "run.root", type: "RUN", durationMs: null })
    const child = span({ spanId: "c1", name: "run.complete", type: "RUN", parentSpanId: "r1", durationMs: 5_000 })
    const node = { span: root, children: [{ span: child, children: [] }] }
    const facts = new Map(simpleFacts(node, { mode: "build", requestedApprovalMode: "auto" }))
    expect(facts.get("耗时")).toContain("5.00 s")
    expect(facts.get("模式")).toBe("build")
    expect(facts.get("审批")).toBe("auto")
  })
})

describe("TraceView simple 模式", () => {
  test("simple 模式下甘特条块数与树节点只含关键节点", () => {
    const spans = [
      span({ spanId: "r1", name: "run.root", type: "RUN", startTime: 0, endTime: 9_000, durationMs: 9_000 }),
      span({ spanId: "a1", name: "agent", type: "AGENT", parentSpanId: "r1", startTime: 100, endTime: 8_000, durationMs: 7_900 }),
      span({ spanId: "c1", name: "context.project", type: "CONTEXT", parentSpanId: "a1", startTime: 200, endTime: 400, durationMs: 200 }),
      span({ spanId: "l1", name: "LLM", type: "LLM", parentSpanId: "c1", startTime: 300, endTime: 1_000, durationMs: 700 }),
      span({ spanId: "t1", name: "tools", type: "TOOL", parentSpanId: "l1", startTime: 1_100, endTime: 1_500, durationMs: 400 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans }, { mode: "simple" })
    try {
      // 甘特条块 = 三行甘特 lane 节点（run.accept/LLM/tools 等；丢 CONTEXT/run.root 无 lane）→ 2 个。
      // 树化简后：r1 → a1 → l1 → t1，l1 与 t1 父子不在同一 lane，都有条块；r1/a1 无 lane 不画。
      const bars = handle.container.querySelectorAll(".trace-gantt-bar")
      expect(bars.length).toBe(2)
      const barKeys = [...bars].map(b => b.getAttribute("data-span-key"))
      expect(barKeys).not.toContain("t-1:c1")
      // 树节点：4 个关键节点。
      const rows = handle.container.querySelectorAll(".trace-node-row")
      expect(rows.length).toBe(4)
      // run 头显示关键节点计数。
      const meta = handle.container.querySelector(".trace-run-meta")?.textContent ?? ""
      expect(meta).toContain("4 个关键节点")
      // 甘特标题也显示关键节点数。
      const title = handle.container.querySelector(".trace-gantt-title")?.textContent ?? ""
      expect(title).toContain("2 个事件")
    } finally {
      handle.unmount()
    }
  })

  test("dev 模式不受影响：甘特条块与树显示全部 span", () => {
    const spans = [
      span({ spanId: "r1", name: "run.root", type: "RUN", startTime: 0, endTime: 9_000, durationMs: 9_000 }),
      span({ spanId: "a1", name: "agent", type: "AGENT", parentSpanId: "r1", startTime: 100, endTime: 8_000, durationMs: 7_900 }),
      span({ spanId: "c1", name: "context.project", type: "CONTEXT", parentSpanId: "a1", startTime: 200, endTime: 400, durationMs: 200 }),
      span({ spanId: "l1", name: "LLM", type: "LLM", parentSpanId: "c1", startTime: 300, endTime: 1_000, durationMs: 700 }),
    ]
    const { handle } = mountTraceView({ "thread-1": spans }, { mode: "dev" })
    try {
      // 三行甘特只画 lane 节点：LLM → Model lane（1 个），其余无 lane 不画条。
      expect(handle.container.querySelectorAll(".trace-gantt-bar").length).toBe(1)
      expect(handle.container.querySelectorAll(".trace-node-row").length).toBe(4)
    } finally {
      handle.unmount()
    }
  })

  test("simple 模式点击节点 → 详情显示自然语言概括而非原始 JSON", () => {
    const llm = span({
      spanId: "l1",
      name: "model-a",
      type: "LLM",
      metadata: { model: "gpt-x" },
    })
    const { handle } = mountTraceView({ "thread-1": [llm] }, { mode: "simple" })
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row")
      act(() => { row!.click() })
      const detail = handle.container.querySelector(".trace-detail")
      expect(detail).not.toBeNull()
      expect(detail?.querySelector(".trace-summary-lead")?.textContent).toContain("调用了模型 gpt-x")
      // 简化模式不显示原始 JSON。
      expect(detail?.querySelector("pre.trace-json")).toBeNull()
      expect(detail?.querySelector(".trace-kv-row")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })

  test("dev 模式点击节点 → 详情仍为完整原始 JSON", () => {
    const llm = span({
      spanId: "l1",
      name: "model-a",
      type: "LLM",
      metadata: { model: "gpt-x" },
    })
    const { handle } = mountTraceView({ "thread-1": [llm] }, { mode: "dev" })
    try {
      const row = handle.container.querySelector<HTMLElement>(".trace-node-row")
      act(() => { row!.click() })
      const detail = handle.container.querySelector(".trace-detail")
      expect(detail?.querySelector("pre.trace-json")).not.toBeNull()
    } finally {
      handle.unmount()
    }
  })
})
