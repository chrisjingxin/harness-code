import { fusionWaitingLabel } from "../../src/interactive/fusion-summary"
import { test, expect } from "bun:test"
import { Capability, EventType } from "@za38/protocol"
import { FusionFeature } from "../../src/interactive/features/fusion-feature"
import {
  applyAgentEvent,
  createInitialState,
  startRun,
} from "../../src/interactive/state"
import type { FeatureContext } from "../../src/interactive/features/types"
import { runtime, makeHarness, flush, terminalEvent } from "./harness"

function context(task: any = null) {
  let state = createInitialState("t")
  const calls: any[] = []
  const ctx = {
    baseRuntime: {
      ...runtime,
      capabilities: [Capability.FUSION_READ, Capability.FUSION_MANAGE],
    },
    getState: () => state,
    commit: (update: any) => {
      state = update(state)
    },
    publish: () => {},
    gateway: {
      listFusionProfiles: async () => ({
        duo: {
          lead_profile_id: "pro",
          sidekick_profile_id: "fast",
          check_plan_ids: [],
        },
      }),
      inspectFusion: async () => ({ task, workspace_blocker: null }),
      cancelFusion: async (params: any) => {
        calls.push(params)
        return { ...task, phase: "CANCELLED", active: false }
      },
      recoverFusion: async (params: any) => {
        calls.push(params)
        return { ...task, phase: "PAUSED", version: task.version + 1 }
      },
    },
  } as unknown as FeatureContext
  return { ctx, calls }
}

function occupied(unknown = false) {
  const owner: any = { task_id: "old-task", thread_id: "old", version: 7, phase: unknown ? "OUTCOME_UNKNOWN" : "REVIEWING", active: true, profile: { profile_id: "duo" } }
  const waiting: any = { task_id: "waiting", thread_id: "t", version: 2, phase: "WAITING_USER", active: true, profile: { profile_id: "duo" }, reason: "workspace_busy", workspace_blocker: { task_id: owner.task_id, thread_id: owner.thread_id, phase: owner.phase, round: 2, requires_inspection: unknown } }
  const { ctx, calls } = context(waiting)
  let released = false
  ctx.gateway.inspectFusion = async (threadId) => ({ task: threadId === "old" ? owner : released ? { ...waiting, version: 3, phase: "PAUSED", reason: "workspace_available", workspace_blocker: null } : waiting, workspace_blocker: null })
  ctx.gateway.cancelFusion = async (params) => {
    calls.push(params)
    if (unknown && !params.stopped_inspection_note) throw new Error("FUSION_OUTCOME_UNKNOWN")
    released = true
    return { ...owner, phase: "CANCELLED", active: false }
  }
  return { ctx, calls, owner }
}

for (const unknown of [false, true]) for (const historical of [false, true]) {
  test(`no active task in this conversation still shows and resolves the workspace owner: ${unknown}, historical: ${historical}`, async () => {
    const ended = historical ? { task_id: "ended-task", thread_id: "t", phase: "CANCELLED", active: false, version: 3, profile: { profile_id: "duo" }, pending_operations: [], workspace_blocker: null } as any : null
    const { ctx, calls } = context(ended)
    const owner = { task_id: "owner-task", thread_id: "old-thread", phase: unknown ? "OUTCOME_UNKNOWN" : "REVIEWING", active: true, version: 7, profile: { profile_id: "duo" } } as any
    const blocker = { task_id: owner.task_id, thread_id: owner.thread_id, phase: owner.phase, round: 1, reason: unknown ? "effects_unconfirmed" : null, requires_inspection: unknown }
    let released = false
    ctx.gateway.inspectFusion = async (threadId) => ({ task: threadId === "old-thread" ? owner : ended, workspace_blocker: threadId === "old-thread" || released ? null : blocker } as any)
    ctx.gateway.cancelFusion = async params => { calls.push(params); released = true; return { ...owner, active: false, phase: "CANCELLED", version: 8 } }
    expect((await new FusionFeature().execute("status", ctx)).status).toBe("accepted")
    const text = ctx.getState().timeline.flatMap(item => item.type === "message" ? [item.message.content] : []).join("\n")
    expect(text).toContain("old-thread")
    expect(text).toContain(unknown ? "/fusion resolve" : "自动继续")
    expect((await new FusionFeature().execute(unknown ? "resolve --stopped 已核查相关命令停止" : "resolve", ctx)).status).toBe("accepted")
    expect(calls).toHaveLength(1)
    expect(calls[0].task_id).toBe("owner-task")
    expect(calls[0].expected_version).toBe(7)
    expect(ctx.getState().fusionTask).toEqual(ended)
  })
}

test("Fusion rejection remains actionable when the current display has no Fusion selection", async () => {
  const h = makeHarness()
  try {
    h.port.startRun = () => { throw new Error("FUSION_OUTCOME_UNKNOWN") }
    const result = await h.controller.dispatch({ type: "input.submit", value: "你自己检查下" })
    expect(result.status).toBe("rejected")
    if (result.status !== "rejected") throw new Error("expected rejection")
    expect(result.message).toContain("/fusion status")
    expect(result.message).toContain("停止")
  } finally { await h.controller.close() }
})

test("resolve cancels the actual owner from the current conversation and refreshes the waiting task", async () => {
  const { ctx, calls } = occupied()
  const result = await new FusionFeature().execute("resolve", ctx)
  expect(result.status).toBe("accepted")
  expect(calls).toEqual([{ task_id: "old-task", expected_version: 7 }])
  expect(ctx.getState().currentThreadId).toBe("t")
  expect(ctx.getState().fusionTask).toMatchObject({ task_id: "waiting", reason: "workspace_available" })
  expect(ctx.getState().fusionProfileId).toBe("duo")
})

test("resolve unknown operation requires explicit stop confirmation in the current conversation", async () => {
  const { ctx, calls } = occupied(true)
  const feature = new FusionFeature()
  const rejected = await feature.execute("resolve", ctx)
  expect(rejected.status).toBe("rejected")
  if (rejected.status !== "rejected") throw new Error("expected rejected")
  expect(rejected.message).toContain("/fusion resolve --stopped")
  expect(calls[0]).not.toHaveProperty("stopped_inspection_note")
  expect((await feature.execute("resolve --stopped 已检查文件和所有旧进程停止", ctx)).status).toBe("accepted")
  expect(calls[1]).toEqual({ task_id: "old-task", expected_version: 7, stopped_inspection_note: "已检查文件和所有旧进程停止" })
  expect(ctx.getState().currentThreadId).toBe("t")
})

test("cancel with explicit stop note uses one canonical cancellation request", async () => {
  const { ctx, calls } = context({ task_id: "f", thread_id: "t", version: 3, active: true, phase: "OUTCOME_UNKNOWN", profile: { profile_id: "duo" } })
  expect((await new FusionFeature().execute("cancel --stopped 已确认执行停止", ctx)).status).toBe("accepted")
  expect(calls).toEqual([{ task_id: "f", expected_version: 3, stopped_inspection_note: "已确认执行停止" }])
  expect(ctx.getState().fusionTask?.active).toBe(false)
  expect(ctx.getState().fusionProfileId).toBeNull()
})

test("resolve refuses changed owner identity and leaves both conversations untouched", async () => {
  const { ctx, calls, owner } = occupied()
  const inspect = ctx.gateway.inspectFusion
  ctx.gateway.inspectFusion = async (threadId) => threadId === "old" ? { task: { ...owner, task_id: "different-task" }, workspace_blocker: null } : inspect(threadId)
  expect((await new FusionFeature().execute("resolve", ctx)).status).toBe("rejected")
  expect(calls).toEqual([])
  expect(ctx.getState().currentThreadId).toBe("t")
})

test("resolve without a blocker never cancels the current task", async () => {
  const { ctx, calls } = context({ task_id: "f", thread_id: "t", version: 3, active: true, phase: "PAUSED", profile: { profile_id: "duo" } })
  expect((await new FusionFeature().execute("resolve", ctx)).status).toBe("rejected")
  expect(calls).toEqual([])
})

test("resolve is already successful when an idle task yielded the directory", async () => {
  const { ctx, calls } = context({ task_id: "waiting", thread_id: "t", version: 3, active: true, phase: "PAUSED", reason: "workspace_available", profile: { profile_id: "duo" } })
  expect((await new FusionFeature().execute("resolve", ctx)).status).toBe("accepted")
  expect(calls).toEqual([])
})

test("cancellation response cannot overwrite a conversation switched during the request", async () => {
  const { ctx } = context({ task_id: "f", thread_id: "t", version: 3, active: true, phase: "PAUSED", profile: { profile_id: "duo" } })
  ctx.gateway.cancelFusion = async () => {
    ctx.commit(current => ({ ...current, currentThreadId: "new-thread", fusionTask: null, fusionProfileId: "new-profile" }))
    return { task_id: "f", thread_id: "t", phase: "CANCELLED", active: false } as any
  }
  expect((await new FusionFeature().execute("cancel", ctx)).status).toBe("accepted")
  expect(ctx.getState().currentThreadId).toBe("new-thread")
  expect(ctx.getState().fusionProfileId).toBe("new-profile")
  expect(ctx.getState().fusionTask).toBeNull()
})

test("switching conversation during initial status refresh cannot cancel the new target", async () => {
  const old = { task_id: "old-task", thread_id: "t", version: 3, active: true, phase: "PAUSED", profile: { profile_id: "duo" } } as any
  const { ctx, calls } = context(old)
  ctx.gateway.inspectFusion = async () => {
    ctx.commit(current => ({ ...current, currentThreadId: "new-thread", fusionTask: { ...old, task_id: "new-task", thread_id: "new-thread" } }))
    return { task: old, workspace_blocker: null }
  }
  expect((await new FusionFeature().execute("cancel", ctx)).status).toBe("rejected")
  expect(calls).toEqual([])
})

for (const action of ["cancel", "recover"]) {
  test(`${action} response cannot overwrite a new task in the same conversation`, async () => {
    const old = { task_id: "old-task", thread_id: "t", version: 3, active: true, phase: "OUTCOME_UNKNOWN", profile: { profile_id: "duo" } } as any
    const { ctx } = context(old)
    const mutate = async () => {
      ctx.commit(current => ({ ...current, fusionTask: { ...old, task_id: "new-task" }, fusionProfileId: "new-profile" }))
      return { ...old, phase: action === "cancel" ? "CANCELLED" : "PAUSED", active: action !== "cancel", version: 4 }
    }
    if (action === "cancel") ctx.gateway.cancelFusion = mutate
    else ctx.gateway.recoverFusion = mutate
    expect((await new FusionFeature().execute(`${action} --stopped 已核实全部操作停止`, ctx)).status).toBe("accepted")
    expect(ctx.getState().fusionTask?.task_id).toBe("new-task")
    expect(ctx.getState().fusionProfileId).toBe("new-profile")
  })
}

test("blank stop notes are rejected before cancellation", async () => {
  for (const value of ["resolve --stopped", "cancel --stopped", "resolve --stopped   "]) {
    const { ctx, calls } = occupied(true)
    expect((await new FusionFeature().execute(value, ctx)).status).toBe("rejected")
    expect(calls).toEqual([])
  }
})

for (const code of ["FUSION_LEASE_BUSY", "FUSION_OUTCOME_UNKNOWN"]) {
  test(`Fusion start failure ${code} gives an action in the current conversation`, async () => {
    const h = makeHarness({ capabilities: [...runtime.capabilities!, Capability.FUSION_READ, Capability.FUSION_MANAGE] })
    try {
      await h.controller.dispatch({ type: "input.submit", value: "/fusion duo" })
      h.port.startRun = () => { throw new Error(code) }
      const result = await h.controller.dispatch({ type: "input.submit", value: "继续" })
      expect(result.status).toBe("rejected")
      if (result.status !== "rejected") throw new Error("expected rejected")
      expect(result.message).toContain("当前会话")
      expect(result.message).toContain("/fusion cancel")
    } finally {
      await h.controller.close()
    }
  })
}

for (const fusion of [true, false]) {
  test(`provider failure after partial output has actionable Fusion guidance: ${fusion}`, async () => {
    const h = makeHarness({ capabilities: [...runtime.capabilities!, Capability.FUSION_READ, Capability.FUSION_MANAGE] })
    const raw = "Provider stream failed after output was published"
    try {
      if (fusion) await h.controller.dispatch({ type: "input.submit", value: "/fusion duo" })
      await h.controller.dispatch({ type: "input.submit", value: "实现工具" })
      const run = h.controller.getSnapshot().activeRun!
      h.port.emitEvent(terminalEvent(EventType.CONTENT_DELTA, run.threadId, run.runId, 1, { text: "已输出内容" }))
      h.port.emitEvent(terminalEvent(EventType.RUN_FAILED, run.threadId, run.runId, 2, { error: { code: "PROVIDER_OUTPUT_INTERRUPTED", message: raw, retryable: true } }))
      await flush()
      const snapshot = h.controller.getSnapshot()
      const text = snapshot.timeline.flatMap(item => item.type === "message" ? [item.message.content] : []).join("\n")
      expect(snapshot.activeRun).toBeNull()
      expect(text).toContain("已输出内容")
      expect(h.calls.filter(call => call === "run.start")).toHaveLength(1)
      if (fusion) {
        expect(text).toContain("模型连接")
        expect(text).toContain("继续")
        expect(text).toContain("/fusion status")
      } else expect(text).toContain(raw)
    } finally { await h.controller.close() }
  })
}

test("selects configured Fusion and refuses off during active task", async () => {
  const { ctx } = context()
  const feature = new FusionFeature()
  expect((await feature.execute("duo", ctx)).status).toBe("accepted")
  expect(ctx.getState().fusionProfileId).toBe("duo")
  const active = context({
    task_id: "f",
    thread_id: "t",
    profile: { profile_id: "duo" },
    version: 3,
    phase: "PAUSED",
    active: true,
  })
  expect((await feature.execute("off", active.ctx)).status).toBe("rejected")
})

test("recover requires explicit inspection note and carries expected version", async () => {
  const { ctx, calls } = context({
    task_id: "f",
    thread_id: "t",
    profile: { profile_id: "duo" },
    version: 3,
    phase: "OUTCOME_UNKNOWN",
    active: true,
  })
  const feature = new FusionFeature()
  expect((await feature.execute("recover", ctx)).status).toBe("rejected")
  expect(
    (
      await feature.execute(
        "recover --stopped 已检查文件并确认所有命令停止",
        ctx,
      )
    ).status,
  ).toBe("accepted")
  expect(calls[0]).toEqual({
    task_id: "f",
    expected_version: 3,
    inspection_note: "已检查文件并确认所有命令停止",
    effects_stopped: true,
  })
})

test("cancel with unknown effects explains recover before cancel without recovering automatically", async () => {
  const { ctx, calls } = context({
    task_id: "f", thread_id: "t", profile: { profile_id: "duo" },
    version: 3, phase: "OUTCOME_UNKNOWN", active: true,
  })
  ctx.gateway.cancelFusion = async () => { throw new Error("FUSION_OUTCOME_UNKNOWN") }
  const result = await new FusionFeature().execute("cancel", ctx)
  expect(result.status).toBe("rejected")
  if (result.status !== "rejected") throw new Error("expected rejected")
  expect(result.message).toContain("/fusion recover --stopped")
  expect(result.message).toContain("核查已记录")
  expect(result.message).toContain("/fusion cancel --stopped")
  expect(calls).toEqual([])
  expect(ctx.getState().fusionTask?.active).toBe(true)
})

test("unrelated cancel failures keep the original error", async () => {
  const { ctx } = context({
    task_id: "f", thread_id: "t", profile: { profile_id: "duo" },
    version: 3, phase: "PAUSED", active: true,
  })
  ctx.gateway.cancelFusion = async () => { throw new Error("FUSION_TASK_CONFLICT") }
  const result = await new FusionFeature().execute("cancel", ctx)
  expect(result).toMatchObject({ status: "rejected", message: "FUSION_TASK_CONFLICT" })
})

test("unknown task status names the recovery command and its success message", async () => {
  const { fusionSummary } = await import("../../src/interactive/fusion-summary")
  const text = fusionSummary({
    profile: { profile_id: "duo" }, phase: "OUTCOME_UNKNOWN",
    verification: "unverified", round: 3, reason: "effects_unconfirmed",
    pending_operations: [{ kind: "dispatch", operation_id: "dispatch-pending" }],
  } as any)
  expect(text).toContain("dispatch-pending")
  expect(text).toContain("/fusion recover --stopped")
  expect(text).toContain("核查已记录")
  expect(text).toContain("单独输入")
  expect(text).toContain("/fusion cancel --stopped")
})

test("workspace blocker with unknown effects shows in-place stop confirmation", async () => {
  const { fusionSummary } = await import("../../src/interactive/fusion-summary")
  const text = fusionSummary({
    profile: { profile_id: "duo" }, phase: "WAITING_USER", round: 0,
    workspace_blocker: {
      task_id: "owner-task", thread_id: "old-thread", phase: "OUTCOME_UNKNOWN", round: 3,
      reason: "effects_unconfirmed", requires_inspection: true,
    },
  } as any)
  expect(text).toContain("old-thread")
  expect(text).not.toContain("/resume")
  expect(text).toContain("/fusion resolve --stopped")
})

test("a stopped workspace owner shows automatic continuation", async () => {
  const { fusionSummary } = await import("../../src/interactive/fusion-summary")
  const text = fusionSummary({
    profile: { profile_id: "duo" }, phase: "WAITING_USER", round: 0,
    workspace_blocker: {
      task_id: "owner-task", thread_id: "old-thread", phase: "PAUSED", round: 1,
      reason: "run_paused", requires_inspection: false,
    },
  } as any)
  expect(text).toContain("自动继续")
  expect(text).not.toContain("/fusion recover")
})

test("shared reducer projects Fusion progress for both frontends", () => {
  const task: any = {
    task_id: "f",
    thread_id: "t",
    profile: { profile_id: "duo" },
    version: 3,
    phase: "REVIEWING",
    active: true,
    verification: "review_only",
    round: 2,
  }
  const initial = startRun(
    createInitialState("t"),
    { threadId: "t", runId: "r" },
    "修改",
  )
  const next = applyAgentEvent(initial, {
    type: EventType.FUSION_PROGRESS,
    thread_id: "t",
    run_id: "r",
    sequence: 1,
    payload: task,
  } as any)
  expect(next.fusionTask).toEqual(task)
  expect(
    next.timeline.some(
      (item) => item.type === "message" && item.message.role === "system",
    ),
  ).toBe(true)
})

test("shared controller selects Fusion and carries it through RunFeature", async () => {
  const harness = makeHarness({
    capabilities: [
      ...runtime.capabilities!,
      Capability.FUSION_READ,
      Capability.FUSION_MANAGE,
    ],
  })
  try {
    expect(
      (
        await harness.controller.dispatch({
          type: "input.submit",
          value: "/fusion duo",
        })
      ).status,
    ).toBe("accepted")
    expect(
      (
        await harness.controller.dispatch({
          type: "input.submit",
          value: "保持兼容，修改实现",
        })
      ).status,
    ).toBe("accepted")
    expect(harness.port.lastRunSelection()).toMatchObject({
      fusionProfileId: "duo",
      mode: "build",
    })
    expect(harness.port.lastRunSelection()?.modelSelection).toBeUndefined()
    expect(
      (
        await harness.controller.dispatch({
          type: "input.submit",
          value: "/fusion off",
        })
      ).status,
    ).toBe("rejected")
  } finally {
    await harness.controller.close()
  }
})

test("Fusion selected rejects Compose and Plan execution without starting a run", async () => {
  const harness = makeHarness({
    capabilities: [
      ...runtime.capabilities!,
      Capability.FUSION_READ,
      Capability.FUSION_MANAGE,
    ],
  })
  try {
    await harness.controller.dispatch({
      type: "input.submit",
      value: "/fusion duo",
    })
    await harness.controller.dispatch({
      type: "approval-mode.set",
      mode: "plan",
    })
    expect(
      (
        await harness.controller.dispatch({
          type: "input.submit",
          value: "修改",
        })
      ).status,
    ).toBe("rejected")
    expect(harness.calls).not.toContain("run.start")
  } finally {
    await harness.controller.close()
  }
})

test("status explanation includes both models and uses Chinese phase/reason", async () => {
  const { fusionSummary } = await import("../../src/interactive/fusion-summary")
  const text = fusionSummary({
    profile: {
      profile_id: "duo",
      lead: { id: "pro" },
      sidekick: { id: "fast" },
    },
    phase: "WAITING_USER",
    verification: "unverified",
    round: 1,
    reason: "worker_report_missing",
  } as any)
  expect(text).toContain("Lead pro")
  expect(text).toContain("Sidekick fast")
  expect(text).toContain("未提交报告")
})

test("shared reducer ignores stale Fusion versions and shows common summary", () => {
  const task: any = {
    task_id: "f",
    thread_id: "t",
    profile: { profile_id: "duo" },
    version: 3,
    phase: "REVIEWING",
    active: true,
    verification: "review_only",
    round: 2,
  }
  let state = startRun(
    createInitialState("t"),
    { threadId: "t", runId: "r" },
    "修改",
  )
  state = applyAgentEvent(state, {
    type: EventType.FUSION_PROGRESS,
    thread_id: "t",
    run_id: "r",
    sequence: 1,
    payload: task,
  } as any)
  state = applyAgentEvent(state, {
    type: EventType.FUSION_PROGRESS,
    thread_id: "t",
    run_id: "r",
    sequence: 2,
    payload: { ...task, version: 2, phase: "WORKER_RUNNING" },
  } as any)
  expect(state.fusionTask?.phase).toBe("REVIEWING")
  const message = state.timeline.at(-1) as any
  expect(message.message.content).toContain("Lead 审阅中")
})

test("unknown status shows operation identities for manual inspection", async () => {
  const { fusionSummary } = await import("../../src/interactive/fusion-summary")
  const text = fusionSummary({
    profile: {
      profile_id: "duo",
      lead: { id: "pro" },
      sidekick: { id: "fast" },
    },
    phase: "OUTCOME_UNKNOWN",
    verification: "unverified",
    round: 1,
    pending_operations: [
      { operation_id: "effect-test-1", kind: "execute", state: "unknown" },
    ],
  } as any)
  expect(text).toContain("待核查操作")
  expect(text).toContain("effect-test-1")
  expect(text).toContain("执行命令")
})


test("工作区占用显示原会话与处理方式，未派单不能当作完成", async () => {
  const { fusionSummary } = await import("../../src/interactive/fusion-summary")
  const task: any = {
    task_id: "waiting", thread_id: "t", version: 2,
    profile: { profile_id: "duo", lead: { id: "pro" }, sidekick: { id: "fast" } },
    phase: "WAITING_USER", active: true, round: 0, revision: 0, verification: "unverified", reason: "workspace_busy",
    workspace_blocker: { task_id: "owner", thread_id: "older-thread", phase: "WAITING_USER", round: 4, reason: "rework_limit", requires_inspection: false },
  }
  const text = fusionSummary(task)
  expect(text).toContain("文件范围被另一任务预留")
  expect(text).toContain("older-thread")
  expect(text).toContain("已达到返工上限")
  expect(text).not.toContain("/resume")
  expect(text).toContain("自动继续")
  expect(text).toContain("尚未派单")
  expect(text).not.toContain("检查及审阅通过")
  const unknown = fusionSummary({ ...task, workspace_blocker: { ...task.workspace_blocker, requires_inspection: true } })
  expect(unknown).toContain("/fusion resolve --stopped")
})


test("较早发出的状态查询不能覆盖新进度中的占用状态", async () => {
  const { ctx } = context()
  const old: any = { task_id: "f", thread_id: "t", version: 1, phase: "READY", active: true, profile: { profile_id: "duo" } }
  let resolve: (value: any) => void = () => {}
  ctx.gateway.inspectFusion = () => new Promise<any>(reply => { resolve = reply })
  const waiting = new FusionFeature().refresh("t", ctx)
  const latest = { ...old, version: 2, phase: "WAITING_USER", reason: "workspace_busy" }
  ctx.commit(state => ({ ...state, fusionTask: latest }))
  resolve({ task: old, workspace_blocker: null })
  await waiting
  expect(ctx.getState().fusionTask?.version).toBe(2)
  expect(ctx.getState().fusionTask?.reason).toBe("workspace_busy")
})


test("a workspace owner from another project has no misleading current-dialog cancellation hint", async () => {
  const { ctx } = context()
  ctx.gateway.inspectFusion = async () => ({ task: null, workspace_blocker: { task_id: null, thread_id: null, phase: null, round: 0, reason: "owner_unavailable", requires_inspection: true } })
  expect((await new FusionFeature().execute("status", ctx)).status).toBe("accepted")
  const notice = JSON.stringify(ctx.getState())
  expect(notice).toContain("原项目")
  expect(notice).not.toContain("/fusion resolve")
})

test("ordinary unknown operation is inspected and released in current conversation", async () => {
  const { ctx, calls } = context()
  let blocker: any = { task_id: null, thread_id: null, phase: null, round: 0, reason: null, requires_inspection: true, kind: "command", paths: ["./"], operation_id: "access-1", sequence: 7 }
  ctx.gateway.inspectFusion = async () => ({ task: null, workspace_blocker: blocker })
  ctx.gateway.releaseFusionOperation = async params => { calls.push(params); blocker = null; return { released: true } }
  const feature = new FusionFeature()
  expect((await feature.execute("resolve", ctx)).status).toBe("rejected")
  expect(calls).toHaveLength(0)
  expect((await feature.execute("resolve --stopped 已确认所有相关命令停止", ctx)).status).toBe("accepted")
  expect(calls).toEqual([{ operation_id: "access-1", expected_sequence: 7, stopped_inspection_note: "已确认所有相关命令停止" }])
})

test("waiting for files or commands is shown separately from model response", () => {
  expect(fusionWaitingLabel({ active: true, phase: "WAITING_RESOURCE", workspace_blocker: { kind: "paths" } } as any)).toBe("等待文件写入权限")
  expect(fusionWaitingLabel({ active: true, phase: "WORKER_RUNNING", resource_waits: [{ kind: "command" }] } as any)).toBe("等待其他命令结束")
  expect(fusionWaitingLabel({ active: true, phase: "OUTCOME_UNKNOWN" } as any)).toBeNull()
})
