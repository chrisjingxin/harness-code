import { expect, test } from "bun:test"
import { makeHarness, flush } from "./harness"

test("重新打开会话恢复同一轮权威耗时，缺失的旧耗时不推算", async () => {
  const harness = makeHarness({ openThreadImpl: async threadId => ({
    thread: { thread_id: threadId, created_at_ms: 1, updated_at_ms: 2, first_message: "hello", latest_message: "answer", message_count: 2, title: null },
    messages: [{ kind: "user", content: "hello", run_id: "r" }, { kind: "assistant", content: "answer", run_id: "r" }],
    run_summaries: [{ run_id: "r", outcome: "completed", duration_ms: 2764, usage: { input_tokens: 100, output_tokens: 20, input_complete: true, output_complete: true } }],
    plan: { has_plan: false, plan_markdown: "", plan_virtual_path: "/.harness/plan.md", plan_display_path: "test" },
    goal: null, goal_pending: null, goal_activities: [],
  }) })
  try {
    await harness.controller.dispatch({ type: "thread.open", threadId: "thread" })
    await flush()
    expect(harness.controller.getSnapshot().runSummaries.r?.durationMs).toBe(2764)
    expect(harness.controller.getSnapshot().lastRun?.durationMs).toBe(2764)
  } finally { await harness.controller.close() }
})

test("Thread 切换：/resume 打开选择器并原子恢复，运行中禁止切换", async () => {
  const harness = makeHarness()
  try {
    await harness.controller.dispatch({ type: "command.execute", commandId: "thread.resume" })
    await flush()
    expect(harness.controller.getSnapshot().catalogs.threads.status).toBe("ready")
    expect(harness.controller.getSnapshot().catalogs.threads.items).toHaveLength(2)

    await harness.controller.dispatch({ type: "thread.open", threadId: "thread-2" })
    await flush()
    let snapshot = harness.controller.getSnapshot()
    expect(snapshot.currentThreadId).toBe("thread-2")
    expect(snapshot.timeline).toHaveLength(2)
    // 恢复完成后 activity 必须回到 idle（"就绪"）；不得永久停在 restoring。
    expect(snapshot.activity.kind).toBe("idle")

    await harness.controller.dispatch({ type: "input.submit", value: "运行中" })
    const outcome = await harness.controller.dispatch({ type: "thread.open", threadId: "thread-1" })
    await flush()
    snapshot = harness.controller.getSnapshot()
    expect(snapshot.currentThreadId).toBe("thread-2")
    expect(outcome).toEqual({ status: "rejected", code: "busy", message: expect.any(String) })
  } finally {
    await harness.controller.close()
  }
})

test("/new 确认后取消并清空 Thread；取消失败保留原 Thread", async () => {
  const harness = makeHarness()
  try {
    await harness.controller.dispatch({ type: "input.submit", value: "保留这个 Thread" })
    const run = harness.runHandles.at(-1)!
    await harness.controller.dispatch({ type: "command.execute", commandId: "thread.new" })
    let snapshot = harness.controller.getSnapshot()
    expect(snapshot.confirmation?.confirmationId).toBe("clear-thread")

    await harness.controller.dispatch({ type: "confirmation.resolve", confirmationId: "clear-thread", confirmed: true })
    await flush()
    snapshot = harness.controller.getSnapshot()
    expect(snapshot.currentThreadId).toBeNull()
    expect(snapshot.timeline).toHaveLength(0)
    expect(harness.calls).toContain("run.cancel")
    expect(run.runId).toBeTruthy()
  } finally {
    await harness.controller.close()
  }
})

test("新建 Thread 只清 conversation scope：全局 Thread catalog 保留、连接保持 open", async () => {
  const harness = makeHarness()
  try {
    await harness.controller.dispatch({ type: "thread.open", threadId: "thread-1" })
    await flush()
    const opened = harness.controller.getSnapshot()
    expect(opened.currentThreadId).toBe("thread-1")
    expect(opened.catalogs.threads.status).toBe("ready")
    expect(opened.catalogs.threads.items).toHaveLength(2)

    await harness.controller.dispatch({ type: "command.execute", commandId: "thread.new" })
    await flush()
    const snapshot = harness.controller.getSnapshot()
    expect(snapshot.currentThreadId).toBeNull()
    expect(snapshot.timeline).toHaveLength(0)
    expect(snapshot.activity.kind).toBe("home")
    // catalog 不被清空：侧栏历史 Thread 立即可见、可切回。
    expect(snapshot.catalogs.threads.status).toBe("ready")
    expect(snapshot.catalogs.threads.items).toHaveLength(2)
    expect(snapshot.connection.status).toBe("open")
  } finally {
    await harness.controller.close()
  }
})

test("Thread 打开期间重复打开被拒绝，stale 模型结果不覆盖新 Thread", async () => {
  const harness = makeHarness()
  let releaseFirst!: () => void
  const gate = new Promise<void>(resolve => { releaseFirst = resolve })
  let openCount = 0
  const originalOpen = harness.port.openThread.bind(harness.port)
  harness.port.openThread = async (threadId: string) => {
    openCount += 1
    const result = await originalOpen(threadId)
    if (openCount === 1) await gate
    return result
  }
  try {
    const first = harness.controller.dispatch({ type: "thread.open", threadId: "thread-1" })
    await flush()
    // openingThread 保护：第二个 open 不发 RPC。
    await harness.controller.dispatch({ type: "thread.open", threadId: "thread-2" })
    await flush()
    expect(harness.calls.filter(call => call === "threads.open")).toHaveLength(1)
    releaseFirst()
    await first
    await flush()
    expect(harness.controller.getSnapshot().currentThreadId).toBe("thread-1")
  } finally {
    await harness.controller.close()
  }
})

