import { expect, test } from "bun:test"
import { fusionSummary } from "../../src/interactive/fusion-summary"
import { fusionTask } from "../fixtures/fusion-timeline"
import type { FusionTaskStatus } from "@za38/protocol"

const role = { profile_id: "pro", calls: 2, input_tokens: 50, output_tokens: 9, cached_input_tokens: 20, complete: true, cache_complete: true, cache_hit_rate: .4 }

test("角色用量、未知缓存与配置估算以相同口径显示", () => {
  const task = { ...fusionTask, usage: { lead: role, sidekick: { ...role, profile_id: "fast", cache_complete: false, cache_hit_rate: null }, estimate: null } } as FusionTaskStatus
  const text = fusionSummary(task)
  expect(text).toContain("Lead 输入 50 / 输出 9")
  expect(text).toContain("缓存 40%")
  expect(text).toContain("Sidekick 输入 50 / 输出 9")
  expect(text).toContain("缓存未知")
  expect(text).not.toContain("金额")
  const priced = fusionSummary({ ...task, usage: { ...task.usage!, estimate: { currency: "USD", lead_cost: "0.1", sidekick_cost: "0.02", sidekick_at_lead_price: "0.2", estimated_saving: "0.18" } } })
  expect(priced).toContain("估算 USD")
  expect(priced).toContain("假设差额 0.18")
})

test("重复失败提示不改变状态说明，探索独立显示", () => {
  const text = fusionSummary({ ...fusionTask, exploration: { exploration_id: "x", status: "running" }, stagnation: { kind: "repeated_unresolved", round: 2, message: "请换策略" } } as FusionTaskStatus)
  expect(text).toContain("只读探索中")
  expect(text).toContain("请换策略")
  expect(text).toContain("尚未派单")
})
