/**
 * ACP `elicitation/create` 表单双向转换测试：覆盖提问（q_N/q_N_other/填空）、
 * 目标确认（decision+criteria）、计划确认（decision+feedback）、必填拒绝反馈、通用字段及取消/拒绝。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  recognizeElicitationForm,
  toConversationInteraction,
  toElicitationAnswer,
} from "../src/renderer/features/session/elicitation-form.ts"

test("q_N 与 q_N_other 映射为 ConversationInteraction(question)，并正确回填单选/多选/其他/填空", () => {
  const req = {
    id: "el-q-1",
    message: "用哪种方案",
    requestedSchema: {
      type: "object",
      properties: {
        q_0: { type: "string", title: "方案", description: "甲：快", oneOf: [{ const: "a", title: "甲" }] },
        q_0_other: { type: "string", title: "其他（可选）" },
        q_1: { type: "array", title: "范围", items: { anyOf: [{ const: "x", title: "一" }, { const: "y", title: "二" }] } },
        q_2: { type: "string", title: "补充说明", maxLength: 4000 },
      },
      required: ["q_0", "q_2"],
    },
  }

  const converted = toConversationInteraction(req)
  assert.ok(converted)
  assert.equal(converted.form.kind, "question")
  assert.equal(converted.interaction.kind, "question")
  if (converted.interaction.kind !== "question") return
  assert.deepEqual(converted.interaction.questions.map(q => q.id), ["q_0", "q_1", "q_2"])
  assert.equal(converted.interaction.questions[0]?.multiple, false)
  assert.equal(converted.interaction.questions[0]?.allowOther, true)
  assert.equal(converted.interaction.questions[0]?.required, true)
  assert.equal(converted.interaction.questions[1]?.multiple, true)
  assert.equal(converted.interaction.questions[1]?.allowOther, false)
  assert.equal(converted.interaction.questions[1]?.required, false)
  assert.deepEqual(converted.interaction.questions[2]?.options, [])
  assert.equal(converted.interaction.questions[2]?.allowOther, true)

  const accepted = toElicitationAnswer(converted.form, {
    kind: "question",
    answers: [
      { questionId: "q_0", selectedOptionIds: ["a"], otherText: "丙方案" },
      { questionId: "q_1", selectedOptionIds: ["x", "y"] },
      { questionId: "q_2", selectedOptionIds: [], otherText: "尽快完成" },
    ],
  })
  assert.deepEqual(accepted, {
    action: "accept",
    content: {
      q_0: "a",
      q_0_other: "丙方案",
      q_1: ["x", "y"],
      q_2: "尽快完成",
    },
  })

  // 单选只填「其他」时写回 q_0_other
  const otherOnly = toElicitationAnswer(converted.form, {
    kind: "question",
    answers: [
      { questionId: "q_0", selectedOptionIds: [], otherText: "自定义方案" },
    ],
  })
  assert.deepEqual(otherOnly, {
    action: "accept",
    content: { q_0_other: "自定义方案" },
  })
})

test("decision + criteria 目标确认映射为 approval 卡片并还原 accepted/edited/rejected 与取消", () => {
  const req = {
    id: "el-goal-1",
    message: "确认目标：修掉失败\n假设：测试已在\n仓库可写",
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          oneOf: [
            { const: "accepted", title: "接受" },
            { const: "edited", title: "修改判定条件后接受" },
            { const: "rejected", title: "拒绝" },
          ],
        },
        criteria: { type: "string", title: "判定条件（每行一条）", default: "有失败用例\n\n能复现" },
        feedback: { type: "string", maxLength: 4000 },
      },
      required: ["decision"],
    },
  }

  const converted = toConversationInteraction(req)
  assert.ok(converted)
  assert.equal(converted.form.kind, "goal")
  assert.equal(converted.interaction.kind, "approval")
  if (converted.interaction.kind !== "approval") return
  assert.equal(converted.interaction.title, "确认目标：修掉失败")
  assert.ok(converted.interaction.description?.includes("测试已在"))
  assert.ok(converted.interaction.description?.includes("有失败用例"))
  assert.deepEqual(converted.interaction.options.map(o => o.id), ["accepted", "edited", "rejected"])
  assert.equal(converted.interaction.options[1]?.feedback, "required")

  assert.deepEqual(
    toElicitationAnswer(converted.form, { kind: "approval", optionId: "edited", feedback: "条件一\n条件二" }),
    { action: "accept", content: { decision: "edited", criteria: "条件一\n条件二", feedback: "条件一\n条件二" } },
  )
  assert.deepEqual(
    toElicitationAnswer(converted.form, { kind: "approval", optionId: "accepted", feedback: "可以" }),
    { action: "accept", content: { decision: "accepted", feedback: "可以" } },
  )
  assert.deepEqual(toElicitationAnswer(converted.form, { kind: "cancel" }), { action: "cancel" })
})

test("decision + feedback 计划确认映射为 approval 卡片并还原 decision 与修改意见", () => {
  const req = {
    id: "el-plan-1",
    message: "请确认执行计划（计划.md）\n\n# 步骤\n1. 先写测试",
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          oneOf: [
            { const: "revise", title: "需要修改" },
            { const: "approved", title: "批准并开始执行" },
          ],
        },
        feedback: { type: "string", title: "修改意见", maxLength: 4000 },
      },
      required: ["decision"],
    },
  }

  const converted = toConversationInteraction(req)
  assert.ok(converted)
  assert.equal(converted.form.kind, "plan")
  assert.equal(converted.interaction.kind, "approval")
  if (converted.interaction.kind !== "approval") return
  assert.equal(converted.interaction.title, "确认执行计划（计划.md）")
  assert.equal(converted.interaction.description, "# 步骤\n1. 先写测试")
  assert.deepEqual(converted.interaction.options.map(o => o.id), ["approved", "revise"])

  assert.deepEqual(
    toElicitationAnswer(converted.form, { kind: "approval", optionId: "revise", feedback: "补一条边界检查" }),
    { action: "accept", content: { decision: "revise", feedback: "补一条边界检查" } },
  )
})

test("只有必填 feedback 时识别为拒绝原因表单，空输入按 decline 处理", () => {
  const form = recognizeElicitationForm({
    type: "object",
    required: ["feedback"],
    properties: { feedback: { type: "string", maxLength: 4000 } },
  }, "请说明拒绝原因，Agent 会据此调整")
  assert.equal(form.kind, "feedback")

  const converted = toConversationInteraction({
    id: "el-fb-1",
    message: "请说明拒绝原因，Agent 会据此调整",
    requestedSchema: {
      type: "object",
      required: ["feedback"],
      properties: { feedback: { type: "string", maxLength: 4000 } },
    },
  })
  assert.ok(converted)
  assert.equal(converted.interaction.kind, "question")
  if (converted.interaction.kind !== "question") return
  assert.equal(converted.interaction.title, "请补充说明")
  assert.equal(converted.interaction.description, undefined)
  assert.equal(converted.interaction.questions[0]?.id, "feedback")
  assert.equal(converted.interaction.questions[0]?.text, "请说明拒绝原因，Agent 会据此调整")
  assert.equal(converted.interaction.questions[0]?.required, true)

  assert.deepEqual(
    toElicitationAnswer(form, { kind: "question", answers: [{ questionId: "feedback", selectedOptionIds: [], otherText: "范围过大" }] }),
    { action: "accept", content: { feedback: "范围过大" } },
  )
  assert.deepEqual(
    toElicitationAnswer(form, { kind: "question", answers: [{ questionId: "feedback", selectedOptionIds: [] }] }),
    { action: "decline" },
  )
})

test("通用 schema 属性支持 enum、boolean、number 与空 schema 返回 null", () => {
  const empty = toConversationInteraction({
    id: "el-empty",
    message: "空表",
    requestedSchema: { type: "object", properties: {} },
  })
  assert.equal(empty, null)

  const generic = toConversationInteraction({
    id: "el-gen",
    message: "补充参数",
    requestedSchema: {
      type: "object",
      properties: {
        confirm: { type: "string", title: "是否继续", enum: ["yes", "no"] },
        dryRun: { type: "boolean", title: "仅演练" },
        retries: { type: "integer", title: "重试次数" },
        note: { type: "string", title: "备注" },
      },
      required: ["confirm"],
    },
  })
  assert.ok(generic)
  assert.equal(generic.interaction.kind, "question")
  if (generic.interaction.kind !== "question") return
  assert.deepEqual(generic.interaction.questions.map(q => q.id), ["confirm", "dryRun", "retries", "note"])
  assert.deepEqual(generic.interaction.questions[1]?.options.map(o => o.id), ["true", "false"])

  const reply = toElicitationAnswer(generic.form, {
    kind: "question",
    answers: [
      { questionId: "confirm", selectedOptionIds: ["yes"] },
      { questionId: "dryRun", selectedOptionIds: ["true"] },
      { questionId: "retries", selectedOptionIds: [], otherText: "3" },
      { questionId: "note", selectedOptionIds: [], otherText: "ok" },
    ],
  })
  assert.deepEqual(reply, {
    action: "accept",
    content: { confirm: "yes", dryRun: true, retries: 3, note: "ok" },
  })
  assert.deepEqual(toElicitationAnswer(generic.form, { kind: "decline" }), { action: "decline" })
})

test("单题 q_0 当 header 与问题正文相同时，卡片标题收敛为“请确认细节”而不重复展示问题", () => {
  const questionText = "README 只写了「请遵守除零保护规范」，没规定具体行为。divide 在 b === 0 时应如何处理？"
  const single = toConversationInteraction({
    id: "el-single-dup",
    message: questionText,
    requestedSchema: {
      type: "object",
      properties: {
        q_0: {
          type: "string",
          title: questionText,
          oneOf: [
            { const: "a", title: "抛 RangeError" },
            { const: "b", title: "返回 undefined" },
          ],
        },
        q_0_other: { type: "string", title: "其他（可选）" },
      },
      required: ["q_0"],
    },
  })
  assert.ok(single)
  assert.equal(single.interaction.kind, "question")
  if (single.interaction.kind !== "question") return
  assert.equal(single.interaction.title, "请确认细节")
  assert.equal(single.interaction.description, undefined)
  assert.equal(single.interaction.questions[0]?.text, questionText)
})
