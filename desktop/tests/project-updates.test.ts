/**
 * HC-225 单元测试：验证通知分派仅在看板页激活时触发 refreshBoard，避免非看板页产生请求放大。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { NotificationEvent } from "@workbench/collaboration-client/types"
import { dispatchProjectUpdates } from "../src/renderer/features/project-updates/use-project-updates.ts"
import type { ProjectUpdateTargets } from "../src/renderer/features/project-updates/use-project-updates.ts"

function createTracker(overrides: Partial<ProjectUpdateTargets> = {}) {
  const calls = {
    projectList: 0,
    projectDetail: 0,
    conversations: 0,
    board: 0,
    tasks: [] as string[][],
    knowledge: [] as string[][],
  }
  const targets: ProjectUpdateTargets = {
    projectId: "proj-1",
    refreshProjectList: () => { calls.projectList++ },
    refreshProjectDetail: () => { calls.projectDetail++ },
    refreshConversations: () => { calls.conversations++ },
    refreshBoard: () => { calls.board++ },
    refreshTasks: ids => { calls.tasks.push([...ids]) },
    refreshKnowledge: ids => { calls.knowledge.push([...ids]) },
    ...overrides,
  }
  return { calls, targets }
}

const sampleEvents: readonly NotificationEvent[] = [
  { id: 1, eventId: "e-1", type: "project.member_changed", objectId: "proj-1", projectId: "proj-1", occurredAtMs: 1 },
  { id: 2, eventId: "e-2", type: "conversation.brief_updated", objectId: "conv-1", projectId: "proj-1", occurredAtMs: 2 },
  { id: 3, eventId: "e-3", type: "task.changed", objectId: "task-1", projectId: "proj-1", occurredAtMs: 3 },
  { id: 4, eventId: "e-4", type: "knowledge.updated", objectId: "kb-1", projectId: null, occurredAtMs: 4 },
]

test("isBoardActive 为 false 时不触发 refreshBoard，但仍刷新列表、详情、会话、任务与知识", () => {
  const { calls, targets } = createTracker({ isBoardActive: false })
  dispatchProjectUpdates(sampleEvents, targets)

  assert.equal(calls.board, 0)
  assert.equal(calls.projectList, 1)
  assert.equal(calls.projectDetail, 1)
  assert.equal(calls.conversations, 1)
  assert.deepEqual(calls.tasks, [["task-1"]])
  assert.deepEqual(calls.knowledge, [["kb-1"]])
})

test("isBoardActive 为 true 或未传时正常合并触发 refreshBoard", () => {
  const active = createTracker({ isBoardActive: true })
  dispatchProjectUpdates(sampleEvents, active.targets)
  assert.equal(active.calls.board, 1)

  const omitted = createTracker()
  dispatchProjectUpdates(sampleEvents, omitted.targets)
  assert.equal(omitted.calls.board, 1)
})

test("仅收到其他项目事件或团队知识事件时不触发当前项目 refreshBoard", () => {
  const { calls, targets } = createTracker({ isBoardActive: true })
  dispatchProjectUpdates([
    { id: 10, eventId: "e-10", type: "task.assigned", objectId: "task-other", projectId: "proj-2", occurredAtMs: 10 },
    { id: 11, eventId: "e-11", type: "knowledge.updated", objectId: "kb-2", projectId: null, occurredAtMs: 11 },
  ], targets)

  assert.equal(calls.board, 0)
  assert.deepEqual(calls.tasks, [])
  assert.deepEqual(calls.knowledge, [["kb-2"]])
})
