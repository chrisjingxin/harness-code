/**
 * /undo list 文本解析与精确回退命令构造单元测试。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { buildUndoCommand, parseUndoListMessage } from "../src/renderer/features/session/undo-choice.ts"

test("parseUndoListMessage 正确解析可回退回合序号、摘要与涉及文件数", () => {
  const sample = [
    "可回退的回合（用 `/undo <N> [both|code|conversation]` 回退）：",
    "- #1 先打个招呼并确认你已就绪，暂时不要修改任何文件",
    "- #2 请依次执行只读操作并修复 pricing.mjs（涉及 2 个文件）",
    "- #3 梳理最小步骤",
  ].join("\n")

  const parsed = parseUndoListMessage(sample)
  assert.deepEqual(parsed, [
    { turnNumber: 1, summary: "先打个招呼并确认你已就绪，暂时不要修改任何文件" },
    { turnNumber: 2, summary: "请依次执行只读操作并修复 pricing.mjs", filesNote: "涉及 2 个文件" },
    { turnNumber: 3, summary: "梳理最小步骤" },
  ])
  assert.equal(buildUndoCommand(2, "both"), "/undo 2 both")
  assert.equal(buildUndoCommand(3, "code"), "/undo 3 code")
  assert.equal(buildUndoCommand(1, "conversation"), "/undo 1 conversation")
})

test("parseUndoListMessage 对空回合或普通助手回复返回 null", () => {
  assert.equal(parseUndoListMessage("当前没有可回退的回合。"), null)
  assert.equal(parseUndoListMessage("我已经修复了第 24 行的计算顺序：\n- #1 测试条目"), null)
  assert.equal(parseUndoListMessage("可回退的回合（用 `/undo <N>` 回退）："), null)
})
