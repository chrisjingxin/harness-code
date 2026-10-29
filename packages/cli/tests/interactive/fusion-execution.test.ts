/** 主界面直接显示 Fusion 两角色，普通子执行继续隔离。 */
import { expect, test } from "bun:test"
import { EventType } from "@za38/protocol"
import { applyAgentEvent, createInitialState, markRunFailed, startRun } from "../../src/interactive/state"
import { scopeTimeline } from "../../src/presentation-shared/timeline-scope"
import { activityGroupTitle, segmentTimeline } from "../../src/presentation-shared/timeline-activity-groups"
import { fusionEvent, fusionTask, liveFusionTimeline, startFusion, workerEvent } from "../fixtures/fusion-timeline"

test("两角色实时记录均进入主时间线，模型和轮次可区分", () => {
  const state = liveFusionTimeline()
  const visible = scopeTimeline(state.timeline, "root")
  expect(JSON.stringify(visible)).toContain("Lead 正在检查代码")
  expect(JSON.stringify(visible)).toContain("Sidekick 正在修改文件")
  expect(visible.some(item => item.type === "tool" && item.tool.name === "write_file")).toBe(true)
  const groups = segmentTimeline(visible).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups.map(activityGroupTitle)).toEqual(["Lead · strong-model", "Sidekick · fast-model · 第 1 轮"])
  expect(groups[1]?.terminal).toBe(false)
})

test("Lead 返回审阅及 Sidekick 返工保持事件顺序，各段 key 唯一", () => {
  let state = liveFusionTimeline()
  for (const event of [
    workerEvent("completed", 7),
    fusionEvent(EventType.CONTENT_DELTA, { text: "Lead 要求返工" }, 8),
    workerEvent("running", 9, "worker-2", 2),
    fusionEvent(EventType.CONTENT_DELTA, { text: "Sidekick 第二轮" }, 10, "worker-2", "root-r"),
    workerEvent("completed", 11, "worker-2", 2),
    fusionEvent(EventType.CONTENT_DELTA, { text: "Lead 最终审阅" }, 12),
  ]) state = applyAgentEvent(state, event)
  const groups = segmentTimeline(scopeTimeline(state.timeline, "root")).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups.map(activityGroupTitle)).toEqual([
    "Lead · strong-model", "Sidekick · fast-model · 第 1 轮", "Lead · strong-model",
    "Sidekick · fast-model · 第 2 轮", "Lead · strong-model",
  ])
  expect(new Set(groups.map(group => group.key)).size).toBe(groups.length)
  expect(groups[1]?.terminal).toBe(true)
  expect(groups[3]?.terminal).toBe(true)
})

test("同名工具在两角色中互不串线，结束即停止该轮流式指示", () => {
  let state = startFusion()
  for (const event of [
    fusionEvent(EventType.TOOL_STARTED, { tool_call_id: "same", name: "read_file" }, 2),
    workerEvent("running", 3),
    fusionEvent(EventType.TOOL_STARTED, { tool_call_id: "same", name: "write_file" }, 4, "worker-1", "root-r"),
    fusionEvent(EventType.CONTENT_DELTA, { text: "子输出" }, 5, "worker-1", "root-r"),
    fusionEvent(EventType.REASONING_DELTA, { text: "子模型返回的思考说明" }, 6, "worker-1", "root-r"),
    workerEvent("cancelled", 7),
  ]) state = applyAgentEvent(state, event)
  const tools = state.timeline.filter(item => item.type === "tool").map(item => item.tool)
  expect(tools.find(tool => tool.executionId === "root-r")?.status).toBe("running")
  expect(tools.find(tool => tool.executionId === "worker-1")?.status).toBe("failed")
  expect(state.timeline.find(item => item.type === "message" && item.message.content === "子输出")?.message.streaming).toBe(false)
  expect(state.timeline.find(item => item.type === "reasoning")?.reasoning.active).toBe(false)
})

test("未绑定的同名子代理、错误父执行和其他任务不会进入主时间线", () => {
  let state = startFusion()
  state = applyAgentEvent(state, { ...workerEvent("running", 2), parent_execution_id: "other-root" })
  state = applyAgentEvent(state, fusionEvent(EventType.CONTENT_DELTA, { text: "无绑定输出" }, 3, "worker-1", "other-root"))
  state = applyAgentEvent(state, { ...workerEvent("running", 4, "worker-other"), payload: { ...workerEvent("running", 4).payload, task_id: "another-task" } } as any)
  state = applyAgentEvent(state, fusionEvent(EventType.CONTENT_DELTA, { text: "其他任务输出" }, 5, "worker-other", "root-r"))
  expect(JSON.stringify(scopeTimeline(state.timeline, "root"))).not.toContain("无绑定输出")
  expect(JSON.stringify(scopeTimeline(state.timeline, "root"))).not.toContain("其他任务输出")
})

test("父运行结束收敛两角色，Fusion 状态只更新一条说明", () => {
  let state = liveFusionTimeline()
  state = applyAgentEvent(state, fusionEvent(EventType.FUSION_PROGRESS, { ...fusionTask, version: 2, phase: "WORKER_RUNNING", round: 1 }, 7))
  state = applyAgentEvent(state, fusionEvent(EventType.FUSION_PROGRESS, { ...fusionTask, version: 3, phase: "CHECKING", round: 1 }, 8))
  state = applyAgentEvent(state, fusionEvent(EventType.RUN_CANCELLED, { reason: "用户取消" }, 9))
  const statuses = state.timeline.filter(item => item.type === "message" && item.message.content.startsWith("Fusion "))
  expect(statuses).toHaveLength(1)
  expect(JSON.stringify(statuses)).toContain("Host 检查中")
  const groups = segmentTimeline(scopeTimeline(state.timeline, "root")).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups.every(group => group.terminal)).toBe(true)
  expect(state.timeline.filter(item => item.type === "message").every(item => item.message.streaming !== true)).toBe(true)
})

test("连接中断的本地失败路径也停止两角色运行状态", () => {
  const state = markRunFailed(liveFusionTimeline(), "r", "连接已关闭")
  const groups = segmentTimeline(scopeTimeline(state.timeline, "root")).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups.length).toBeGreaterThan(0)
  expect(groups.every(group => group.terminal)).toBe(true)
})

test("缺省 root 身份仍合成同一个 Lead 过程组", () => {
  let state = startRun(createInitialState("t"), { threadId: "t", runId: "r" }, "修改")
  state = applyAgentEvent(state, { ...fusionEvent(EventType.RUN_STARTED, { mode: "build", resumed: false, fusion: fusionTask }, 1), execution_id: undefined })
  state = applyAgentEvent(state, { ...fusionEvent(EventType.CONTENT_DELTA, { text: "Lead 输出" }, 2), execution_id: undefined })
  const groups = segmentTimeline(state.timeline).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups).toHaveLength(1)
  expect(JSON.stringify(groups[0]?.items)).toContain("Lead 输出")
})

test("迟到的重复开始和正文不能复活已结束的 Sidekick", () => {
  let state = liveFusionTimeline()
  state = applyAgentEvent(state, workerEvent("completed", 7))
  state = applyAgentEvent(state, workerEvent("running", 8))
  state = applyAgentEvent(state, fusionEvent(EventType.CONTENT_DELTA, { text: "迟到内容" }, 9, "worker-1", "root-r"))
  const visible = scopeTimeline(state.timeline, "root")
  expect(JSON.stringify(visible)).not.toContain("迟到内容")
  const groups = segmentTimeline(visible).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups.find(group => group.fusion?.role === "sidekick")?.terminal).toBe(true)
})


test("模型故障的具体原因和下一步显示在共享时间线", () => {
  const message = "上游账号 cn-cli 的登录已失效（HTTP 401）。请在代理控制台重新登录，完成授权后回到当前对话继续。"
  const state = applyAgentEvent(liveFusionTimeline(), fusionEvent(EventType.RUN_FAILED, {
    error: { code: "PROVIDER_REQUEST_REJECTED", message, retryable: false },
  }, 7))
  expect(JSON.stringify(scopeTimeline(state.timeline, "root"))).toContain(message)
  expect(state.activity.kind).toBe("failed")
})

test("只读探索显示独立标题，迟到帧不能更改探索身份", () => {
  let state = startFusion()
  state = applyAgentEvent(state, fusionEvent(EventType.FUSION_EXECUTION, { task_id: "fusion-test", role: "sidekick", kind: "exploration", round: 0, model: "fast-model", status: "running" }, 2, "explorer", "root-r"))
  state = applyAgentEvent(state, fusionEvent(EventType.CONTENT_DELTA, { text: "调查依据" }, 3, "explorer", "root-r"))
  const groups = segmentTimeline(scopeTimeline(state.timeline, "root")).filter(segment => segment.kind === "group").map(segment => segment.group)
  expect(groups.map(activityGroupTitle)).toContain("Sidekick · fast-model · 只读探索")
  state = applyAgentEvent(state, fusionEvent(EventType.FUSION_EXECUTION, { task_id: "fusion-test", role: "sidekick", round: 0, model: "fast-model", status: "completed" }, 4, "explorer", "root-r"))
  const marker = state.timeline.find(item => item.type === "message" && item.message.fusionExecution?.role === "sidekick")
  expect(marker?.type === "message" && marker.message.fusionExecution?.status).toBe("running")
})
