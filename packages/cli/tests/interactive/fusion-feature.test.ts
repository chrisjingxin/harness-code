import { test, expect } from "bun:test"
import { Capability, EventType } from "@za38/protocol"
import { FusionFeature } from "../../src/interactive/features/fusion-feature"
import {
  applyAgentEvent,
  createInitialState,
  startRun,
} from "../../src/interactive/state"
import type { FeatureContext } from "../../src/interactive/features/types"
import { runtime, makeHarness, flush } from "./harness"

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
      inspectFusion: async () => ({ task }),
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
  expect(text).toContain("工作区被另一任务占用")
  expect(text).toContain("older-thread")
  expect(text).toContain("已达到返工上限")
  expect(text).toContain("/resume")
  expect(text).toContain("/fusion cancel")
  expect(text).toContain("尚未派单")
  expect(text).not.toContain("检查及审阅通过")
  const unknown = fusionSummary({ ...task, workspace_blocker: { ...task.workspace_blocker, requires_inspection: true } })
  expect(unknown).toContain("先核查")
})


test("较早发出的状态查询不能覆盖新进度中的占用状态", async () => {
  const { ctx } = context()
  const old: any = { task_id: "f", thread_id: "t", version: 1, phase: "READY", active: true, profile: { profile_id: "duo" } }
  let resolve: (value: any) => void = () => {}
  ctx.gateway.inspectFusion = () => new Promise<any>(reply => { resolve = reply })
  const waiting = new FusionFeature().refresh("t", ctx)
  const latest = { ...old, version: 2, phase: "WAITING_USER", reason: "workspace_busy" }
  ctx.commit(state => ({ ...state, fusionTask: latest }))
  resolve({ task: old })
  await waiting
  expect(ctx.getState().fusionTask?.version).toBe(2)
  expect(ctx.getState().fusionTask?.reason).toBe("workspace_busy")
})
