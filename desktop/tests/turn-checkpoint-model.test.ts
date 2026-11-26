/** 轮次变更文件树汇总与时间线位置匹配纯函数测试。 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { CodeCheckpointTurn } from "../src/shared/local-execution-host.js"
import type { ConversationTimelineEntry } from "../src/ui/index.js"
import {
  buildTurnDiffTree,
  extractTimelineTurnId,
  matchTurnSpans,
  summarizeCheckpointFiles,
} from "../src/renderer/features/session/turn-checkpoint-model.js"

test("summarizeCheckpointFiles 正确合计文本与二进制文件改动统计", () => {
  assert.deepEqual(summarizeCheckpointFiles([
    { path: "a.ts", added: 12, removed: 3 },
    { path: "logo.png", added: null, removed: null },
    { path: "b.ts", added: 5, removed: 0 },
  ]), { count: 3, additions: 17, deletions: 3 })
})

test("buildTurnDiffTree 折叠单一子目录并按目录优先、字母序排列", () => {
  const tree = buildTurnDiffTree([
    { path: "README.md", added: 2, removed: 1 },
    { path: "desktop/src/main/project-service/checkpoints.ts", added: 10, removed: 2 },
    { path: "desktop/src/main/project-service/checkpoint-git.ts", added: 4, removed: 0 },
    { path: "desktop/src/renderer/features/session/panel.tsx", added: 8, removed: 3 },
  ])
  assert.equal(tree.length, 2)
  assert.equal(tree[0]!.kind, "directory")
  assert.equal(tree[0]!.name, "desktop/src")
  if (tree[0]!.kind !== "directory") throw new Error("expected directory")
  assert.deepEqual(
    tree[0]!.children.map(child => child.name),
    ["main/project-service", "renderer/features/session"],
  )
  assert.equal(tree[1]!.kind, "file")
  assert.equal(tree[1]!.name, "README.md")
})

test("matchTurnSpans 支持本机轮次、follow-up 并入同一轮、seq 时间戳回退并跳过运行中轮次", () => {
  assert.equal(extractTimelineTurnId("local-execution:t1:user"), "t1")
  assert.equal(extractTimelineTurnId("local-turn:t2:assistant"), "t2")
  assert.equal(extractTimelineTurnId("seq-10"), null)

  const entries: ConversationTimelineEntry[] = [
    { kind: "message", id: "seq-1", role: "user", text: "第一轮问题", createdAtMs: 1_000 },
    { kind: "message", id: "seq-2", role: "assistant", text: "第一轮回答" },
    { kind: "message", id: "local-turn:t2:user", role: "user", text: "第二轮主指令", createdAtMs: 2_000 },
    { kind: "message", id: "local-turn:t2:followup:0", role: "user", text: "第二轮中途补充", createdAtMs: 2_100 },
    { kind: "tool", id: "local-turn:t2:tool:0", label: "Edit", status: "completed", tone: "write" },
    { kind: "message", id: "local-turn:t2:assistant", role: "assistant", text: "第二轮完成" },
    { kind: "message", id: "local-execution:t3:user", role: "user", text: "第三轮运行中", createdAtMs: 3_000 },
    { kind: "message", id: "local-execution:t3:assistant", role: "assistant", text: "", streaming: true },
  ]

  const turns: CodeCheckpointTurn[] = [
    {
      turnId: "t1",
      ordinal: 1,
      createdAtMs: 1_000,
      status: "completed",
      files: [],
      guards: [],
    },
    {
      turnId: "t2",
      ordinal: 2,
      createdAtMs: 2_000,
      status: "completed",
      files: [{ path: "src/app.ts", added: 3, removed: 1 }],
      guards: [],
    },
    {
      turnId: "t3",
      ordinal: 3,
      createdAtMs: 3_000,
      status: "completed",
      files: [{ path: "src/wip.ts", added: 1, removed: 0 }],
      guards: [],
    },
  ]

  const spans = matchTurnSpans(entries, turns, "t3")
  assert.deepEqual(
    spans.map(item => ({ turnId: item.turn.turnId, userIndex: item.userIndex, endIndex: item.endIndex })),
    [
      { turnId: "t1", userIndex: 0, endIndex: 1 },
      { turnId: "t2", userIndex: 2, endIndex: 5 },
    ],
  )
})
