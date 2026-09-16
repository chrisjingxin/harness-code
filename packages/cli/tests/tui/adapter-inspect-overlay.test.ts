/** 执行中 Goal/Plan 查看浮层：独立 overlay，审批到来时让位。 */

import { expect, test } from "bun:test"

import { Capability } from "@za38/protocol"
import { createTuiAdapter } from "../../src/tui/application/adapter"
import { approvalRequest, flush, makeHarness } from "../interactive/harness"

function goalProjection() {
  return {
    goal_id: "goal-1",
    revision: 1,
    status: "active" as const,
    objective: "完成登录功能",
    assumptions: [],
    criteria: [{ criterion_id: "criterion-1", text: "登录成功后进入首页" }],
    note: null,
    prior_blocker: null,
    grader: { selection: "inherit" as const, configured_profile_id: null, actual_profile_id: null },
    max_iterations: 3,
    created_at_ms: 1,
    updated_at_ms: 2,
    completed_at_ms: null,
  }
}

test("执行中 /goal 打开 inspect overlay，Esc 关闭后 Run 继续", async () => {
  const harness = makeHarness({
    capabilities: [Capability.GOAL_READ, Capability.GOAL_MANAGE],
    initialThreadId: "thread-goal",
    openThreadImpl: async threadId => ({
      thread: { thread_id: threadId, created_at_ms: 1, updated_at_ms: 2, first_message: "", latest_message: "", message_count: 0, title: null },
      messages: [],
      plan: { has_plan: false, plan_markdown: "", plan_virtual_path: "/.harness/plan.md", plan_display_path: `~/.harness/plans/${threadId}.md` },
      goal: goalProjection(),
      goal_pending: null,
      goal_activities: [],
    }),
  })
  const adapter = createTuiAdapter({
    controller: harness.controller,
    onRequestExit: () => {},
  })
  try {
    await flush()
    harness.port.inspectGoal = async () => ({ goal: goalProjection(), pending: null, latest_evaluation: null })
    await harness.controller.dispatch({ type: "input.submit", value: "先做当前任务" })
    await adapter.dispatch({ type: "execute-command", commandId: "goal.manage" })
    expect(adapter.getSnapshot().inspectOverlay.visible).toBe(true)
    expect(adapter.getSnapshot().inspectOverlay.kind).toBe("goal")
    expect(adapter.getSnapshot().inspectOverlay.body).toContain("完成登录功能")
    expect(adapter.getSnapshot().interactive.interaction).toBeNull()

    await adapter.dispatch({ type: "shortcut", action: "close-inspect-overlay" })
    expect(adapter.getSnapshot().inspectOverlay.visible).toBe(false)
    expect(adapter.getSnapshot().interactive.activeRun).not.toBeNull()
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("空参 /mcp 打开 MCP 状态浮层", async () => {
  const harness = makeHarness()
  const adapter = createTuiAdapter({
    controller: harness.controller,
    onRequestExit: () => {},
  })
  try {
    await flush()
    await adapter.dispatch({ type: "execute-command", commandId: "mcp.manage" })
    expect(adapter.getSnapshot().inspectOverlay.visible).toBe(true)
    expect(adapter.getSnapshot().inspectOverlay.kind).toBe("mcp")
    expect(adapter.getSnapshot().inspectOverlay.body).toContain("filesystem")
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("/code-index status 打开供应商无关的代码索引浮层", async () => {
  const harness = makeHarness({
    capabilities: [Capability.CODE_INDEX_READ],
    codeIndexStatusImpl: async () => ({
      revision: 0,
      generation: 0,
      engine_version: "1.1.6",
      data_directory: ".harness-index",
      runtime_status: "ready",
      index_status: "absent",
      query_status: "stopped",
      watcher_status: "stopped",
      job: null,
      stats: null,
      error: null,
    }),
  })
  const adapter = createTuiAdapter({ controller: harness.controller, onRequestExit: () => {} })
  try {
    await adapter.dispatch({ type: "execute-command", commandId: "code-index.manage", argument: "status" })
    const overlay = adapter.getSnapshot().inspectOverlay
    expect(overlay).toMatchObject({
      visible: true,
      kind: "code-index",
      title: "代码索引",
      body: "代码索引 · 未建立",
    })
    expect(JSON.stringify(overlay)).not.toContain("CodeGraph")
    expect(JSON.stringify(overlay)).not.toContain("实验")
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("代码索引 changed 通知原地更新同一个浮层且不显示伪百分比", async () => {
  const base = {
    revision: 0,
    generation: 0,
    engine_version: "1.1.6" as const,
    data_directory: ".harness-index" as const,
    runtime_status: "ready" as const,
    index_status: "absent" as const,
    query_status: "stopped" as const,
    watcher_status: "stopped" as const,
    job: null,
    stats: null,
    error: null,
  }
  const harness = makeHarness({
    capabilities: [Capability.CODE_INDEX_READ, Capability.CODE_INDEX_MANAGE],
    codeIndexStatusImpl: async () => base,
    codeIndexApplyImpl: async () => ({
      ...base,
      revision: 1,
      job: { id: "job-1", action: "initialize" as const, status: "running" as const, phase: "indexing" as const, completed: 2 },
    }),
  })
  const adapter = createTuiAdapter({ controller: harness.controller, onRequestExit: () => {} })
  try {
    await adapter.dispatch({ type: "execute-command", commandId: "code-index.manage" })
    expect(adapter.getSnapshot().inspectOverlay.body).toBe("代码索引 · 建立中\n已处理 2 项")
    expect(adapter.getSnapshot().inspectOverlay.body).not.toContain("%")

    harness.port.emitCodeIndexChanged({
      ...base,
      revision: 2,
      generation: 1,
      index_status: "ready",
      query_status: "ready",
      watcher_status: "ready",
      job: { id: "job-1", action: "initialize", status: "succeeded", phase: "starting_query" },
      stats: { files: 3, symbols: 10, relationships: 4, db_bytes: 100, wal_bytes: 0 },
    })
    expect(adapter.getSnapshot().inspectOverlay.body).toContain("3 个文件 · 10 个符号 · 4 条关系")
    expect(adapter.getSnapshot().inspectOverlay.visible).toBe(true)
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})

test("审批到来时关闭 Goal/Status/BTW overlay", async () => {
  const harness = makeHarness({
    capabilities: [Capability.GOAL_READ, Capability.GOAL_MANAGE],
    initialThreadId: "thread-goal",
    openThreadImpl: async threadId => ({
      thread: { thread_id: threadId, created_at_ms: 1, updated_at_ms: 2, first_message: "", latest_message: "", message_count: 0, title: null },
      messages: [],
      plan: { has_plan: false, plan_markdown: "", plan_virtual_path: "/.harness/plan.md", plan_display_path: `~/.harness/plans/${threadId}.md` },
      goal: goalProjection(),
      goal_pending: null,
      goal_activities: [],
    }),
  })
  const adapter = createTuiAdapter({
    controller: harness.controller,
    onRequestExit: () => {},
  })
  try {
    await flush()
    harness.port.inspectGoal = async () => ({ goal: goalProjection(), pending: null, latest_evaluation: null })
    await harness.controller.dispatch({ type: "input.submit", value: "先做当前任务" })
    await adapter.dispatch({ type: "execute-command", commandId: "goal.manage" })
    await adapter.dispatch({ type: "execute-command", commandId: "system.status" })
    expect(adapter.getSnapshot().inspectOverlay.visible).toBe(true)
    expect(adapter.getSnapshot().statusModal.visible).toBe(true)

    const run = harness.runHandles.at(-1)!
    void harness.port.sendInteraction(approvalRequest(run.threadId, run.runId))
    await flush()

    expect(adapter.getSnapshot().interactive.interaction?.type).toBe("approval")
    expect(adapter.getSnapshot().inspectOverlay.visible).toBe(false)
    expect(adapter.getSnapshot().statusModal.visible).toBe(false)
    expect(adapter.getSnapshot().btw.visible).toBe(false)
  } finally {
    await adapter.close()
    await harness.controller.close()
  }
})
