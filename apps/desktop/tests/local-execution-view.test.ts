/** HC-222 Part A：本机执行视图的工具细节合并、色调映射与思考条目归并测试。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyLocalExecutionUpdate,
  describePermissionRequest,
  emptyLocalExecutionView,
  projectLocalExecution,
} from "../src/renderer/features/session/local-execution-view.ts"
import type { LocalExecutionPermission, LocalExecutionTool } from "../src/local-execution-host.ts"

const author = { id: "u-1", displayName: "我" }

const accepted = (text = "请处理") => applyLocalExecutionUpdate(emptyLocalExecutionView, {
  kind: "accepted", turnId: "t-1", text, author,
})

const tool = (id: string, overrides: Partial<LocalExecutionTool> = {}): LocalExecutionTool => ({ id, ...overrides })

test("工具更新合并：后到的状态+输出不丢先到参数", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "tool", turnId: "t-1", tool: tool("c-1", { title: "编辑", kind: "edit", input: "参数", status: "in_progress" }) })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("c-1", { status: "completed", output: "完成" }) })
  const entry = state.entries.find(item => item.id === "local-execution:t-1:tool:c-1")
  assert.equal(entry?.kind, "tool")
  if (entry?.kind !== "tool") return
  assert.equal(entry.status, "completed")
  assert.equal(entry.detail?.argumentsText, "参数")
  assert.equal(entry.detail?.outputText, "完成")
  assert.equal(entry.detail?.copyText, "完成")
})

test("kind 映射色调：读类 read，写类 write，缺省 neutral", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "tool", turnId: "t-1", tool: tool("r-1", { kind: "search" }) })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("w-1", { kind: "move" }) })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("n-1", {}) })
  const tone = (id: string) => state.entries.find(e => e.id === `local-execution:t-1:tool:${id}`)
  assert.equal(tone("r-1")?.kind === "tool" && tone("r-1")?.tone === "read", true)
  assert.equal(tone("w-1")?.kind === "tool" && tone("w-1")?.tone === "write", true)
  assert.equal(tone("n-1")?.kind === "tool" && tone("n-1")?.tone === "neutral", true)
})

test("diff 转成增删行块", () => {
  const state = applyLocalExecutionUpdate(accepted(), {
    kind: "tool", turnId: "t-1",
    tool: tool("d-1", { diffs: [{ path: "a.ts", oldText: "x\ny", newText: "z" }] }),
  })
  const entry = state.entries.at(-1)
  if (entry?.kind !== "tool") return assert.fail("expected tool")
  assert.deepEqual(entry.detail?.blocks, [{
    kind: "diff", path: "a.ts",
    rows: [{ kind: "remove", text: "x" }, { kind: "remove", text: "y" }, { kind: "add", text: "z" }],
  }])
})

test("思考片段归并：连续合并同一条目，工具后出现新条目", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "thought", turnId: "t-1", text: "先想" })
  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "再想" })
  let reasoning = state.entries.at(-1)
  if (reasoning?.kind !== "reasoning") return assert.fail("expected reasoning")
  assert.equal(reasoning.text, "先想再想")
  assert.equal(reasoning.active, true)
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("x-1") })
  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "工具后的思考" })
  reasoning = state.entries.at(-1)
  if (reasoning?.kind !== "reasoning") return assert.fail("expected new reasoning")
  assert.equal(reasoning.id, "local-execution:t-1:reasoning:1")
  assert.equal(reasoning.text, "工具后的思考")
})

test("结束后思考置 inactive，运行中工具置失败", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "thought", turnId: "t-1", text: "思考" })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("z-1", { status: "in_progress" }) })
  state = applyLocalExecutionUpdate(state, { kind: "finished", turnId: "t-1" })
  const reasoning = state.entries.find(e => e.kind === "reasoning")
  assert.equal(reasoning?.kind === "reasoning" && reasoning.active, false)
  const toolEntry = state.entries.find(e => e.kind === "tool")
  assert.equal(toolEntry?.kind === "tool" && toolEntry.status, "failed")
})

test("结束后迟到的更新被忽略", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "finished", turnId: "t-1" })
  const before = state
  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "迟到" })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("late-1") })
  assert.equal(state, before)
})

test("受理的提问带有本机时间戳，供锚定预览显示", () => {
  const before = Date.now()
  const state = accepted()
  const entry = state.entries[0]
  assert.equal(entry?.kind, "message")
  if (entry?.kind !== "message") return
  assert.equal(typeof entry.createdAtMs, "number")
  assert.ok(entry.createdAtMs !== undefined && entry.createdAtMs >= before && entry.createdAtMs <= Date.now())
})

test("思考在工具调用或正文输出开始时立即结束思考中状态", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "thought", turnId: "t-1", text: "先分析" })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("c-1", { title: "read_file src/a.ts", status: "in_progress" }) })
  const firstThought = state.entries.find(e => e.id === "local-execution:t-1:reasoning:0")
  assert.equal(firstThought?.kind === "reasoning" && firstThought.active, false)

  state = applyLocalExecutionUpdate(state, { kind: "thought", turnId: "t-1", text: "再总结" })
  const secondThoughtBefore = state.entries.find(e => e.id === "local-execution:t-1:reasoning:1")
  assert.equal(secondThoughtBefore?.kind === "reasoning" && secondThoughtBefore.active, true)

  state = applyLocalExecutionUpdate(state, { kind: "assistant-text", turnId: "t-1", text: "得出结论" })
  const secondThoughtAfter = state.entries.find(e => e.id === "local-execution:t-1:reasoning:1")
  assert.equal(secondThoughtAfter?.kind === "reasoning" && secondThoughtAfter.active, false)
})

test("多段正文按工具或 messageId 切换分段而不覆盖先发文字", () => {
  let state = applyLocalExecutionUpdate(accepted(), { kind: "assistant-text", turnId: "t-1", text: "第一段", messageId: "m-1" })
  state = applyLocalExecutionUpdate(state, { kind: "assistant-text", turnId: "t-1", text: "补充", messageId: "m-1" })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("c-1", { title: "read_file src/a.ts", status: "completed" }) })
  state = applyLocalExecutionUpdate(state, { kind: "assistant-text", turnId: "t-1", text: "第二段", messageId: "m-1" })
  state = applyLocalExecutionUpdate(state, { kind: "assistant-text", turnId: "t-1", text: "第三段", messageId: "m-2" })
  state = applyLocalExecutionUpdate(state, { kind: "finished", turnId: "t-1" })

  const assistants = state.entries.filter(e => e.kind === "message" && e.role === "assistant")
  assert.equal(assistants.length, 3)
  assert.deepEqual(assistants.map(a => a.kind === "message" ? [a.id, a.text, a.streaming] : []), [
    ["local-execution:t-1:assistant", "第一段补充", false],
    ["local-execution:t-1:assistant:1", "第二段", false],
    ["local-execution:t-1:assistant:2", "第三段", false],
  ])
})

test("工具标题与 locations 拆分 label 与 summary，并保留 originalName", () => {
  let state = applyLocalExecutionUpdate(accepted(), {
    kind: "tool", turnId: "t-1",
    tool: tool("t-a", { title: "read_file src/renderer/app.tsx", kind: "read" }),
  })
  state = applyLocalExecutionUpdate(state, {
    kind: "tool", turnId: "t-1",
    tool: tool("t-b", { title: "edit_file", kind: "edit", locations: [{ path: "src/main.ts", line: 42 }] }),
  })
  const toolA = state.entries.find(e => e.id === "local-execution:t-1:tool:t-a")
  const toolB = state.entries.find(e => e.id === "local-execution:t-1:tool:t-b")
  assert.equal(toolA?.kind === "tool" && toolA.label, "read_file")
  assert.equal(toolA?.kind === "tool" && toolA.summary, "src/renderer/app.tsx")
  assert.equal(toolA?.kind === "tool" && toolA.originalName, "read_file src/renderer/app.tsx")
  assert.equal(toolB?.kind === "tool" && toolB.label, "edit_file")
  assert.equal(toolB?.kind === "tool" && toolB.summary, "src/main.ts:42")
})

test("大文件行级 diff 仅保留上下 3 行上下文，并同时保留文本输出与 diff 复制文本", () => {
  const oldLines = Array.from({ length: 12 }, (_, idx) => `line-${idx + 1}`)
  const newLines = oldLines.map((line, idx) => idx === 6 ? "line-7-updated" : line)
  const state = applyLocalExecutionUpdate(accepted(), {
    kind: "tool", turnId: "t-1",
    tool: tool("d-ctx", {
      title: "edit_file src/big.ts",
      kind: "edit",
      output: "已写入 1 处变更",
      diffs: [{ path: "src/big.ts", oldText: oldLines.join("\n"), newText: newLines.join("\n") }],
    }),
  })
  const entry = state.entries.at(-1)
  if (entry?.kind !== "tool") return assert.fail("expected tool")
  assert.equal(entry.detail?.outputText, "已写入 1 处变更")
  assert.equal(entry.detail?.blocks?.length, 2)
  const diffBlock = entry.detail?.blocks?.[0]
  assert.equal(diffBlock?.kind, "diff")
  if (diffBlock?.kind === "diff") {
    assert.deepEqual(diffBlock.rows, [
      { kind: "context", text: "⋯" },
      { kind: "context", text: "line-4" },
      { kind: "context", text: "line-5" },
      { kind: "context", text: "line-6" },
      { kind: "remove", text: "line-7" },
      { kind: "add", text: "line-7-updated" },
      { kind: "context", text: "line-8" },
      { kind: "context", text: "line-9" },
      { kind: "context", text: "line-10" },
      { kind: "context", text: "⋯" },
    ])
  }
  assert.deepEqual(entry.detail?.blocks?.[1], { kind: "text", text: "已写入 1 处变更" })

  const diffOnlyState = applyLocalExecutionUpdate(accepted(), {
    kind: "tool", turnId: "t-1",
    tool: tool("d-only", { diffs: [{ path: "src/a.ts", oldText: "a", newText: "b" }] }),
  })
  const diffOnly = diffOnlyState.entries.at(-1)
  assert.equal(diffOnly?.kind === "tool" && Boolean(diffOnly.detail?.copyText?.includes("-a") && diffOnly.detail?.copyText?.includes("+b")), true)
})

test("权限审批投影保留工具详情、diff 预览与已处理交互历史", () => {
  const permission: LocalExecutionPermission = {
    id: "perm-1",
    title: "写入配置文件",
    options: [
      { id: "allow", label: "允许一次", allows: true },
      { id: "reject", label: "拒绝", allows: false },
    ],
    tool: {
      id: "c-perm",
      title: "edit_file config.json",
      kind: "edit",
      input: '{"path":"config.json"}',
      locations: [{ path: "config.json", line: 3 }],
      diffs: [{ path: "config.json", oldText: '{"a":1}', newText: '{"a":2}' }],
    },
  }
  const described = describePermissionRequest(permission)
  assert.ok(described.description?.includes("config.json:3"))
  assert.ok(described.blocks.some(block => block.kind === "diff"))

  let state = applyLocalExecutionUpdate(accepted(), { kind: "permission", turnId: "t-1", request: permission })
  state = applyLocalExecutionUpdate(state, {
    kind: "permission-decision", turnId: "t-1", requestId: "perm-1", title: permission.title, optionLabel: "允许一次",
  })
  const history = state.entries.find(e => e.kind === "interaction-history")
  assert.equal(history?.kind === "interaction-history" && history.statusLabel, "允许一次")
  assert.equal(history?.kind === "interaction-history" && history.title, "写入配置文件")
})

test("upload 确认同步 seq 范围后，projectLocalExecution 去重并保留本地推理与工具顺序", () => {
  let state = applyLocalExecutionUpdate(accepted("第一轮提问"), {
    kind: "thought", turnId: "t-1", text: "本地思考",
  })
  state = applyLocalExecutionUpdate(state, { kind: "tool", turnId: "t-1", tool: tool("c-1", { status: "completed", output: "ok" }) })
  state = applyLocalExecutionUpdate(state, { kind: "assistant-text", turnId: "t-1", text: "第一轮回答" })
  state = applyLocalExecutionUpdate(state, { kind: "finished", turnId: "t-1" })
  state = applyLocalExecutionUpdate(state, {
    kind: "upload", turnId: "t-1", firstSequence: 10, syncedSequence: 11,
  })

  const syncedHistory = [
    { kind: "message" as const, id: "seq-9", role: "user" as const, text: "更早消息" },
    { kind: "message" as const, id: "seq-10", role: "user" as const, text: "第一轮提问" },
    { kind: "message" as const, id: "seq-11", role: "assistant" as const, text: "第一轮回答" },
    { kind: "message" as const, id: "seq-12", role: "assistant" as const, text: "队友插话" },
  ]
  const projected = projectLocalExecution({
    entries: syncedHistory,
    contentRevision: 1,
    composer: {
      send: { enabled: true },
      cancel: { enabled: true },
      primaryActions: "send",
    } as never,
  }, state)
  assert.deepEqual(
    projected.entries.map(e => e.id),
    [
      "seq-9",
      "local-execution:t-1:user",
      "local-execution:t-1:reasoning:0",
      "local-execution:t-1:tool:c-1",
      "local-execution:t-1:assistant",
      "seq-12",
    ],
  )
})

test("applyLocalExecutionUpdate records permission-decision at permission settle point even after finished", () => {
  let state = emptyLocalExecutionView
  state = applyLocalExecutionUpdate(state, {
    kind: "accepted",
    turnId: "t-perm-race",
    text: "允许修改配置吗",
    author: { name: "我" },
  })
  state = applyLocalExecutionUpdate(state, {
    kind: "tool",
    turnId: "t-perm-race",
    tool: {
      id: "call-perm",
      title: "edit_file package-settings.json",
      kind: "edit",
      status: "in_progress",
      locations: [{ path: "package-settings.json", line: 4 }],
    },
  })
  state = applyLocalExecutionUpdate(state, {
    kind: "permission",
    turnId: "t-perm-race",
    request: {
      id: "perm-1",
      title: "edit_file package-settings.json",
      options: [
        { id: "allow-once", label: "允许一次", kind: "allow_once" },
        { id: "reject-once", label: "拒绝", kind: "reject_once" },
      ],
      tool: {
        id: "call-perm",
        title: "edit_file package-settings.json",
        kind: "edit",
        locations: [{ path: "package-settings.json", line: 4 }],
      },
    },
  })
  // IPC notice clears permission synchronously before invoke returns, then tool completes & turn finishes
  state = applyLocalExecutionUpdate(state, {
    kind: "permission",
    turnId: "t-perm-race",
    request: null,
  })
  assert.equal(state.permission, null)
  state = applyLocalExecutionUpdate(state, {
    kind: "tool",
    turnId: "t-perm-race",
    tool: { id: "call-perm", status: "completed", output: "ok" },
  })
  state = applyLocalExecutionUpdate(state, {
    kind: "assistant-text",
    turnId: "t-perm-race",
    text: "已按授权写入。",
  })
  state = applyLocalExecutionUpdate(state, {
    kind: "finished",
    turnId: "t-perm-race",
  })
  assert.equal(state.activeTurnId, null)

  // Now answerPermission invoke resolves in renderer and dispatches permission-decision
  state = applyLocalExecutionUpdate(state, {
    kind: "permission-decision",
    turnId: "t-perm-race",
    requestId: "perm-1",
    title: "edit_file package-settings.json",
    optionLabel: "允许一次",
    description: "涉及路径：package-settings.json:4 · 操作类型：edit",
  })

  assert.deepEqual(
    state.entries.map(e => e.id),
    [
      "local-execution:t-perm-race:user",
      "local-execution:t-perm-race:tool:call-perm",
      "local-execution:t-perm-race:interaction:perm-1",
      "local-execution:t-perm-race:assistant",
    ],
  )
  const history = state.entries[2]
  assert.equal(history?.kind, "interaction-history")
  if (history?.kind === "interaction-history") {
    assert.equal(history.statusLabel, "允许一次")
    assert.equal(history.title, "edit_file package-settings.json")
  }
})
